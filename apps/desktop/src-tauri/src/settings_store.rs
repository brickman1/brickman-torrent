//! UI settings kept in `<data-dir>/settings.json`.
//!
//! The document belongs to the frontend: the backend never looks at a field,
//! it hands the whole value back and forth, so the UI can add a setting without
//! a backend change. A write goes through `settings.json.tmp` and a rename, so
//! a crash in the middle never leaves a half-written file behind.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Name of the settings file inside the data folder.
pub const SETTINGS_FILE: &str = "settings.json";

/// Path of the settings file inside `data_dir`.
pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_FILE)
}

/// Reads the settings. `None` means the file does not exist yet: a fresh
/// install starts with the defaults of the frontend.
pub fn load(data_dir: &Path) -> Result<Option<Value>, String> {
    let path = settings_path(data_dir);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let settings = serde_json::from_slice(&bytes)
        .map_err(|error| format!("cannot parse {}: {error}", path.display()))?;
    Ok(Some(settings))
}

/// Replaces the whole settings document. `std::fs::rename` puts the temporary
/// file in place in one step on both Windows and Unix, so a reader never sees a
/// partial document.
pub fn save(data_dir: &Path, settings: &Value) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|error| format!("cannot create {}: {error}", data_dir.display()))?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("cannot encode the settings: {error}"))?;
    let path = settings_path(data_dir);
    let tmp_path = path.with_extension("json.tmp");
    if let Err(error) = std::fs::write(&tmp_path, &bytes) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("cannot write {}: {error}", tmp_path.display()));
    }
    if let Err(error) = std::fs::rename(&tmp_path, &path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("cannot replace {}: {error}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "brickman-desktop-settings-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn settings_survive_a_round_trip() {
        let dir = temp_dir("roundtrip");
        assert_eq!(load(&dir).expect("load"), None, "a missing file is not an error");

        let settings = serde_json::json!({
            "closeToTray": true,
            "language": "ru",
            "limits": { "download": 0, "upload": 128 },
        });
        save(&dir, &settings).expect("save");
        assert_eq!(load(&dir).expect("load"), Some(settings));

        // The next save replaces the document as a whole.
        let changed = serde_json::json!({ "closeToTray": false });
        save(&dir, &changed).expect("save");
        assert_eq!(load(&dir).expect("load"), Some(changed));

        // The temporary file of the atomic write is gone.
        assert!(!settings_path(&dir).with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_settings_file_is_an_error() {
        let dir = temp_dir("broken");
        std::fs::create_dir_all(&dir).expect("create dir");
        std::fs::write(settings_path(&dir), b"{ not json").expect("write");
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
