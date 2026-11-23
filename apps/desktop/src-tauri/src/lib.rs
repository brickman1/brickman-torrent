//! Tauri entry point: the desktop UI driving `brickman-core`.
//!
//! Every command here runs the synchronous `brickman_core::Downloader` on a
//! blocking thread. The core owns its private tokio runtime, so calling it from
//! an async command directly would panic with "no reactor running" — the
//! `run_blocking` helper is the single place where that is handled.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use brickman_core::{
    AddOptions, ConnectionOptions, DEFAULT_PEER_LIMIT, Downloader, DownloaderOptions,
    OutputDirChange, SessionView, Source, TorrentId, TorrentState, TorrentView, default_data_dir,
    default_download_dir, normalize_peer_limit, now_ms,
};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

mod handler;
mod launch;
mod power;
mod settings_store;

/// Event that carries a `magnet:` link or a `.torrent` file to the window.
const LINK_EVENT: &str = "link-received";
/// Upper bound of the clipboard text handed to the UI: a magnet link is well
/// under 1 KiB, and a pasted document must not travel to the frontend.
const CLIPBOARD_LIMIT: usize = 8 * 1024;

/// Event that tells the window what the tray menu asked for; the payload is the
/// action, currently only `pause-all`.
const TRAY_ACTION_EVENT: &str = "tray-action";
/// Ids of the tray menu items. The frontend renames the items for its language,
/// so the ids, not the texts, say which item was clicked.
const TRAY_SHOW_ID: &str = "tray-show";
const TRAY_PAUSE_ID: &str = "tray-pause";
const TRAY_QUIT_ID: &str = "tray-quit";

/// Sub folder of the data folder where a `.torrent` dropped on the window is
/// staged: the webview hides the real path of a dropped file, so the frontend
/// hands over the bytes and gets a path back.
const STAGED_DIR: &str = "dropped";
/// A `.torrent` file is a few kilobytes; anything this large is not one.
const STAGED_LIMIT: usize = 8 * 1024 * 1024;
/// A staged file the add dialog never used is cleaned up after this long.
const STAGED_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// Longest staged file name kept, so the folder stays readable.
const STAGED_NAME_LIMIT: usize = 120;

/// Release feed checked by `check_for_updates`.
const UPDATE_URL: &str = "https://api.github.com/repos/brickman1/brickman-torrent/releases/latest";
/// The update check must not hang the UI or the network.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(5);
/// How many changelog lines the update dialog shows.
const UPDATE_CHANGELOG_LINES: usize = 8;

const KB: u64 = 1024;

// --------------------------------------------------------------------- DTOs

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiecesDto {
    have: u32,
    total: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TorrentDto {
    id: String,
    ordinal: u32,
    name: String,
    size: u64,
    status: &'static str,
    progress: f64,
    down_speed: u64,
    up_speed: u64,
    seeds: u32,
    seeds_total: u32,
    peers: u32,
    peers_total: u32,
    eta_sec: Option<u64>,
    priority: u32,
    label: String,
    queued: bool,
    added_at: u64,
    downloaded: u64,
    uploaded: u64,
    ratio: f64,
    save_path: String,
    hash: String,
    pieces: PiecesDto,
    connections: u32,
    comment: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatsDto {
    down_speed: u64,
    up_speed: u64,
    active: u32,
    port_open: bool,
    port: u16,
    /// UPnP forwarding was requested at startup (librqbit reports no result).
    upnp_requested: bool,
    /// The uTP listener was requested at startup.
    utp_enabled: bool,
    /// Concurrent peers per torrent, `0` = no limit.
    peer_limit: u32,
    peers_tcp: u32,
    peers_utp: u32,
    dht_nodes: u32,
    max_active: u32,
    down_limit: u64,
    up_limit: u64,
}

/// Per-add network options, as the settings dialog sends them.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionSettingsInput {
    #[serde(default)]
    upnp_enabled: Option<bool>,
    #[serde(default)]
    utp_enabled: Option<bool>,
    #[serde(default)]
    peer_limit: Option<u32>,
    #[serde(default)]
    extra_trackers: Vec<String>,
}

/// What `set_connection_settings` could apply and what needs a restart.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionChangeDto {
    restart_required: bool,
    /// Peer limit for the next torrents, `0` = no limit.
    peer_limit: u32,
    trackers: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDto {
    id: usize,
    path: String,
    size: u64,
    downloaded: u64,
    progress: f64,
    /// `1` = download, `-1` = don't download (the UI only offers these two).
    priority: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackerDto {
    url: String,
    tier: u32,
    status: &'static str,
    peers: u32,
    seeds: u32,
    next_announce_sec: u64,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerDto {
    address: String,
    client: String,
    down: u64,
    up: u64,
    progress: f64,
    flags: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDto {
    available: bool,
    current_version: String,
    version: Option<String>,
    changelog: Vec<String>,
    url: Option<String>,
    checked_at: u64,
}

/// Answer of `set_torrent_output_dir`: the torrent snapshot plus what happened
/// to the files that were already on disk.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputDirChangeDto {
    torrent: TorrentDto,
    moved_files: u32,
    failed_moves: Vec<String>,
}

/// What a `.torrent` file contains, without adding it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TorrentPreviewDto {
    name: String,
    files: u32,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
}

// ------------------------------------------------------------------- state

/// Per-peer byte counters sampled on each `list_peers` call, so the UI can show
/// per-peer speeds instead of lifetime totals.
#[derive(Debug, Clone, Copy)]
struct PeerSample {
    fetched: u64,
    uploaded: u64,
    at: Instant,
}

struct Engine {
    downloader: Downloader,
    add_dir: Mutex<PathBuf>,
    peer_samples: Mutex<HashMap<(u32, String), PeerSample>>,
}

/// Where and how a new torrent is added (per-add overrides of the settings).
#[derive(Debug, Clone, Default)]
struct AddRequest {
    output_dir: Option<PathBuf>,
    create_subfolder: Option<bool>,
    start_paused: bool,
}

impl Engine {
    fn new(
        data_dir: PathBuf,
        download_dir: PathBuf,
        connections: ConnectionOptions,
    ) -> Result<Self, String> {
        let downloader =
            Downloader::new(DownloaderOptions::new(data_dir, download_dir.clone()).with_connections(connections))
                .map_err(|error| error.to_string())?;
        Ok(Self {
            downloader,
            add_dir: Mutex::new(download_dir),
            peer_samples: Mutex::new(HashMap::new()),
        })
    }

    fn add_dir(&self) -> PathBuf {
        lock(&self.add_dir).clone()
    }

    fn set_add_dir(&self, dir: PathBuf) -> Result<(), String> {
        brickman_core::validate_output_dir(&dir).map_err(user_message)?;
        *lock(&self.add_dir) = dir;
        Ok(())
    }

    fn add(&self, source: Source, request: AddRequest) -> Result<u32, String> {
        let options = AddOptions {
            output_dir: Some(request.output_dir.unwrap_or_else(|| self.add_dir())),
            create_subfolder: request.create_subfolder,
            start_paused: request.start_paused,
            ..Default::default()
        };
        self.downloader
            .add(source, options)
            .map(|id| id.0)
            .map_err(user_message)
    }

    /// Fresh snapshot of one torrent, used as the return value of the add
    /// commands.
    fn snapshot(&self, raw_id: u32) -> Result<TorrentDto, String> {
        let views = self.downloader.list();
        let (index, view) = views
            .iter()
            .enumerate()
            .find(|(_, view)| view.id.0 == raw_id)
            .ok_or_else(|| "torrent is not managed by the engine".to_string())?;
        Ok(torrent_dto(index, view))
    }
}

/// Errors of the core carry a prefix (`invalid argument: …`) that only means
/// something to a programmer; the UI shows the rest as it is.
fn user_message(error: brickman_core::Error) -> String {
    match error {
        brickman_core::Error::InvalidArgument(message) => message,
        other => other.to_string(),
    }
}

struct AppState {
    engine: tokio::sync::Mutex<Option<Arc<Engine>>>,
    /// Set once `engine_init` created the engine: only then can the window
    /// receive a `link-received` event.
    engine_ready: AtomicBool,
    /// Links that arrived before the engine existed (a `magnet:` link on the
    /// command line of the first launch); `engine_init` flushes them.
    links: Mutex<Vec<launch::LinkPayload>>,
    /// `.torrent` files passed on the command line; added once the UI told us
    /// where to download to.
    pending: Mutex<Vec<PathBuf>>,
    /// Shut down / sleep once every download has finished.
    power: Arc<power::PowerState>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn engine(state: &State<'_, AppState>) -> Result<Arc<Engine>, String> {
    state
        .engine
        .lock()
        .await
        .clone()
        .ok_or_else(|| "engine is not initialized".to_string())
}

/// Runs `task` on a blocking thread: the core's methods use `block_on` on their
/// own runtime and must never run inside an async task.
async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("engine task failed: {error}"))?
}

/// Sends a link to the window; a failure is logged, not fatal: the app keeps
/// running, only this link is lost.
fn emit_link(app: &AppHandle, payload: launch::LinkPayload) {
    if let Err(error) = app.emit(LINK_EVENT, payload) {
        eprintln!("[brickman-torrent] cannot send {LINK_EVENT}: {error}");
    }
}

/// Hands a link to the window. Before the engine exists the window is still
/// starting and cannot receive events yet, so the link is queued instead and
/// `engine_init` flushes the queue.
fn deliver_link(app: &AppHandle, target: &launch::LaunchTarget) {
    let payload = launch::LinkPayload::new(target);
    let state = app.state::<AppState>();
    if state.engine_ready.load(Ordering::Acquire) {
        emit_link(app, payload);
    } else {
        lock(&state.links).push(payload);
    }
}

// ------------------------------------------------------------------ mapping

fn status_name(state: TorrentState) -> &'static str {
    match state {
        TorrentState::FetchingMetadata | TorrentState::Checking => "checking",
        TorrentState::Downloading => "downloading",
        TorrentState::Seeding => "seeding",
        TorrentState::Done => "completed",
        TorrentState::Queued => "queued",
        TorrentState::Paused => "paused",
        TorrentState::Error => "error",
    }
}

