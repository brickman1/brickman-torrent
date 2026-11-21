# winget manifest

Layout follows the [winget-pkgs](https://github.com/microsoft/winget-pkgs)
repository: `manifests/<first letter>/<Publisher>/<Package>/<Version>/`, three
files per version — version, installer, locale.

```
manifests/b/Brickman/brickman-torrent/0.1.1/
  Brickman.brickman-torrent.yaml              # PackageIdentifier + PackageVersion
  Brickman.brickman-torrent.installer.yaml    # InstallerType, Scope, URL, SHA256
  Brickman.brickman-torrent.locale.en-US.yaml # name, publisher, license, description
```

The package is the NSIS installer from the GitHub release, installed per user
(`Scope: user`), as `tauri build` prepares it. winget calls NSIS
`InstallerType: nullsoft` — `nsis` is not a valid value in the schema. The MSI
from the same release is not described: one installer per architecture is enough
for winget.

## Current state — read before submitting

`installer.yaml` expects the 0.1.1 asset:

```
https://github.com/brickman1/brickman-torrent/releases/download/v0.1.1/Brickman%20Torrent_0.1.1_x64-setup.exe
SHA256 6CF79A645606551364E5D4B5AD63F7C39EB424B9DAB6BC9E3F8F9AB4A54C45BA
```

The hash was taken from the local build
`target/release/bundle/nsis/Brickman Torrent_0.1.1_x64-setup.exe`. As of
2026-11-22 the `v0.1.1` release on GitHub carries the **0.1.0** installers
(`Brickman.Torrent_0.1.0_x64-setup.exe`, published 2026-11-21), so the URL above
returns 404 until the 0.1.1 artifacts are uploaded. Upload them first, then
check both values again:

```sh
curl -fLO 'https://github.com/brickman1/brickman-torrent/releases/download/v0.1.1/Brickman%20Torrent_0.1.1_x64-setup.exe'
sha256sum 'Brickman Torrent_0.1.1_x64-setup.exe'
```

Windows equivalent:

```powershell
Get-FileHash 'target\release\bundle\nsis\Brickman Torrent_0.1.1_x64-setup.exe' -Algorithm SHA256
```

## Validate

```sh
winget validate --manifest packaging/winget/manifests/b/Brickman/brickman-torrent/0.1.1
winget install --manifest packaging/winget/manifests/b/Brickman/brickman-torrent/0.1.1
```

`winget install --manifest` actually downloads the installer and checks the
hash, so it is the real test. `wingetvalidate` from
[wingetcreate](https://github.com/microsoft/winget-create) works too.

## Submit

1. Fork `microsoft/winget-pkgs` and clone the fork.
2. Copy the directory so that it lands as
   `manifests/b/Brickman/brickman-torrent/0.1.1/` in the fork.
3. Commit with a title like
   `New package: Brickman.brickman-torrent version 0.1.1` and open a pull
   request against `master`.
4. Answer the validation bot; a moderator merges it, after which
   `winget install Brickman.brickman-torrent` works for everyone.

Requirements the manifest has to satisfy:
[winget-pkgs authoring](https://github.com/microsoft/winget-pkgs/blob/master/AUTHORING_MANIFESTS.md)
and the
[package guidelines](https://github.com/microsoft/winget-pkgs/blob/master/CONTRIBUTING.md).
`wingetcreate submit` / `wingetcreate update` automates steps 2–4 and is the
usual path once the release asset is in place.

For a later version, copy the `0.1.1` directory to `0.1.2` and change
`PackageVersion`, `InstallerUrl`, `InstallerSha256` and `ReleaseNotesUrl`.
