//! The downloader: a synchronous facade over a private tokio runtime running
//! the librqbit engine, plus the persistent download queue.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use librqbit::api::TorrentIdOrHash;
use librqbit::limits::LimitsConfig;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, ListenerMode,
    ListenerOptions, ManagedTorrent, Session, SessionOptions, SessionPersistenceConfig,
    TorrentStatsState,
};
use url::Url;

use crate::error::Error;
use crate::model::{
    FileView, PeerView, SessionView, Source, TorrentId, TorrentState, TorrentView, TrackerView,
};
use crate::paths;
use crate::scheduler::{self, QueueItem};
use crate::state::State;

/// How long to wait for magnet metadata by default.
pub const DEFAULT_METADATA_TIMEOUT: Duration = Duration::from_secs(60);

/// Default number of concurrently connected peers per torrent.
pub const DEFAULT_PEER_LIMIT: u32 = 200;

/// Smallest per-torrent peer limit this crate accepts (`0` means "no limit").
pub const MIN_PEER_LIMIT: u32 = 1;

/// Largest per-torrent peer limit; more peers than this only costs memory.
pub const MAX_PEER_LIMIT: u32 = 1000;

/// How many extra trackers are kept; the rest of the input is dropped.
pub const MAX_EXTRA_TRACKERS: usize = 50;

/// Network options that decide how many peers a download can reach.
///
/// The per-add options ([`ConnectionOptions::peer_limit`] and the trackers) are
/// applied to every torrent added from now on. The listener options (UPnP and
/// uTP) are decided when the session starts: librqbit builds the listener once
/// and exposes no API to re-open it, so changing them needs a new process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionOptions {
    /// Ask the router to forward the listening port over UPnP (TCP).
    pub upnp_port_forwarding: bool,
    /// Listen for incoming uTP (UDP) connections next to TCP.
    pub utp_enabled: bool,
    /// Concurrent peers per torrent; `None`/`Some(0)` = no limit.
    pub peer_limit: Option<u32>,
    /// Trackers added to every torrent, one URL per entry (lines are split).
    pub extra_trackers: Vec<String>,
}

impl Default for ConnectionOptions {
    fn default() -> Self {
        Self {
            // Both are safe defaults: a closed port is the only thing they can
            // cost, and without them a NAT'ed machine has few incoming peers.
            upnp_port_forwarding: true,
            utp_enabled: true,
            peer_limit: Some(DEFAULT_PEER_LIMIT),
            extra_trackers: Vec::new(),
        }
    }
}

impl ConnectionOptions {
    /// A copy with validated trackers and a clamped peer limit.
    ///
    /// Junk in the tracker list is dropped instead of failing the whole
    /// setting: one broken line must not stop the user from saving.
    pub fn normalized(&self) -> Self {
        Self {
            upnp_port_forwarding: self.upnp_port_forwarding,
            utp_enabled: self.utp_enabled,
            peer_limit: normalize_peer_limit(self.peer_limit),
            extra_trackers: derived_trackers(&self.extra_trackers),
        }
    }
}

/// What [`Downloader::set_connection_options`] did and what it could not do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectionChange {
    /// The listener (UPnP / uTP) differs from the running one: restart needed.
    pub restart_required: bool,
    /// Peer limit applied to torrents added from now on (`None` = no limit).
    pub peer_limit: Option<u32>,
    /// Number of valid, de-duplicated extra trackers that are now in effect.
    pub trackers: usize,
}

/// Options for [`Downloader::new`].
#[derive(Debug, Clone)]
pub struct DownloaderOptions {
    /// Folder for the state file and engine persistence.
    pub data_dir: PathBuf,
    /// Default download folder.
    pub download_dir: PathBuf,
    /// Enable DHT, LSD and the incoming TCP listener. Only commands that
    /// actually need the network (`add`, `run`) should turn this on.
    pub networking: bool,
    /// UPnP, uTP, peer limit and extra trackers.
    pub connections: ConnectionOptions,
}

impl DownloaderOptions {
    /// Options with networking enabled.
    pub fn new(data_dir: PathBuf, download_dir: PathBuf) -> Self {
        Self {
            data_dir,
            download_dir,
            networking: true,
            connections: ConnectionOptions::default(),
        }
    }

    /// Options for commands that only inspect or reorder the queue.
    pub fn read_only(mut self) -> Self {
        self.networking = false;
        self
    }

    /// Replaces the network options.
    pub fn with_connections(mut self, connections: ConnectionOptions) -> Self {
        self.connections = connections;
        self
    }
}

/// Listener settings the running session was started with.
///
/// librqbit creates the TCP/uTP listeners and the UPnP forwarder once, inside
/// `Session::new_with_opts`; neither can be changed afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ListenerState {
    upnp_port_forwarding: bool,
    utp_enabled: bool,
}

/// Options in effect at runtime: the listener is fixed, the rest follows the
/// user's settings and is applied to the next added torrent.
#[derive(Debug, Clone)]
struct AppliedConnections {
    listener: ListenerState,
    options: ConnectionOptions,
}

/// Options for [`Downloader::add`].
#[derive(Debug, Clone)]
pub struct AddOptions {
    /// Folder to download into; defaults to [`DownloaderOptions::download_dir`].
    pub output_dir: Option<PathBuf>,
    /// How long to wait for metadata of a magnet link.
    pub metadata_timeout: Duration,
    /// Write the files into a sub folder named after the torrent.
    ///
    /// `None` keeps the engine's convention: multi-file torrents get their own
    /// folder, a single-file torrent is written straight into the output folder.
    pub create_subfolder: Option<bool>,
    /// Add the torrent paused instead of handing it to the queue.
    pub start_paused: bool,
}

impl Default for AddOptions {
    fn default() -> Self {
        Self {
            output_dir: None,
            metadata_timeout: DEFAULT_METADATA_TIMEOUT,
            create_subfolder: None,
            start_paused: false,
        }
    }
}

/// Main entry point of the core crate.
///
/// The API is synchronous on purpose: every CLI invocation is one short-lived
/// process. An internal multi-threaded tokio runtime drives the engine, and
/// dropping the downloader pauses the torrents so their progress is flushed.
pub struct Downloader {
    rt: tokio::runtime::Runtime,
    session: Arc<Session>,
    state_path: PathBuf,
    state: Mutex<State>,
    /// Serializes state file writes so two parallel commands cannot interleave
    /// their snapshots (the UI sends several commands at once).
    save_lock: Mutex<()>,
    download_dir: PathBuf,
    /// Network options: the listener is fixed, the rest is live.
    connections: Mutex<AppliedConnections>,
    closed: AtomicBool,
}

