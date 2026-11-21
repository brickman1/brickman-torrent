//! Making the app the `magnet:` handler and the owner of `.torrent` files.
//!
//! Registration is per user (`HKCU\Software\Classes`), so it needs no
//! administrator rights, and it is reversible: [`register`] snapshots every key
//! it is about to touch *before* the first change and writes the backup to
//! `<data-dir>/handler-backup.json`. The snapshot keeps the raw bytes and the
//! `REG_*` type of every value and recurses into every subkey, so [`unregister`]
//! restores exactly what was there — including the case "the key did not exist
//! at all", which is then removed again.
//!
//! A second registration never overwrites the backup: it would otherwise
//! snapshot our own keys and "restore" the user's original handler to us.
//!
//! Tests never touch the real `magnet` / `.torrent` keys. The registry tests
//! work on `HKCU\Software\Classes\BrickmanTorrentTest*` and remove it again.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// `HKCU`-relative key of the `magnet:` protocol handler.
pub const MAGNET_KEY: &str = r"Software\Classes\magnet";
/// `HKCU`-relative key of the document type this app owns.
pub const TORRENT_PROGID_KEY: &str = r"Software\Classes\BrickmanTorrent.Torrent";
/// `HKCU`-relative key of the `.torrent` extension.
pub const TORRENT_EXT_KEY: &str = r"Software\Classes\.torrent";
/// ProgID written as the default value of the `.torrent` extension.
pub const PROGID: &str = "BrickmanTorrent.Torrent";
/// Type name Explorer shows for a `.torrent` file.
pub const FRIENDLY_NAME: &str = "Brickman Torrent Document";
/// Name of the backup file inside the data folder.
pub const BACKUP_FILE_NAME: &str = "handler-backup.json";

// ------------------------------------------------------------- command line

/// Command line the shell runs for a link or a file: `"<exe>" "%1"`.
///
/// Both parts are quoted: the executable path contains spaces when the app is
/// installed under `C:\Program Files\…`, and `%1` is the path or the link the
/// shell appends. Windows file names cannot contain `"`, so there is nothing
/// else to escape.
pub fn open_command(exe: &Path) -> String {
    format!("\"{}\" \"%1\"", exe.display())
}

/// Default value of the `DefaultIcon` subkey: `"<exe>",0` (first icon).
pub fn icon_value(exe: &Path) -> String {
    format!("\"{}\",0", exe.display())
}

// ------------------------------------------------------------------ snapshot

/// One registry value, exactly as the registry stores it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValueSnapshot {
    /// Value name; `""` is the default value of the key.
    pub name: String,
    /// `REG_*` type as its numeric constant, so the file does not need winreg
    /// to be read.
    pub vtype: u32,
    /// Raw bytes, not decoded: the restore writes them back unchanged.
    pub bytes: Vec<u8>,
}

/// A subkey and everything below it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubkeySnapshot {
    pub name: String,
    pub key: KeySnapshot,
}

/// A key with its values and subkeys, sorted by name so two snapshots of the
/// same state compare equal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeySnapshot {
    pub values: Vec<ValueSnapshot>,
    pub subkeys: Vec<SubkeySnapshot>,
}

/// What the three handler keys looked like before registration.
///
/// `None` means the key did not exist: unregistering removes it again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlerBackup {
    /// `HKCU\Software\Classes\magnet`.
    pub magnet: Option<KeySnapshot>,
    /// `HKCU\Software\Classes\BrickmanTorrent.Torrent`.
    pub torrent_progid: Option<KeySnapshot>,
    /// `HKCU\Software\Classes\.torrent`.
    pub torrent_extension: Option<KeySnapshot>,
}

/// What the settings UI shows for the two switches.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlerStatus {
    /// The `magnet:` command line points at this executable.
    pub registered: bool,
    /// A backup file exists, so unregistering can put the old handlers back.
    pub backup_present: bool,
    /// Why the last operation failed, if it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// -------------------------------------------------------------- backup file

pub fn backup_path(data_dir: &Path) -> PathBuf {
    data_dir.join(BACKUP_FILE_NAME)
}

pub fn backup_present(data_dir: &Path) -> bool {
    backup_path(data_dir).is_file()
}

