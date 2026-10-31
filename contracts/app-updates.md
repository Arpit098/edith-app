# App updates contract (CI ⇄ server ⇄ app)

How the app updates itself (docs/PHASE3_APP_PLAN.md §9): **OTA JS bundles** through expo-updates, and
**new APKs** through the App API. Three parties:
- **CI** (`.github/workflows/build-apk.yml`) builds, signs and uploads artifacts;
- **the server** (`server/edith/features/app_updates/`) collects them from GitHub and serves them;
- **the app** checks, downloads, verifies and installs.

Change this file first, then the sides. Times in JSON are unix seconds; anything shown to Arpit is in IST.

## 1. Auth and transport

- Every route below is on the App API: **Tailscale IP only**, `http://edith:8787`, with the same
  `Authorization: Bearer <token>` check as every other route (401 without it). No route is public.
- expo-updates sends the token too. The APK is built with
  `updates.requestHeaders = {"Authorization": "Bearer -", "expo-channel-name": "main"}`. The `-` is a
  placeholder: expo-updates only allows a runtime override of header names that were embedded at build
  time. At startup the app calls `Updates.setUpdateRequestHeadersOverride({Authorization: "Bearer <token>",
  "expo-channel-name": "main"})`. expo-updates sends these headers on the manifest request **and on every
  asset request**, so assets need no `assetRequestHeaders`.
- Until the override is in effect (the first launch after install or after a new token), the manifest
  request carries `Bearer -` and gets a **401**: harmless, the app keeps its current bundle.
- `updates.url` (build time) = `http://edith:8787/v1/updates/manifest`, using the MagicDNS name `edith`.

## 2. Artifacts CI uploads (every successful run; the server takes them only from `main`)

The server lists runs with `gh run list --repo Arpit098/edith-app --workflow build-apk.yml --branch main
--status success --json databaseId,headSha,createdAt` and downloads by artifact name with
`gh run download <run_id> --name <artifact> --dir <tmp>`.

### `edith-apk`

```
edith.apk
apk.json
```

`apk.json`:

```json
{
  "versionName": "0.2.0",
  "versionCode": 1042,
  "sha": "8f12b81c…",            // full git commit
  "run_id": 40872583751,
  "built_at": 1793280000,        // unix seconds
  "runtimeVersion": "4f0c…",     // the fingerprint this APK accepts OTA bundles for (see §4)
  "size": 15432247,              // bytes of edith.apk
  "sha256": "9b1e…",             // hex SHA-256 of edith.apk
  "cert_sha256": "AB:CD:…",      // SHA-256 digest of the signing certificate (apksigner --print-certs)
  "signing": "release",          // or "debug": the public Expo debug key (see §6)
  "release_notes": { "new": ["Attach photos and voice notes"], "fixes": ["Messages no longer vanish"],
                     "changes": [], "details": ["feat: …", "fix: …"] }
}
```

- `versionCode` = `1000 + github.run_number`: it goes up with every run, as Android requires for an update.
- `release_notes` (main builds; empty lists on PR builds, absent in older builds): what changed, in plain words.
  - Source: the `## Release notes` block of every PR merged since the previous successful main build
    (`New: …`, `Fix: …` lines; `Internal: …` lines are left out). See `.github/pull_request_template.md`.
  - `new` and `fixes` come from those blocks, deduplicated, at most 20 each. `changes` holds the titles of PRs
    without a block. `details` holds the commit subjects, at most 30, for a collapsed "Technical details".
  - `app/scripts/release-notes.js` makes them with three GitHub calls. It never fails the build: on a problem
    the lists are empty.

### `edith-ota` (only when the OTA signing key is configured in CI; see §6)

```
update.json
manifest.json        the exact bytes to serve (they are what is signed)
manifest.sig         the full expo-signature header value: sig="<base64>", keyid="main", alg="rsa-v1_5-sha256"
dist/…               the `npx expo export --platform android` output (bundle, assets, metadata.json)
```

`update.json`:

