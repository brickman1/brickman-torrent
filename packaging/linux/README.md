# Linux packaging

Tauri does not produce AppImage or deb bundles here yet. What is ready is the
desktop entry, so a locally built GUI can be started from the menu and can own
`magnet:` links.

## What the file expects

- `Exec=brickman-desktop %U` — the GUI binary. `cargo build --release` in the
  workspace produces `brickman-desktop` (GUI, `mainBinaryName` in
  `apps/desktop/src-tauri/tauri.conf.json`) and `brickman-torrent` (the CLI,
  which runs one command and exits). Do not point `Exec` at the CLI: it has no
  command for a magnet URL.
- `Icon=brickman-torrent` — a placeholder. No icon file ships with this entry;
  either install a PNG/SVG named `brickman-torrent.png` /
  `brickman-torrent.svg` into a hicolor theme, or the key is simply ignored and
  the launcher shows a default icon.
- `MimeType=x-scheme-handler/magnet;application/x-bittorrent;` — these are what
  make the app appear in *Open with* for magnet links and `.torrent` files.
- The GUI reads its argument at startup, so `%U` (a URL or a file) is passed
  through as is.

## Install the desktop entry for the current user

```sh
mkdir -p ~/.local/share/applications
desktop-file-install --dir="$HOME/.local/share/applications" \
  packaging/linux/brickman-torrent.desktop

xdg-mime default brickman-torrent.desktop x-scheme-handler/magnet
xdg-mime default brickman-torrent.desktop application/x-bittorrent
update-desktop-database ~/.local/share/applications
```

Check it:

```sh
xdg-mime query default x-scheme-handler/magnet   # prints brickman-torrent.desktop
desktop-file-validate packaging/linux/brickman-torrent.desktop
```

`desktop-file-install` copies the file into place and runs `update-desktop-database`
itself; a plain `cp` into `~/.local/share/applications` works too, but then run
`update-desktop-database` by hand.

Remove it again:

```sh
rm ~/.local/share/applications/brickman-torrent.desktop
update-desktop-database ~/.local/share/applications
```

## Building the GUI on Linux

The engine and the CLI are plain Rust and build anywhere. The GUI is Tauri 2, so
it needs WebKitGTK. On Debian/Ubuntu:

```sh
sudo apt install build-essential curl wget file libssl-dev libgtk-3-dev \
  libwebkit2gtk-4.1-dev librsvg2-dev

npm --prefix apps/desktop ci
npm --prefix apps/desktop run build
cargo build --release            # target/release/brickman-desktop, brickman-torrent
```

If `brickman-desktop` is not in `PATH`, put the full path in `Exec=` or install
the binary to `/usr/local/bin`.

AppImage and deb bundling is a separate task: it needs a Linux build host with
WebKitGTK and the `tauri build` bundle targets enabled.