impl Downloader {
    /// Opens the engine and restores the previous session.
    pub fn new(options: DownloaderOptions) -> Result<Self, Error> {
        let data_dir = options.data_dir;
        let download_dir = options.download_dir;
        std::fs::create_dir_all(&data_dir)?;
        std::fs::create_dir_all(&download_dir)?;

        let state_path = data_dir.join("state.json");
        let state = State::load(&state_path)?;

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;

        // Validate once here: the session and the runtime options must agree.
        let connections = options.connections.normalized();
        let listener_state = ListenerState {
            upnp_port_forwarding: connections.upnp_port_forwarding,
            utp_enabled: connections.utp_enabled,
        };
        let listener = ListenerOptions {
            // uTP is a second transport next to TCP: librqbit binds a UDP
            // socket to the same port and accepts `utp` handshakes there.
            mode: if connections.utp_enabled {
                ListenerMode::TcpAndUtp
            } else {
                ListenerMode::TcpOnly
            },
            enable_upnp_port_forwarding: connections.upnp_port_forwarding,
            ..Default::default()
        };
        let trackers = parse_trackers(&connections.extra_trackers);

        let session_options = SessionOptions {
            dht: options.networking.then(DhtSessionConfig::default),
            listen: options.networking.then_some(listener),
            fastresume: true,
            persistence: Some(SessionPersistenceConfig::Json {
                folder: Some(data_dir.join("session")),
            }),
            ratelimits: limits_config(&state),
            disable_local_service_discovery: !options.networking,
            // Session-wide list: announced by every torrent the engine runs,
            // including the ones restored from the previous run.
            trackers: trackers.into_iter().collect(),
            peer_limit: connections.peer_limit.map(peer_limit_usize),
            client_name_and_version: Some(format!(
                "brickman-torrent/{}",
                env!("CARGO_PKG_VERSION")
            )),
            ..Default::default()
        };

        let session = rt.block_on(Session::new_with_opts(download_dir.clone(), session_options))?;

        let downloader = Self {
            rt,
            session,
            state_path,
            state: Mutex::new(state),
            save_lock: Mutex::new(()),
            download_dir,
            connections: Mutex::new(AppliedConnections {
                listener: listener_state,
                options: connections,
            }),
            closed: AtomicBool::new(false),
        };
        downloader.enforce_idle()?;
        Ok(downloader)
    }

    /// Network options in effect right now.
    pub fn connection_options(&self) -> ConnectionOptions {
        self.with_connections(|applied| applied.options.clone())
    }

    /// Applies new network options.
    ///
    /// The peer limit and the extra trackers are used by the *next* added
    /// torrent. UPnP and uTP belong to the listener, which librqbit creates
    /// once; a change there is only reported as `restart_required`, it is not
    /// pretended to be applied.
    pub fn set_connection_options(&self, options: ConnectionOptions) -> ConnectionChange {
        let options = options.normalized();
        self.with_connections(|applied| {
            let listener = applied.listener;
            let restart_required = options.upnp_port_forwarding != listener.upnp_port_forwarding
                || options.utp_enabled != listener.utp_enabled;
            let trackers = parse_trackers(&options.extra_trackers).len();
            applied.options = options.clone();
            ConnectionChange {
                restart_required,
                peer_limit: options.peer_limit,
                trackers,
            }
        })
    }

    /// Path of the queue state file.
    pub fn state_path(&self) -> &Path {
        &self.state_path
    }

    /// Default download folder.
    pub fn download_dir(&self) -> &Path {
        &self.download_dir
    }

    /// Adds a torrent from a `.torrent` file or a magnet link.
    pub fn add_source(&self, source: Source) -> Result<TorrentId, Error> {
        self.add(source, AddOptions::default())
    }

    /// Reads a source without adding it: the name and the number of files.
    ///
    /// Used by the add dialog to decide about the per-torrent sub folder before
    /// anything is written. Paths are validated here as well, so an unsafe
    /// torrent is refused while the user is still looking at the dialog.
    pub fn inspect(&self, source: &Source, metadata_timeout: Duration) -> Result<TorrentPreview, Error> {
        let metadata = self.fetch_metadata(source, metadata_timeout)?;
        paths::validate_torrent_files(metadata.name.as_deref(), &metadata.files)?;
        Ok(TorrentPreview {
            name: metadata.name,
            file_count: metadata.files.len(),
        })
    }

    /// Adds a torrent with explicit options.
    ///
    /// Metadata is fetched and validated *before* the torrent is started, so a
    /// torrent with unsafe paths never touches the disk.
    pub fn add(&self, source: Source, options: AddOptions) -> Result<TorrentId, Error> {
        let output_root = options
            .output_dir
            .clone()
            .unwrap_or_else(|| self.download_dir.clone());
        // Fail here, with a message about the folder itself, instead of letting
        // the engine fail with something the user cannot act on.
        paths::validate_output_dir(&output_root)?;

        let metadata = self.fetch_metadata(&source, options.metadata_timeout)?;
        paths::validate_torrent_files(metadata.name.as_deref(), &metadata.files)?;

        let is_multi_file = metadata.files.len() > 1;
        let create_subfolder = options.create_subfolder.unwrap_or(is_multi_file);
        let output_folder = match &metadata.name {
            Some(name) if create_subfolder => output_root.join(name),
            _ => output_root,
        };

        let connections = self.connection_options();
        let trackers = parse_trackers(&connections.extra_trackers);
        let add_options = AddTorrentOptions {
            paused: true,
            overwrite: true,
            output_folder: Some(output_folder.to_string_lossy().into_owned()),
            // Both are per-add in librqbit 9.1.0, so a changed limit or tracker
            // list applies to the next torrent without restarting the session.
            peer_limit: connections.peer_limit.map(peer_limit_usize),
            trackers: (!trackers.is_empty()).then(|| {
                trackers.iter().map(ToString::to_string).collect()
            }),
            ..Default::default()
        };
        let response = self.rt.block_on(
            self.session
                .add_torrent(AddTorrent::TorrentFileBytes(metadata.bytes), Some(add_options)),
        )?;

        let (raw_id, _handle) = match response {
            AddTorrentResponse::Added(id, handle) => (id, handle),
            AddTorrentResponse::AlreadyManaged(id, handle) => (id, handle),
            AddTorrentResponse::ListOnly(_) => {
                return Err(Error::engine("engine returned metadata only for a real add"));
            }
        };

        let id = TorrentId(u32::try_from(raw_id).map_err(|_| Error::engine("torrent id overflow"))?);
        let described = source.describe();
        let start_paused = options.start_paused;
        self.with_state(|s| {
            let entry = s.entry_or_insert(id.0, described);
            if start_paused {
                entry.user_paused = true;
            }
        });
        self.save_state()?;
        self.sync_queue()?;
        Ok(id)
    }

