//! Queue state that must survive process restarts.
//!
//! The engine (librqbit) persists the torrent list itself (`.torrent` bytes,
//! bitfields, output folders, paused flag). What it does not have is the
//! user's queue: numeric priorities, "paused by user" vs "waiting for a slot",
//! the active limit and the bandwidth limits. Those live here, in
//! `<data-dir>/state.json`, written atomically (temp file + rename).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::error::Error;

/// Current on-disk format version.
pub const STATE_VERSION: u32 = 1;

/// Default number of simultaneously running downloads.
pub const DEFAULT_MAX_ACTIVE: u32 = 3;

/// Bandwidth limits; `None` means unlimited.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limits {
    /// Download limit in bytes per second.
    #[serde(default)]
    pub down_bps: Option<u64>,
    /// Upload limit in bytes per second.
    #[serde(default)]
    pub up_bps: Option<u64>,
}

/// Persisted per-torrent queue data.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TorrentEntry {
    /// Queue priority, `1` is the highest.
    #[serde(default)]
    pub priority: u32,
    /// Paused by the user (as opposed to parked by the queue).
    #[serde(default)]
    pub user_paused: bool,
    /// Where the torrent came from, for diagnostics only.
    #[serde(default)]
    pub source: String,
    /// When the torrent was added, Unix time in milliseconds (`0` = unknown).
    #[serde(default)]
    pub added_at_ms: u64,
}

fn default_version() -> u32 {
    STATE_VERSION
}

fn default_max_active() -> u32 {
    DEFAULT_MAX_ACTIVE
}

/// The whole persisted state document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    /// Format version.
    #[serde(default = "default_version")]
    pub version: u32,
    /// Maximum number of concurrently downloading torrents, `0` = unlimited.
    #[serde(default = "default_max_active")]
    pub max_active: u32,
    /// Global bandwidth limits.
    #[serde(default)]
    pub limits: Limits,
    /// Per torrent data, keyed by engine id.
    #[serde(default)]
    pub torrents: BTreeMap<u32, TorrentEntry>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            max_active: DEFAULT_MAX_ACTIVE,
            limits: Limits::default(),
            torrents: BTreeMap::new(),
        }
    }
}

impl State {
    /// Loads the state file; a missing file yields the default state.
    pub fn load(path: &Path) -> Result<Self, Error> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| {
                Error::State(format!("cannot parse {}: {e}", path.display()))
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(e) => Err(Error::State(format!("cannot read {}: {e}", path.display()))),
        }
    }

    /// Writes the state file atomically (temp file + rename).
    pub fn save(&self, path: &Path) -> Result<(), Error> {
        let text = serde_json::to_vec_pretty(self)
            .map_err(|e| Error::State(format!("cannot serialize state: {e}")))?;
        atomic_write(path, &text)?;
        Ok(())
    }

    /// Priority for a newly added torrent: last in the queue.
    pub fn next_priority(&self) -> u32 {
        self.torrents
            .values()
            .map(|e| e.priority)
            .max()
            .unwrap_or(0)
            .saturating_add(1)
    }

    /// Per torrent entry, if known.
    pub fn entry(&self, id: u32) -> Option<&TorrentEntry> {
        self.torrents.get(&id)
    }

    /// Returns the entry for `id`, creating it with the next priority.
    pub fn entry_or_insert(&mut self, id: u32, source: String) -> &mut TorrentEntry {
        let priority = self.next_priority();
        let added_at_ms = now_ms();
        self.torrents.entry(id).or_insert(TorrentEntry {
            priority,
            user_paused: false,
            source,
            added_at_ms,
        })
    }
}