/// Reads the backup; `None` when no registration was ever made.
pub fn load_backup(data_dir: &Path) -> Result<Option<HandlerBackup>, String> {
    let path = backup_path(data_dir);
    let contents = match std::fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    serde_json::from_slice(&contents)
        .map(Some)
        .map_err(|error| format!("{} is damaged: {error}", path.display()))
}

/// Writes the backup atomically: a crash must not leave a half-written file
/// that could no longer restore the original handlers.
pub fn save_backup(data_dir: &Path, backup: &HandlerBackup) -> Result<(), String> {
    let path = backup_path(data_dir);
    let contents = serde_json::to_vec_pretty(backup)
        .map_err(|error| format!("cannot encode the handler backup: {error}"))?;
    atomic_write(&path, &contents)
}

fn remove_backup(data_dir: &Path) -> Result<(), String> {
    let path = backup_path(data_dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot remove {}: {error}", path.display())),
    }
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid backup path {}", path.display()))?;
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!("{name}.{}.{seq}.tmp", std::process::id()));

    let write = || -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()
    };
    if let Err(error) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("cannot write {}: {error}", tmp.display()));
    }
    // `rename` replaces an existing file on both Windows and Unix.
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("cannot write {}: {error}", path.display()));
    }
    Ok(())
}

// ------------------------------------------------------------ registration

/// Registers the app for `magnet:` links and `.torrent` files and returns the
/// state it replaced.
///
/// The backup is written before the first key is changed, so a failure halfway
/// through can still be undone with [`unregister`].
pub fn register(exe: &Path, data_dir: &Path) -> Result<HandlerBackup, String> {
    let backup = match load_backup(data_dir)? {
        Some(backup) => backup,
        None => {
            let backup = HandlerBackup {
                magnet: registry::snapshot(MAGNET_KEY)?,
                torrent_progid: registry::snapshot(TORRENT_PROGID_KEY)?,
                torrent_extension: registry::snapshot(TORRENT_EXT_KEY)?,
            };
            save_backup(data_dir, &backup)?;
            backup
        }
    };
    registry::register_keys(exe)?;
    Ok(backup)
}

/// Puts back exactly what [`register`] replaced and drops the backup file.
///
/// Without a backup there is nothing to undo; the file is kept when a restore
/// fails, so the operation can be retried.
pub fn unregister(data_dir: &Path) -> Result<(), String> {
    let Some(backup) = load_backup(data_dir)? else {
        return Ok(());
    };
    registry::restore(MAGNET_KEY, &backup.magnet)?;
    registry::restore(TORRENT_PROGID_KEY, &backup.torrent_progid)?;
    registry::restore(TORRENT_EXT_KEY, &backup.torrent_extension)?;
    remove_backup(data_dir)
}

/// Current state of the two switches, without touching the registry.
pub fn status(exe: &Path, data_dir: &Path) -> HandlerStatus {
    HandlerStatus {
        registered: registry::is_registered(exe, MAGNET_KEY),
        backup_present: backup_present(data_dir),
        // Nothing to report on Windows; elsewhere the switches cannot work.
        error: (!cfg!(windows)).then(|| NOT_SUPPORTED.to_string()),
    }
}

// ------------------------------------------------------------ Windows layer

#[cfg(windows)]
mod registry {
    use std::borrow::Cow;
    use std::io::ErrorKind;
    use std::path::Path;

    use winreg::RegKey;
    use winreg::RegValue;
    use winreg::enums::{HKEY_CURRENT_USER, REG_BINARY, RegType};

    use super::{
        FRIENDLY_NAME, KeySnapshot, MAGNET_KEY, PROGID, SubkeySnapshot, TORRENT_EXT_KEY,
        TORRENT_PROGID_KEY, ValueSnapshot, icon_value, open_command,
    };