    /// All managed torrents, in queue order (first = next to download).
    ///
    /// Waits briefly (up to 5 s) for pending initial checks to finish so that
    /// progress and state reflect the data on disk rather than "checking".
    pub fn list(&self) -> Vec<TorrentView> {
        self.wait_for_initial_check(Duration::from_secs(5));
        let state = self.with_state(|s| s.clone());
        let mut views: Vec<TorrentView> = self.session.with_torrents(|torrents| {
            torrents.map(|(raw_id, handle)| view(raw_id, handle, &state)).collect()
        });
        // The table order *is* the queue; torrents unknown to the state file go
        // last so a fresh session cannot hide anything.
        views.sort_by_key(|v| {
            state
                .position(v.id.0)
                .map_or((usize::MAX, v.id.0), |index| (index, v.id.0))
        });
        views
    }

    /// Advances the queue by one pass: starts the torrents that own a free
    /// slot, parks the rest and lets finished torrents seed.
    ///
    /// A long-lived front end calls this on every refresh (the UI polls once
    /// per second), the same way [`Downloader::run_until`] does.
    pub fn tick(&self) -> Result<(), Error> {
        self.sync_queue()
    }

    /// Files of a torrent with per-file progress and selection state.
    pub fn files(&self, id: TorrentId) -> Result<Vec<FileView>, Error> {
        let handle = self.handle(id)?;
        let stats = handle.stats();
        let selected: Option<Vec<usize>> = handle.only_files();
        let mut files: Vec<FileView> = Vec::new();
        handle.with_metadata(|metadata| {
            for (index, info) in metadata.file_infos.iter().enumerate() {
                let len = info.len;
                let downloaded = stats
                    .file_progress
                    .get(index)
                    .copied()
                    .unwrap_or(0)
                    .min(len);
                let progress = if len == 0 {
                    1.0
                } else {
                    (downloaded as f64 / len as f64).clamp(0.0, 1.0)
                };
                files.push(FileView {
                    index,
                    path: info.relative_filename.to_string_lossy().replace('\\', "/"),
                    len,
                    downloaded,
                    progress,
                    included: selected
                        .as_ref()
                        .is_none_or(|wanted| wanted.contains(&index)),
                });
            }
        })?;
        Ok(files)
    }

    /// Includes or excludes a single file of a torrent.
    ///
    /// librqbit keeps the selection as `only_files`; the set is rebuilt from the
    /// current selection so that repeated calls stay independent.
    pub fn set_file_included(
        &self,
        id: TorrentId,
        index: usize,
        included: bool,
    ) -> Result<(), Error> {
        let handle = self.handle(id)?;
        // librqbit refuses file selection changes while the initial check runs,
        // so give it a moment to settle before touching `only_files`.
        self.wait_for_initial_check(Duration::from_secs(3));
        let file_count = handle.with_metadata(|metadata| metadata.file_infos.len())?;
        if index >= file_count {
            return Err(Error::InvalidArgument(format!(
                "torrent {id} has no file #{index}"
            )));
        }

        let mut selection: HashSet<usize> = match handle.only_files() {
            Some(list) => list.into_iter().collect(),
            None => (0..file_count).collect(),
        };
        if included {
            selection.insert(index);
        } else {
            selection.remove(&index);
        }
        if selection.is_empty() {
            return Err(Error::InvalidArgument(
                "a torrent must keep at least one file selected".to_string(),
            ));
        }

        self.rt
            .block_on(self.session.update_only_files(&handle, &selection))?;
        Ok(())
    }

    /// Trackers announced for a torrent, ordered by URL.
    pub fn trackers(&self, id: TorrentId) -> Result<Vec<TrackerView>, Error> {
        let handle = self.handle(id)?;
        let mut trackers: Vec<TrackerView> = handle
            .shared
            .trackers
            .iter()
            .map(|url| TrackerView {
                url: url.to_string(),
                tier: 0,
            })
            .collect();
        trackers.sort_by(|a, b| a.url.cmp(&b.url));
        Ok(trackers)
    }

    /// Peers the engine currently tracks for a torrent.
    pub fn peers(&self, id: TorrentId) -> Result<Vec<PeerView>, Error> {
        let handle = self.handle(id)?;
        let Some(live) = handle.live() else {
            return Ok(Vec::new());
        };
        let snapshot = live.per_peer_stats_snapshot(Default::default());
        let mut peers: Vec<PeerView> = snapshot
            .peers
            .into_iter()
            .map(|(address, stats)| PeerView {
                address,
                client: stats.client_name,
                state: stats.state.to_string(),
                fetched_bytes: stats.counters.fetched_bytes,
                uploaded_bytes: stats.counters.uploaded_bytes,
            })
            .collect();
        peers.sort_by(|a, b| a.address.cmp(&b.address));
        Ok(peers)
    }

    /// Aggregate speeds, listening port and queue numbers for the status bar.
    pub fn session_stats(&self) -> SessionView {
        let snapshot = self.session.stats_snapshot();
        let state = self.with_state(|s| s.clone());
        let applied = self.with_connections(|applied| applied.clone());
        let active = self
            .handles()
            .iter()
            .filter(|(_, handle)| handle.stats().live.is_some())
            .count();
        let listen_addr = self.session.listen_addr();
        let port = self
            .session
            .announce_port()
            .or_else(|| listen_addr.map(|addr| addr.port()))
            .unwrap_or(0);
        let dht_nodes = self
            .session
            .get_dht()
            .map_or(0, |dht| dht.stats().routing_table_size);

        SessionView {
            down_bps: snapshot.download_speed.as_bytes(),
            up_bps: snapshot.upload_speed.as_bytes(),
            active: u32::try_from(active).unwrap_or(u32::MAX),
            port,
            port_open: listen_addr.is_some(),
            // The listener is created once, so these are what the session was
            // started with, not what a changed setting asks for.
            upnp_requested: applied.listener.upnp_port_forwarding,
            utp_enabled: applied.listener.utp_enabled,
            peer_limit: applied.options.peer_limit.unwrap_or(0),
            peers_tcp: snapshot.peers.live_tcp,
            peers_utp: snapshot.peers.live_utp,
            dht_nodes: u32::try_from(dht_nodes).unwrap_or(u32::MAX),
            max_active: state.max_active,
            down_limit_bps: state.limits.down_bps.unwrap_or(0),
            up_limit_bps: state.limits.up_bps.unwrap_or(0),
        }
    }

    /// Pauses a torrent (user pause, it will not be restarted by the queue).
    pub fn pause(&self, id: TorrentId) -> Result<(), Error> {
        self.ensure_exists(id)?;
        self.with_state(|s| {
            s.entry_or_insert(id.0, String::new()).user_paused = true;
        });
        self.save_state()?;
        self.sync_queue()
    }

