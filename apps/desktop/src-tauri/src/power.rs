//! Power off / sleep once every download has finished.
//!
//! The monitor is driven by the UI poll: `list_torrents` hands a fresh snapshot
//! to [`PowerState::observe`] once per second. This module owns the state
//! machine (what counts as "finished", the countdown, the cancellations) and the
//! command lines. The command line itself is a pure function ([`command_for`])
//! over the action and the target system, so every action on both supported
//! systems is covered by unit tests without depending on the build host.
//!
//! `BRICKMAN_POWER_DRYRUN=1` replaces the execution with a log line, both on
//! stderr and in `<data-dir>/power.log`: the countdown and the cancellations work
//! exactly as usual, only the final command is not run.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Delay used when nothing else is configured.
pub const DEFAULT_DELAY_SECS: u64 = 60;
/// Bounds of the delay the settings dialog offers.
pub const MIN_DELAY_SECS: u64 = 5;
/// Bounds of the delay the settings dialog offers.
pub const MAX_DELAY_SECS: u64 = 600;
/// Set to `1` to log the command instead of running it.
pub const DRYRUN_ENV: &str = "BRICKMAN_POWER_DRYRUN";

// ------------------------------------------------------------------- action

/// What to do when no download is left.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerAction {
    /// Only show nothing: the monitor never starts a countdown.
    Nothing,
    /// Suspend to RAM.
    Sleep,
    /// Suspend to disk.
    Hibernate,
    /// Regular shutdown (programs may ask to save their work).
    Shutdown,
    /// Shutdown without giving programs a chance to save.
    ForceShutdown,
}

impl PowerAction {
    /// Parses the value the UI stores (`nothing`, `sleep`, `hibernate`,
    /// `shutdown`, `force-shutdown`).
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "nothing" => Ok(PowerAction::Nothing),
            "sleep" => Ok(PowerAction::Sleep),
            "hibernate" => Ok(PowerAction::Hibernate),
            "shutdown" => Ok(PowerAction::Shutdown),
            "force-shutdown" => Ok(PowerAction::ForceShutdown),
            other => Err(format!("invalid power action {other:?}")),
        }
    }

    /// Name used by the UI and in the log.
    pub fn as_str(self) -> &'static str {
        match self {
            PowerAction::Nothing => "nothing",
            PowerAction::Sleep => "sleep",
            PowerAction::Hibernate => "hibernate",
            PowerAction::Shutdown => "shutdown",
            PowerAction::ForceShutdown => "force-shutdown",
        }
    }
}

// ------------------------------------------------------------------ command

/// System the command line is built for. A parameter, not `cfg`, so the tests
/// can check both systems on either build host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// The variants of the other system are only used by the tests on this host.
#[allow(dead_code)]
pub enum TargetOs {
    Windows,
    Linux,
    /// No command is known: the action is logged and nothing is run.
    Other,
}

/// The system this build runs on.
#[cfg(target_os = "windows")]
pub const fn current_os() -> TargetOs {
    TargetOs::Windows
}

/// The system this build runs on.
#[cfg(target_os = "linux")]
pub const fn current_os() -> TargetOs {
    TargetOs::Linux
}

/// The system this build runs on.
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub const fn current_os() -> TargetOs {
    TargetOs::Other
}

/// A program with its arguments, ready to be spawned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PowerCommand {
    pub program: &'static str,
    pub args: Vec<&'static str>,
}

