//! Tauri entry point: the desktop UI driving `brickman-core`.
//!
//! Every command here runs the synchronous `brickman_core::Downloader` on a
//! blocking thread. The core owns its private tokio runtime, so calling it from
//! an async command directly would panic with "no reactor running" — the
//! `run_blocking` helper is the single place where that is handled.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use brickman_core::{
    AddOptions, Downloader, DownloaderOptions, SessionView, Source, TorrentId, TorrentState,
    TorrentView, default_data_dir, default_download_dir, now_ms,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

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
    dht_nodes: u32,
    max_active: u32,
    down_limit: u64,
    up_limit: u64,
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

impl Engine {
    fn new(data_dir: PathBuf, download_dir: PathBuf) -> Result<Self, String> {
        let downloader = Downloader::new(DownloaderOptions::new(data_dir, download_dir.clone()))
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
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
        *lock(&self.add_dir) = dir;
        Ok(())
    }

    fn add(&self, source: Source) -> Result<u32, String> {
        let options = AddOptions {
            output_dir: Some(self.add_dir()),
            ..Default::default()
        };
        self.downloader
            .add(source, options)
            .map(|id| id.0)
            .map_err(|error| error.to_string())
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

#[derive(Default)]
struct AppState {
    engine: tokio::sync::Mutex<Option<Arc<Engine>>>,
    /// `.torrent` files passed on the command line; added once the UI told us
    /// where to download to.
    pending: Mutex<Vec<PathBuf>>,
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
        dht_nodes: view.dht_nodes,
        max_active: view.max_active,
        // The settings dialog works in kB/s; the core stores bytes per second.
        down_limit: view.down_limit_bps / KB,
        up_limit: view.up_limit_bps / KB,
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

/// Creates the engine once, using the download folder from the UI settings.
/// A second call only updates the folder used for new torrents.
#[tauri::command]
async fn engine_init(
    download_dir: Option<String>,
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
    let engine = run_blocking(move || {
        let engine = Engine::new(data_dir, download_dir)?;
        for path in pending {
            match engine.add(Source::TorrentFile(path.clone())) {
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

#[tauri::command]
async fn list_torrents(state: State<'_, AppState>) -> Result<Vec<TorrentDto>, String> {
    let engine = engine(&state).await?;
    run_blocking(move || {
        // The UI polls once per second; that is also what keeps the queue
        // moving (a torrent added during its initial check stays paused until
        // the next pass).
        if let Err(error) = engine.downloader.tick() {
            eprintln!("[brickman-torrent] queue tick failed: {error}");
        }
        Ok(engine
            .downloader
            .list()
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
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TorrentDto, String> {
    let engine = engine(&state).await?;
    let name = name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());

    run_blocking(move || {
        let path = match name {
            Some(path) => PathBuf::from(path),
            None => pick_torrent_file(&app)?,
        };
        let id = engine.add(Source::TorrentFile(path))?;
        engine.snapshot(id)
    })
    .await
}

/// Native file picker; must run on a blocking thread, not on the UI thread.
fn pick_torrent_file(app: &AppHandle) -> Result<PathBuf, String> {
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

#[tauri::command]
async fn add_magnet(uri: Option<String>, state: State<'_, AppState>) -> Result<TorrentDto, String> {
    let engine = engine(&state).await?;
    let uri = uri
        .map(|uri| uri.trim().to_string())
        .filter(|uri| !uri.is_empty())
        .ok_or_else(|| "empty magnet link".to_string())?;
    if !uri.starts_with("magnet:") {
        return Err("only magnet: links are accepted here".to_string());
    }

    run_blocking(move || {
        let id = engine.add(Source::Magnet(uri))?;
        engine.snapshot(id)
    })
    .await
}

#[tauri::command]
async fn resume_torrents(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let engine = engine(&state).await?;
    let ids = parse_ids(&ids)?;
    run_blocking(move || {
        for id in ids {
            engine
                .downloader
                .resume(id)
                .map_err(|error| error.to_string())?;
        }
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

#[tauri::command]
async fn set_priority(
    id: String,
    priority: u32,
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
            .set_priority(id, priority)
            .map_err(|error| error.to_string())
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

// -------------------------------------------------------------------- entry

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `app.exe C:\path\to\file.torrent` adds the torrent once the UI has told
    // the engine where to download to.
    let pending: Vec<PathBuf> = std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(PathBuf::from)
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("torrent"))
        })
        .collect();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            engine: tokio::sync::Mutex::new(None),
            pending: Mutex::new(pending),
        })
        .invoke_handler(tauri::generate_handler![
            engine_init,
            set_download_dir,
            list_torrents,
            get_session_stats,
            add_torrent_file,
            add_magnet,
            resume_torrents,
            pause_torrents,
            stop_torrents,
            remove_torrents,
            set_priority,
            set_max_active,
            set_limits,
            list_files,
            set_file_priority,
            list_trackers,
            list_peers,
            check_for_updates,
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the tauri application");
}