fn torrent_dto(index: usize, view: &TorrentView) -> TorrentDto {
    let remaining = view.total_bytes.saturating_sub(view.downloaded_bytes);
    let eta_sec = (view.down_bps > 0 && remaining > 0)
        .then(|| remaining.div_ceil(view.down_bps))
        .filter(|seconds| *seconds > 0);
    let ratio = if view.downloaded_bytes > 0 {
        view.uploaded_bytes as f64 / view.downloaded_bytes as f64
    } else {
        0.0
    };

    TorrentDto {
        id: view.id.0.to_string(),
        ordinal: u32::try_from(index + 1).unwrap_or(u32::MAX),
        name: view.name.clone(),
        size: view.total_bytes,
        status: status_name(view.state),
        progress: view.progress,
        down_speed: view.down_bps,
        up_speed: view.up_bps,
        // librqbit exposes connected counts only; the "(connected) / (connected)"
        // columns therefore show the same number twice.
        seeds: view.seeds,
        seeds_total: view.seeds,
        peers: view.peers,
        peers_total: view.peers,
        eta_sec,
        priority: view.priority,
        label: String::new(),
        queued: matches!(view.state, TorrentState::Queued),
        added_at: view.added_at_ms,
        downloaded: view.downloaded_bytes,
        uploaded: view.uploaded_bytes,
        ratio,
        save_path: view.save_path.to_string_lossy().into_owned(),
        hash: view.hash.clone(),
        pieces: PiecesDto {
            have: view.pieces_done,
            total: view.pieces,
        },
        connections: view.peers,
        comment: String::new(),
    }
}

fn session_stats_dto(view: &SessionView) -> SessionStatsDto {
    SessionStatsDto {
        down_speed: view.down_bps,
        up_speed: view.up_bps,
        active: view.active,
        port_open: view.port_open,
        port: view.port,
        upnp_requested: view.upnp_requested,
        utp_enabled: view.utp_enabled,
        peer_limit: view.peer_limit,
        peers_tcp: view.peers_tcp,
        peers_utp: view.peers_utp,
        dht_nodes: view.dht_nodes,
        max_active: view.max_active,
        // The settings dialog works in kB/s; the core stores bytes per second.
        down_limit: view.down_limit_bps / KB,
        up_limit: view.up_limit_bps / KB,
    }
}

/// Settings dialog → core options. A missing switch keeps the recommended
/// default (both transports on, 200 peers per torrent); a limit of `0` means
/// "no limit", like everywhere else in the settings.
fn connection_options(input: Option<ConnectionSettingsInput>) -> ConnectionOptions {
    let Some(input) = input else {
        return ConnectionOptions::default();
    };
    ConnectionOptions {
        upnp_port_forwarding: input.upnp_enabled.unwrap_or(true),
        utp_enabled: input.utp_enabled.unwrap_or(true),
        peer_limit: normalize_peer_limit(
            input.peer_limit.or(Some(DEFAULT_PEER_LIMIT)),
        ),
        extra_trackers: input.extra_trackers,
    }
}

