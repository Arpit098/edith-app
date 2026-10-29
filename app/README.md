# EDITH Android app

React Native with Expo SDK 57 (prebuild, no EAS), TypeScript strict, Android only. It talks to the
App API on edith over Tailscale (`contracts/events.md`, "App API").

## Phase 2 (App v1)

| Screen | Where | What |
|---|---|---|
| Connect | shell | Server address (`edith:8787` or `100.x.y.z:8787`) and token. Checked with `GET /v1/status`, then saved with expo-secure-store (encrypted with an Android Keystore key, excluded from backups) |
| Live | `features/live-session` | The live session from the stream: chat bubbles, tool calls with result, diffs, system messages with buttons. Status bar (idle / working · step · time), text send, Stop |
| Sessions | `features/sessions` | List, switch (tap), rename (pencil), new conversation, pull to refresh |
| Approvals | `features/approvals` | Allow/Deny cards in a banner above every screen while a prompt is pending |
| Tools | shell | Grid of the features' `tool` tiles. Today: **Commands** (`features/commands`), which runs the server commands (`/today`, `/mail`, `/reminders`, `/brief`, …) with their reply buttons |
| Settings | shell | Server, connection state, reconnect, change server (deletes the token), then each feature's settings section |

## Layout

```
app/
├── index.ts, app.json, babel.config.js, jest.config.js, tsconfig.json
├── plugins/with-cleartext-traffic.js   allows http:// to the App API (Tailscale already encrypts it)
└── src/
    ├── App.tsx      composition root: picks adapters, builds core, loads features
    ├── core/        events (contract types + bus), ports, api (typed App API client), connection,
    │                store (+ memoized selector hook), feature registry, guards (untrusted wire data)
    ├── adapters/    transport/edith-api (HTTP + the one WebSocket), storage/secure-store
    ├── common/      shared helpers (core only)
    ├── features/    live-session, sessions, approvals, commands; registered in features/index.ts
    ├── shell/       connect gate, header, tabs, banner slot, Tools grid, Settings, navigation
    ├── ui/          shared components, no feature logic
    └── testing/     fakes for jest (never imported by the app)
```

**Rules** (enforced by `src/__tests__/isolation.test.ts`): a feature imports only `core/`, `common/`,
`ui/` and its own folder. Never another feature, never `adapters/`, and no native library directly:
device capabilities go through a port in `core/ports.ts`. `shell/`, `App.tsx` and `features/index.ts`
are the composition root. See [../docs/ADDING_A_FEATURE.md](../docs/ADDING_A_FEATURE.md).

## How it behaves

- **One WebSocket** (`adapters/transport/edith-api/stream.ts`), shared by everything; features only
  see events on the bus. It reconnects with exponential backoff and jitter (1 s to 30 s), stops retrying
  on a rejected token, and sends `{"type":"ping"}` every 25 s. It closes after 60 s in the background
  (battery) and reconnects as soon as the app is back in front.
- **Resync, not polling.** Every (re)connect publishes the app-local `app.connected` event; features
  then fetch `/v1/status`, `/v1/permissions` and `/v1/sessions` once. Everything else comes from the stream.
- **Live history** (contracts/events.md, "History"): on open, Live shows the newest 100 events of the
  current conversation. After a reconnect it catches up with `after=<last cursor>`, and after a session
  change it shows the new conversation. Scrolling up loads older pages. Stream events that arrive during
  a request are held and applied after it, skipping those whose `cursor` the page already had.
- **Tool calls and results** pair by `id`. A session switch ends on `session.switched`.
- **HTTP**: 10 s timeout per attempt. GET and PATCH retry twice with backoff on network errors and
  502/503/504. POSTs are sent once, because a repeated POST could run a task twice.
- **Rendering**: small stores with memoized selectors (`core/store.ts`); the transcript is bounded
  (400 items), drawn by an inverted `FlatList`, with memoized rows that the reducer keeps as the same
  objects when they don't change.

## Develop

```bash
cd app
npm ci
npm run typecheck
npm test
```

Don't build Android on edith (ARM64). The APK comes from GitHub Actions (`.github/workflows/build-apk.yml`):
typecheck and jest, then `expo prebuild` and `./gradlew assembleRelease` (arm64-v8a) on an x86 runner.
The APK is uploaded as a workflow artifact. For now it's signed with the **debug keystore**. Release
signing comes later with a keystore Arpit creates and keeps in GitHub Secrets.