impl PowerCommand {
    fn new(program: &'static str, args: &[&'static str]) -> Self {
        Self {
            program,
            args: args.to_vec(),
        }
    }

    /// The command as one line, used for logging and tests.
    pub fn display(&self) -> String {
        std::iter::once(self.program)
            .chain(self.args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// The command line of `action` on `os`; `None` when no command is needed.
///
/// Windows sleep goes through `rundll32.exe powrprof.dll,SetSuspendState 0,1,0`
/// instead of a WinAPI call: the app would have to link `powrprof` and declare
/// the function by hand for the same effect, and `rundll32` is the documented
/// way to reach `SetSuspendState` from a shell. Note the well-known caveat: on a
/// system with hibernation enabled this same call may hibernate instead of
/// sleeping; the `hibernate` action is explicit for that reason.
pub fn command_for(action: PowerAction, os: TargetOs) -> Option<PowerCommand> {
    match (action, os) {
        (PowerAction::Nothing, _) | (_, TargetOs::Other) => None,
        (PowerAction::Shutdown, TargetOs::Windows) => {
            Some(PowerCommand::new("shutdown", &["/s", "/t", "0"]))
        }
        (PowerAction::ForceShutdown, TargetOs::Windows) => {
            Some(PowerCommand::new("shutdown", &["/s", "/f", "/t", "0"]))
        }
        (PowerAction::Hibernate, TargetOs::Windows) => {
            Some(PowerCommand::new("shutdown", &["/h"]))
        }
        (PowerAction::Sleep, TargetOs::Windows) => Some(PowerCommand::new(
            "rundll32.exe",
            &["powrprof.dll,SetSuspendState", "0,1,0"],
        )),
        (PowerAction::Shutdown, TargetOs::Linux) => {
            Some(PowerCommand::new("systemctl", &["poweroff"]))
        }
        (PowerAction::ForceShutdown, TargetOs::Linux) => {
            Some(PowerCommand::new("systemctl", &["poweroff", "-f"]))
        }
        (PowerAction::Hibernate, TargetOs::Linux) => {
            Some(PowerCommand::new("systemctl", &["hibernate"]))
        }
        (PowerAction::Sleep, TargetOs::Linux) => Some(PowerCommand::new("systemctl", &["suspend"])),
    }
}

// ------------------------------------------------------------------ dry run

/// Whether the command must be logged instead of run.
pub fn is_dry_run() -> bool {
    std::env::var(DRYRUN_ENV).is_ok_and(|value| {
        let value = value.trim();
        value == "1" || value.eq_ignore_ascii_case("true")
    })
}

/// Appends one line to the monitor log and mirrors it on stderr.
fn log_line(path: &Path, text: &str) {
    use std::io::Write;

    eprintln!("[brickman-torrent] {text}");
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        let _ = std::fs::create_dir_all(parent);
    }
    let line = format!("{} {text}\n", brickman_core::now_ms());
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(mut file) => {
            if let Err(error) = file.write_all(line.as_bytes()) {
                eprintln!("[brickman-torrent] cannot write {}: {error}", path.display());
            }
        }
        Err(error) => {
            eprintln!("[brickman-torrent] cannot write {}: {error}", path.display());
        }
    }
}

/// Runs the command, or logs it in dry-run mode.
pub fn run(command: &PowerCommand, log_path: &Path) -> Result<(), String> {
    if is_dry_run() {
        log_line(log_path, &format!("DRYRUN: would run {}", command.display()));
        return Ok(());
    }
    log_line(log_path, &format!("run {}", command.display()));
    std::process::Command::new(command.program)
        .args(&command.args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("cannot run {}: {error}", command.display()))
}

// ------------------------------------------------------------------- monitor

/// One torrent as the monitor needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TorrentProgress {
    /// Engine id.
    pub id: u32,
    /// The download reached 100 % (the engine reports it as seeding/done).
    pub complete: bool,
}

/// Persisted-by-the-UI settings of the monitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PowerSettings {
    pub action: PowerAction,
    /// Seconds between "everything is downloaded" and the action.
    pub delay_secs: u64,
}

impl Default for PowerSettings {
    fn default() -> Self {
        Self {
            action: PowerAction::Nothing,
            delay_secs: DEFAULT_DELAY_SECS,
        }
    }
}

impl PowerSettings {
    /// Settings with the delay clamped to the range the dialog offers.
    pub fn with(action: PowerAction, delay_secs: u64) -> Self {
        Self {
            action,
            delay_secs: delay_secs.clamp(MIN_DELAY_SECS, MAX_DELAY_SECS),
        }
    }

