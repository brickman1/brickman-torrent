//! The downloader: a synchronous facade over a private tokio runtime running
//! the librqbit engine, plus the persistent download queue.

use std::collections::HashMap;
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
use crate::model::{Source, TorrentId, TorrentState, TorrentView};
use crate::paths;
use crate::scheduler::{self, QueueItem};
use crate::state::{State, TorrentEntry};

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

    /// All managed torrents, ordered by id.
    ///
    /// Waits briefly (up to 5 s) for pending initial checks to finish so that
    /// progress and state reflect the data on disk rather than "checking".
    pub fn list(&self) -> Vec<TorrentView> {
        self.wait_for_initial_check(Duration::from_secs(5));
        let state = self.with_state(|s| s.clone());
        let mut views: Vec<TorrentView> = self.session.with_torrents(|torrents| {
            torrents.map(|(raw_id, handle)| view(raw_id, handle, &state)).collect()
        });
        views.sort_by_key(|v| v.id.0);
        views
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
            s.torrents.remove(&id.0);
        });
        self.save_state()?;
        Ok(())
    }

    /// Sets the numeric queue priority, `1` is the highest.
    pub fn set_priority(&self, id: TorrentId, number: u32) -> Result<(), Error> {
        if number == 0 {
            return Err(Error::InvalidArgument(
                "priority must be 1 or greater".to_string(),
            ));
        }
        self.ensure_exists(id)?;
        self.with_state(|s| {
            s.entry_or_insert(id.0, String::new()).priority = number;
        });
        self.save_state()?;
        self.sync_queue()
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
                let priority = state.next_priority();
                let user_paused = handle.is_paused();
                state.torrents.insert(
                    *id,
                    TorrentEntry {
                        priority,
                        user_paused,
                        source: String::new(),
                    },
                );
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
                    priority: entry.map(|e| e.priority).unwrap_or(u32::MAX),
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

async fn set_paused(
    session: &Arc<Session>,
    handle: &Arc<ManagedTorrent>,
    paused: bool,
) -> Option<String> {
    if handle.is_paused() == paused {
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
            if handle.is_paused() == paused {
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
    let priority = entry.map(|e| e.priority).unwrap_or(0);
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
