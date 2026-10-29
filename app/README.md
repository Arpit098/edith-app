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

**Install:** download the artifact from the workflow run, unzip it, open the `.apk` on the phone
(allow "Install unknown apps" for the browser or file manager), then connect with Tailscale on.