fn parse_ids(ids: &[String]) -> Result<Vec<TorrentId>, String> {
    ids.iter()
        .map(|raw| {
            raw.trim()
                .parse::<u32>()
                .map(TorrentId)
                .map_err(|_| format!("invalid torrent id {raw:?}"))
        })
        .collect()
}

fn kb_to_bps(kilobytes: u64) -> Option<u64> {
    (kilobytes > 0).then_some(kilobytes.saturating_mul(KB))
}

// --------------------------------------------------------------- commands

/// Creates the engine once, using the download folder and the network options
/// from the UI settings. A second call only updates the folder used for new
/// torrents: the listener of a running engine cannot be rebuilt.
#[tauri::command]
async fn engine_init(
    download_dir: Option<String>,
    connections: Option<ConnectionSettingsInput>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let dir = match download_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
    {
        Some(dir) => PathBuf::from(dir),
        None => default_download_dir(),
    };

    let mut guard = state.engine.lock().await;
    if let Some(engine) = guard.as_ref() {
        return engine.set_add_dir(dir);
    }

    let pending = std::mem::take(&mut *lock(&state.pending));
    let data_dir = default_data_dir();
    let download_dir = dir.clone();
    let connections = connection_options(connections);
    let engine = run_blocking(move || {
        let engine = Engine::new(data_dir, download_dir, connections)?;
        for path in pending {
            match engine.add(Source::TorrentFile(path.clone()), AddRequest::default()) {
                Ok(id) => eprintln!("[brickman-torrent] added {} as #{id}", path.display()),
                Err(error) => {
                    eprintln!("[brickman-torrent] cannot add {}: {error}", path.display());
                }
            }
        }
        Ok(engine)
    })
    .await?;

    *guard = Some(Arc::new(engine));
    drop(guard);

    // The window registers its `link-received` listener before it calls
    // `engine_init`, so this is the first moment a link found on the command
    // line of the first launch can be delivered.
    state.engine_ready.store(true, Ordering::Release);
    for payload in std::mem::take(&mut *lock(&state.links)) {
        emit_link(&app, payload);
    }
    Ok(())
}

/// Download folder for torrents added from now on.
#[tauri::command]
async fn set_download_dir(dir: String, state: State<'_, AppState>) -> Result<(), String> {
    let engine = engine(&state).await?;
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        return Ok(());
    }
    run_blocking(move || engine.set_add_dir(PathBuf::from(dir))).await
}

/// The system default download folder, so the settings can show the real path
/// when the field is empty.
#[tauri::command]
fn default_download_folder() -> String {
    default_download_dir().to_string_lossy().into_owned()
}

/// Checks a download folder before anything is added: the folder is created when
/// missing and a probe file is written and removed, so "no such drive", "path is
/// a file" and "no write permission" come back as readable text.
#[tauri::command]
async fn validate_download_dir(path: String) -> Result<(), String> {
    run_blocking(move || {
        brickman_core::validate_output_dir(std::path::Path::new(path.trim()))
            .map_err(user_message)
    })
    .await
}

/// Native folder picker. Returns `None` when the user cancelled.
#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    run_blocking(move || {
        // The dialog is modal to the window, so the call must not run on the UI
        // thread.
        let picked = app.dialog().file().blocking_pick_folder();
        Ok(picked
            .and_then(|folder| folder.into_path().ok())
            .map(|folder| folder.to_string_lossy().into_owned()))
    })
    .await
}

/// First entry of `paths` that is a directory; used for dropping a folder on
/// the window (files are not part of this feature).
#[tauri::command]
async fn first_directory(paths: Vec<String>) -> Result<Option<String>, String> {
    run_blocking(move || {
        Ok(paths
            .into_iter()
            .find(|path| std::path::Path::new(path).is_dir()))
    })
    .await
}

/// Opens a folder in the file manager. With `id` the folder of that torrent is
/// opened; a single-file torrent reveals the file itself.
#[tauri::command]
async fn open_folder(
    id: Option<String>,
    path: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let engine = engine(&state).await?;
    run_blocking(move || {
        let target = match (id, path) {
            (Some(raw), _) => torrent_folder(&engine, &raw)?,
            (None, Some(path)) if !path.trim().is_empty() => PathBuf::from(path.trim()),
            _ => return Err("no folder given".to_string()),
        };
        if target.is_dir() {
            app.opener()
                .open_path(target.to_string_lossy().as_ref(), None::<&str>)
                .map_err(|error| format!("cannot open {}: {error}", target.display()))
        } else if target.is_file() {
            app.opener()
                .reveal_item_in_dir(&target)
                .map_err(|error| format!("cannot open {}: {error}", target.display()))
        } else {
            Err(format!("folder not found: {}", target.display()))
        }
    })
    .await
}

/// The path to open for a torrent: the single file when it has exactly one
/// (revealed in its folder), otherwise the torrent's folder.
fn torrent_folder(engine: &Engine, raw: &str) -> Result<PathBuf, String> {
    let id = raw
        .trim()
        .parse::<u32>()
        .map(TorrentId)
        .map_err(|_| format!("invalid torrent id {raw:?}"))?;
    let views = engine.downloader.list();
    let view = views
        .iter()
        .find(|view| view.id == id)
        .ok_or_else(|| format!("torrent #{id} is not managed by the engine"))?;
    let files = engine
        .downloader
        .files(id)
        .map_err(|error| error.to_string())?;
    if files.len() == 1 {
        let relative = files[0].path.replace('/', std::path::MAIN_SEPARATOR_STR);
        let single = view.save_path.join(relative);
        if single.is_file() {
            return Ok(single);
        }
    }
    Ok(view.save_path.clone())
}

/// Moves a stopped torrent to another download folder.
#[tauri::command]
async fn set_torrent_output_dir(
    id: String,
    dir: String,
    state: State<'_, AppState>,
) -> Result<OutputDirChangeDto, String> {
    let engine = engine(&state).await?;
    let torrent_id = parse_ids(&[id])?
        .into_iter()
        .next()
        .ok_or_else(|| "missing torrent id".to_string())?;
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        return Err("empty download folder".to_string());
    }
    let dir = PathBuf::from(dir);

    run_blocking(move || {
        let OutputDirChange {
            id: new_id,
            moved_files,
            failed_moves,
        } = engine
            .downloader
            .set_output_dir(torrent_id, &dir)
            .map_err(user_message)?;
        Ok(OutputDirChangeDto {
            torrent: engine.snapshot(new_id.0)?,
            moved_files: u32::try_from(moved_files).unwrap_or(u32::MAX),
            failed_moves,
        })
    })
    .await
}

