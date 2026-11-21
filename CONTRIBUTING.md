# Contributing

Thanks for looking at Brickman Torrent. Bug reports and small, focused pull
requests are the most useful kind of contribution.

## Before you start

- Security issues go through [SECURITY.md](SECURITY.md), not the issue tracker.
- The client only speaks BitTorrent for downloads. Features that add search,
  catalogues or bundled tracker lists are out of scope by design (see SPEC.md).
- For anything larger than a bug fix, open an issue first so we can agree on the
  approach before you spend time on it.

## Toolchain

- Rust 1.85+ (on Windows: the MSVC toolchain, `rustup default stable-msvc`).
- Node.js 20+ (`npm --prefix apps/desktop ci` installs the pinned frontend deps).
- Windows needs WebView2 for the Tauri shell; it ships with Windows 11.

## Build

The frontend must be built **before** Cargo: the Tauri crate embeds
`apps/desktop/dist` at compile time, so a bare `cargo build` on a fresh clone
fails on a missing dist directory.

```sh
npm --prefix apps/desktop ci
npm --prefix apps/desktop run build        # tsc --noEmit + vite build -> apps/desktop/dist

cargo build                                # whole workspace (core, cli, desktop)
cargo build --release
```

Installers (not needed for day-to-day work):

```sh
npm --prefix apps/desktop run tauri build  # target/release/bundle/{nsis,msi}
```

Iterating on the UI only: `npm --prefix apps/desktop run dev` serves the mock
data provider on <http://localhost:1420>, no Rust rebuild involved.

## Checks

Run these before opening a pull request; CI runs the same set.

```sh
cargo test
cargo clippy --all-targets -- -D warnings
npm --prefix apps/desktop run check:locales   # every locale keeps en.json's keys
```

UI smoke test (headless Edge, needs the dev server running on port 1420):

```sh
npm --prefix apps/desktop run dev             # terminal 1
npm --prefix apps/desktop run smoke           # terminal 2
```

`cargo fmt --check` is **not** enforced yet — the tree is not rustfmt-clean. You
may format the files you touch, but do not reformat unrelated code in the same
pull request; it makes review impossible.

## Code layout

- `crates/core` — engine wrapper over `librqbit`: sessions, queue, persistence,
  torrent metadata and path validation.
- `crates/cli` — one-shot command line client on top of the core.
- `apps/desktop/src-tauri` — Tauri commands and the app shell.
- `apps/desktop/src` — TypeScript UI, i18n dictionaries, mock provider.

Anything that turns torrent-supplied text into a filesystem path belongs in
`crates/core/src/paths.rs` and needs a unit test next to it: that is the piece
that keeps a malicious `.torrent` from writing outside the download directory.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(desktop): add per-torrent speed limit
fix(core): reject Windows device names in torrent paths
docs: explain checksum verification in the README
chore(deps): bump librqbit to 9.2
```

- One logical change per commit; keep the subject under ~72 characters.
- Scopes in use: `core`, `cli`, `desktop`, `i18n`, `ci`, `deps`, `docs`.
- In the pull request body, say what changed and how you verified it (commands
  run, screenshots for UI changes).
- Do not mix formatting-only changes with behaviour changes.

## Versioning

The version lives in three places and they must agree: `Cargo.toml`
(`[workspace.package]`), `apps/desktop/package.json` and
`apps/desktop/src-tauri/tauri.conf.json`. Releases are cut by tagging `vX.Y.Z`;
the release workflow refuses a tag that disagrees with those files.
