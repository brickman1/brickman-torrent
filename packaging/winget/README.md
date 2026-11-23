# winget manifest

Layout follows the [winget-pkgs](https://github.com/microsoft/winget-pkgs)
repository: `manifests/<first letter>/<Publisher>/<Package>/<Version>/`, three
files per version — version, installer, default locale.

```
manifests/b/Brickman/brickman-torrent/0.3.0/
  Brickman.brickman-torrent.yaml              # PackageIdentifier + PackageVersion
  Brickman.brickman-torrent.installer.yaml    # InstallerType, Scope, URL, SHA256
  Brickman.brickman-torrent.locale.en-US.yaml # name, publisher, license, description
```

The en-US file is the package's default locale, so it must declare
`ManifestType: defaultLocale` and reference the `defaultLocale` schema, even
though the file name keeps the `.locale.<locale>.yaml` form. With
`ManifestType: locale` there, `winget validate` reports
`The multi file manifest is incomplete` — that is what the `0.1.1` directory
still has, so it does not validate; `0.2.0` and `0.3.0` are corrected.

The `0.1.1` and `0.2.0` directories are kept as they are: winget-pkgs allows
several versions of the same package, and the submit PR carries the new one only.

The package is the NSIS installer from the GitHub release, installed per user
(`Scope: user`), as `tauri build` prepares it. winget calls NSIS
`InstallerType: nullsoft` — `nsis` is not a valid value in the schema. The MSI
from the same release is not described: one installer per architecture is enough
for winget.

## Current state — read before submitting

Current version is **0.3.0**, taken from the published GitHub release
(`v0.3.0`, published 2026-11-23T15:50:18Z, i.e. 2026-11-23 in MSK):

```
https://github.com/brickman1/brickman-torrent/releases/download/v0.3.0/Brickman.Torrent_0.3.0_x64-setup.exe
SHA256   1A2969BC62BDEAD995EF27486BC280AB7DC6D7C9948E5D7D0BA4759B7E312BB1
size     5845411 bytes
```

The hash was not taken from a local build: it is the SHA256 of the asset
downloaded from the URL above. Local `target/release/bundle/nsis/*` binaries may
differ because paths are embedded during the build, so always hash the release
asset.

Re-check both values from the release copy before submitting (the URL in the
manifest is the asset name with dots, the release label spells it with a space):

```sh
curl -fLO 'https://github.com/brickman1/brickman-torrent/releases/download/v0.3.0/Brickman.Torrent_0.3.0_x64-setup.exe'
sha256sum 'Brickman.Torrent_0.3.0_x64-setup.exe'
curl -fsSL 'https://github.com/brickman1/brickman-torrent/releases/download/v0.3.0/SHA256SUMS.txt'
```

Windows equivalent:

```powershell
curl.exe -fLO 'https://github.com/brickman1/brickman-torrent/releases/download/v0.3.0/Brickman.Torrent_0.3.0_x64-setup.exe'
(Get-FileHash 'Brickman.Torrent_0.3.0_x64-setup.exe' -Algorithm SHA256).Hash
(Get-Item 'Brickman.Torrent_0.3.0_x64-setup.exe').Length
```

`0.2.0` is superseded and left as it was; its hash
(`8E22CE94…563CAF`, 5771951 bytes) matches the `v0.2.0` release asset as of
2026-11-23. `0.1.1` is left as it was too; the hash there
(`6CF79A64…4C45BA`) matches the `v0.1.1` release asset as of 2026-11-22.

## Validate

```sh
winget validate --manifest packaging/winget/manifests/b/Brickman/brickman-torrent/0.3.0
winget install --manifest packaging/winget/manifests/b/Brickman/brickman-torrent/0.3.0
```

`winget validate` on `0.3.0` reports
`Проверка манифеста выполнена успешно` (exit 0). `winget install --manifest`
also downloads the installer and checks the hash, so it is the real test — run
it last, because it installs the app. `wingetvalidate` from
[wingetcreate](https://github.com/microsoft/winget-create) works too.

Without winget, parse the YAML and check it against the 1.12.0 schemas the files
reference (`defaultLocale`, `installer`, `version`):

```sh
python -c "import yaml,glob; [yaml.safe_load(open(p, encoding='utf-8')) for p in glob.glob('packaging/winget/manifests/b/Brickman/brickman-torrent/0.3.0/*.yaml')]"
```

## Submit

1. Fork `microsoft/winget-pkgs` and clone the fork.
2. Copy the directory so that it lands as
   `manifests/b/Brickman/brickman-torrent/0.3.0/` in the fork.
3. Commit with a title like
   `Update: Brickman.brickman-torrent version 0.3.0` — `New package: …` for the
   first submission of the package — and open a pull request against `master`.
4. Answer the validation bot; a moderator merges it, after which
   `winget install Brickman.brickman-torrent` works for everyone.

Requirements the manifest has to satisfy:
[winget-pkgs authoring](https://github.com/microsoft/winget-pkgs/blob/master/AUTHORING_MANIFESTS.md)
and the
[package guidelines](https://github.com/microsoft/winget-pkgs/blob/master/CONTRIBUTING.md).
`wingetcreate submit` / `wingetcreate update` automates steps 2–4 and is the
usual path once the release asset is in place.

For a later version, copy the `0.3.0` directory to `0.3.1` and change
`PackageVersion`, `ReleaseDate`, `InstallerUrl`, `InstallerSha256` and
`ReleaseNotesUrl`, then hash the new release asset.