#[tauri::command]
async fn list_torrents(state: State<'_, AppState>) -> Result<Vec<TorrentDto>, String> {
    let engine = engine(&state).await?;
    let monitor = Arc::clone(&state.power);
    run_blocking(move || {
        // The UI polls once per second; that is also what keeps the queue
        // moving (a torrent added during its initial check stays paused until
        // the next pass).
        if let Err(error) = engine.downloader.tick() {
            eprintln!("[brickman-torrent] queue tick failed: {error}");
        }
        let views = engine.downloader.list();

        // The same poll drives the "power off when done" monitor. A torrent
        // counts as finished only when the engine says so; a paused or stopped
        // torrent that never reached 100 % keeps the condition false.
        let progress: Vec<power::TorrentProgress> = views
            .iter()
            .map(|view| power::TorrentProgress {
                id: view.id.0,
                complete: matches!(view.state, TorrentState::Seeding | TorrentState::Done)
                    || view.progress >= 0.999,
            })
            .collect();
        if let Some(command) = monitor.observe(&progress)
            && let Err(error) = power::run(&command, monitor.log_path())
        {
            eprintln!("[brickman-torrent] power action failed: {error}");
        }

        Ok(views
            .iter()
            .enumerate()
            .map(|(index, view)| torrent_dto(index, view))
            .collect())
    })
    .await
}

#[tauri::command]
async fn get_session_stats(state: State<'_, AppState>) -> Result<SessionStatsDto, String> {
    let engine = engine(&state).await?;
    run_blocking(move || Ok(session_stats_dto(&engine.downloader.session_stats()))).await
}

#[tauri::command]
async fn add_torrent_file(
    name: Option<String>,
    output_dir: Option<String>,
    create_subfolder: Option<bool>,
    start_paused: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TorrentDto, String> {
    let engine = engine(&state).await?;
    let name = name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());
    let request = AddRequest {
        output_dir: parse_output_dir(output_dir),
        create_subfolder,
        start_paused: start_paused.unwrap_or(false),
    };

    let monitor = Arc::clone(&state.power);
    run_blocking(move || {
        let path = match name {
            Some(path) => PathBuf::from(path),
            None => ask_torrent_file(&app)?,
        };
        if let Some(dir) = request.output_dir.as_deref() {
            // Validate before the metadata fetch: a wrong folder must be
            // reported as a folder problem, not as a failed download.
            brickman_core::validate_output_dir(dir).map_err(user_message)?;
        }
        let id = engine.add(Source::TorrentFile(path.clone()), request)?;
        // A staged drop is only a temporary copy: the engine has the metadata
        // now, so the file does not have to stay in the data folder.
        if is_staged(&staged_dir(), &path) {
            let _ = std::fs::remove_file(&path);
        }
        // A new download is a reason to stop a running "power off" countdown.
        monitor.cancel_countdown();
        engine.snapshot(id)
    })
    .await
}

/// Native file picker; must run on a blocking thread, not on the UI thread.
fn ask_torrent_file(app: &AppHandle) -> Result<PathBuf, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Torrent files", &["torrent"])
        .blocking_pick_file();
    match picked {
        Some(file) => file
            .into_path()
            .map_err(|error| format!("cannot read the selected file: {error}")),
        None => Err("no torrent file selected".to_string()),
    }
}

/// Same picker for the UI, where a cancelled dialog is not an error.
#[tauri::command]
async fn pick_torrent_file(app: AppHandle) -> Result<Option<String>, String> {
    run_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("Torrent files", &["torrent"])
            .blocking_pick_file();
        Ok(picked
            .and_then(|file| file.into_path().ok())
            .map(|file| file.to_string_lossy().into_owned()))
    })
    .await
}

// ------------------------------------------------------- dropped torrent files

/// Folder where a `.torrent` dropped on the window is staged.
fn staged_dir() -> PathBuf {
    default_data_dir().join(STAGED_DIR)
}

/// A dropped file name as a single usable path component.
///
/// The name comes from the dropped file, so it is only trusted after the path
/// separators and the characters Windows refuses are gone; a name that is still
/// unusable (a reserved device name, an empty one) becomes `dropped.torrent`.
fn staged_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let mut cleaned: String = base
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .collect();
    // Windows cannot create a name that ends with a space or a dot.
    cleaned = cleaned.trim_matches([' ', '.']).to_string();
    while cleaned.len() > STAGED_NAME_LIMIT {
        cleaned.pop();
    }
    if cleaned.is_empty() {
        return "dropped.torrent".to_string();
    }
    if !cleaned.to_ascii_lowercase().ends_with(".torrent") {
        cleaned.push_str(".torrent");
    }
    if brickman_core::validate_component(&cleaned).is_err() {
        return "dropped.torrent".to_string();
    }
    cleaned
}

/// Writes the bytes of a dropped `.torrent` into `dir` and returns the path.
///
/// `name` is only a hint: the file is never overwritten, so a second drop with
/// the same name gets `name-1.torrent` and a dialog that is still open keeps
/// working with the file it was given.
fn stage_torrent_in(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("the dropped file is empty".to_string());
    }
    if bytes.len() > STAGED_LIMIT {
        return Err(format!(
            "the dropped file is too large ({} bytes)",
            bytes.len()
        ));
    }
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    prune_staged(dir);

    let name = staged_file_name(name);
    let stem = Path::new(&name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "dropped".to_string());
    let mut path = dir.join(&name);
    let mut counter = 1_u32;
    while path.exists() {
        if counter > 1000 {
            return Err(format!("too many staged files in {}", dir.display()));
        }
        path = dir.join(format!("{stem}-{counter}.torrent"));
        counter += 1;
    }
    std::fs::write(&path, bytes)
        .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    Ok(path)
}

/// Writes a dropped `.torrent` to the staging folder of the app.
fn stage_torrent_bytes(name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    stage_torrent_in(&staged_dir(), name, bytes)
}

/// Drops staged files nothing used, so a cancelled add dialog does not leak.
fn prune_staged(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > STAGED_MAX_AGE);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// True for a file this app staged: only such a copy is deleted after the
/// engine read it, a file the user picked is never touched.
fn is_staged(dir: &Path, path: &Path) -> bool {
    path.starts_with(dir)
}