    /// Resumes a torrent; it starts as soon as a queue slot is free.
    pub fn resume(&self, id: TorrentId) -> Result<(), Error> {
        self.ensure_exists(id)?;
        self.with_state(|s| {
            s.entry_or_insert(id.0, String::new()).user_paused = false;
        });
        self.save_state()?;
        self.sync_queue()
    }

    /// Pauses every torrent.
    pub fn pause_all(&self) -> Result<(), Error> {
        let ids = self.ids();
        self.set_user_paused(&ids, true)
    }

    /// Resumes every torrent.
    pub fn resume_all(&self) -> Result<(), Error> {
        let ids = self.ids();
        self.set_user_paused(&ids, false)
    }

    /// Removes a torrent, optionally deleting its files.
    pub fn remove(&self, id: TorrentId, delete_files: bool) -> Result<(), Error> {
        self.ensure_exists(id)?;
        self.rt.block_on(
            self.session
                .delete(TorrentIdOrHash::Id(id.as_usize()), delete_files),
        )?;
        self.with_state(|s| {
            s.remove_torrent(id.0);
        });
        self.save_state()?;
        Ok(())
    }

    /// Moves a torrent to another download folder.
    ///
    /// librqbit 9.1.0 has no API for this: `ManagedTorrentShared::options` is
    /// private and immutable, and the session only exposes `update_only_files`
    /// and `update_trackers`. The folder is therefore changed by removing the
    /// torrent from the engine *without* deleting its data, moving the files
    /// that are already on disk and adding the same torrent bytes back with the
    /// new output folder, asking the engine to reuse the old id. The initial
    /// check after the re-add verifies the moved files, so the downloaded
    /// pieces are kept instead of starting from zero.
    ///
    /// The torrent has to be stopped: renaming files of a running torrent is not
    /// possible on Windows (the engine holds them open).
    pub fn set_output_dir(
        &self,
        id: TorrentId,
        new_dir: &Path,
    ) -> Result<OutputDirChange, Error> {
        let handle = self.handle(id)?;
        if !matches!(handle.stats().state, TorrentStatsState::Paused) {
            return Err(Error::InvalidArgument(
                "stop the torrent before changing its download folder".to_string(),
            ));
        }
        // `Session::delete` reads the metadata unconditionally; a torrent whose
        // magnet is still resolving must not be removed here.
        let Some(metadata) = handle.metadata.load_full() else {
            return Err(Error::InvalidArgument(
                "torrent metadata is not available yet".to_string(),
            ));
        };

        paths::validate_output_dir(new_dir)?;
        let old_dir = handle.output_folder().to_path_buf();
        if same_folder(&old_dir, new_dir) {
            return Ok(OutputDirChange {
                id,
                moved_files: 0,
                failed_moves: Vec::new(),
            });
        }

        let torrent_bytes = metadata.torrent_bytes.clone();
        let relative: Vec<PathBuf> = metadata
            .file_infos
            .iter()
            .map(|info| info.relative_filename.clone())
            .collect();
        let only_files = handle.only_files();
        let (user_paused, added_at_ms, position, source) = self.with_state(|s| {
            let entry = s.entry(id.0);
            (
                entry.is_some_and(|e| e.user_paused),
                entry.map(|e| e.added_at_ms).unwrap_or(0),
                s.position(id.0),
                entry.map(|e| e.source.clone()).unwrap_or_default(),
            )
        });
        // A name is needed for the new entry; keep whatever the state had.
        let source = if source.is_empty() {
            format!("moved to {}", new_dir.display())
        } else {
            source
        };

        // 1. Leave the engine, keep the files.
        self.rt.block_on(
            self.session
                .delete(TorrentIdOrHash::Id(id.as_usize()), false),
        )?;

        // 2. Take the already downloaded files with us.
        let (moved_files, failed_moves) = relocate_files(&old_dir, new_dir, &relative);

        // 3. Add the same torrent back at the new place, reusing the id.
        let connections = self.connection_options();
        let trackers = parse_trackers(&connections.extra_trackers);
        let add_options = AddTorrentOptions {
            paused: true,
            overwrite: true,
            output_folder: Some(new_dir.to_string_lossy().into_owned()),
            only_files: only_files.clone(),
            preferred_id: Some(id.as_usize()),
            peer_limit: connections.peer_limit.map(peer_limit_usize),
            trackers: (!trackers.is_empty()).then(|| {
                trackers.iter().map(ToString::to_string).collect()
            }),
            ..Default::default()
        };
        let response = self.rt.block_on(
            self.session
                .add_torrent(AddTorrent::TorrentFileBytes(torrent_bytes), Some(add_options)),
        );
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                // The torrent is gone from the engine and its state entry would
                // be a ghost; report the whole picture instead of only the add.
                self.with_state(|s| s.remove_torrent(id.0));
                let _ = self.save_state();
                return Err(Error::engine(format!(
                    "torrent was removed and {moved_files} file(s) were moved to {}, \
                     but adding it there failed: {error:#}",
                    new_dir.display()
                )));
            }
        };
        let (raw_id, _handle) = match response {
            AddTorrentResponse::Added(id, handle) => (id, handle),
            AddTorrentResponse::AlreadyManaged(id, handle) => (id, handle),
            AddTorrentResponse::ListOnly(_) => {
                return Err(Error::engine("engine returned metadata only for a real add"));
            }
        };
        let new_id = TorrentId(u32::try_from(raw_id).map_err(|_| Error::engine("torrent id overflow"))?);

        // 4. Keep the queue position, the pause flag and the add time.
        self.with_state(|s| {
            if new_id != id {
                s.remove_torrent(id.0);
            }
            let entry = s.entry_or_insert(new_id.0, source);
            entry.user_paused = user_paused;
            entry.added_at_ms = added_at_ms;
            if let Some(index) = position {
                s.move_to(new_id.0, index);
            }
        });
        self.save_state()?;
        self.sync_queue()?;

        Ok(OutputDirChange {
            id: new_id,
            moved_files,
            failed_moves,
        })
    }

    /// Moves a torrent to the zero-based `index` of the queue and applies the
    /// new order immediately: whoever is now on top starts, the rest may pause.
    ///
    /// An index past the end puts the torrent last.
    pub fn move_to(&self, id: TorrentId, index: usize) -> Result<(), Error> {
        self.ensure_exists(id)?;
        let moved = self.with_state(|s| {
            s.entry_or_insert(id.0, String::new());
            s.move_to(id.0, index)
        });
        if !moved {
            return Err(Error::NotFound(id));
        }
        self.save_state()?;
        self.sync_queue()
    }

    /// Moves a torrent one position up; the first torrent stays first.
    pub fn move_up(&self, id: TorrentId) -> Result<(), Error> {
        self.move_by(id, -1)
    }

    /// Moves a torrent one position down; the last torrent stays last.
    pub fn move_down(&self, id: TorrentId) -> Result<(), Error> {
        self.move_by(id, 1)
    }

    fn move_by(&self, id: TorrentId, delta: isize) -> Result<(), Error> {
        self.ensure_exists(id)?;
        let moved = self.with_state(|s| {
            s.entry_or_insert(id.0, String::new());
            s.move_by(id.0, delta)
        });
        if !moved {
            return Err(Error::NotFound(id));
        }
        self.save_state()?;
        self.sync_queue()
    }

    /// Replaces the queue with an explicit order (drag and drop of many rows).
    ///
    /// Listed torrents come first in the given order; torrents missing from the
    /// list keep their previous relative position. The new order is applied
    /// right away.
    pub fn reorder(&self, ids: &[TorrentId]) -> Result<(), Error> {
        let raw: Vec<u32> = ids.iter().map(|id| id.0).collect();
        self.with_state(|s| {
            for id in &raw {
                s.entry_or_insert(*id, String::new());
            }
            s.reorder(&raw);
        });
        self.save_state()?;
        self.sync_queue()
    }

    /// Places a torrent at a 1-based queue position (`1` = first).
    ///
    /// Kept for the numeric command line; [`Downloader::move_to`] is the same
    /// operation with a zero-based index.
    pub fn set_priority(&self, id: TorrentId, number: u32) -> Result<(), Error> {
        if number == 0 {
            return Err(Error::InvalidArgument(
                "queue position must be 1 or greater".to_string(),
            ));
        }
        self.move_to(id, usize::try_from(number - 1).unwrap_or(usize::MAX))
    }

    /// Queue position of a torrent, `1` = first, `0` = not in the queue.
    pub fn position(&self, id: TorrentId) -> u32 {
        self.with_state(|s| {
            s.position(id.0)
                .and_then(|index| u32::try_from(index + 1).ok())
                .unwrap_or(0)
        })
    }

    /// Maximum number of simultaneously downloading torrents, `0` = unlimited.
    pub fn set_max_active(&self, n: u32) -> Result<(), Error> {
        self.with_state(|s| s.max_active = n);
        self.save_state()?;
        self.sync_queue()
    }

    /// Current active-download limit.
    pub fn max_active(&self) -> u32 {
        self.with_state(|s| s.max_active)
    }

    /// Sets global bandwidth limits in bytes per second (`None` = unlimited).
    pub fn set_limits(&self, down_bps: Option<u64>, up_bps: Option<u64>) -> Result<(), Error> {
        let down = non_zero_bps(down_bps)?;
        let up = non_zero_bps(up_bps)?;
        self.session.ratelimits.set_download_bps(down);
        self.session.ratelimits.set_upload_bps(up);
        self.with_state(|s| {
            s.limits.down_bps = down.map(|v| u64::from(v.get()));
            s.limits.up_bps = up.map(|v| u64::from(v.get()));
        });
        self.save_state()
    }

    /// Persisted bandwidth limits in bytes per second.
    pub fn limits(&self) -> crate::state::Limits {
        self.with_state(|s| s.limits)
    }

    /// Runs the engine in the foreground for up to `max_duration`, calling
    /// `on_tick` once per second with a fresh snapshot.
    ///
    /// Stops early on Ctrl+C or when `max_duration` elapses. This is not a
    /// daemon: the process is expected to be started by the user and to exit.
    pub fn run_until<F>(&self, max_duration: Option<Duration>, mut on_tick: F) -> Result<(), Error>
    where
        F: FnMut(&[TorrentView]),
    {
        let deadline = max_duration.map(|d| Instant::now() + d);
        loop {
            self.sync_queue()?;
            let views = self.list();
            on_tick(&views);

            let step = match deadline {
                None => Duration::from_secs(1),
                Some(deadline) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    remaining.min(Duration::from_secs(1))
                }
            };

            let interrupted = self.rt.block_on(async {
                tokio::select! {
                    () = tokio::time::sleep(step) => false,
                    res = tokio::signal::ctrl_c() => {
                        res.is_ok()
                    }
                }
            });
            if interrupted {
                break;
            }
        }
        Ok(())
    }

    /// Pauses all torrents so the engine flushes its bitfields, then stops it.
    ///
    /// Called automatically when the downloader is dropped.
    pub fn shutdown(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.pause_engine(Duration::ZERO);
        self.rt.block_on(async {
            // Give the bitfield flusher task a moment to write to disk.
            tokio::time::sleep(Duration::from_millis(300)).await;
            self.session.cancellation_token().cancel();
        });
    }

    /// Brings the engine to a known idle state right after a restart.
    ///
    /// The engine only stores a single "paused" bit per torrent, and it can be
    /// left stale (for example when a torrent is paused while its initial check
    /// is still running, the check may start it afterwards). Pausing everything
    /// here makes every command start from the persisted plan instead of from
    /// whatever the previous process happened to leave behind.
    fn enforce_idle(&self) -> Result<(), Error> {
        let handles = self.handles();
        let mut added = false;
        self.with_state(|state| {
            for (id, handle) in &handles {
                if state.torrents.contains_key(id) {
                    continue;
                }
                let user_paused = handle.is_paused();
                state.entry_or_insert(*id, String::new()).user_paused = user_paused;
                added = true;
            }
        });
        if added {
            self.save_state()?;
        }
        self.pause_engine(Duration::from_secs(10));
        Ok(())
    }

    /// Pauses every torrent. An initial check that is still running can start
    /// the torrent afterwards, so pause again once checks had time to finish.
    fn pause_engine(&self, settle: Duration) {
        let pause_now = || {
            let handles = self.handles();
            self.rt.block_on(async {
                for (_, handle) in &handles {
                    if !handle.is_paused() {
                        let _ = self.session.pause(handle).await;
                    }
                }
            });
        };
        pause_now();
        if !settle.is_zero() {
            self.wait_for_initial_check(settle);
            pause_now();
        }
    }

    fn fetch_metadata(
        &self,
        source: &Source,
        metadata_timeout: Duration,
    ) -> Result<Metadata, Error> {
        let response = match source {
            Source::TorrentFile(path) => {
                let bytes = std::fs::read(path).map_err(|e| {
                    Error::InvalidArgument(format!(
                        "cannot read torrent file {}: {e}",
                        path.display()
                    ))
                })?;
                let add = AddTorrent::TorrentFileBytes(Bytes::from(bytes));
                let options = AddTorrentOptions {
                    paused: true,
                    list_only: true,
                    ..Default::default()
                };
                self.rt
                    .block_on(self.session.add_torrent(add, Some(options)))?
            }
            Source::Magnet(url) => {
                // Trackers typed in the settings help the metadata exchange:
                // librqbit ignores `AddTorrentOptions::trackers` for magnets and
                // reads the `tr` parameters of the link itself instead.
                let trackers = parse_trackers(&self.connection_options().extra_trackers);
                let add = AddTorrent::from_url(with_tracker_params(url, &trackers));
                let options = AddTorrentOptions {
                    paused: true,
                    list_only: true,
                    ..Default::default()
                };
                let future = self.session.add_torrent(add, Some(options));
                // The timeout has to be constructed inside the runtime context,
                // otherwise tokio has no timer to register it with.
                let timeout = async move { tokio::time::timeout(metadata_timeout, future).await };
                match self.rt.block_on(timeout) {
                    Ok(result) => result?,
                    Err(_) => return Err(Error::MetadataTimeout(metadata_timeout.as_secs())),
                }
            }
        };

        match response {
            AddTorrentResponse::ListOnly(response) => {
                let files: Vec<Vec<String>> = response
                    .info
                    .iter_file_details()
                    .map(|details| details.filename.to_vec())
                    .collect();
                let name = response.info.name().map(|n| n.into_owned());
                Ok(Metadata {
                    bytes: response.torrent_bytes,
                    name,
                    files,
                })
            }
            AddTorrentResponse::AlreadyManaged(id, _) => Err(Error::InvalidArgument(format!(
                "torrent is already managed (id {id})"
            ))),
            AddTorrentResponse::Added(..) => Err(Error::engine(
                "engine started the torrent during a metadata-only request",
            )),
        }
    }

    fn ids(&self) -> Vec<u32> {
        self.handles()
            .iter()
            .map(|(id, _)| *id)
            .collect()
    }

    fn wait_for_initial_check(&self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            let busy = self.handles().iter().any(|(_, handle)| {
                matches!(
                    handle.stats().state,
                    TorrentStatsState::Initializing { .. }
                )
            });
            if !busy || Instant::now() >= deadline {
                return;
            }
            self.rt.block_on(async {
                tokio::time::sleep(Duration::from_millis(100)).await;
            });
        }
    }

    fn handles(&self) -> Vec<(u32, Arc<ManagedTorrent>)> {
        self.session.with_torrents(|torrents| {
            torrents
                .map(|(raw_id, handle)| {
                    (u32::try_from(raw_id).unwrap_or(u32::MAX), Arc::clone(handle))
                })
                .collect()
        })
    }

    fn handle(&self, id: TorrentId) -> Result<Arc<ManagedTorrent>, Error> {
        self.session
            .get(TorrentIdOrHash::Id(id.as_usize()))
            .ok_or(Error::NotFound(id))
    }

    fn ensure_exists(&self, id: TorrentId) -> Result<(), Error> {
        self.handle(id).map(|_| ())
    }

    fn set_user_paused(&self, ids: &[u32], paused: bool) -> Result<(), Error> {
        self.with_state(|s| {
            for id in ids {
                s.entry_or_insert(*id, String::new()).user_paused = paused;
            }
        });
        self.save_state()?;
        self.sync_queue()
    }

    /// Applies the queue: starts the torrents that own the free slots, parks
    /// the rest, keeps user-paused torrents paused and lets finished ones seed.
    ///
    /// A torrent paused while its initial check is still running can be started
    /// by the engine once the check finishes, so the plan is applied again after
    /// pending checks settle.
    fn sync_queue(&self) -> Result<(), Error> {
        let pending = self.sync_queue_once()?;
        if pending {
            self.wait_for_initial_check(Duration::from_secs(10));
            self.sync_queue_once()?;
        }
        Ok(())
    }

    /// One scheduling pass. Returns `true` if some torrent was still checking.
    fn sync_queue_once(&self) -> Result<bool, Error> {
        let state = self.with_state(|s| s.clone());
        let handles: HashMap<u32, Arc<ManagedTorrent>> =
            self.handles().into_iter().collect();
        if handles.is_empty() {
            return Ok(false);
        }

        let pending = handles.values().any(|handle| {
            matches!(
                handle.stats().state,
                TorrentStatsState::Initializing { .. }
            )
        });

        let items: Vec<QueueItem> = handles
            .iter()
            .map(|(id, handle)| {
                let stats = handle.stats();
                let entry = state.entry(*id);
                QueueItem {
                    id: TorrentId(*id),
                    // Torrents missing from the queue state go last.
                    position: state
                        .position(*id)
                        .and_then(|index| u32::try_from(index + 1).ok())
                        .unwrap_or(u32::MAX),
                    user_paused: entry.map(|e| e.user_paused).unwrap_or(false),
                    finished: stats.finished,
                    errored: matches!(stats.state, TorrentStatsState::Error),
                }
            })
            .collect();

        let plan = scheduler::plan(&items, state.max_active);
        let mut errors: Vec<String> = Vec::new();

        self.rt.block_on(async {
            for id in plan.active.iter().chain(plan.seeding.iter()) {
                if let Some(handle) = handles.get(&id.0)
                    && let Some(error) = set_paused(&self.session, handle, false).await
                {
                    errors.push(format!("#{id}: {error}"));
                }
            }
            for id in plan.queued.iter().chain(plan.paused.iter()) {
                if let Some(handle) = handles.get(&id.0)
                    && let Some(error) = set_paused(&self.session, handle, true).await
                {
                    errors.push(format!("#{id}: {error}"));
                }
            }
        });

        if errors.is_empty() {
            Ok(pending)
        } else {
            Err(Error::Engine(errors.join("; ")))
        }
    }

    fn save_state(&self) -> Result<(), Error> {
        // Hold the write lock across snapshot+write: two concurrent commands
        // must not overwrite each other with an older snapshot.
        let _guard = match self.save_lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let state = self.with_state(|s| s.clone());
        state.save(&self.state_path)
    }

    fn with_state<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        let mut guard = match self.state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(&mut guard)
    }

    fn with_connections<R>(&self, f: impl FnOnce(&mut AppliedConnections) -> R) -> R {
        let mut guard = match self.connections.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(&mut guard)
    }
}

