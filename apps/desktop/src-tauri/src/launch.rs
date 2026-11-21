//! What the app was started with: a `magnet:` link or a `.torrent` file.
//!
//! Windows hands both cases over as a bare command-line argument (the
//! `magnet:` protocol handler and the `.torrent` file association run
//! `"app.exe" "%1"`), so the arguments of the first launch and of a second
//! launch are parsed the same way here.
//!
//! Everything in this module is pure: [`parse_launch_args`] does not touch the
//! disk, and the existence of a `.torrent` file is a separate question
//! ([`is_existing_torrent`]) so the UI can tell "open this file" from "the link
//! points at a file that is gone".

use std::path::{Path, PathBuf};

use serde::Serialize;

/// `magnet:` links are compared case-insensitively (`MAGNET:` is the same
/// scheme) and are normalized to this spelling.
const MAGNET_SCHEME: &str = "magnet:";
/// Extension of a torrent file, compared case-insensitively.
const TORRENT_EXTENSION: &str = "torrent";

/// A link or a file the app was asked to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchTarget {
    /// A `.torrent` file. The path may be missing; see [`is_existing_torrent`].
    Torrent(PathBuf),
    /// A magnet link, normalized to a lowercase `magnet:` scheme.
    Magnet(String),
}

impl LaunchTarget {
    /// `"magnet"` or `"torrent"`: the `kind` of the `link-received` event.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Torrent(_) => "torrent",
            Self::Magnet(_) => "magnet",
        }
    }
}

/// Payload of the `link-received` event the window receives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPayload {
    /// `"magnet"` or `"torrent"`.
    pub kind: &'static str,
    /// The magnet link or the path of the `.torrent` file.
    pub value: String,
    /// For a `.torrent` file: whether the path exists right now. A missing file
    /// is still reported (the UI shows an error instead of silently doing
    /// nothing); a magnet link is always `true`.
    pub exists: bool,
}

impl LinkPayload {
    pub fn new(target: &LaunchTarget) -> Self {
        match target {
            LaunchTarget::Torrent(path) => Self {
                kind: target.kind(),
                value: path.to_string_lossy().into_owned(),
                exists: is_existing_torrent(path),
            },
            LaunchTarget::Magnet(uri) => Self {
                kind: target.kind(),
                value: uri.clone(),
                exists: true,
            },
        }
    }
}

/// First argument that is a magnet link or a `.torrent` file.
///
/// Flags (`--minimized`, `-x`), empty arguments and everything else are
/// skipped, so a launcher may pass extra arguments. Pass the program arguments
/// without the executable name (`std::env::args().skip(1)`).
pub fn parse_launch_args<I>(args: I) -> Option<LaunchTarget>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter().find_map(|arg| parse_arg(&arg))
}

fn parse_arg(arg: &str) -> Option<LaunchTarget> {
    let arg = arg.trim();
    if arg.is_empty() || arg.starts_with('-') {
        return None;
    }
    if let Some(rest) = strip_magnet_scheme(arg) {
        // `magnet:` alone is not a link; there is nothing to download.
        if rest.is_empty() {
            return None;
        }
        // The scheme is case-insensitive but the engine (and every other
        // client) expects the lowercase spelling; the rest is kept as it is.
        return Some(LaunchTarget::Magnet(format!("{MAGNET_SCHEME}{rest}")));
    }
    let path = PathBuf::from(arg);
    has_torrent_extension(&path).then_some(LaunchTarget::Torrent(path))
}

/// `magnet:?xt=…` → `Some("?xt=…")`, `MAGNET:?xt=…` → `Some("?xt=…")`.
fn strip_magnet_scheme(arg: &str) -> Option<&str> {
    let (scheme, rest) = arg.split_at_checked(MAGNET_SCHEME.len())?;
    scheme.eq_ignore_ascii_case(MAGNET_SCHEME).then_some(rest)
}

fn has_torrent_extension(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case(TORRENT_EXTENSION))
}

