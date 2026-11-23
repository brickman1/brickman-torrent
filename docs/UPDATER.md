# In-app updates (tauri-plugin-updater)

The app **checks** for a new release on GitHub and can now also **download and
install** it without leaving the window. Installing needs one thing the repo
deliberately does not ship: the **updater signing key**. Until that key exists,
the feature is switched off and the app behaves exactly as before - the update
banner and the dialog only offer "Download", which opens the release page.

The plugin itself is always compiled in (`apps/desktop/src-tauri/src/lib.rs`),
the endpoint is already configured, and only `plugins.updater.pubkey` is empty.
That is the switch: no key, no in-app install.

## How the switch works

| Piece | Where | Without a key |
| --- | --- | --- |
| Endpoint | `plugins.updater.endpoints` in `apps/desktop/src-tauri/tauri.conf.json` | set, but `latest.json` is not published |
| Public key | `plugins.updater.pubkey` (empty string) | `updater_enabled` returns `false` |
| Updater artifacts | `createUpdaterArtifacts: true` via `--config` in the release workflow | not built, no `.sig`, no `latest.json` |
| UI | update dialog | button "Download" opens the release page |

`tauri.conf.json` is JSON, so the "empty means off" state is documented here
instead of a comment in the file.

The frontend never guesses: `updater_enabled` (Rust) reports whether `pubkey`
is non-empty, and the dialog asks it before offering "Download and install". A
run that fails anyway - missing `latest.json`, a rejected signature, no network
- is caught and falls back to opening the release page.

## One-time setup (owner does this, once)

1. Generate the signing key pair (keep the private key out of the repo):

   ```powershell
   npm --prefix apps/desktop run tauri -- signer generate -w $env:USERPROFILE\.tauri\brickman-torrent.key
   ```

   `cargo tauri signer generate -w <path>` works the same if the CLI is
   installed globally. The `--` keeps npm from reading `-w` as one of its own
   flags. The command asks for a password, prints the **public** key and writes
   the **private** key to the given path. Store both in Vaultwarden; the private
   key is the only thing that can sign releases.

2. Put the **public** key into `plugins.updater.pubkey` in
   `apps/desktop/src-tauri/tauri.conf.json` (one line, base64, includes the
   `untrusted comment:` line - copy it exactly as printed):

   ```json
   "plugins": {
     "updater": {
       "endpoints": [
         "https://github.com/brickman1/brickman-torrent/releases/latest/download/latest.json"
       ],
       "pubkey": "RW..."
     }
   }
   ```

   The public key belongs in git; it is what every installed copy verifies
   against.

3. Add two repository secrets (Settings -> Secrets and variables -> Actions):

   - `TAURI_SIGNING_PRIVATE_KEY` - the **content** of the private key file
     (not the path);
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` - the password chosen in step 1
     (empty only if the key was generated without one).

4. Bump the version and push a `v*.*.*` tag. The `Release` workflow now:

   - merges `createUpdaterArtifacts: true` in through `--config`, so only the
     keyed build produces updater artifacts;
   - signs the final setup `.exe` **after** the SignPath step and writes
     `latest.json` (`version`, `pub_date`, `platforms.windows-x86_64` with
     `url` + `signature`);
   - uploads `latest.json` and `Brickman Torrent_<version>_x64-setup.exe.sig`
     to the release with `gh release upload` (notes stay untouched).

   Without the secret both steps are skipped and the release publishes the same
   files as before.

## Verifying it works

- The new release shows two extra assets: `latest.json` and
  `Brickman Torrent_<version>_x64-setup.exe.sig`.
- <https://github.com/brickman1/brickman-torrent/releases/latest/download/latest.json>
  returns the manifest.
- Run an **older** installed version: the update dialog shows "Download and
  install"; the status line reports download progress and then the app restarts
  into the new version. (Windows: the NSIS setup restarts the app itself.)

## Notes and gotchas

- **The version in `latest.json` is the release tag.** The workflow already
  refuses a tag that disagrees with `tauri.conf.json` / `package.json`, so the
  manifest and the bundles always name the same version.
- **Order matters with code signing.** The updater signature covers the bytes of
  the installer, so it is created from the file that is actually published -
  after SignPath replaces the bundle. Do not Authenticode-sign the setup again
  after that step, or the signature in `latest.json` will no longer match.
- **Rotating the key** invalidates in-app updates for every copy that already
  has the old public key compiled in: those copies cannot verify new releases
  and need one manual install of a build carrying the new key.
- **Platforms:** only `windows-x86_64` is published today; the manifest lists
  just that key. Adding Linux/macOS bundles means adding their entries (and
  their own artifacts) to the manifest.
- **The updater endpoint is not signed.** The manifest is fetched over TLS and
  the signature covers only the downloaded installer, so `latest.json` can never
  make a client install a file this key did not sign.
- Reference: <https://v2.tauri.app/plugin/updater/>.