impl Drop for Downloader {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl std::fmt::Debug for Downloader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Downloader")
            .field("state_path", &self.state_path)
            .field("download_dir", &self.download_dir)
            .finish_non_exhaustive()
    }
}

struct Metadata {
    bytes: Bytes,
    name: Option<String>,
    files: Vec<Vec<String>>,
}

/// Result of [`Downloader::set_output_dir`].
#[derive(Debug, Clone)]
pub struct OutputDirChange {
    /// Engine id after the move (the old one unless the engine assigned a new one).
    pub id: TorrentId,
    /// Files that were carried over to the new folder.
    pub moved_files: usize,
    /// Relative paths that could not be moved; those files are downloaded again.
    pub failed_moves: Vec<String>,
}

/// What a source contains, as returned by [`Downloader::inspect`].
#[derive(Debug, Clone)]
pub struct TorrentPreview {
    /// Torrent name (`info.name`), when the metadata has one.
    pub name: Option<String>,
    /// Number of files; more than one means the torrent needs its own folder.
    pub file_count: usize,
}

/// Whether two paths point at the same folder (case-insensitive on Windows).
fn same_folder(left: &Path, right: &Path) -> bool {
    let resolve = |path: &Path| {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    };
    let left = resolve(left);
    let right = resolve(right);
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

/// Moves the files of a torrent from `old_root` to `new_root`.
///
/// Returns the number of moved files and the relative paths that failed. A file
/// that already exists at the destination is left alone: the initial check after
/// the re-add reports it as downloaded, and overwriting user data is worse.
fn relocate_files(
    old_root: &Path,
    new_root: &Path,
    relative: &[PathBuf],
) -> (usize, Vec<String>) {
    let mut moved = 0;
    let mut failed = Vec::new();
    for path in relative {
        let from = old_root.join(path);
        let to = new_root.join(path);
        if !from.is_file() || to.exists() {
            continue;
        }
        match move_file(&from, &to) {
            Ok(()) => moved += 1,
            Err(error) => failed.push(format!("{}: {error}", path.display())),
        }
    }
    (moved, failed)
}

fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        // A rename across volumes fails on Windows; copy and remove instead.
        Err(rename_error) => match std::fs::copy(from, to) {
            Ok(_) => {
                let _ = std::fs::remove_file(from);
                Ok(())
            }
            Err(_) => Err(rename_error),
        },
    }
}

