//! Error type for the Brickman Torrent core.

use crate::TorrentId;

/// Errors returned by [`crate::Downloader`].
///
/// The library never panics on engine or input errors; everything is reported
/// through this type.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Local filesystem error (state file, torrent file, directories).
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),

    /// Error reported by the torrent engine (librqbit).
    #[error("engine error: {0}")]
    Engine(String),

    /// The torrent metadata describes a file path that would escape the
    /// download folder (CWE-22 path traversal).
    #[error("unsafe path in torrent metadata: {path:?} ({reason})")]
    UnsafePath {
        /// Offending path or path component.
        path: String,
        /// Human readable reason for the rejection.
        reason: String,
    },

    /// The requested torrent id is not managed by this client.
    #[error("torrent {0} not found")]
    NotFound(TorrentId),

    /// Magnet link did not produce metadata in time.
    #[error("metadata not received within {0} s")]
    MetadataTimeout(u64),

    /// The persisted state file could not be read or is not valid.
    #[error("state file error: {0}")]
    State(String),

    /// Command line / API argument is not valid.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
}

impl Error {
    /// Wraps an engine error.
    pub fn engine(e: impl std::fmt::Display) -> Self {
        Error::Engine(e.to_string())
    }

    /// Wraps a state file error.
    pub fn state(e: impl std::fmt::Display) -> Self {
        Error::State(e.to_string())
    }
}

impl From<anyhow::Error> for Error {
    fn from(value: anyhow::Error) -> Self {
        Error::Engine(format!("{value:#}"))
    }
}