    fn hkcu() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    /// Snapshot of a key; `None` when it does not exist.
    pub fn snapshot(key_path: &str) -> Result<Option<KeySnapshot>, String> {
        let key = match hkcu().open_subkey(key_path) {
            Ok(key) => key,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("cannot open HKCU\\{key_path}: {error}")),
        };
        snapshot_key(&key, key_path).map(Some)
    }

    fn snapshot_key(key: &RegKey, key_path: &str) -> Result<KeySnapshot, String> {
        let mut values = Vec::new();
        for entry in key.enum_values() {
            let (name, value) =
                entry.map_err(|error| format!("cannot read HKCU\\{key_path}: {error}"))?;
            values.push(ValueSnapshot {
                name,
                vtype: value.vtype as u32,
                bytes: value.bytes.into_owned(),
            });
        }
        values.sort_by(|left, right| left.name.cmp(&right.name));

        let mut subkeys = Vec::new();
        for entry in key.enum_keys() {
            let name = entry.map_err(|error| format!("cannot read HKCU\\{key_path}: {error}"))?;
            let child_path = format!("{key_path}\\{name}");
            let child = key
                .open_subkey(&name)
                .map_err(|error| format!("cannot open HKCU\\{child_path}: {error}"))?;
            subkeys.push(SubkeySnapshot {
                key: snapshot_key(&child, &child_path)?,
                name,
            });
        }
        subkeys.sort_by(|left, right| left.name.cmp(&right.name));

        Ok(KeySnapshot { values, subkeys })
    }

    /// Recreates a key from a snapshot; `None` deletes it.
    pub fn restore(key_path: &str, snapshot: &Option<KeySnapshot>) -> Result<(), String> {
        delete_key(key_path)?;
        let Some(snapshot) = snapshot else {
            return Ok(());
        };
        let (key, _) = hkcu()
            .create_subkey(key_path)
            .map_err(|error| format!("cannot create HKCU\\{key_path}: {error}"))?;
        write_key(&key, key_path, snapshot)
    }

    fn write_key(key: &RegKey, key_path: &str, snapshot: &KeySnapshot) -> Result<(), String> {
        for value in &snapshot.values {
            let raw = RegValue {
                bytes: Cow::Borrowed(&value.bytes),
                vtype: reg_type(value.vtype),
            };
            key.set_raw_value(&value.name, &raw)
                .map_err(|error| format!("cannot write HKCU\\{key_path}: {error}"))?;
        }
        for subkey in &snapshot.subkeys {
            let child_path = format!("{key_path}\\{}", subkey.name);
            let (child, _) = key
                .create_subkey(&subkey.name)
                .map_err(|error| format!("cannot create HKCU\\{child_path}: {error}"))?;
            write_key(&child, &child_path, &subkey.key)?;
        }
        Ok(())
    }

    fn delete_key(key_path: &str) -> Result<(), String> {
        match hkcu().delete_subkey_all(key_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("cannot delete HKCU\\{key_path}: {error}")),
        }
    }

    /// `REG_*` number back to a type. Types the handler keys never contain fall
    /// back to `REG_BINARY`, which keeps the bytes intact.
    fn reg_type(raw: u32) -> RegType {
        match raw {
            0 => RegType::REG_NONE,
            1 => RegType::REG_SZ,
            2 => RegType::REG_EXPAND_SZ,
            3 => RegType::REG_BINARY,
            4 => RegType::REG_DWORD,
            5 => RegType::REG_DWORD_BIG_ENDIAN,
            6 => RegType::REG_LINK,
            7 => RegType::REG_MULTI_SZ,
            8 => RegType::REG_RESOURCE_LIST,
            9 => RegType::REG_FULL_RESOURCE_DESCRIPTOR,
            10 => RegType::REG_RESOURCE_REQUIREMENTS_LIST,
            11 => RegType::REG_QWORD,
            _ => REG_BINARY,
        }
    }

    /// Writes the handler keys. Every `DefaultIcon` / `open\command` is a
    /// subkey whose default value holds the data, as Windows expects.
    pub fn register_keys(exe: &Path) -> Result<(), String> {
        register_keys_at(exe, MAGNET_KEY, TORRENT_PROGID_KEY, TORRENT_EXT_KEY)
    }

    /// Same as [`register_keys`], on the given keys: the tests point it at
    /// throwaway keys so the real handlers are never touched.
    pub fn register_keys_at(
        exe: &Path,
        magnet_key: &str,
        progid_key: &str,
        extension_key: &str,
    ) -> Result<(), String> {
        let command = open_command(exe);
        let icon = icon_value(exe);

        // `magnet:` protocol handler.
        let (magnet, _) = hkcu()
            .create_subkey(magnet_key)
            .map_err(|error| format!("cannot create HKCU\\{magnet_key}: {error}"))?;
        magnet
            .set_value("URL Protocol", &"")
            .map_err(|error| format!("cannot write URL Protocol: {error}"))?;
        let (magnet_icon, _) = magnet
            .create_subkey("DefaultIcon")
            .map_err(|error| format!("cannot create the magnet icon key: {error}"))?;
        magnet_icon
            .set_value("", &icon)
            .map_err(|error| format!("cannot write the magnet icon: {error}"))?;
        let (magnet_command, _) = magnet
            .create_subkey(r"shell\open\command")
            .map_err(|error| format!("cannot create the magnet command key: {error}"))?;
        magnet_command
            .set_value("", &command)
            .map_err(|error| format!("cannot write the magnet command: {error}"))?;

        // Document type of a `.torrent` file.
        let (progid, _) = hkcu()
            .create_subkey(progid_key)
            .map_err(|error| format!("cannot create HKCU\\{progid_key}: {error}"))?;
        progid
            .set_value("FriendlyTypeName", &FRIENDLY_NAME)
            .map_err(|error| format!("cannot write FriendlyTypeName: {error}"))?;
        let (progid_icon, _) = progid
            .create_subkey("DefaultIcon")
            .map_err(|error| format!("cannot create the torrent icon key: {error}"))?;
        progid_icon
            .set_value("", &icon)
            .map_err(|error| format!("cannot write the torrent icon: {error}"))?;
        let (progid_command, _) = progid
            .create_subkey(r"shell\open\command")
            .map_err(|error| format!("cannot create the torrent command key: {error}"))?;
        progid_command
            .set_value("", &command)
            .map_err(|error| format!("cannot write the torrent command: {error}"))?;

        // `.torrent` → our ProgID.
        let (extension, _) = hkcu()
            .create_subkey(extension_key)
            .map_err(|error| format!("cannot create HKCU\\{extension_key}: {error}"))?;
        extension
            .set_value("", &PROGID)
            .map_err(|error| format!("cannot write HKCU\\{extension_key}: {error}"))?;
        Ok(())
    }

    /// Whether `key_path\shell\open\command` is exactly the command of `exe`.
    pub fn is_registered(exe: &Path, key_path: &str) -> bool {
        let command_path = format!(r"{key_path}\shell\open\command");
        let Ok(key) = hkcu().open_subkey(&command_path) else {
            return false;
        };
        matches!(key.get_value::<String, _>(""), Ok(command) if command == open_command(exe))
    }
}