/// Whether the engine currently runs this torrent, or `None` if it cannot be
/// started or paused at all (error state).
fn engine_paused(state: TorrentStatsState) -> Option<bool> {
    match state {
        TorrentStatsState::Paused => Some(true),
        TorrentStatsState::Live => Some(false),
        TorrentStatsState::Initializing { paused } => Some(paused),
        TorrentStatsState::Error => None,
    }
}

async fn set_paused(
    session: &Arc<Session>,
    handle: &Arc<ManagedTorrent>,
    paused: bool,
) -> Option<String> {
    // Decide on the real engine state, not on `handle.is_paused()`: that flag is
    // already cleared while a torrent added with `paused: true` is initializing,
    // so it reports "not paused" for a torrent that the engine leaves in the
    // `Paused` state once its initial check finishes. Trusting it skipped the
    // `unpause` call and the torrent never started.
    let Some(current) = engine_paused(handle.stats().state) else {
        // A torrent in the error state can neither be paused nor started.
        return None;
    };
    if current == paused {
        return None;
    }

    let result = if paused {
        session.pause(handle).await
    } else {
        session.unpause(handle).await
    };
    match result {
        Ok(()) => None,
        Err(error) => {
            // A racing state change is harmless as long as the end state matches.
            if engine_paused(handle.stats().state) == Some(paused) {
                None
            } else {
                Some(format!("{error:#}"))
            }
        }
    }
}