```json
{
  "id": "1c9e5a3e-…",             // = manifest.id
  "createdAt": 1793280000,       // unix seconds; manifest.createdAt is the same instant in ISO 8601
  "runtimeVersion": "4f0c…",
  "channel": "main",
  "platform": "android",
  "sha": "8f12b81c…",
  "run_id": 40872583751,
  "files": [
    { "path": "dist/_expo/static/js/android/index-….hbc", "sha256": "…hex…", "size": 1180000,
      "contentType": "application/javascript", "launch": true },
    { "path": "dist/assets/5a29…", "sha256": "…hex…", "size": 1310000, "contentType": "font/ttf" }
  ],
  "release_notes": { "new": […], "fixes": […], "changes": […], "details": […] }   // as in apk.json
}
```

`manifest.json` (built and signed by CI; the server never changes or re-serializes it):

```json
{
  "id": "1c9e5a3e-…",
  "createdAt": "2026-10-29T12:30:00.000Z",
  "runtimeVersion": "4f0c…",
  "launchAsset": { "hash": "<base64url sha256>", "key": "<md5 hex>", "contentType": "application/javascript",
                   "url": "http://edith:8787/v1/updates/assets/<sha256 hex>" },
  "assets": [ { "hash": "<base64url sha256>", "key": "<md5 hex>", "contentType": "font/ttf", "fileExtension": ".ttf",
                "url": "http://edith:8787/v1/updates/assets/<sha256 hex>" } ],
  "metadata": { "channel": "main", "sha": "8f12b81c…", "release_notes": "{\"new\":[…],\"fixes\":[…],…}" },
  "extra": { "expoClient": { …the app's public Expo config… } }
}
```

- `metadata.release_notes` is the same object as in `update.json`, as a JSON **string**: manifest metadata
  values stay flat strings for expo-updates. It is signed with the rest of the manifest.

- `hash` is the Base64URL SHA-256 that expo-updates checks. The URL uses the **hex** SHA-256, matching
  `update.json` `files[].sha256`. `key` is the asset's MD5 (the name `expo export` gives it, which is how
  the bundle refers to it).

### Local builds (OTA only, built on edith without CI)

`python3 -m edith.features.app_updates.local_build [--ref origin/main]` (in `server/`) makes the same
`edith-ota` artifact on edith, for JS-only changes when CI can't run. APKs still come only from CI.

- From a clean checkout of the ref in its own clone (`<state_dir>/ota-build/src`): `npm ci --ignore-scripts`
  (skipped while the lockfile and Node are unchanged), the runtimeVersion resolved as CI does (§4),
  `expo export`, then `scripts/ota.js`. The release notes cover the PRs merged since the newest build the
  server holds for that runtimeVersion.
- The steps that run npm packages' code each run as a transient `systemd-run --user` unit, with a minimal
  environment (`env -i`). Nothing they leave running survives the step, and none of our tokens or agent
  sockets reach them. Only `ota.js` gets the key path.
  - This is not a filesystem sandbox: edith blocks unprivileged user namespaces, so `ProtectHome=` can't apply.
- The key is a file, by default `~/.config/edith-signing/ota/private-key.pem`. It must be the owner's and
  mode 600, or the build refuses. Only `ota.js` reads it, which also checks it against
  `app/certs/updates-certificate.pem`.
- It refuses when the runtimeVersion matches no APK the server offers: the native side changed, so a new APK
  is needed. It also refuses when that commit is already the newest bundle for the runtimeVersion.
- It also refuses unless the commit contains the newest build the server holds for the runtimeVersion. That
  is the newest bundle, or the APK's commit when there is no bundle yet (`git merge-base --is-ancestor`).
  The newest bundle is served, so building an older ref would roll the app back.
- The artifact goes into `<state_dir>/app-updates/inbox/<id>/`: it is copied in under a dot name, then renamed.
  The collect job imports it before its GitHub pass, with the same checks as a CI artifact, and the record
  gets `"source": "local"` and `run_id` 0. CI records have `"source": "ci"`. The newest update for a
  runtimeVersion is served, whichever built it.
- An inbox folder that fails a check, has malformed JSON or lacks `update.json`, `manifest.json` or
  `manifest.sig` is renamed to `.rejected-<id>`. It is never retried, and it never stops CI artifacts from
  being collected. Rejected folders are deleted after 7 days.