/// Whether the path is an existing `.torrent` file. A `.torrent` path that does
/// not exist is still a valid [`LaunchTarget`]: the UI reports it instead of
/// pretending the launch was empty.
pub fn is_existing_torrent(path: &Path) -> bool {
    has_torrent_extension(path) && path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Option<LaunchTarget> {
        parse_launch_args(args.iter().map(|arg| (*arg).to_string()))
    }

    fn magnet(uri: &str) -> Option<LaunchTarget> {
        Some(LaunchTarget::Magnet(uri.to_string()))
    }

    fn torrent(path: &str) -> Option<LaunchTarget> {
        Some(LaunchTarget::Torrent(PathBuf::from(path)))
    }

    #[test]
    fn magnet_with_parameters() {
        let uri = "magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a\
                   &dn=Arch+Linux+2024.10.01&tr=udp%3A%2F%2Ftracker.example%3A6969";
        assert_eq!(parse(&[uri]), magnet(uri));
    }

    #[test]
    fn magnet_scheme_is_case_insensitive() {
        assert_eq!(
            parse(&["MAGNET:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a"]),
            magnet("magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a")
        );
        // The parameters keep their case; only the scheme is normalized.
        assert_eq!(
            parse(&["Magnet:?xt=urn:btih:ABC&dn=Mixed+Case"]),
            magnet("magnet:?xt=urn:btih:ABC&dn=Mixed+Case")
        );
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        assert_eq!(
            parse(&["  magnet:?xt=urn:btih:abc  "]),
            magnet("magnet:?xt=urn:btih:abc")
        );
        assert_eq!(
            parse(&["\tC:\\Downloads\\a.torrent\r\n"]),
            torrent("C:\\Downloads\\a.torrent")
        );
    }

    #[test]
    fn torrent_extension_is_case_insensitive() {
        assert_eq!(
            parse(&["C:\\Downloads\\Ubuntu.TORRENT"]),
            torrent("C:\\Downloads\\Ubuntu.TORRENT")
        );
    }

    #[test]
    fn torrent_path_with_spaces_and_cyrillic() {
        let path = r"C:\Загрузки\Мои файлы\Linux Mint 22.torrent";
        assert_eq!(parse(&[path]), torrent(path));
    }

    #[test]
    fn flags_and_empty_arguments_are_skipped() {
        assert_eq!(
            parse(&["--minimized", "-x", "", "   ", "magnet:?xt=urn:btih:abc"]),
            magnet("magnet:?xt=urn:btih:abc")
        );
        assert_eq!(parse(&["--minimized", "-x"]), None);
    }

    #[test]
    fn empty_list_has_no_target() {
        assert_eq!(parse(&[]), None);
    }

    #[test]
    fn garbage_is_ignored() {
        assert_eq!(
            parse(&["hello world", "notes.txt", "https://example.com/a.html"]),
            None
        );
        // `magnet:` without a payload is not a link.
        assert_eq!(parse(&["magnet:"]), None);
        assert_eq!(parse(&["MAGNET:"]), None);
    }

    #[test]
    fn first_valid_argument_wins() {
        assert_eq!(
            parse(&["--flag", r"C:\a\b.torrent", "magnet:?xt=urn:btih:abc"]),
            torrent(r"C:\a\b.torrent")
        );
        assert_eq!(
            parse(&["--flag", "magnet:?xt=urn:btih:abc", r"C:\a\b.torrent"]),
            magnet("magnet:?xt=urn:btih:abc")
        );
    }

    #[test]
    fn missing_torrent_is_still_a_target() {
        let path = r"C:\no such folder\missing.torrent";
        let target = parse(&[path]).expect("a .torrent path is a target");
        assert_eq!(target, LaunchTarget::Torrent(PathBuf::from(path)));
        assert!(!is_existing_torrent(Path::new(path)));
        let payload = LinkPayload::new(&target);
        assert_eq!(payload.kind, "torrent");
        assert_eq!(payload.value, path);
        assert!(!payload.exists);
    }

    #[test]
    fn existing_torrent_is_detected() {
        let dir = std::env::temp_dir().join(format!("brickman-launch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("Sample Torrent.torrent");
        std::fs::write(&file, b"d4:infod4:name4:testee").expect("temp file");

        assert!(is_existing_torrent(&file));
        // A directory with a .torrent name is not a torrent file.
        let folder = dir.join("folder.torrent");
        std::fs::create_dir_all(&folder).expect("temp folder");
        assert!(!is_existing_torrent(&folder));
        // A file with another extension is not a torrent either.
        let other = dir.join("notes.txt");
        std::fs::write(&other, b"x").expect("temp file");
        assert!(!is_existing_torrent(&other));

        let payload = LinkPayload::new(&LaunchTarget::Torrent(file.clone()));
        assert!(payload.exists);
        assert_eq!(payload.kind, "torrent");

        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn payload_has_the_event_shape() {
        let payload =
            LinkPayload::new(&LaunchTarget::Magnet("magnet:?xt=urn:btih:abc".to_string()));
        let json = serde_json::to_string(&payload).expect("encode");
        assert_eq!(
            json,
            r#"{"kind":"magnet","value":"magnet:?xt=urn:btih:abc","exists":true}"#
        );
    }
}