fn view(raw_id: usize, handle: &Arc<ManagedTorrent>, state: &State) -> TorrentView {
    let id = TorrentId(u32::try_from(raw_id).unwrap_or(u32::MAX));
    let stats = handle.stats();
    let entry = state.entry(id.0);
    // The visible queue position drives the number shown as "priority": the
    // queue is the order of `State::order`, not a stored number.
    let priority = state
        .position(id.0)
        .and_then(|index| u32::try_from(index + 1).ok())
        .or_else(|| entry.map(|e| e.priority))
        .unwrap_or(0);
    let user_paused = entry.is_some_and(|e| e.user_paused);

    let total_bytes = stats.total_bytes;
    let progress = if total_bytes == 0 {
        0.0
    } else {
        (stats.progress_bytes as f64 / total_bytes as f64).clamp(0.0, 1.0)
    };

    let (down_bps, up_bps, peers, seeds) = match &stats.live {
        Some(live) => (
            live.download_speed.as_bytes(),
            live.upload_speed.as_bytes(),
            live.snapshot.peer_stats.live,
            live.snapshot.peer_stats.live_seeders,
        ),
        None => (0, 0, 0, 0),
    };

    let metadata_available = handle.metadata.load().is_some();
    let pieces = handle
        .with_metadata(|metadata| metadata.lengths().total_pieces())
        .unwrap_or(0);
    let pieces_done = stats
        .live
        .as_ref()
        .map_or(0, |live| live.snapshot.downloaded_and_checked_pieces);
    let pieces_done = u32::try_from(pieces_done).unwrap_or(u32::MAX);
    let torrent_state = if matches!(stats.state, TorrentStatsState::Error) {
        TorrentState::Error
    } else if user_paused {
        TorrentState::Paused
    } else if !metadata_available {
        TorrentState::FetchingMetadata
    } else if matches!(stats.state, TorrentStatsState::Initializing { .. }) {
        TorrentState::Checking
    } else if stats.finished {
        match stats.live.is_some() {
            true => TorrentState::Seeding,
            false => TorrentState::Done,
        }
    } else if matches!(stats.state, TorrentStatsState::Live) {
        TorrentState::Downloading
    } else {
        TorrentState::Queued
    };

    TorrentView {
        id,
        name: handle
            .name()
            .unwrap_or_else(|| format!("<torrent {id}>")),
        total_bytes,
        progress,
        state: torrent_state,
        down_bps,
        up_bps,
        peers,
        seeds,
        priority,
        save_path: handle.output_folder().to_path_buf(),
        downloaded_bytes: stats.progress_bytes,
        uploaded_bytes: stats.uploaded_bytes,
        hash: handle.info_hash().as_string(),
        added_at_ms: entry.map(|e| e.added_at_ms).unwrap_or(0),
        pieces,
        pieces_done,
    }
}

fn limits_config(state: &State) -> LimitsConfig {
    LimitsConfig {
        download_bps: non_zero_bps(state.limits.down_bps).ok().flatten(),
        upload_bps: non_zero_bps(state.limits.up_bps).ok().flatten(),
    }
}

fn non_zero_bps(value: Option<u64>) -> Result<Option<std::num::NonZeroU32>, Error> {
    match value {
        None | Some(0) => Ok(None),
        Some(bps) => {
            let bps = u32::try_from(bps).map_err(|_| {
                Error::InvalidArgument(format!("bandwidth limit {bps} is too large"))
            })?;
            Ok(std::num::NonZeroU32::new(bps))
        }
    }
}

