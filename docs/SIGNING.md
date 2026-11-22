# Code signing with SignPath

Release builds are **unsigned by default**. To get an Authenticode-signed
installer (so SmartScreen stops warning on download), sign the release
artifacts with [SignPath](https://signpath.io), which is free for open-source
projects.

The workflow already has the signing steps wired in; they are skipped until the
secrets and variables below exist. Until then releases publish unsigned.

## One-time setup (owner does this, once)

1. Apply for the SignPath OSS program at <https://signpath.io/open-source>,
   pointing at `brickman1/brickman-torrent`.
2. Install the **SignPath GitHub App** for the repo (SignPath gives the link
   during onboarding; it lets the connector read the workflow artifact).
3. In SignPath, create:
   - a **project** (slug, e.g. `brickman-torrent`);
   - a **signing policy** (slug, e.g. `release-signing`) that signs the
     Authenticode artifacts;
   - an **artifact configuration** (slug, e.g. `release-bundles`) whose root
     element is a ZIP and that signs both `Brickman Torrent_*_x64-setup.exe`
     and `Brickman Torrent_*_x64_en-US.msi`;
   - a dedicated **CI user** and an API token for it.
4. Add to the repository:

   Secrets:
   - `SIGNPATH_API_TOKEN` — the CI user's API token.

   Variables (Settings → Secrets and variables → Actions → Variables):
   - `SIGNPATH_ORGANIZATION_ID`
   - `SIGNPATH_PROJECT_SLUG`
   - `SIGNPATH_SIGNING_POLICY_SLUG`
   - `SIGNPATH_ARTIFACT_CONFIG_SLUG`

5. Push a `v*.*.*` tag. The `Release` workflow will:
   - build the bundles,
   - upload them as a workflow artifact,
   - submit a signing request and **wait for approval**,
   - after you approve in SignPath (the signing-request URL is printed in the
     run log / step summary), download the signed copies and publish them.

## Notes

- **Manual approval per release** is part of SignPath's OSS terms; the workflow
  intentionally waits (`wait-for-completion: true`). Approve in the SignPath UI
  when the run pauses, or the release job will time out.
- `SHA256SUMS.txt` is regenerated **after** signing, because signing changes the
  hashes.
- If the signing request fails or the secrets are missing, the release still
  publishes the unsigned artifacts — signing is best-effort.
- Reference: <https://docs.signpath.io/trusted-build-systems/github> and the
  `signpath/github-action-submit-signing-request` action.