/// Writes a `.torrent` dropped on the window to the staging folder.
///
/// The webview hands over the bytes of a dropped file, not its path; this turns
/// them back into a file so preview, the add dialog and the engine work exactly
/// like with a file from the file dialog.
#[tauri::command]
async fn stage_torrent_file(name: String, bytes: Vec<u8>) -> Result<String, String> {
    run_blocking(move || {
        Ok(stage_torrent_bytes(&name, &bytes)?
            .to_string_lossy()
            .into_owned())
    })
    .await
}

/// Name and file count of a `.torrent` file, without adding it. The add dialog
/// needs the count to decide about the per-torrent sub folder.
#[tauri::command]
async fn preview_torrent_file(
    name: String,
    state: State<'_, AppState>,
) -> Result<TorrentPreviewDto, String> {
    let engine = engine(&state).await?;
    let path = PathBuf::from(name.trim());
    run_blocking(move || {
        let preview = engine
            .downloader
            .inspect(&Source::TorrentFile(path), brickman_core::DEFAULT_METADATA_TIMEOUT)
            .map_err(user_message)?;
        Ok(TorrentPreviewDto {
            name: preview.name.unwrap_or_default(),
            files: u32::try_from(preview.file_count).unwrap_or(u32::MAX),
        })
    })
    .await
}

