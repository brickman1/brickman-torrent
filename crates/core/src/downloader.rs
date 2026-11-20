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
    AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, ListenerOptions,
    ManagedTorrent, Session, SessionOptions, SessionPersistenceConfig, TorrentStatsState,
};

use crate::error::Error;
use crate::model::{
    FileView, PeerView, SessionView, Source, TorrentId, TorrentState, TorrentView, TrackerView,
};
use crate::paths;
use crate::scheduler::{self, QueueItem};
use crate::state::State;

/// How long to wait for magnet metadata by default.
pub const DEFAULT_METADATA_TIMEOUT: Duration = Duration::from_secs(60);

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
}

impl DownloaderOptions {
    /// Options with networking enabled.
    pub fn new(data_dir: PathBuf, download_dir: PathBuf) -> Self {
        Self {
            data_dir,
            download_dir,
            networking: true,
        }
    }

    /// Options for commands that only inspect or reorder the queue.
    pub fn read_only(mut self) -> Self {
        self.networking = false;
        self
    }
}

/// Options for [`Downloader::add`].
#[derive(Debug, Clone)]
pub struct AddOptions {
    /// Folder to download into; defaults to [`DownloaderOptions::download_dir`].
    pub output_dir: Option<PathBuf>,
    /// How long to wait for metadata of a magnet link.
    pub metadata_timeout: Duration,
}

impl Default for AddOptions {
    fn default() -> Self {
        Self {
            output_dir: None,
            metadata_timeout: DEFAULT_METADATA_TIMEOUT,
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

        let session_options = SessionOptions {
            dht: options.networking.then(DhtSessionConfig::default),
            listen: options
                .networking
                .then(ListenerOptions::default),
            fastresume: true,
            persistence: Some(SessionPersistenceConfig::Json {
                folder: Some(data_dir.join("session")),
            }),
            ratelimits: limits_config(&state),
            disable_local_service_discovery: !options.networking,
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
            closed: AtomicBool::new(false),
        };
        downloader.enforce_idle()?;
        Ok(downloader)
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

    /// Adds a torrent with explicit options.
    ///
    /// Metadata is fetched and validated *before* the torrent is started, so a
    /// torrent with unsafe paths never touches the disk.
    pub fn add(&self, source: Source, options: AddOptions) -> Result<TorrentId, Error> {
        let output_root = options
            .output_dir
            .clone()
            .unwrap_or_else(|| self.download_dir.clone());
        std::fs::create_dir_all(&output_root)?;

        let metadata = self.fetch_metadata(&source, options.metadata_timeout)?;
        paths::validate_torrent_files(metadata.name.as_deref(), &metadata.files)?;

        let is_multi_file = metadata.files.len() > 1;
        let output_folder = match &metadata.name {
            Some(name) if is_multi_file => output_root.join(name),
            _ => output_root,
        };

        let add_options = AddTorrentOptions {
            paused: true,
            overwrite: true,
            output_folder: Some(output_folder.to_string_lossy().into_owned()),
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
        self.with_state(|s| {
            s.entry_or_insert(id.0, described);
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
                let add = AddTorrent::from_url(url.clone());
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