/// Validates the tracker URLs the user typed.
///
/// Entries are split on newlines, so a text area with one URL per line and a
/// single comma-free string both work. Only `udp://`, `http://` and `https://`
/// announces with a host are kept; anything else (a magnet link, a bare word,
/// `http://` without a host, an unsupported scheme) is dropped instead of
/// failing the whole setting. The result is de-duplicated by exact URL and
/// capped at [`MAX_EXTRA_TRACKERS`].
pub fn parse_trackers(entries: &[String]) -> Vec<Url> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut trackers = Vec::new();
    for entry in entries {
        for line in entry.split(['\n', '\r']) {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Ok(url) = Url::parse(line) else {
                continue;
            };
            if !matches!(url.scheme(), "udp" | "http" | "https") {
                continue;
            }
            if url.host_str().is_none_or(str::is_empty) {
                continue;
            }
            let key = url.to_string();
            if !seen.insert(key) {
                continue;
            }
            trackers.push(url);
            if trackers.len() >= MAX_EXTRA_TRACKERS {
                return trackers;
            }
        }
    }
    trackers
}

/// Validated tracker list as the strings the engine and the API take.
fn derived_trackers(entries: &[String]) -> Vec<String> {
    parse_trackers(entries)
        .iter()
        .map(ToString::to_string)
        .collect()
}

/// `None`/`0` means "no limit"; anything else is clamped into the supported
/// range, because a limit of ten million peers can only exhaust memory.
pub fn normalize_peer_limit(value: Option<u32>) -> Option<u32> {
    match value {
        None | Some(0) => None,
        Some(value) => Some(value.clamp(MIN_PEER_LIMIT, MAX_PEER_LIMIT)),
    }
}

/// The engine takes the limit as a `usize`.
fn peer_limit_usize(limit: u32) -> usize {
    usize::try_from(limit).unwrap_or(usize::MAX)
}

/// Adds the validated trackers to a magnet link as `tr` parameters.
///
/// librqbit only reads the `tr` parameters of a magnet when it looks for
/// metadata, so this is what makes a changed tracker list work for a magnet
/// without restarting the session. Values are percent-encoded; a link that is
/// not a magnet is returned unchanged.
fn with_tracker_params(link: &str, trackers: &[Url]) -> String {
    if trackers.is_empty() || !link.starts_with("magnet:") {
        return link.to_string();
    }
    let mut result = link.trim().to_string();
    for tracker in trackers {
        let encoded: String =
            url::form_urlencoded::byte_serialize(tracker.as_str().as_bytes()).collect();
        result.push_str(if result.contains('?') { "&tr=" } else { "?tr=" });
        result.push_str(&encoded);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn tracker_input_is_validated() {
        let parsed = parse_trackers(&strings(&[
            " udp://tracker.opentrackr.org:1337/announce ",
            "http://tracker.example.org:80/announce",
            "https://tracker.example.net/announce",
            // Everything below must be dropped.
            "",
            "   ",
            "# a comment",
            "not a url",
            "http://",
            "ftp://tracker.example.org/announce",
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            "ws://tracker.example.org/announce",
        ]));
        assert_eq!(parsed.len(), 3, "{parsed:?}");
        assert_eq!(parsed[0].scheme(), "udp");
        assert_eq!(parsed[1].scheme(), "http");
        assert_eq!(parsed[2].scheme(), "https");
        assert_eq!(parsed[0].host_str(), Some("tracker.opentrackr.org"));
    }

    #[test]
    fn tracker_list_is_deduplicated_and_capped() {
        let mut entries = strings(&[
            "udp://tracker.example.org:1337/announce",
            "udp://tracker.example.org:1337/announce",
            "  udp://tracker.example.org:1337/announce  ",
        ]);
        // One entry holding several lines works like several entries.
        entries.push(
            "udp://a.example/announce\nudp://b.example/announce\r\nudp://c.example/announce"
                .to_string(),
        );
        let parsed = parse_trackers(&entries);
        let urls: Vec<&str> = parsed.iter().map(Url::as_str).collect();
        assert_eq!(
            urls,
            vec![
                "udp://tracker.example.org:1337/announce",
                "udp://a.example/announce",
                "udp://b.example/announce",
                "udp://c.example/announce",
            ]
        );

        let many: Vec<String> = (0..(MAX_EXTRA_TRACKERS + 20))
            .map(|index| format!("udp://tracker{index}.example.org:6969/announce"))
            .collect();
        assert_eq!(parse_trackers(&many).len(), MAX_EXTRA_TRACKERS);
    }

    #[test]
    fn connection_defaults_reach_more_peers() {
        let defaults = ConnectionOptions::default();
        assert!(defaults.upnp_port_forwarding);
        assert!(defaults.utp_enabled);
        assert_eq!(defaults.peer_limit, Some(DEFAULT_PEER_LIMIT));
        assert_eq!(defaults.peer_limit, Some(200));
        assert!(defaults.extra_trackers.is_empty());

        // The normalized copy keeps the switches, cleans the list and the limit.
        let dirty = ConnectionOptions {
            upnp_port_forwarding: false,
            utp_enabled: true,
            peer_limit: Some(5),
            extra_trackers: strings(&["udp://tracker.example.org:1337/announce", "junk"]),
        };
        let clean = dirty.normalized();
        assert!(!clean.upnp_port_forwarding);
        assert!(clean.utp_enabled);
        assert_eq!(clean.peer_limit, Some(5));
        assert_eq!(clean.extra_trackers.len(), 1);
        assert_eq!(clean.extra_trackers[0], "udp://tracker.example.org:1337/announce");
    }

    #[test]
    fn peer_limit_is_clamped_or_unlimited() {
        assert_eq!(normalize_peer_limit(None), None);
        assert_eq!(normalize_peer_limit(Some(0)), None);
        assert_eq!(normalize_peer_limit(Some(1)), Some(1));
        assert_eq!(normalize_peer_limit(Some(200)), Some(200));
        assert_eq!(normalize_peer_limit(Some(1000)), Some(1000));
        assert_eq!(normalize_peer_limit(Some(100_000)), Some(MAX_PEER_LIMIT));
    }

    #[test]
    fn magnet_gets_the_extra_trackers_as_parameters() {
        let trackers = parse_trackers(&strings(&[
            "udp://tracker.opentrackr.org:1337/announce",
            "http://tracker.example.org/announce?a=b",
        ]));
        let link = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test";
        let result = with_tracker_params(link, &trackers);
        assert!(result.starts_with(link));
        assert!(result.contains("&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce"));
        assert!(result.contains("&tr=http%3A%2F%2Ftracker.example.org%2Fannounce%3Fa%3Db"));

        // The magnet parser of the engine gets the original URLs back.
        let magnet = librqbit::Magnet::parse(&result).expect("parse");
        assert_eq!(
            magnet.trackers,
            vec![
                "udp://tracker.opentrackr.org:1337/announce".to_string(),
                "http://tracker.example.org/announce?a=b".to_string(),
            ]
        );

        // Nothing to add, and a non-magnet link is left alone.
        assert_eq!(with_tracker_params(link, &[]), link);
        assert_eq!(
            with_tracker_params("https://example.org/file.torrent", &trackers),
            "https://example.org/file.torrent"
        );
    }
}