fn parse_output_dir(dir: Option<String>) -> Option<PathBuf> {
    dir.map(|dir| dir.trim().to_string())
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

#[tauri::command]
async fn add_magnet(
    uri: Option<String>,
    output_dir: Option<String>,
    create_subfolder: Option<bool>,
    start_paused: Option<bool>,
    state: State<'_, AppState>,
) -> Result<TorrentDto, String> {
    let engine = engine(&state).await?;
    let uri = uri
        .map(|uri| uri.trim().to_string())
        .filter(|uri| !uri.is_empty())
        .ok_or_else(|| "empty magnet link".to_string())?;
    if !uri.starts_with("magnet:") {
        return Err("only magnet: links are accepted here".to_string());
    }
    let request = AddRequest {
        output_dir: parse_output_dir(output_dir),
        create_subfolder,
        start_paused: start_paused.unwrap_or(false),
    };

    let monitor = Arc::clone(&state.power);
    run_blocking(move || {
        if let Some(dir) = request.output_dir.as_deref() {
            brickman_core::validate_output_dir(dir).map_err(user_message)?;
        }
        let id = engine.add(Source::Magnet(uri), request)?;
        // A new download is a reason to stop a running "power off" countdown.
        monitor.cancel_countdown();
        engine.snapshot(id)
    })
    .await
}

#[tauri::command]
async fn resume_torrents(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let engine = engine(&state).await?;
    let ids = parse_ids(&ids)?;
    let monitor = Arc::clone(&state.power);
    run_blocking(move || {
        for id in ids {
            engine
                .downloader
                .resume(id)
                .map_err(|error| error.to_string())?;
        }
        // A lifted pause means downloads are running again: no countdown.
        monitor.cancel_countdown();
        Ok(())
    })
    .await
}

#[tauri::command]
async fn pause_torrents(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let engine = engine(&state).await?;
    let ids = parse_ids(&ids)?;
    run_blocking(move || {
        for id in ids {
            engine
                .downloader
                .pause(id)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
}

/// The core has a single user-pause flag, so "stop" and "pause" are the same
/// operation: the torrent leaves the queue and stays down until resumed.
#[tauri::command]
async fn stop_torrents(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    pause_torrents(ids, state).await
}

#[tauri::command]
async fn remove_torrents(
    ids: Vec<String>,
    delete_data: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let engine = engine(&state).await?;
    let ids = parse_ids(&ids)?;
    run_blocking(move || {
        for id in ids {
            engine
                .downloader
                .remove(id, delete_data)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
}

/// Moves a torrent to a zero-based queue position; the UI sends the position
/// of the drop indicator. The queue is applied on the next tick, which the
/// list poll already runs once per second (and the command runs it directly).
#[tauri::command]
async fn move_torrent(
    id: String,
    index: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let engine = engine(&state).await?;
    let id = parse_ids(&[id])?
        .into_iter()
        .next()
        .ok_or_else(|| "missing torrent id".to_string())?;
    run_blocking(move || {
        engine
            .downloader
            .move_to(id, index)
            .map_err(|error| error.to_string())
    })
    .await
}

/// Steps a torrent one position up (`delta < 0`) or down in the queue.
#[tauri::command]
async fn move_torrent_by(
    id: String,
    delta: i32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let engine = engine(&state).await?;
    let id = parse_ids(&[id])?
        .into_iter()
        .next()
        .ok_or_else(|| "missing torrent id".to_string())?;
    run_blocking(move || {
        let result = if delta < 0 {
            engine.downloader.move_up(id)
        } else {
            engine.downloader.move_down(id)
        };
        result.map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn set_max_active(max_active: u32, state: State<'_, AppState>) -> Result<(), String> {
    let engine = engine(&state).await?;
    run_blocking(move || {
        engine
            .downloader
            .set_max_active(max_active)
            .map_err(|error| error.to_string())
    })
    .await
}

/// Connection settings from the dialog: the peer limit and the extra trackers
/// are applied to the next torrents, a change of UPnP or uTP needs a restart
/// (the listener is created once, inside the engine).
#[tauri::command]
async fn set_connection_settings(
    connections: ConnectionSettingsInput,
    state: State<'_, AppState>,
) -> Result<ConnectionChangeDto, String> {
    let engine = engine(&state).await?;
    let options = connection_options(Some(connections));
    run_blocking(move || {
        let change = engine.downloader.set_connection_options(options);
        Ok(ConnectionChangeDto {
            restart_required: change.restart_required,
            peer_limit: change.peer_limit.unwrap_or(0),
            trackers: u32::try_from(change.trackers).unwrap_or(u32::MAX),
        })
    })
    .await
}

/// Limits arrive in kB/s (the unit of the settings dialog), `0` = unlimited.
#[tauri::command]
async fn set_limits(
    down_limit: u64,
    up_limit: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let engine = engine(&state).await?;
    run_blocking(move || {
        engine
            .downloader
            .set_limits(kb_to_bps(down_limit), kb_to_bps(up_limit))
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn list_files(id: String, state: State<'_, AppState>) -> Result<Vec<FileDto>, String> {
    let engine = engine(&state).await?;
    let id = parse_ids(&[id])?
        .into_iter()
        .next()
        .ok_or_else(|| "missing torrent id".to_string())?;
    run_blocking(move || {
        Ok(engine
            .downloader
            .files(id)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|file| FileDto {
                id: file.index,
                path: file.path,
                size: file.len,
                downloaded: file.downloaded,
                progress: file.progress,
                priority: if file.included { 1 } else { -1 },
            })
            .collect())
    })
    .await
}

#[tauri::command]
async fn set_file_priority(
    id: String,
    file_id: usize,
    priority: i32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let engine = engine(&state).await?;
    let id = parse_ids(&[id])?
        .into_iter()
        .next()
        .ok_or_else(|| "missing torrent id".to_string())?;
    run_blocking(move || {
        engine
            .downloader
            .set_file_included(id, file_id, priority >= 0)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn list_trackers(id: String, state: State<'_, AppState>) -> Result<Vec<TrackerDto>, String> {
    let engine = engine(&state).await?;
    let id = parse_ids(&[id])?
        .into_iter()
        .next()
        .ok_or_else(|| "missing torrent id".to_string())?;
    run_blocking(move || {
        let live = engine
            .downloader
            .list()
            .iter()
            .any(|view| view.id == id && view.state == TorrentState::Downloading);
        Ok(engine
            .downloader
            .trackers(id)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|tracker| TrackerDto {
                url: tracker.url,
                tier: tracker.tier,
                status: if live { "working" } else { "idle" },
                peers: 0,
                seeds: 0,
                next_announce_sec: 0,
                message: String::new(),
            })
            .collect())
    })
    .await
}

#[tauri::command]
async fn list_peers(id: String, state: State<'_, AppState>) -> Result<Vec<PeerDto>, String> {
    let engine = engine(&state).await?;
    let id = parse_ids(&[id])?
        .into_iter()
        .next()
        .ok_or_else(|| "missing torrent id".to_string())?;
    run_blocking(move || {
        let peers = engine
            .downloader
            .peers(id)
            .map_err(|error| error.to_string())?;
        let now = Instant::now();
        let mut samples = lock(&engine.peer_samples);
        let mut result = Vec::with_capacity(peers.len());
        for peer in peers {
            let key = (id.0, peer.address.clone());
            let (down, up) = match samples.get(&key) {
                Some(previous) => {
                    let seconds = now.duration_since(previous.at).as_secs_f64().max(0.001);
                    let down = peer.fetched_bytes.saturating_sub(previous.fetched) as f64 / seconds;
                    let up = peer.uploaded_bytes.saturating_sub(previous.uploaded) as f64 / seconds;
                    (down as u64, up as u64)
                }
                None => (0, 0),
            };
            samples.insert(
                key,
                PeerSample {
                    fetched: peer.fetched_bytes,
                    uploaded: peer.uploaded_bytes,
                    at: now,
                },
            );
            result.push(PeerDto {
                address: peer.address,
                client: peer.client.unwrap_or_default(),
                down,
                up,
                // librqbit does not expose per-peer progress, only its state.
                progress: 0.0,
                flags: peer.state,
            });
        }
        // Drop counters of peers that disconnected since the last call.
        let seen: HashSet<&str> = result.iter().map(|peer| peer.address.as_str()).collect();
        samples.retain(|(torrent, address), _| *torrent != id.0 || seen.contains(address.as_str()));
        Ok(result)
    })
    .await
}

/// The only non-BitTorrent request the app makes: a single `GET` to the GitHub
/// release feed. `404` (repository not published yet) means "up to date".
#[tauri::command]
async fn check_for_updates() -> Result<UpdateDto, String> {
    run_blocking(|| {
        let current_version = env!("CARGO_PKG_VERSION").to_string();
        let checked_at = now_ms();
        let client = reqwest::blocking::Client::builder()
            .timeout(UPDATE_TIMEOUT)
            .user_agent(format!("brickman-torrent/{current_version}"))
            .build()
            .map_err(|error| format!("cannot create the HTTP client: {error}"))?;
        let response = client
            .get(UPDATE_URL)
            .header("Accept", "application/vnd.github+json")
            .send()
            .map_err(|error| format!("update check failed: {error}"))?;

        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(UpdateDto {
                available: false,
                current_version,
                version: None,
                changelog: Vec::new(),
                url: None,
                checked_at,
            });
        }
        if !status.is_success() {
            return Err(format!("update check failed: HTTP {status}"));
        }

        let release: GithubRelease = response
            .json()
            .map_err(|error| format!("cannot parse the release feed: {error}"))?;
        let version = release.tag_name.trim().trim_start_matches('v').to_string();
        if version.is_empty() {
            return Ok(UpdateDto {
                available: false,
                current_version,
                version: None,
                changelog: Vec::new(),
                url: None,
                checked_at,
            });
        }
        let available = version_is_newer(&version, &current_version);
        let changelog = release
            .body
            .as_deref()
            .map_or_else(Vec::new, changelog_lines);

        Ok(UpdateDto {
            available,
            current_version,
            version: Some(version),
            changelog: if available { changelog } else { Vec::new() },
            url: available.then_some(release.html_url).flatten(),
            checked_at,
        })
    })
    .await
}

fn changelog_lines(body: &str) -> Vec<String> {
    body.lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            line.trim_start_matches(['-', '*'])
                .trim()
                .replace(['`', '*'], "")
        })
        .filter(|line| !line.is_empty())
        .take(UPDATE_CHANGELOG_LINES)
        .collect()
}

/// Simple numeric comparison (`0.10.0` > `0.9.0`); prerelease suffixes are
/// ignored, which is enough for the release tags this project will publish.
fn version_is_newer(candidate: &str, current: &str) -> bool {
    fn numbers(text: &str) -> Vec<u64> {
        text.split(|c: char| !c.is_ascii_digit())
            .filter(|part| !part.is_empty())
            .filter_map(|part| part.parse().ok())
            .collect()
    }

    let candidate = numbers(candidate);
    let current = numbers(current);
    if candidate.is_empty() {
        return false;
    }
    for index in 0..candidate.len().max(current.len()) {
        let left = candidate.get(index).copied().unwrap_or(0);
        let right = current.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

/// Opens an `http(s)` link in the system browser. No other schemes are allowed.
#[tauri::command]
async fn open_external(url: String, app: AppHandle) -> Result<(), String> {
    let url = url.trim();
    let allowed = url.starts_with("https://") || url.starts_with("http://");
    if !allowed {
        return Err("only http and https links can be opened".to_string());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("cannot open {url}: {error}"))
}

/// Opens the Windows page "Default apps".
///
/// This is the fallback for the handler registration: Windows 11 may reset the
/// association after a major update, and the user can then pick the app there.
/// The URL is fixed here, so the frontend cannot pass another scheme.
#[tauri::command]
async fn open_default_apps(app: AppHandle) -> Result<(), String> {
    const URL: &str = "ms-settings:defaultapps";
    app.opener()
        .open_url(URL, None::<&str>)
        .map_err(|error| format!("cannot open {URL}: {error}"))
}

// ------------------------------------------------------- links and handlers

/// Text from the clipboard, for Ctrl+V in the "add link" dialog.
///
/// Only text is read. An image or a copied file is not an error, it simply has
/// no text; the result is trimmed and cut at [`CLIPBOARD_LIMIT`].
#[tauri::command]
async fn read_clipboard() -> Result<Option<String>, String> {
    run_blocking(|| {
        #[cfg(windows)]
        {
            let mut clipboard = arboard::Clipboard::new()
                .map_err(|error| format!("cannot open the clipboard: {error}"))?;
            match clipboard.get_text() {
                Ok(text) => Ok(clipboard_text(&text)),
                Err(arboard::Error::ContentNotAvailable) => Ok(None),
                Err(error) => Err(format!("cannot read the clipboard: {error}")),
            }
        }
        #[cfg(not(windows))]
        {
            Err("the clipboard is only supported on Windows".to_string())
        }
    })
    .await
}

/// Trims the clipboard text, drops it when empty and cuts it at
/// [`CLIPBOARD_LIMIT`] without splitting a multi-byte character.
fn clipboard_text(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if text.len() <= CLIPBOARD_LIMIT {
        return Some(text.to_string());
    }
    let mut end = CLIPBOARD_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(text[..end].trim_end().to_string())
}

/// This executable: what the shell has to run for a link or a file.
fn exe_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("brickman-desktop.exe"))
}

/// Whether the app is the `magnet:` handler and whether a backup of the
/// previous handlers exists.
#[tauri::command]
async fn handler_status() -> Result<handler::HandlerStatus, String> {
    run_blocking(|| Ok(handler::status(&exe_path(), &default_data_dir()))).await
}

/// Makes the app the `magnet:` and `.torrent` handler (per user, no admin
/// rights). The previous handlers are backed up before anything changes; the
/// answer is the new status, with `error` set when the registration failed.
#[tauri::command]
async fn handler_register() -> Result<handler::HandlerStatus, String> {
    run_blocking(|| {
        let (exe, data_dir) = (exe_path(), default_data_dir());
        let error = handler::register(&exe, &data_dir).err();
        let mut status = handler::status(&exe, &data_dir);
        status.error = error;
        Ok(status)
    })
    .await
}

/// Puts the handlers that were there before back and removes the backup.
#[tauri::command]
async fn handler_unregister() -> Result<handler::HandlerStatus, String> {
    run_blocking(|| {
        let (exe, data_dir) = (exe_path(), default_data_dir());
        let error = handler::unregister(&data_dir).err();
        let mut status = handler::status(&exe, &data_dir);
        status.error = error;
        Ok(status)
    })
    .await
}

// ------------------------------------------------------- power after download

/// State of the "power off when downloads finish" monitor, polled once a second
/// together with the torrent list.
#[tauri::command]
fn get_power_status(state: State<'_, AppState>) -> power::PowerStatusDto {
    state.power.status()
}

/// Stores the action and the delay; a running countdown is dropped.
#[tauri::command]
fn set_power_settings(
    action: String,
    delay_secs: u64,
    state: State<'_, AppState>,
) -> Result<power::PowerStatusDto, String> {
    let action = power::PowerAction::parse(&action)?;
    state
        .power
        .set_settings(power::PowerSettings::with(action, delay_secs));
    Ok(state.power.status())
}

/// The "Cancel" button of the countdown banner.
#[tauri::command]
fn cancel_power_off(state: State<'_, AppState>) -> Result<power::PowerStatusDto, String> {
    state.power.cancel();
    Ok(state.power.status())
}

// ---------------------------------------------------------- tray & window

/// Handles of the tray menu items: `set_tray_labels` renames them when the UI
/// language changes.
struct TrayMenu {
    show: MenuItem<tauri::Wry>,
    pause: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

/// Brings the main window up: while "close to tray" is on the window is only
/// hidden, so it has to be unminimized before it is shown.
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Creates the tray icon and its menu. The icon is owned by the app, so the
/// handle `build` returns is dropped on purpose: the icon stays while the app
/// runs.
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW_ID, "Show", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, TRAY_PAUSE_ID, "Pause all", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &pause, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("Brickman Torrent")
        .menu(&menu)
        // The left button belongs to "show the window"; the menu opens on the
        // right button.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => show_main_window(app),
            TRAY_PAUSE_ID => {
                if let Err(error) = app.emit(TRAY_ACTION_EVENT, "pause-all") {
                    eprintln!("[brickman-torrent] cannot send {TRAY_ACTION_EVENT}: {error}");
                }
            }
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    app.manage(TrayMenu { show, pause, quit });
    Ok(())
}

// ----------------------------------------------------- settings & autostart

/// The UI settings, `None` while the file does not exist yet.
#[tauri::command]
fn load_settings() -> Result<Option<serde_json::Value>, String> {
    settings_store::load(&default_data_dir())
}

/// Replaces the whole settings document; the frontend owns its fields.
#[tauri::command]
fn save_settings(settings: serde_json::Value) -> Result<(), String> {
    settings_store::save(&default_data_dir(), &settings)
}

/// Whether closing the window hides it to the tray instead of quitting. The
/// window event of the same name reads the value this command stores.
#[tauri::command]
fn set_close_to_tray(
    enabled: bool,
    close_to_tray: State<'_, Arc<AtomicBool>>,
) -> Result<(), String> {
    close_to_tray.store(enabled, Ordering::Relaxed);
    Ok(())
}

/// Whether the app is started with the system.
#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

/// Adds or removes the app from the programs the system starts at login.
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    result.map_err(|error| error.to_string())
}

/// Renames the tray menu items: the UI passes the texts of its language.
#[tauri::command]
fn set_tray_labels(
    show: String,
    pause: String,
    quit: String,
    app: AppHandle,
) -> Result<(), String> {
    let menu = app
        .try_state::<TrayMenu>()
        .ok_or("the tray icon is not created")?;
    for (item, text) in [(&menu.show, show), (&menu.pause, pause), (&menu.quit, quit)] {
        item.set_text(text)
            .map_err(|error| format!("cannot rename a tray item: {error}"))?;
    }
    Ok(())
}

// -------------------------------------------------------------------- entry

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A link or a `.torrent` file handed over by the shell. An existing torrent
    // file keeps the old path: `app.exe C:\path\to\file.torrent` is added once
    // the UI has told the engine where to download to. Everything else becomes
    // a `link-received` event after the engine exists, so the window can open
    // its add dialog (a magnet link, or a `.torrent` file that is gone).
    let mut pending: Vec<PathBuf> = Vec::new();
    let mut links: Vec<launch::LinkPayload> = Vec::new();
    if let Some(target) = launch::parse_launch_args(std::env::args().skip(1)) {
        match target {
            launch::LaunchTarget::Torrent(path) if launch::is_existing_torrent(&path) => {
                pending.push(path);
            }
            other => links.push(launch::LinkPayload::new(&other)),
        }
    }

    tauri::Builder::default()
        // Must be the first plugin: a second launch (`app.exe magnet:?…`) has to
        // reach the running app before anything else could start a second
        // engine on the same data folder.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(target) = launch::parse_launch_args(argv.into_iter().skip(1)) {
                deliver_link(app, &target);
            }
            // The link lands in the window of the running app: bring it up.
            show_main_window(app);
        }))
        // "Start with Windows" of the settings dialog: an HKCU `Run` value, no
        // admin rights needed.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // A tray that cannot be created is not fatal: the window keeps
            // working, only the tray menu is missing.
            if let Err(error) = setup_tray(app.handle()) {
                eprintln!("[brickman-torrent] cannot create the tray icon: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            if window.label() != "main" {
                return;
            }
            // With "close to tray" on, closing the window only hides it: the
            // downloads keep running and the tray brings the window back.
            if window.state::<Arc<AtomicBool>>().load(Ordering::Relaxed) {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .manage(AppState {
            engine: tokio::sync::Mutex::new(None),
            engine_ready: AtomicBool::new(false),
            links: Mutex::new(links),
            pending: Mutex::new(pending),
            power: Arc::new(power::PowerState::new(&default_data_dir())),
        })
        // Whether the window hides to the tray on close; `set_close_to_tray`
        // changes it at runtime, the default is on.
        .manage(Arc::new(AtomicBool::new(true)))
        .invoke_handler(tauri::generate_handler![
            engine_init,
            set_download_dir,
            default_download_folder,
            validate_download_dir,
            pick_directory,
            first_directory,
            pick_torrent_file,
            preview_torrent_file,
            stage_torrent_file,
            open_folder,
            set_torrent_output_dir,
            list_torrents,
            get_session_stats,
            add_torrent_file,
            add_magnet,
            resume_torrents,
            pause_torrents,
            stop_torrents,
            remove_torrents,
            move_torrent,
            move_torrent_by,
            set_max_active,
            set_connection_settings,
            set_limits,
            list_files,
            set_file_priority,
            list_trackers,
            list_peers,
            check_for_updates,
            open_external,
            open_default_apps,
            read_clipboard,
            handler_status,
            handler_register,
            handler_unregister,
            get_power_status,
            set_power_settings,
            cancel_power_off,
            load_settings,
            save_settings,
            set_close_to_tray,
            get_autostart,
            set_autostart,
            set_tray_labels,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_name_stays_one_usable_component() {
        assert_eq!(
            staged_file_name("ubuntu-24.04-desktop-amd64.iso.torrent"),
            "ubuntu-24.04-desktop-amd64.iso.torrent"
        );
        // A path is cut to its last component, the extension is kept.
        assert_eq!(staged_file_name(r"C:\Users\me\Desktop\a b.TORRENT"), "a b.TORRENT");
        assert_eq!(staged_file_name("../../evil"), "evil.torrent");
        // Characters Windows refuses become `_`.
        assert_eq!(staged_file_name("a:b?.torrent"), "a_b_.torrent");
        // Unusable names fall back to a fixed one.
        assert_eq!(staged_file_name(""), "dropped.torrent");
        assert_eq!(staged_file_name("../../"), "dropped.torrent");
        assert_eq!(staged_file_name("con.torrent"), "dropped.torrent");
        assert_eq!(staged_file_name("name without extension"), "name without extension.torrent");

        let long = format!("{}.torrent", "a".repeat(STAGED_NAME_LIMIT + 40));
        assert!(staged_file_name(&long).len() <= STAGED_NAME_LIMIT + ".torrent".len());
    }

    fn staging_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "brickman-desktop-stage-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_dropped_torrent_is_staged_without_overwriting() {
        let dir = staging_dir("twice");
        let first = stage_torrent_in(&dir, "a.torrent", b"one").expect("stage");
        let second = stage_torrent_in(&dir, "a.torrent", b"two").expect("stage");

        assert_ne!(first, second, "the second drop must not overwrite the first");
        assert_eq!(std::fs::read(&first).expect("read"), b"one");
        assert_eq!(std::fs::read(&second).expect("read"), b"two");
        assert!(is_staged(&dir, &first));
        assert!(!is_staged(&dir, Path::new("C:\\Users\\me\\Desktop\\a.torrent")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_staged_torrent_must_not_be_empty() {
        let dir = staging_dir("empty");
        assert!(stage_torrent_in(&dir, "a.torrent", b"").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clipboard_text_is_trimmed() {
        assert_eq!(
            clipboard_text("  magnet:?xt=urn:btih:abc \r\n"),
            Some("magnet:?xt=urn:btih:abc".to_string())
        );
        assert_eq!(clipboard_text(""), None);
        assert_eq!(clipboard_text(" \t\r\n"), None);
    }

    #[test]
    fn clipboard_text_is_cut_at_the_limit() {
        let long = "a".repeat(CLIPBOARD_LIMIT + 100);
        let text = clipboard_text(&long).expect("text");
        assert_eq!(text.len(), CLIPBOARD_LIMIT);

        // A two-byte character at the limit is dropped whole, not split.
        let long = format!("{}ж", "a".repeat(CLIPBOARD_LIMIT - 1));
        let text = clipboard_text(&long).expect("text");
        assert_eq!(text.len(), CLIPBOARD_LIMIT - 1);
        assert!(text.ends_with('a'));

        assert_eq!(
            clipboard_text("magnet:?xt=urn:btih:abc").as_deref(),
            Some("magnet:?xt=urn:btih:abc")
        );
    }
}