    fn delay(self) -> Duration {
        Duration::from_secs(self.delay_secs)
    }
}

/// Answer of `get_power_status`, polled by the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatusDto {
    /// Configured action.
    pub action: &'static str,
    /// Configured delay in seconds.
    pub delay_secs: u64,
    /// A countdown is running.
    pub pending: bool,
    /// Whole seconds left, `0` when no countdown is running.
    pub seconds_left: u64,
    /// `BRICKMAN_POWER_DRYRUN` is set: the command is only logged.
    pub dry_run: bool,
}

#[derive(Debug, Default)]
struct Runtime {
    /// Last known completeness per torrent id; the first sight is never counted
    /// as a completion, so a restarted session with finished torrents stays quiet.
    seen: HashMap<u32, bool>,
    /// At least one download finished while this app was running.
    completed: bool,
    /// When the running countdown ends.
    deadline: Option<Instant>,
}

#[derive(Debug)]
struct Inner {
    settings: PowerSettings,
    runtime: Runtime,
}

/// The monitor: settings, the countdown and its log.
#[derive(Debug)]
pub struct PowerState {
    inner: Mutex<Inner>,
    log_path: PathBuf,
}

impl PowerState {
    /// Creates the monitor; the log is written next to the engine state.
    pub fn new(data_dir: &Path) -> Self {
        Self {
            inner: Mutex::new(Inner {
                settings: PowerSettings::default(),
                runtime: Runtime::default(),
            }),
            log_path: data_dir.join("power.log"),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Log file, next to the engine's `state.json`.
    pub fn log_path(&self) -> &Path {
        &self.log_path
    }

    /// Stores new settings. A running countdown is dropped: the new delay counts
    /// from the next poll, so the change is what the user sees.
    pub fn set_settings(&self, settings: PowerSettings) -> PowerSettings {
        let cancelled = {
            let mut inner = self.lock();
            inner.settings = settings;
            inner.runtime.deadline.take().is_some()
        };
        if cancelled {
            log_line(&self.log_path, "countdown cancelled: settings changed");
        }
        settings
    }

    /// Drops a running countdown without forgetting the finished downloads: it
    /// may start again later (a torrent was added, a pause was lifted).
    pub fn cancel_countdown(&self) -> bool {
        let cancelled = { self.lock().runtime.deadline.take().is_some() };
        if cancelled {
            log_line(&self.log_path, "countdown cancelled: downloads changed");
        }
        cancelled
    }

    /// The explicit "Cancel" button. The finished downloads are forgotten as
    /// well, so the next poll does not start the countdown again.
    pub fn cancel(&self) -> bool {
        let (was_pending, was_completed) = {
            let mut inner = self.lock();
            let pending = inner.runtime.deadline.take().is_some();
            let completed = std::mem::replace(&mut inner.runtime.completed, false);
            (pending, completed)
        };
        if was_pending || was_completed {
            log_line(&self.log_path, "countdown cancelled by the user");
        }
        was_pending
    }

    /// Feeds a fresh snapshot of the engine; returns the command to run when the
    /// countdown has expired.
    ///
    /// The countdown starts when every torrent is downloaded *and* at least one
    /// of them finished while this app was running: a session restored from disk
    /// (or an empty list) never turns the PC off. A torrent that is still
    /// unfinished — downloading, queued, paused by the user, checking or
    /// errored — keeps the condition false, and the countdown is cancelled when
    /// the condition stops holding.
    pub fn observe(&self, torrents: &[TorrentProgress]) -> Option<PowerCommand> {
        self.observe_at(torrents, Instant::now())
    }

    /// [`PowerState::observe`] with an explicit "now", so the tests can move the
    /// clock instead of sleeping.
    fn observe_at(&self, torrents: &[TorrentProgress], now: Instant) -> Option<PowerCommand> {
        let mut started = None;
        let mut cancelled = false;
        let command = {
            let mut inner = self.lock();

            for torrent in torrents {
                if let Some(previous) = inner.runtime.seen.insert(torrent.id, torrent.complete)
                    && !previous
                    && torrent.complete
                {
                    inner.runtime.completed = true;
                }
            }
            inner
                .runtime
                .seen
                .retain(|id, _| torrents.iter().any(|torrent| torrent.id == *id));

            let action = inner.settings.action;
            let condition = !torrents.is_empty()
                && torrents.iter().all(|torrent| torrent.complete)
                && inner.runtime.completed
                && action != PowerAction::Nothing;

            match (condition, inner.runtime.deadline) {
                (true, None) => {
                    inner.runtime.deadline = Some(now + inner.settings.delay());
                    started = Some(inner.settings);
                }
                (false, Some(_)) => {
                    inner.runtime.deadline = None;
                    cancelled = true;
                }
                _ => {}
            }

            match inner.runtime.deadline {
                Some(deadline) if now >= deadline => {
                    inner.runtime.deadline = None;
                    // A second completion is needed before the next countdown.
                    inner.runtime.completed = false;
                    command_for(action, current_os())
                }
                _ => None,
            }
        };

        if let Some(settings) = started {
            log_line(
                &self.log_path,
                &format!(
                    "countdown started: {} in {} s",
                    settings.action.as_str(),
                    settings.delay_secs
                ),
            );
        }
        if cancelled {
            log_line(
                &self.log_path,
                "countdown cancelled: a download is running again",
            );
        }
        command
    }

    /// What the UI shows: the settings and, while a countdown runs, its state.
    pub fn status(&self) -> PowerStatusDto {
        let (settings, deadline) = {
            let inner = self.lock();
            (inner.settings, inner.runtime.deadline)
        };
        let seconds_left = deadline.map_or(0, |deadline| {
            let remaining = deadline.saturating_duration_since(Instant::now());
            u64::try_from(remaining.as_millis().div_ceil(1000)).unwrap_or(0)
        });
        PowerStatusDto {
            action: settings.action.as_str(),
            delay_secs: settings.delay_secs,
            pending: deadline.is_some(),
            seconds_left,
            dry_run: is_dry_run(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn torrent(id: u32, complete: bool) -> TorrentProgress {
        TorrentProgress { id, complete }
    }

    fn state_with(action: PowerAction, delay_secs: u64) -> (PowerState, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "tcdesktop-power-{}-{action:?}-{delay_secs}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let state = PowerState::new(&dir);
        state.set_settings(PowerSettings::with(action, delay_secs));
        (state, dir)
    }

    fn display(action: PowerAction, os: TargetOs) -> Option<String> {
        command_for(action, os).map(|command| command.display())
    }

    #[test]
    fn every_action_has_the_windows_command() {
        assert_eq!(display(PowerAction::Nothing, TargetOs::Windows), None);
        assert_eq!(
            display(PowerAction::Shutdown, TargetOs::Windows).as_deref(),
            Some("shutdown /s /t 0")
        );
        assert_eq!(
            display(PowerAction::ForceShutdown, TargetOs::Windows).as_deref(),
            Some("shutdown /s /f /t 0")
        );
        assert_eq!(
            display(PowerAction::Hibernate, TargetOs::Windows).as_deref(),
            Some("shutdown /h")
        );
        assert_eq!(
            display(PowerAction::Sleep, TargetOs::Windows).as_deref(),
            Some("rundll32.exe powrprof.dll,SetSuspendState 0,1,0")
        );
    }

    #[test]
    fn every_action_has_the_linux_command() {
        assert_eq!(display(PowerAction::Nothing, TargetOs::Linux), None);
        assert_eq!(
            display(PowerAction::Shutdown, TargetOs::Linux).as_deref(),
            Some("systemctl poweroff")
        );
        assert_eq!(
            display(PowerAction::ForceShutdown, TargetOs::Linux).as_deref(),
            Some("systemctl poweroff -f")
        );
        assert_eq!(
            display(PowerAction::Hibernate, TargetOs::Linux).as_deref(),
            Some("systemctl hibernate")
        );
        assert_eq!(
            display(PowerAction::Sleep, TargetOs::Linux).as_deref(),
            Some("systemctl suspend")
        );
    }

    #[test]
    fn only_nothing_has_no_command_on_any_system() {
        let actions = [
            PowerAction::Sleep,
            PowerAction::Hibernate,
            PowerAction::Shutdown,
            PowerAction::ForceShutdown,
        ];
        for os in [TargetOs::Windows, TargetOs::Linux] {
            for action in actions {
                let command = command_for(action, os).expect("a command per action and system");
                assert!(!command.program.is_empty());
                assert!(!command.display().contains("  "));
            }
        }
        // A build for a system without a known command stays silent.
        assert_eq!(command_for(PowerAction::Shutdown, TargetOs::Other), None);
    }

    #[test]
    fn settings_parse_and_clamp() {
        assert_eq!(PowerAction::parse("force-shutdown"), Ok(PowerAction::ForceShutdown));
        assert_eq!(PowerAction::parse(" nothing "), Ok(PowerAction::Nothing));
        assert!(PowerAction::parse("reboot").is_err());
        assert_eq!(PowerSettings::default().delay_secs, DEFAULT_DELAY_SECS);
        assert_eq!(PowerSettings::with(PowerAction::Shutdown, 1).delay_secs, MIN_DELAY_SECS);
        assert_eq!(PowerSettings::with(PowerAction::Shutdown, 5000).delay_secs, MAX_DELAY_SECS);
        assert_eq!(PowerSettings::with(PowerAction::Shutdown, 60).delay_secs, 60);
    }

    #[test]
    fn an_empty_list_never_arms() {
        let (state, dir) = state_with(PowerAction::Shutdown, MIN_DELAY_SECS);
        let start = Instant::now();
        assert_eq!(state.observe_at(&[], start), None);
        assert!(!state.status().pending);
        assert_eq!(state.observe_at(&[], start + Duration::from_secs(3600)), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_restored_session_with_finished_torrents_does_not_arm() {
        let (state, dir) = state_with(PowerAction::Shutdown, MIN_DELAY_SECS);
        let start = Instant::now();
        // The first snapshot already shows everything complete: nothing finished
        // in this run, so the PC stays on.
        let snapshot = [torrent(0, true), torrent(1, true)];
        assert_eq!(state.observe_at(&snapshot, start), None);
        assert!(!state.status().pending);
        assert_eq!(
            state.observe_at(&snapshot, start + Duration::from_secs(3600)),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_completion_starts_the_countdown_and_expiry_returns_the_command() {
        let (state, dir) = state_with(PowerAction::Shutdown, MIN_DELAY_SECS);
        let start = Instant::now();
        // Downloading: no countdown yet.
        assert_eq!(
            state.observe_at(&[torrent(0, false)], start),
            None
        );
        assert!(!state.status().pending);
        // The download finished: the countdown starts.
        assert_eq!(
            state.observe_at(&[torrent(0, true)], start + Duration::from_secs(1)),
            None
        );
        assert!(state.status().pending);
        let armed = start + Duration::from_secs(1);
        // Still counting down one second before the end.
        assert_eq!(
            state.observe_at(
                &[torrent(0, true)],
                armed + Duration::from_secs(MIN_DELAY_SECS - 1)
            ),
            None
        );
        assert!(state.status().pending);
        // The delay is over: the command is returned once.
        let command = state
            .observe_at(&[torrent(0, true)], armed + Duration::from_secs(MIN_DELAY_SECS))
            .expect("the countdown expired");
        assert_eq!(command, command_for(PowerAction::Shutdown, current_os()).expect("command"));
        assert!(!state.status().pending);
        // Nothing fires twice without a new completion.
        assert_eq!(
            state.observe_at(
                &[torrent(0, true)],
                armed + Duration::from_secs(MIN_DELAY_SECS * 2)
            ),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cancel_button_stops_the_countdown_for_good() {
        let (state, dir) = state_with(PowerAction::Shutdown, MIN_DELAY_SECS);
        let start = Instant::now();
        let snapshot = [torrent(0, true)];
        assert_eq!(state.observe_at(&[torrent(0, false)], start), None);
        state.observe_at(&snapshot, start + Duration::from_secs(1));
        assert!(state.status().pending);

        assert!(state.cancel());
        assert!(!state.status().pending);
        // The same finished download does not start the countdown again.
        assert_eq!(
            state.observe_at(
                &snapshot,
                start + Duration::from_secs(1) + Duration::from_secs(MIN_DELAY_SECS * 2)
            ),
            None
        );
        assert!(!state.status().pending);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_torrent_and_a_lifted_pause_cancel_the_countdown() {
        let (state, dir) = state_with(PowerAction::Shutdown, MIN_DELAY_SECS);
        let start = Instant::now();
        let snapshot = [torrent(0, true)];
        assert_eq!(state.observe_at(&[torrent(0, false)], start), None);
        state.observe_at(&snapshot, start + Duration::from_secs(1));
        assert!(state.status().pending);

        // The add command reports the new torrent before the next poll; the poll
        // sees an unfinished torrent and drops the countdown.
        assert!(state.cancel_countdown());
        assert!(!state.status().pending);
        assert_eq!(
            state.observe_at(&[torrent(0, true), torrent(1, false)], start + Duration::from_secs(2)),
            None
        );
        assert!(!state.status().pending);
        // When the new torrent finishes too, the countdown starts again.
        assert_eq!(
            state.observe_at(
                &[torrent(0, true), torrent(1, true)],
                start + Duration::from_secs(30)
            ),
            None
        );
        assert!(state.status().pending);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_paused_unfinished_torrent_blocks_the_countdown() {
        let (state, dir) = state_with(PowerAction::Shutdown, MIN_DELAY_SECS);
        let start = Instant::now();
        // The user paused the second torrent while it was incomplete: its state
        // is "paused", but that is not "downloaded", so nothing counts as done.
        let snapshot = [torrent(0, true), torrent(1, false)];
        assert_eq!(state.observe_at(&[torrent(0, false), torrent(1, false)], start), None);
        assert_eq!(
            state.observe_at(&snapshot, start + Duration::from_secs(1)),
            None
        );
        assert!(!state.status().pending);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn changing_the_settings_cancels_the_countdown() {
        let (state, dir) = state_with(PowerAction::Shutdown, MIN_DELAY_SECS);
        let start = Instant::now();
        assert_eq!(state.observe_at(&[torrent(0, false)], start), None);
        state.observe_at(&[torrent(0, true)], start + Duration::from_secs(1));
        assert!(state.status().pending);

        let settings = state.set_settings(PowerSettings::with(PowerAction::Sleep, 120));
        assert_eq!(settings.delay_secs, 120);
        assert!(!state.status().pending);
        // The next poll starts a countdown with the new delay.
        assert_eq!(
            state.observe_at(&[torrent(0, true)], start + Duration::from_secs(2)),
            None
        );
        let status = state.status();
        assert!(status.pending);
        assert_eq!(status.action, "sleep");
        assert_eq!(status.delay_secs, 120);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_never_starts_a_countdown() {
        let (state, dir) = state_with(PowerAction::Nothing, MIN_DELAY_SECS);
        let start = Instant::now();
        assert_eq!(state.observe_at(&[torrent(0, false)], start), None);
        assert_eq!(
            state.observe_at(&[torrent(0, true)], start + Duration::from_secs(1)),
            None
        );
        assert!(!state.status().pending);
        assert_eq!(
            state.observe_at(
                &[torrent(0, true)],
                start + Duration::from_secs(1) + Duration::from_secs(MIN_DELAY_SECS * 2)
            ),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