// -------------------------------------------------------- other platforms

#[cfg(not(windows))]
mod registry {
    use std::path::Path;

    use super::{KeySnapshot, NOT_SUPPORTED};

    pub fn snapshot(_key_path: &str) -> Result<Option<KeySnapshot>, String> {
        Err(NOT_SUPPORTED.to_string())
    }

    pub fn restore(_key_path: &str, _snapshot: &Option<KeySnapshot>) -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    pub fn register_keys(_exe: &Path) -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    pub fn is_registered(_exe: &Path, _key_path: &str) -> bool {
        false
    }
}

/// Shown by [`status`] where the handler keys do not exist.
pub const NOT_SUPPORTED: &str = "file associations are only supported on Windows";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_command_quotes_both_parts() {
        assert_eq!(
            open_command(Path::new(
                r"C:\Program Files\Brickman Torrent\brickman-desktop.exe"
            )),
            r#""C:\Program Files\Brickman Torrent\brickman-desktop.exe" "%1""#
        );
        assert_eq!(
            open_command(Path::new(r"C:\brickman-desktop.exe")),
            r#""C:\brickman-desktop.exe" "%1""#
        );
        assert_eq!(
            icon_value(Path::new(
                r"C:\Program Files\Brickman Torrent\brickman-desktop.exe"
            )),
            r#""C:\Program Files\Brickman Torrent\brickman-desktop.exe",0"#
        );
    }

    fn sample_backup() -> HandlerBackup {
        HandlerBackup {
            magnet: Some(KeySnapshot {
                values: vec![ValueSnapshot {
                    name: String::new(),
                    vtype: 1,
                    // UTF-16LE "qBittorrent\0".
                    bytes: vec![
                        0x71, 0x00, 0x42, 0x00, 0x69, 0x00, 0x74, 0x00, 0x74, 0x00, 0x6f, 0x00,
                        0x72, 0x00, 0x72, 0x00, 0x65, 0x00, 0x6e, 0x00, 0x74, 0x00, 0x00, 0x00,
                    ],
                }],
                subkeys: vec![SubkeySnapshot {
                    name: "shell".to_string(),
                    key: KeySnapshot {
                        values: Vec::new(),
                        subkeys: vec![SubkeySnapshot {
                            name: "open".to_string(),
                            key: KeySnapshot {
                                values: Vec::new(),
                                subkeys: vec![SubkeySnapshot {
                                    name: "command".to_string(),
                                    key: KeySnapshot {
                                        values: vec![ValueSnapshot {
                                            name: String::new(),
                                            vtype: 2,
                                            bytes: vec![0x25, 0x00, 0x31, 0x00, 0x00, 0x00],
                                        }],
                                        subkeys: Vec::new(),
                                    },
                                }],
                            },
                        }],
                    },
                }],
            }),
            torrent_progid: None,
            torrent_extension: Some(KeySnapshot {
                values: vec![ValueSnapshot {
                    name: String::new(),
                    vtype: 1,
                    bytes: vec![0x01, 0x00],
                }],
                subkeys: Vec::new(),
            }),
        }
    }

    #[test]
    fn backup_survives_json() {
        let backup = sample_backup();
        let json = serde_json::to_string(&backup).expect("encode");
        let parsed: HandlerBackup = serde_json::from_str(&json).expect("decode");
        assert_eq!(parsed, backup);
        // `None` (the key did not exist) must survive as `None`, not as empty.
        assert!(parsed.torrent_progid.is_none());
        assert!(json.contains("\"torrentProgid\":null"));
    }

    #[test]
    fn snapshots_compare_by_content() {
        let mut other = sample_backup();
        other.magnet.as_mut().expect("magnet").values[0].bytes[0] = 0x7a;
        assert_ne!(other, sample_backup());
        // A copy is equal; the order of the fields does not matter for `==`.
        assert_eq!(sample_backup(), sample_backup());
    }

    #[test]
    fn backup_file_round_trip() {
        let dir = std::env::temp_dir().join(format!("brickman-handler-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");

        assert!(!backup_present(&dir));
        assert_eq!(load_backup(&dir).expect("no backup"), None);

        let backup = sample_backup();
        save_backup(&dir, &backup).expect("save");
        assert!(backup_present(&dir));
        assert_eq!(load_backup(&dir).expect("load"), Some(backup));
        // No temporary file is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != BACKUP_FILE_NAME)
            .collect();
        assert!(leftovers.is_empty(), "leftovers: {leftovers:?}");

        remove_backup(&dir).expect("remove");
        assert!(!backup_present(&dir));
        // Removing twice is not an error.
        remove_backup(&dir).expect("remove twice");

        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn damaged_backup_is_reported() {
        let dir = std::env::temp_dir().join(format!("brickman-handler-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(backup_path(&dir), b"{not json").expect("write");
        let error = load_backup(&dir).expect_err("damaged backup must fail");
        assert!(error.contains("damaged"), "unexpected error: {error}");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    // ------------------------------------------------- Windows-only registry

    #[cfg(windows)]
    use winreg::RegKey;
    #[cfg(windows)]
    use winreg::enums::HKEY_CURRENT_USER;

    /// Test keys live under `Software\Classes\BrickmanTorrentTest…` and are
    /// removed even when an assertion fails, so the real handlers stay intact.
    #[cfg(windows)]
    struct TestKey(&'static str);

    #[cfg(windows)]
    impl TestKey {
        fn new(path: &'static str) -> Self {
            let root = RegKey::predef(HKEY_CURRENT_USER);
            let _ = root.delete_subkey_all(path);
            Self(path)
        }
    }

    #[cfg(windows)]
    impl Drop for TestKey {
        fn drop(&mut self) {
            let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(self.0);
        }
    }

    #[cfg(windows)]
    #[test]
    fn snapshot_restores_a_key_exactly() {
        let path = r"Software\Classes\BrickmanTorrentTest";
        let _guard = TestKey::new(path);
        let root = RegKey::predef(HKEY_CURRENT_USER);

        let (key, _) = root.create_subkey(path).expect("create test key");
        key.set_value("", &"default").expect("default value");
        key.set_value("Text", &"hello").expect("text value");
        key.set_value("Number", &42u32).expect("dword value");
        let (command, _) = key
            .create_subkey(r"shell\open\command")
            .expect("create subkey");
        command
            .set_value("", &open_command(Path::new(r"C:\app.exe")))
            .expect("command");

        let snapshot = registry::snapshot(path)
            .expect("snapshot")
            .expect("key exists");

        // Mangle everything the restore has to fix.
        key.set_value("Text", &"changed").expect("overwrite");
        key.delete_value("Number").expect("delete value");
        root.delete_subkey_all(r"Software\Classes\BrickmanTorrentTest\shell")
            .expect("delete subkey");

        registry::restore(path, &Some(snapshot.clone())).expect("restore");
        assert_eq!(registry::snapshot(path).expect("snapshot"), Some(snapshot));

        // "The key did not exist" restores to nothing.
        registry::restore(path, &None).expect("restore missing");
        assert_eq!(registry::snapshot(path).expect("snapshot"), None);
    }

    #[cfg(windows)]
    #[test]
    fn is_registered_compares_the_open_command() {
        let path = r"Software\Classes\BrickmanTorrentTestCommand";
        let _guard = TestKey::new(path);
        let exe = Path::new(r"C:\Program Files\Brickman Torrent\brickman-desktop.exe");

        assert!(!registry::is_registered(exe, path), "no key yet");

        let root = RegKey::predef(HKEY_CURRENT_USER);
        let (command, _) = root
            .create_subkey(format!(r"{path}\shell\open\command"))
            .expect("create command key");
        command.set_value("", &open_command(exe)).expect("command");

        assert!(registry::is_registered(exe, path));
        assert!(!registry::is_registered(Path::new(r"C:\other.exe"), path));
    }

    /// The real `register_keys` on throwaway keys: every value name and subkey
    /// the shell looks for is written where it belongs.
    #[cfg(windows)]
    #[test]
    fn register_writes_the_expected_structure() {
        let magnet = r"Software\Classes\BrickmanTorrentTestMagnet";
        let progid = r"Software\Classes\BrickmanTorrentTestProgid";
        let extension = r"Software\Classes\BrickmanTorrentTestExt";
        let _magnet_guard = TestKey::new(magnet);
        let _progid_guard = TestKey::new(progid);
        let _extension_guard = TestKey::new(extension);

        let exe = Path::new(r"C:\Program Files\Brickman Torrent\brickman-desktop.exe");
        registry::register_keys_at(exe, magnet, progid, extension).expect("register");

        let root = RegKey::predef(HKEY_CURRENT_USER);
        let magnet_key = root.open_subkey(magnet).expect("magnet key");
        assert_eq!(
            magnet_key
                .get_value::<String, _>("URL Protocol")
                .expect("URL Protocol"),
            ""
        );
        assert_eq!(
            magnet_key
                .open_subkey("DefaultIcon")
                .expect("magnet icon key")
                .get_value::<String, _>("")
                .expect("magnet icon"),
            icon_value(exe)
        );
        assert_eq!(
            magnet_key
                .open_subkey(r"shell\open\command")
                .expect("magnet command key")
                .get_value::<String, _>("")
                .expect("magnet command"),
            open_command(exe)
        );
        assert!(registry::is_registered(exe, magnet));

        let progid_key = root.open_subkey(progid).expect("progid key");
        assert_eq!(
            progid_key
                .get_value::<String, _>("FriendlyTypeName")
                .expect("FriendlyTypeName"),
            FRIENDLY_NAME
        );
        assert_eq!(
            progid_key
                .open_subkey("DefaultIcon")
                .expect("torrent icon key")
                .get_value::<String, _>("")
                .expect("torrent icon"),
            icon_value(exe)
        );
        assert_eq!(
            progid_key
                .open_subkey(r"shell\open\command")
                .expect("torrent command key")
                .get_value::<String, _>("")
                .expect("torrent command"),
            open_command(exe)
        );

        let extension_key = root.open_subkey(extension).expect("extension key");
        assert_eq!(
            extension_key
                .get_value::<String, _>("")
                .expect("default value"),
            PROGID
        );
    }
}
