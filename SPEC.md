# Brickman Torrent — scope

Two milestones: (1) engine + CLI, (2) desktop UI. Both are implemented in this
repository; the sections below say what is done and what remains.

## Core (implemented)

- **Sources**: `.torrent` files and magnet links with BEP-9 metadata exchange
  (metadata is fetched and validated before the torrent starts).
- **Peers**: DHT, HTTP and UDP trackers, PEX, local service discovery (LSD),
  incoming TCP connections.
- **Resume**: fastresume — the engine's persisted session plus on-disk
  bitfields, so progress and file layout survive restarts.
- **Limits**: global download/upload rate limits in bytes per second
  (`0` = unlimited), applied to the running engine and persisted.
- **File selection**: per-file inclusion (`only_files` via
  `set_file_included`) plus per-file progress and file listing. The engine also
  supports piece priorities; the UI exposes selection only (see remaining).
- **Queue**: a list, not a number. The order of torrents (`state.json`:
  `order`) *is* the queue — position `1` downloads first and takes the whole
  bandwidth. "Maximum active downloads" (default `1`, `0` = unlimited) caps how
  many unfinished torrents download at once; the rest are parked in the engine's
  paused state and reported as `queued`, which is distinct from a pause
  requested by the user. The API can `move_to` an index, `move_up` / `move_down`
  by one and `reorder` a whole list; the numeric `priority` is derived from the
  position and kept for display and old state files. Changing the order applies
  at once (`sync_queue`), so a different torrent may start or pause. A torrent
  that reaches 100 % leaves the download queue immediately and may keep seeding
  without a slot, so the next one starts. Order, user pauses, the active limit
  and rate limits persist between processes; a state file without `order` (older
  version) is migrated by sorting on its numeric priorities.
- **Status data for a UI**: torrent snapshot (speeds, peers, seeds, piece
  counts, hash, upload total, add time), session snapshot (speeds, active
  count, listening port, DHT size, limits).
- **Path safety**: names from torrent metadata are validated (no absolute paths,
  no drive/UNC prefixes, no `..`, no NUL/control characters, no Windows-forbidden
  characters, no reserved device names) and the torrent is refused before the
  engine creates any file (CWE-22).
- **Errors**: a single `thiserror` error type; the library does not panic on
  engine or input errors and the CLI prints readable messages.
- **No telemetry, no built-in trackers, no content search.**

## CLI (implemented)

`add`, `list`, `pause`, `resume`, `rm`, `move`, `up`, `down`, `priority`
(an alias of `move`), `limits`, `max-active`, `run`. One command = one action,
then the process exits. The engine runs in the foreground only for `add --wait N`
and `run [--seconds N]`. `list` shows the queue in order; `#` is the engine id and
`Pos` the 1-based queue position.

## Desktop UI (implemented)

- Tauri 2 application, Windows first; crate `apps/desktop/src-tauri`
  (package `brickman-desktop`), frontend `apps/desktop` (Vite + TypeScript,
  plain DOM, no framework).
- μTorrent-like layout: toolbar, left filter panel (all / downloading / active /
  queued / completed / paused / stopped), main table with sortable columns
  (name, size, progress, down, up, seeds, peers, ETA, label), bottom
  tab bar with General / Files / Trackers / Peers, status bar with totals and
  limits.
- **Queue in the table**: the "#" column is the queue position, the first row
  downloads first. Drag a row (or its grip in the first column) to reorder the
  queue; a line marks the insertion point and the core's `move_to` applies the
  new order at once. The torrent that is downloading at the top of the queue
  gets a marker and a bold number. Sorting by another column (name, size, …) is
  a temporary view: drag and drop is then refused with "Sort by # to change the
  queue". The row context menu has "Move to top", "Move up", "Move down" and
  "Move to position…" (a number, for those who prefer it).
- The UI runs in a plain browser on a mock provider (`npm run dev`) and in the
  webview on the real engine; if the engine cannot start, the UI falls back to
  the mock so the window is never empty.
- One `brickman_core::Downloader` per run, created at startup, state in
  `%APPDATA%\BrickmanTorrent`, download folder from the settings (empty =
  `Downloads`). All core calls run on blocking threads (`spawn_blocking`),
  because the core owns a private tokio runtime.
- Commands: `list_torrents`, `get_session_stats`, `add_torrent_file`,
  `add_magnet`, `resume_torrents`, `pause_torrents`, `stop_torrents`,
  `remove_torrents`, `move_torrent`, `move_torrent_by`, `set_max_active`,
  `set_limits`, `list_files`, `set_file_priority`, `list_trackers`,
  `list_peers`, `check_for_updates`, `open_external`, plus `engine_init` and
  `set_download_dir` for startup.
- Settings: download folder, limits, maximum active downloads (default 1),
  update check toggle, theme, language. Persisted in the webview's
  `localStorage`.
- Update check: a single `GET` to
  `https://api.github.com/repos/brickman1/brickman-torrent/releases/latest`
  with a 5 s timeout. `404` (repository not published yet) is reported as
  "up to date" and is not retried; the check can be disabled. No telemetry.
- Opening a link (`open_external`) uses the system browser through the Tauri
  opener plugin and accepts `http(s)` only.
- `brickman-desktop.exe <file.torrent>` adds the torrent on startup.

### Known simplifications

- **`stop_torrents` == `pause_torrents`.** The core keeps a single user-pause
  flag per torrent: a paused torrent leaves the queue and stays down until
  resumed. The UI shows both buttons, but there is no separate "force stop"
  state yet.
- **File selection is binary** in the UI: a checkbox per file maps to
  `only_files` (included / excluded). There are no per-file priority levels.
- **Tracker and peer detail is shallow**: tracker announce status is not
  exposed by the engine, so the list shows URL and a running/idle hint; per-peer
  progress is not exposed either, while speeds are derived from byte counters.
- **Seeds/peers totals** show connected counts only (the engine does not expose
  swarm totals), so the table shows the same number twice.
- Labels and comments are empty: neither exists in the core.

## Remaining (not implemented)

- **Five-level file priorities** (`skip` / `low` / `normal` / `high` / `max`)
  in the UI; the engine supports piece priorities, the core and UI do not.
- **Tray icon** with show/hide, "pause all"/"resume all", exit.
- **File associations** for `.torrent` and `magnet:` links, and registering the
  app as a handler (the CLI argument is a manual stand-in).
- **Single instance**: a second launch should hand its arguments to the running
  window instead of opening a new engine on the same state folder.
- **Signed updates**: a signed update feed and in-app installer. Today the check
  only reports that a release exists and opens the release page.
- Drag and drop of `.torrent` files onto the window (dragging rows to reorder
  the queue is implemented).

## Legal

The client ships without search, catalogue, index or tracker lists. The user is
responsible for the content they download. Acceptable uses include Linux
distributions, open data and the user's own files.