- Just before copying into the inbox, the build reads `index.json` again and repeats its checks, so a CI bundle
  imported during the build can't be rolled back.
- Hermes: npm's `hermesc` is x86-64 only, so on edith (ARM64) the build needs `--hermes-dir` (a `hermesc` built
  from the same Hermes release) or `--no-bytecode`. With `--no-bytecode`, the bundle is plain JS, which Hermes
  also runs but starts a little slower.
  - **`--no-bytecode`: verify on a phone before relying on it.** CI never ships such a bundle, so check that the
    first one installs, starts and works on a phone before treating that path as routine.

## 3. Server routes

### OTA (Expo Updates protocol v1)

| Method | Path | Answer |
|---|---|---|
| GET | `/v1/updates/manifest` | The newest update for the request's `expo-runtime-version` + `expo-channel-name` (+ `expo-platform: android`), as below; **204** (no body, no content-type) when there is none, or when it is the one in `expo-current-update-id` |
| GET | `/v1/updates/assets/{sha256hex}` | The file with that SHA-256, from any stored update; 404 if unknown |

Manifest response, 200:
- Headers: `expo-protocol-version: 1`, `expo-sfv-version: 0`, `cache-control: private, max-age=0`,
  `content-type: multipart/mixed; boundary=<random>`.
- One part, `manifest`:
  ```
  --<boundary>
  content-type: application/json; charset=utf-8
  content-disposition: form-data; name="manifest"
  expo-signature: <manifest.sig, verbatim>

  <manifest.json bytes, verbatim>
  --<boundary>--
  ```
- Missing or wrong request headers: 400 (no `expo-runtime-version`, or a platform other than `android`).

Asset response: the bytes with `content-type` from `update.json`, `content-length`, and
`cache-control: public, max-age=31536000, immutable`. Gzip is optional (`accept-encoding`). Files are
streamed from disk.

The server logs `expo-current-update-id`, `expo-embedded-update-id` and `expo-fatal-error` (the client's
last crash, ≤ 1024 chars) in the audit log. A fatal error that names the current update is how a
crashing bundle shows up.

### APK

| Method | Path | Answer |
|---|---|---|
| GET | `/v1/app/latest` | The newest offerable APK: `{versionName, versionCode, sha, built_at, runtimeVersion, size, sha256, cert_sha256, notes, release_notes, url}`. `url` = `/v1/app/apk/{versionCode}`. `release_notes` = the build's `{new, fixes, changes, details}` (lists of strings), or `null` for builds from before release notes. `notes` = plain text for older apps: `New: …` / `Fix: …` / `Change: …` lines when the build has release notes, else the commit subjects since the previous offered APK (≤ 20 lines). 404 `{"error": "no app build yet"}` if none |
| GET | `/v1/app/apk/{versionCode}` | `application/vnd.android.package-archive`, `content-length`, `etag: "<sha256>"`, `accept-ranges: bytes`; `Range: bytes=N-` → 206 (resume). 404 if not offered |

**Offerable** = collected from a successful `main` run, `signing == "release"`, and `cert_sha256` equal to
the server config's pinned `app_updates.cert_sha256` (if set). **Debug-signed APKs are never offered**
(the debug key is public; §6). The server keeps the newest 5 APKs and the updates of the newest 3
runtimeVersions.
At most the newest 10 updates are kept per runtimeVersion (only the newest is served; older ones only use disk).

## 4. runtimeVersion and channel

- `runtimeVersion` uses expo-updates' **fingerprint** policy: a hash of everything native (dependencies
  with native code, config plugins, the native parts of the app config, `android-modules/`). The version
  name and code are left out of it (`sourceSkips: ExpoConfigVersions`), so a version bump alone doesn't
  change it. CI records it with `npx expo-updates runtimeversion:resolve --platform android`.
- Each APK sends its own value as `expo-runtime-version`; the server matches it **exactly**. A JS bundle
  built from a commit whose native side differs has a different runtimeVersion and never reaches that
  APK. The app then shows "Update available" for the new APK instead.
