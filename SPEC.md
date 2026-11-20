# Brickman Torrent — scope

Two milestones: (1) engine + CLI, (2) desktop UI. This repository implements
milestone 1. Section "UI (next milestone)" is a specification input only; none
of it is built here.

## Core (milestone 1, implemented)

- **Sources**: `.torrent` files and magnet links with BEP-9 metadata exchange
  (metadata is fetched and validated before the torrent starts).
- **Peers**: DHT, HTTP and UDP trackers, PEX, local service discovery (LSD),
  incoming TCP connections.
- **Resume**: fastresume — the engine's persisted session plus on-disk
  bitfields, so progress and file layout survive restarts.
- **Limits**: global download/upload rate limits in bytes per second
  (`0` = unlimited), applied to the running engine and persisted.
- **File selection**: per-file selection with priorities `skip`, `low`,
  `normal`, `high`, `max` is part of the MVP scope. Status: the engine supports
  file inclusion and piece priority, the core/CLI in this milestone do not
  expose it yet — adding `set_file_priority` is remaining work before the UI
  needs it (the UI's Files tab is its first consumer).
- **Queue**: numeric priorities (`1` = highest) and "maximum active downloads"
  (`0` = unlimited). At most `max_active` unfinished torrents run; the rest are
  parked in the engine's paused state and reported as `queued`, which is
  distinct from a pause requested by the user. A freed slot goes to the lowest
  priority number (ties broken by torrent id). Priorities, user pauses, the
  active limit and rate limits persist between processes.
- **Path safety**: names from torrent metadata are validated (no absolute paths,
  no drive/UNC prefixes, no `..`, no NUL/control characters, no Windows-forbidden
  characters, no reserved device names) and the torrent is refused before the
  engine creates any file (CWE-22).
- **Errors**: a single `thiserror` error type; the library does not panic on
  engine or input errors and the CLI prints readable messages.
- **No telemetry, no built-in trackers, no content search.**

## CLI (milestone 1, implemented)

`add`, `list`, `pause`, `resume`, `rm`, `priority`, `limits`, `max-active`,
`run`. One command = one action, then the process exits. The engine runs in the
foreground only for `add --wait N` and `run [--seconds N]`.

## UI (next milestone — NOT implemented)

- Tauri desktop application, Windows first.
- μTorrent-like layout: toolbar, left filter panel (all / downloading / seeding /
  completed / paused / active), main table with sortable columns (name, size,
  progress, down, up, peers, seeds, state, priority, ETA), bottom tab bar with
  General / Files / Trackers / Peers, status bar with totals and limits.
- Tray icon with show/hide, "pause all"/"resume all", exit.
- Settings for download folder, limits, active limit, update check toggle.
- Update check is the only non-torrent network request; it is optional and can
  be disabled.
- Long-lived engine session with live UI updates (the core already separates the
  queue plan from the engine so the UI can drive it).

## Legal

The client ships without search, catalogue, index or tracker lists. The user is
responsible for the content they download. Acceptable uses include Linux
distributions, open data and the user's own files.
