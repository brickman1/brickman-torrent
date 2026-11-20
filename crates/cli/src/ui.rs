//! Output helpers for the `tc` command line.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use brickman_core::{TorrentState, TorrentView};

/// Formats a byte count using binary units.
pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// Formats a transfer rate.
pub fn human_rate(bytes_per_second: u64) -> String {
    if bytes_per_second == 0 {
        "-".to_string()
    } else {
        format!("{}/s", human_bytes(bytes_per_second))
    }
}

fn progress_percent(progress: f64) -> String {
    format!("{:.1}%", (progress * 100.0).clamp(0.0, 100.0))
}

fn truncate(text: &str, width: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= width {
        return text.to_string();
    }
    if width <= 1 {
        return chars.into_iter().take(width).collect();
    }
    let mut out: String = chars.into_iter().take(width - 1).collect();
    out.push('…');
    out
}

/// Renders the torrent table used by `brickman-torrent list`.
pub fn render_table(views: &[TorrentView]) -> String {
    if views.is_empty() {
        return "no torrents\n".to_string();
    }

    let name_width = views
        .iter()
        .map(|v| v.name.chars().count())
        .max()
        .unwrap_or(4)
        .clamp(4, 48);

    let mut out = String::new();
    out.push_str(&format!(
        "{:>3}  {:<name_width$}  {:>9}  {:>7}  {:>10}  {:>10}  {:>5}  {:<10}  {:>4}\n",
        "#",
        "Name",
        "Size",
        "Done",
        "Down",
        "Up",
        "Peers",
        "State",
        "Prio",
        name_width = name_width
    ));
    for view in views {
        out.push_str(&format!(
            "{:>3}  {:<name_width$}  {:>9}  {:>7}  {:>10}  {:>10}  {:>5}  {:<10}  {:>4}\n",
            view.id.0,
            truncate(&view.name, name_width),
            human_bytes(view.total_bytes),
            progress_percent(view.progress),
            human_rate(view.down_bps),
            human_rate(view.up_bps),
            view.peers,
            view.state.as_str(),
            view.priority,
            name_width = name_width
        ));
    }
    out
}

/// One-line summary of the whole session, used while the engine runs.
pub fn render_status_line(views: &[TorrentView], elapsed: Duration) -> String {
    let downloading = views
        .iter()
        .filter(|v| matches!(v.state, TorrentState::Downloading))
        .count();
    let queued = views
        .iter()
        .filter(|v| matches!(v.state, TorrentState::Queued))
        .count();
    let down: u64 = views.iter().map(|v| v.down_bps).sum();
    let up: u64 = views.iter().map(|v| v.up_bps).sum();
    format!(
        "[{:>4}s] {} torrent(s): {} downloading, {} queued, {:>10} down, {:>10} up",
        elapsed.as_secs(),
        views.len(),
        downloading,
        queued,
        human_rate(down),
        human_rate(up)
    )
}

/// A tiny terminal spinner used while waiting for magnet metadata.
pub struct Spinner {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

const SPINNER_WIDTH: usize = 68;

impl Spinner {
    pub fn start(message: impl Into<String>) -> Self {
        let message = message.into();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let join = std::thread::spawn(move || {
            let mut dots = 0usize;
            while !flag.load(Ordering::Relaxed) {
                dots = dots % 3 + 1;
                let line = format!("{message} {}", ".".repeat(dots));
                eprint!("\r{line:<SPINNER_WIDTH$}");
                let _ = std::io::stderr().flush();
                std::thread::sleep(Duration::from_millis(600));
            }
            eprint!("\r{:<SPINNER_WIDTH$}\r", "");
            let _ = std::io::stderr().flush();
        });
        Self {
            stop,
            join: Some(join),
        }
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Prints a status line in place (used by `run` and `add --wait`).
pub fn print_status_line(text: &str) {
    eprint!("\r{text:<SPINNER_WIDTH$}");
    let _ = std::io::stderr().flush();
}

/// Clears the in-place status line.
pub fn clear_status_line() {
    eprint!("\r{:<SPINNER_WIDTH$}\r", "");
    let _ = std::io::stderr().flush();
}
