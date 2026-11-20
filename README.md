# Brickman Torrent

A small, open source BitTorrent client: a Rust core on top of
[librqbit](https://github.com/ikatson/rqbit) plus a thin command line front-end.
The desktop UI is the next milestone (see [SPEC.md](SPEC.md)); this repository
currently ships the engine, the download queue and the CLI.

## What it does

- `.torrent` files and magnet links (BEP-9 metadata exchange),
- DHT, HTTP/UDP trackers, PEX, local service discovery,
- fastresume: progress survives restarts,
- numeric queue priorities, "maximum active downloads", global up/down limits,
- torrent file paths are validated before anything is written, so a hostile
  torrent cannot write outside the download folder.

## Build

Requires Rust 1.85 or newer (MSVC toolchain on Windows). No CMake, NASM or
other external build tools are needed.

```sh
cargo build --release
```

The binary is `target/release/brickman-torrent` (`brickman-torrent.exe` on
Windows).

Checks used in CI-less development:

```sh
cargo clippy --all-targets -- -D warnings
cargo test
```

## Usage

```sh
brickman-torrent add <path/to/file.torrent | magnet:?...> [--dir DIR] [--wait SECS]
brickman-torrent list
brickman-torrent pause <id|all>
brickman-torrent resume <id|all>
brickman-torrent rm <id> [--files]
brickman-torrent priority <id> <number>
brickman-torrent limits [--down <KiB/s>] [--up <KiB/s>]
brickman-torrent max-active <n>
brickman-torrent run [--seconds SECS]
```

Every command performs one action and exits. The download engine runs only
while a command is running: `add --wait N` and `run` keep it in the foreground
for at most `N` seconds (`run` without `--seconds` stops on Ctrl+C). State lives
in `%APPDATA%\BrickmanTorrent\` (`state.json` for the queue, `session\` for the
engine's torrent list and fastresume bitfields); override it with `TC_DATA_DIR`,
and the default download folder with `TC_DOWNLOAD_DIR`.

Priorities are numbers, `1` is the highest. `max-active 0` means unlimited.
Torrents that wait for a free slot are shown as `queued`, torrents paused by the
user as `paused`.

## Acceptable use

Brickman Torrent is a protocol client. It contains no search, no content
catalogue, no index and no built-in tracker lists — it only downloads the
torrents you add yourself.

You are responsible for the content you download and share. The BitTorrent
protocol itself is legal and is commonly used for Linux distributions, open
data sets and your own files; distributing copyrighted works without permission
is not. Check the law of your jurisdiction before downloading.

## No telemetry

The client sends nothing about you or your usage. There is no analytics, no
crash reporting and no account. Network traffic consists of BitTorrent protocol
traffic (peers, DHT, trackers you selected) and, once the desktop UI lands, a
single update check that can be switched off in settings. Nothing else phones
home.

## License

MIT, see [LICENSE](LICENSE).
