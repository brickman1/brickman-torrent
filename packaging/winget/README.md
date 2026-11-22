# winget manifest

Layout follows the [winget-pkgs](https://github.com/microsoft/winget-pkgs)
repository: `manifests/<first letter>/<Publisher>/<Package>/<Version>/`, three
files per version — version, installer, default locale.

```
manifests/b/Brickman/brickman-torrent/0.2.0/
  Brickman.brickman-torrent.yaml              # PackageIdentifier + PackageVersion
  Brickman.brickman-torrent.installer.yaml    # InstallerType, Scope, URL, SHA256
  Brickman.brickman-torrent.locale.en-US.yaml # name, publisher, license, description
```

The en-US file is the package's default locale, so it must declare
`ManifestType: defaultLocale` and reference the `defaultLocale` schema, even
though the file name keeps the `.locale.<locale>.yaml` form. With
`ManifestType: locale` there, `winget validate` reports
`The multi file manifest is incomplete` — that is what the `0.1.1` directory
still has, so it does not validate; `0.2.0` is corrected.

The `0.1.1` directory is kept next to it: winget-pkgs allows several versions of
the same package, and the submit PR carries the new one only.

The package is the NSIS installer from the GitHub release, installed per user
(`Scope: user`), as `tauri build` prepares it. winget calls NSIS
`InstallerType: nullsoft` — `nsis` is not a valid value in the schema. The MSI
from the same release is not described: one installer per architecture is enough
for winget.

## Current state — read before submitting

Current version is **0.2.0**, taken from the published GitHub release
(`v0.2.0`, published 2026-11-21T22:28:06Z, i.e. 2026-11-22 in MSK):

```
https://github.com/brickman1/brickman-torrent/releases/download/v0.2.0/Brickman.Torrent_0.2.0_x64-setup.exe
SHA256   8E22CE94FCF303A781AF8B1E1362EC3D5C9F6DDC22F268B779330DAA83563CAF
size     5771951 bytes
```

The hash was not taken from a local build: it is the SHA256 of the asset
downloaded from the URL above, and it matches both the asset digest reported by
the GitHub API and `SHA256SUMS.txt` in the same release. Local
`target/release/bundle/nsis/*` binaries may differ because paths are embedded
during the build, so always hash the release asset.

Re-check both values from the release copy before submitting (the URL in the
manifest is the asset name with dots, the release label spells it with a space):

```sh
curl -fLO 'https://github.com/brickman1/brickman-torrent/releases/download/v0.2.0/Brickman.Torrent_0.2.0_x64-setup.exe'
sha256sum 'Brickman.Torrent_0.2.0_x64-setup.exe'
curl -fsSL 'https://github.com/brickman1/brickman-torrent/releases/download/v0.2.0/SHA256SUMS.txt'
```

Windows equivalent:

```powershell
curl.exe -fLO 'https://github.com/brickman1/brickman-torrent/releases/download/v0.2.0/Brickman.Torrent_0.2.0_x64-setup.exe'
(Get-FileHash 'Brickman.Torrent_0.2.0_x64-setup.exe' -Algorithm SHA256).Hash
```

`0.1.1` is superseded, but its manifest is left as it was; the hash there
(`6CF79A64…4C45BA`) matches the `v0.1.1` release asset as of 2026-11-22.

## Validate

```sh
winget validate --manifest packaging/winget/manifests/b/Brickman/brickman-torrent/0.2.0
winget install --manifest packaging/winget/manifests/b/Brickman/brickman-torrent/0.2.0
```

`winget validate` on `0.2.0` reports
`Проверка манифеста выполнена успешно` (exit 0). `winget install --manifest`
also downloads the installer and checks the hash, so it is the real test — run
it last, because it installs the app. `wingetvalidate` from
[wingetcreate](https://github.com/microsoft/winget-create) works too.

Without winget, parse the YAML and check it against the 1.12.0 schemas the files
reference (`defaultLocale`, `installer`, `version`):

```sh
python -c "import yaml,glob; [yaml.safe_load(open(p, encoding='utf-8')) for p in glob.glob('packaging/winget/manifests/b/Brickman/brickman-torrent/0.2.0/*.yaml')]"
```

## Submit

1. Fork `microsoft/winget-pkgs` and clone the fork.
2. Copy the directory so that it lands as
   `manifests/b/Brickman/brickman-torrent/0.2.0/` in the fork.
3. Commit with a title like
   `Update: Brickman.brickman-torrent version 0.2.0` — `New package: …` for the
   first submission of the package — and open a pull request against `master`.
4. Answer the validation bot; a moderator merges it, after which
   `winget install Brickman.brickman-torrent` works for everyone.

Requirements the manifest has to satisfy:
[winget-pkgs authoring](https://github.com/microsoft/winget-pkgs/blob/master/AUTHORING_MANIFESTS.md)
and the
[package guidelines](https://github.com/microsoft/winget-pkgs/blob/master/CONTRIBUTING.md).
`wingetcreate submit` / `wingetcreate update` automates steps 2–4 and is the
usual path once the release asset is in place.

For a later version, copy the `0.2.0` directory to `0.2.1` and change
`PackageVersion`, `ReleaseDate`, `InstallerUrl`, `InstallerSha256` and
`ReleaseNotesUrl`, then hash the new release asset.