/// Current Unix time in milliseconds (`0` if the system clock is before 1970).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Atomically replaces `path` with `contents`.
///
/// The temporary file name is unique per call: concurrent writers (the UI fires
/// several engine commands in parallel) must not rename each other's temp file,
/// which would fail with "file not found" on Windows.
pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), Error> {
    use std::io::Write;

    static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::State(format!("invalid state path {}", path.display())))?;
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = path.with_file_name(format!(
        "{file_name}.{}.{seq}.tmp",
        std::process::id()
    ));

    let write = || -> Result<(), Error> {
        let mut file = std::fs::File::create(&tmp_path)?;
        file.write_all(contents)?;
        file.sync_all()?;
        Ok(())
    };
    if let Err(error) = write() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(error);
    }

    // `std::fs::rename` replaces an existing file on both Windows and Unix.
    if let Err(error) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(Error::Io(error));
    }
    Ok(())
}

/// Per-user data folder: `%APPDATA%\BrickmanTorrent` on Windows,
/// `$XDG_DATA_HOME/BrickmanTorrent` (or `~/.local/share/BrickmanTorrent`)
/// elsewhere. `TC_DATA_DIR` overrides it.
pub fn default_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("TC_DATA_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("BrickmanTorrent");
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(data).join("BrickmanTorrent");
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".local/share/BrickmanTorrent");
        }
    }
    PathBuf::from(".brickman-torrent")
}

/// Default download folder: `%USERPROFILE%\Downloads` on Windows,
/// `$HOME/Downloads` elsewhere. `TC_DOWNLOAD_DIR` overrides it.
pub fn default_download_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("TC_DOWNLOAD_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(profile).join("Downloads");
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Downloads");
        }
    }
    PathBuf::from(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tccore-state-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn missing_file_yields_defaults() {
        let dir = temp_dir("missing");
        let path = dir.join("state.json");
        let state = State::load(&path).expect("load");
        assert_eq!(state, State::default());
        assert_eq!(state.max_active, DEFAULT_MAX_ACTIVE);
        assert!(state.torrents.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn priority_and_pause_flag_round_trip() {
        let dir = temp_dir("round-trip");
        let path = dir.join("state.json");

        let mut state = State {
            max_active: 2,
            ..State::default()
        };
        state.limits.down_bps = Some(1024 * 1024);
        state.entry_or_insert(0, "magnet:?xt=urn:btih:00".to_string());
        state.entry_or_insert(1, "a.torrent".to_string());
        state.torrents.get_mut(&1).expect("entry").priority = 5;
        state.torrents.get_mut(&1).expect("entry").user_paused = true;
        state.save(&path).expect("save");

        let loaded = State::load(&path).expect("load");
        assert_eq!(loaded, state);
        assert_eq!(loaded.entry(1).map(|e| e.priority), Some(5));
        assert!(loaded.entry(1).is_some_and(|e| e.user_paused));
        assert_eq!(loaded.next_priority(), 6);

        // No temp file is left behind.
        assert!(!dir.join("state.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_replaces_previous_content() {
        let dir = temp_dir("replace");
        let path = dir.join("state.json");

        let first = State {
            max_active: 1,
            ..State::default()
        };
        first.save(&path).expect("save 1");

        let second = State {
            max_active: 7,
            ..State::default()
        };
        second.save(&path).expect("save 2");

        assert_eq!(State::load(&path).expect("load").max_active, 7);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_reported() {
        let dir = temp_dir("corrupt");
        let path = dir.join("state.json");
        std::fs::write(&path, b"{not json").expect("write");
        assert!(matches!(State::load(&path), Err(Error::State(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writes_do_not_collide() {
        let dir = temp_dir("concurrent");
        let path = dir.join("state.json");
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let state = State {
                        max_active: index,
                        ..State::default()
                    };
                    // Every writer must succeed: a shared temp file used to
                    // fail with "file not found" when two writers raced.
                    state.save(&path).expect("concurrent save");
                })
            })
            .collect();
        for thread in threads {
            thread.join().expect("join");
        }

        let loaded = State::load(&path).expect("load");
        assert!(loaded.max_active < 8);
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
