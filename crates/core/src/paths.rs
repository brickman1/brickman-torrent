//! Torrent path validation (CWE-22 defence).
//!
//! Torrent metadata is attacker controlled: a hostile `.torrent` file or magnet
//! link can contain absolute paths, `..` components, drive prefixes or Windows
//! device names. Every file of a torrent is validated before the torrent is
//! handed to the engine, and the torrent is refused if anything looks unsafe.

use crate::error::Error;

/// Characters that Windows cannot store in a file name.
const FORBIDDEN_CHARS: [char; 7] = ['<', '>', ':', '"', '|', '?', '*'];

/// Reserved DOS device names; they are invalid even with an extension.
const RESERVED_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Maximum length of a single path component.
const MAX_COMPONENT_LEN: usize = 255;

fn unsafe_path(path: impl Into<String>, reason: impl Into<String>) -> Error {
    Error::UnsafePath {
        path: path.into(),
        reason: reason.into(),
    }
}

fn is_reserved_name(component: &str) -> bool {
    // Windows ignores trailing dots and spaces when resolving a name, and a
    // device name stays reserved when it carries an extension ("con.txt").
    let trimmed = component.trim_end_matches([' ', '.']);
    let stem = trimmed.split('.').next().unwrap_or(trimmed);
    RESERVED_NAMES.iter().any(|r| stem.eq_ignore_ascii_case(r))
}

/// Validates a single path component (one file or directory name).
pub fn validate_component(component: &str) -> Result<(), Error> {
    if component.is_empty() {
        return Err(unsafe_path("", "empty path component"));
    }
    if component == "." || component == ".." {
        return Err(unsafe_path(component, "path traversal"));
    }
    if component.len() > MAX_COMPONENT_LEN {
        return Err(unsafe_path(component, "path component is too long"));
    }
    if component
        .chars()
        .any(|c| c.is_control() || c == '\0')
    {
        return Err(unsafe_path(
            component,
            "control character in path component",
        ));
    }
    if component.contains('/') || component.contains('\\') {
        return Err(unsafe_path(
            component,
            "path separator inside a single component",
        ));
    }
    if let Some(bad) = component.chars().find(|c| FORBIDDEN_CHARS.contains(c)) {
        return Err(unsafe_path(
            component,
            format!("character {bad:?} is not allowed on Windows"),
        ));
    }
    if component.ends_with(' ') || component.ends_with('.') {
        return Err(unsafe_path(
            component,
            "path component ends with a space or a dot",
        ));
    }
    if is_reserved_name(component) {
        return Err(unsafe_path(
            component,
            "reserved Windows device name",
        ));
    }
    Ok(())
}

/// Validates a path that must stay inside the download folder.
///
/// Accepts both `/` and `\` as separators so that malformed torrents cannot
/// smuggle traversal sequences past the check.
pub fn validate_relative_path(path: &str) -> Result<(), Error> {
    if path.is_empty() {
        return Err(unsafe_path(path, "empty path"));
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err(unsafe_path(path, "absolute path"));
    }
    if path.as_bytes().get(1) == Some(&b':') {
        return Err(unsafe_path(path, "path with a drive prefix"));
    }
    for component in path.split(['/', '\\']) {
        validate_component(component)?;
    }
    Ok(())
}

/// Validates the whole file list of a torrent before it is started.
///
/// `name` is the torrent name (`info.name`), `files` are the per-file path
/// components as they appear in the metadata. On success every file is
/// guaranteed to be written below the torrent's output folder.
pub fn validate_torrent_files(name: Option<&str>, files: &[Vec<String>]) -> Result<(), Error> {
    if let Some(name) = name {
        validate_component(name)?;
    }
    if files.is_empty() {
        return Err(unsafe_path("", "torrent contains no files"));
    }
    for components in files {
        if components.is_empty() {
            return Err(unsafe_path("", "file without a name"));
        }
        for component in components {
            validate_component(component)?;
        }
        // Defence in depth: the joined path must not contain anything but
        // normal components.
        let joined = components.join("/");
        validate_relative_path(&joined)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(paths: &[&str]) -> Vec<Vec<String>> {
        paths
            .iter()
            .map(|p| p.split('/').map(|s| s.to_string()).collect())
            .collect()
    }

    #[test]
    fn accepts_normal_names() {
        assert!(validate_relative_path("ubuntu-24.04.iso").is_ok());
        assert!(validate_relative_path("dir/sub/file.bin").is_ok());
        assert!(validate_torrent_files(Some("ubuntu"), &files(&["ubuntu/a.iso", "ubuntu/b.iso"])).is_ok());
    }

    #[test]
    fn rejects_parent_directory() {
        assert!(matches!(
            validate_relative_path(".."),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path("../etc/passwd"),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path("a\\..\\b"),
            Err(Error::UnsafePath { .. })
        ));
    }

    #[test]
    fn rejects_nested_traversal() {
        assert!(matches!(
            validate_relative_path("a/../../b"),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_torrent_files(Some("t"), &files(&["a/../../b"])),
            Err(Error::UnsafePath { .. })
        ));
    }

    #[test]
    fn rejects_absolute_and_drive_paths() {
        assert!(matches!(
            validate_relative_path("C:\\Windows\\System32\\evil.dll"),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path("C:/Windows/evil.dll"),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path("/etc/passwd"),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path("\\\\server\\share\\evil"),
            Err(Error::UnsafePath { .. })
        ));
    }

    #[test]
    fn rejects_reserved_device_names() {
        assert!(matches!(
            validate_relative_path("con"),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path("CON.txt"),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path("dir/Lpt1.log"),
            Err(Error::UnsafePath { .. })
        ));
    }

    #[test]
    fn rejects_empty_name() {
        assert!(matches!(
            validate_torrent_files(Some(""), &files(&["file.bin"])),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path(""),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_torrent_files(Some("t"), &[]),
            Err(Error::UnsafePath { .. })
        ));
    }

    #[test]
    fn rejects_forbidden_characters() {
        assert!(matches!(
            validate_relative_path("a:b"),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path("a?b"),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path("nul\u{0}byte"),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path("trailing."),
            Err(Error::UnsafePath { .. })
        ));
        assert!(matches!(
            validate_relative_path("a//b"),
            Err(Error::UnsafePath { .. })
        ));
    }

    #[test]
    fn rejects_component_with_separator() {
        let nested = vec![vec!["a/b".to_string()]];
        assert!(matches!(
            validate_torrent_files(None, &nested),
            Err(Error::UnsafePath { .. })
        ));
    }
}
