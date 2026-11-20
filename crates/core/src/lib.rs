//! `brickman-core` — Brickman Torrent engine and download queue.
//!
//! The crate wraps [librqbit] and adds what a desktop torrent client needs on
//! top of a bare engine:
//!
//! * a queue that is a list: the order is the priority, with "maximum active
//!   downloads" and a real `Queued` state distinct from a user pause,
//! * persistence of the queue (order, pause flags, limits) next to the
//!   engine's own fastresume data,
//! * validation of torrent file paths before anything is written to disk
//!   (defence against CWE-22 path traversal),
//! * a synchronous API suitable for one-shot CLI commands.
//!
//! Legal note: this crate contains no search, no catalogue and no tracker
//! lists. It only downloads torrents the user explicitly adds.

#![warn(missing_debug_implementations)]

mod downloader;
mod error;
mod model;
mod paths;
mod scheduler;
mod state;

pub use downloader::{
    AddOptions, DEFAULT_METADATA_TIMEOUT, Downloader, DownloaderOptions, OutputDirChange,
    TorrentPreview,
};
pub use error::Error;
pub use model::{
    FileView, PeerView, SessionView, Source, TorrentId, TorrentState, TorrentView, TrackerView,
};
pub use paths::{
    validate_component, validate_output_dir, validate_relative_path, validate_torrent_files,
};
pub use scheduler::{QueueItem, QueuePlan, plan, sort_for_queue};
pub use state::{
    DEFAULT_MAX_ACTIVE, Limits, STATE_VERSION, State, TorrentEntry, default_data_dir,
    default_download_dir, now_ms,
};

/// Convenience alias for results produced by this crate.
pub type Result<T> = std::result::Result<T, Error>;
