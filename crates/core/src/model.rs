//! Public data types of the torrent-client core.

use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;

use crate::error::Error;

/// Identifier of a torrent inside a [`crate::Downloader`].
///
/// Ids are assigned by the engine, survive restarts and are stable for the
/// lifetime of the torrent entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TorrentId(pub u32);

impl TorrentId {
    /// Converts the id to the engine's native `usize`.
    pub fn as_usize(self) -> usize {
        self.0 as usize
    }
}

impl fmt::Display for TorrentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for TorrentId {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let raw = s.trim();
        let value: u32 = raw
            .parse()
            .map_err(|_| Error::InvalidArgument(format!("invalid torrent id {raw:?}")))?;
        Ok(TorrentId(value))
    }
}

/// Where a new torrent comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A local `.torrent` file.
    TorrentFile(PathBuf),
    /// A `magnet:` link.
    Magnet(String),
}

impl Source {
    /// Recognises `magnet:` links, everything else is treated as a file path.
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(Error::InvalidArgument("empty source".to_string()));
        }
        if trimmed.starts_with("magnet:") {
            return Ok(Source::Magnet(trimmed.to_string()));
        }
        Ok(Source::TorrentFile(PathBuf::from(trimmed)))
    }

    /// Short human readable description, stored in the state file.
    pub fn describe(&self) -> String {
        match self {
            Source::TorrentFile(path) => path.display().to_string(),
            Source::Magnet(url) => {
                // Do not store unbounded URLs in the state file.
                if url.len() > 200 {
                    format!("{}…", &url[..200])
                } else {
                    url.clone()
                }
            }
        }
    }
}

/// State of a torrent as shown to the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TorrentState {
    /// Metadata (file list) has not been received yet.
    FetchingMetadata,
    /// Files are being verified against the piece hashes.
    Checking,
    /// Downloading pieces.
    Downloading,
    /// Download finished, uploading to peers.
    Seeding,
    /// Download finished, not running.
    Done,
    /// Waiting for a free queue slot; not paused by the user.
    Queued,
    /// Explicitly paused by the user.
    Paused,
    /// The engine reported an error for this torrent.
    Error,
}

impl TorrentState {
    /// Lowercase name used by the CLI and (later) the UI.
    pub fn as_str(self) -> &'static str {
        match self {
            TorrentState::FetchingMetadata => "fetching-metadata",
            TorrentState::Checking => "checking",
            TorrentState::Downloading => "downloading",
            TorrentState::Seeding => "seeding",
            TorrentState::Done => "done",
            TorrentState::Queued => "queued",
            TorrentState::Paused => "paused",
            TorrentState::Error => "error",
        }
    }
}

impl fmt::Display for TorrentState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Snapshot of a single torrent, as returned by [`crate::Downloader::list`].
#[derive(Debug, Clone)]
pub struct TorrentView {
    /// Engine id.
    pub id: TorrentId,
    /// Display name (torrent name or magnet display name).
    pub name: String,
    /// Total size of the selected files.
    pub total_bytes: u64,
    /// Progress in `0.0..=1.0`.
    pub progress: f64,
    /// Current state.
    pub state: TorrentState,
    /// Current download rate, bytes per second.
    pub down_bps: u64,
    /// Current upload rate, bytes per second.
    pub up_bps: u64,
    /// Number of connected peers.
    pub peers: u32,
    /// Number of connected peers that are seeds.
    pub seeds: u32,
    /// Queue priority, `1` is the highest.
    pub priority: u32,
    /// Folder the torrent's files are written to.
    pub save_path: PathBuf,
}