- `channel` is `main` (sent as `expo-channel-name`). Only `main` builds are collected; other channels
  are a later addition.

## 5. What the app checks

- **OTA:** expo-updates verifies the manifest signature against the certificate embedded in the APK,
  and each asset's SHA-256 against the manifest. An update is applied on the next cold start. If the
  new bundle crashes before it renders, expo-updates goes back to the previous bundle (and reports the
  error as `expo-fatal-error` on its next request).
- **APK:** the app downloads `/v1/app/apk/{versionCode}` to its cache and compares the file's SHA-256
  with `latest.sha256` (mismatch: delete and report). Only then does it open Android's installer
  (`PackageInstaller`, permission `REQUEST_INSTALL_PACKAGES`). Android itself refuses an APK whose
  signature differs from the installed app's.

## 6. Signing keys (GitHub Secrets; Arpit creates them; never in git)

| Secret | What |
|---|---|
| `EDITH_KEYSTORE_B64` | The release keystore (`.jks`), base64 |
| `EDITH_KEYSTORE_PASSWORD`, `EDITH_KEY_ALIAS`, `EDITH_KEY_PASSWORD` | Its passwords and alias |
| `EDITH_UPDATES_KEY_PEM` | The OTA code-signing private key (PEM) |
| `EDITH_UPDATES_CERT_PEM` | Its self-signed certificate (PEM; public, embedded in the APK) |

- No release keystore: CI signs with Expo's public debug key, says so in the job summary, and writes
  `"signing": "debug"`. The server never offers that APK.
- No OTA key: the APK is built with expo-updates **disabled** and no `edith-ota` artifact is made. An
  APK never accepts unsigned bundles.
- The commands to create both are in `app/README.md` ("Signing keys").

## 7. Update announcements (`app.update_available`)

After each collect pass the server announces a newly offerable update once on the event bus (and so on
`/v1/stream`); the `notifications` feature pushes it (contracts/push.md), even while the app is connected.

```json
{ "kind": "ota", "id": "1c9e5a3e-…", "versionName": null, "versionCode": null, "runtimeVersion": "4f0c…",
  "sha": "8f12b81c…", "summary": "New: Attach photos · Fix: Messages no longer vanish" }
```

- **apk**: the newest offerable `versionCode` is above the last one announced. `id` is the versionCode as a
  string; `versionName` and `versionCode` are set.
- **ota**: the newest update for the newest offerable APK's `runtimeVersion` has an id not announced before.
  `id` is the update id.
- A new APK whose `runtimeVersion` equals the previous APK's (only JS changed) is decided by its run's
  `edith-ota` artifact. Not collected yet (e.g. a failed download, retried next pass): nothing is announced
  or recorded until it is. Collected: only the `ota` is announced (nothing, if that OTA already was), since
  nothing needs installing, and the APK is recorded. Missing or rejected: the `apk` is announced.
- A new APK with new native code is announced as `apk`; its own OTA is recorded, not announced too.
- Announcing runs after every pass, also one whose GitHub part failed, so a local OTA is announced while
  GitHub is down. An announcing error is logged and never fails the pass.
- `summary`: the first 3 of the build's release notes as `New: …` / `Fix: …` / `Change: …`, joined with
  ` · `; without notes, `EDITH <versionName> (build <versionCode>) is ready to install` (apk) or
  `A newer version of the app's code is ready` (ota).
- What was announced is kept in `index.json` (`announced: {apk: <versionCode>, ota: [<ids>, ≤ 50]}`) and
  written before the event is published, so an update is announced at most once, also across restarts.
  A store with no `announced` record, or a malformed one (the first start with this feature, an index
  rebuilt from scratch), records what it holds as the baseline and announces nothing. Nothing is recorded
  while no APK is offered, so **the first offerable APK ever (and its OTA) is recorded quietly**, never announced.

The app, on that event or on its own check, shows a small "Update ready · Restart" banner for an update
it hasn't shown before (remembered on the phone, keyed on the downloaded bundle's update id or the APK's
versionCode), and `edith://settings/updates` opens Settings → Updates. An announcement that comes in
during a check runs one more check after it.