**Install:** download the `edith-apk` artifact from the workflow run, unzip it, open `edith.apk` on the
phone (allow "Install unknown apps" for the browser or file manager), then connect with Tailscale on.
After that, updates come from inside the app (below).

## Updates from inside the app (contracts/app-updates.md)

- **Code (OTA):** expo-updates checks `http://edith:8787/v1/updates/manifest` in the background at
  launch, sending Arpit's token (set at runtime; the APK only embeds a `Bearer -` placeholder). A newer
  bundle is used on the next start, or at once with Settings → Updates → "Restart now". Bundles are
  code-signed in CI, and the APK runs only bundles signed with `certs/updates-certificate.pem`'s key.
  A bundle that crashes at start is rolled back by expo-updates. Only bundles with the APK's exact
  `runtimeVersion` (a fingerprint of the native side; `fingerprint.config.js`) reach it.
- **APK:** Settings → Updates shows "Update available" when edith offers a higher `versionCode`. "Download
  and install" streams `/v1/app/apk/{versionCode}` to the cache (resumable, SHA-256 checked in Kotlin,
  `android-modules/edith-installer`), then opens Android's installer. Android always asks for one tap.
  The first time, it asks to allow EDITH to install apps.
- CI (`build-apk.yml`) publishes `edith-apk` (APK + `apk.json`) and, when the OTA key is set,
  `edith-ota` (export + signed manifest, built by `scripts/ota.js`). edith collects them from successful
  `main` runs. `versionCode` is `1000 + run number`.

## Signing keys (Arpit creates them; never in git, never printed)

| Key | Where it lives | GitHub Secrets |
|---|---|---|
| Release keystore (PKCS12, RSA 4096, alias `edith`) | edith `~/.config/edith-signing/` + offline backup | `EDITH_KEYSTORE_B64`, `EDITH_KEYSTORE_PASSWORD`, `EDITH_KEY_ALIAS`, `EDITH_KEY_PASSWORD` |
| OTA code-signing key (RSA, 30-year cert, CN EDITH) | edith `~/.config/edith-signing/ota/` + offline backup; the **certificate** is committed as `certs/updates-certificate.pem` | `EDITH_UPDATES_KEY_PEM`, `EDITH_UPDATES_CERT_PEM` |

Creating them (done 2026-10-29; only needed again for a new key, which means a reinstall):

```bash
umask 077
# Release keystore (openssl only; no Java needed). Store and key password are the same.
openssl req -x509 -newkey rsa:4096 -sha256 -days 10950 -subj "/CN=EDITH" -keyout key.pem -out cert.pem
openssl pkcs12 -export -inkey key.pem -in cert.pem -name edith -out edith-release.p12   # then shred key.pem
base64 -w0 edith-release.p12 | gh secret set EDITH_KEYSTORE_B64 --repo Arpit098/edith-app
gh secret set EDITH_KEYSTORE_PASSWORD --repo Arpit098/edith-app   # prompts; same value for EDITH_KEY_PASSWORD
gh secret set EDITH_KEY_ALIAS --repo Arpit098/edith-app --body edith

# OTA code-signing key (from app/, with the expo-updates CLI)
npx expo-updates codesigning:generate --key-output-directory ~/.config/edith-signing/ota \
  --certificate-output-directory ~/.config/edith-signing/ota \
  --certificate-validity-duration-years 30 --certificate-common-name EDITH
cp ~/.config/edith-signing/ota/certificate.pem certs/updates-certificate.pem   # public: commit this one
gh secret set EDITH_UPDATES_KEY_PEM --repo Arpit098/edith-app < ~/.config/edith-signing/ota/private-key.pem
gh secret set EDITH_UPDATES_CERT_PEM --repo Arpit098/edith-app < ~/.config/edith-signing/ota/certificate.pem
```

CI checks the release APK prints the pinned certificate SHA-256
(`2B:6C:D3:6E:EA:02:20:9B:55:D9:7D:7A:78:20:E1:F6:81:A6:B1:60:67:3A:4A:49:F2:2B:43:9F:3F:D8:02:AB`), that
`EDITH_UPDATES_CERT_PEM` equals the committed certificate, and that the OTA key signs for it.
**Switching from the debug key to the release key needs one uninstall + install** (Android refuses an
update with a different signature). After that, every update keeps the app's data.
