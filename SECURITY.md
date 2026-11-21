# Security policy

Brickman Torrent is a small desktop BitTorrent client: a Tauri 2 shell around a
Rust core that wraps [`librqbit`](https://github.com/ikatson/rqbit). The download
engine is third-party code; this document covers what *this* repository owns.

## Reporting a vulnerability

Please do **not** open a public issue for anything security-relevant.

- Email: `security@brickman161.ru` — put `Brickman Torrent` in the subject.
- Or open a private advisory on GitHub:
  <https://github.com/brickman1/brickman-torrent/security/advisories/new>.

Useful in a report: affected version (Settings → About, or the release tag),
operating system, steps to reproduce, and whether a `.torrent`/magnet file is
involved. We aim to acknowledge within a few days and to agree on a disclosure
date with you; there is no bug bounty.

## Threat model

The main untrusted input is the torrent itself:

- **`.torrent` metadata and magnet links.** The `info` dictionary is fully
  attacker-controlled: file names, lengths, piece hashes, trackers, and the
  optional `info.utf8`/`encoding` fields. Parsing happens in `librqbit`; our
  code treats everything it reports as data, never as paths to trust.
- **File names inside a torrent.** Names may contain `..`, absolute paths,
  Windows drive letters, reserved device names (`CON`, `NUL`, `COM1`, ...),
  trailing dots/spaces, NTFS alternate-data-stream colons, and control
  characters. `brickman-core` sanitises every entry and rejects anything that
  would resolve outside the download directory (CWE-22 path traversal); this is
  covered by unit tests, so a regression there is a security bug.
- **Tracker/DHT and peer traffic.** Peer-supplied data (piece bytes, extension
  messages) is handled by `librqbit`; pieces are hash-checked before being
  written.
- **Remote metadata from magnet links** is downloaded from peers before we see
  file names, i.e. the sanitisation above must run on the *resolved* metadata
  too, not only on locally loaded `.torrent` files.

Out of scope for the app itself, but worth knowing:

- Local files served by the web UI over Tauri's asset protocol come from our own
  bundle, not from torrent data.
- A malicious *local* user, or a compromised machine, is not defended against.

## Known gaps

- **Builds are unsigned.** Release artifacts are not code-signed yet, so Windows
  SmartScreen will warn on first run and there is no publisher pinning. Only run
  builds from the official releases page and compare `SHA256SUMS.txt` against
  the downloaded files.
- **Updates only check that a release exists.** The app compares its version with
  the latest GitHub release and points at the download page; it does not verify
  signatures and does not auto-install, so an update is a manual download that
  you can inspect first.
- No sandboxing beyond the OS defaults; the client writes only inside the chosen
  download directory and the app data directory.

## Supported versions

Only the latest release receives fixes; there are no maintained back-branches at
this stage.
