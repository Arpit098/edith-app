# Architecture: ports, adapters and features

The goal is that **any feature or integration can be added, changed or removed without touching
the others.** Both the server and the app follow the same three rules:

1. **Core** is small and stable. It holds the event bus, the registry and shared types. Features
   and adapters depend on core; core never depends on them.
2. **Ports** are interfaces that describe *what* is needed: "speech-to-text", "agent", "frontend",
   "notifier". **Adapters** are interchangeable implementations of a port: whisper.cpp, tmux
   Claude, Telegram, ntfy. Switching an implementation is a config change.
3. **Features** are self-contained folders such as sessions, approvals, voice or reminders. A
   feature registers its commands, API routes and event handlers through the context it is given.
   **Features never import each other.** They communicate only through events on the bus.
4. **Common** (`common/`) holds shared helpers that more than one feature or adapter uses, such as
   text chunking or time formatting. It may import core only, never a feature or adapter, so
   sharing code can't couple features together. Move code here only once a second user needs it.

**Import rules:**

| From ↓ may import → | core | ports | common | own folder | other features | adapters |
|---|---|---|---|---|---|---|
| **features** | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| **adapters** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ (shared adapter helpers) |
| **common** | ✅ | ❌ | ✅ | — | ❌ | ❌ |
| **ports** | ✅ | ✅ | ❌ | — | ❌ | ❌ |
| **core** | ✅ | ❌ | ❌ | — | ❌ | ❌ |

```
          ┌──────────── features/ (one folder each, isolated) ─────────────┐
          │ sessions   approvals   voice   reminders   quick_actions  ...   │
          └───────▲───────────────────────▲─────────────────────────────────┘
                  │ register via Context  │ publish / subscribe
          ┌───────┴───────────────────────┴──────────┐
          │ core: EventBus · Registry · Context        │
          └───────▲───────────────────────▲──────────┘
                  │ implements             │ implements
          ┌───────┴───────┐        ┌──────┴────────┐
          │ ports/ (interfaces)    │               │
          └───────▲───────┘        └──────▲────────┘
     adapters/frontends/telegram   adapters/agents/claude_tmux
     adapters/frontends/app_api    adapters/stt/whisper_cpp
                                   adapters/notifiers/ntfy
```

## Isolation guarantees

- **Load failures are contained.** If a feature or adapter fails to load or set up, the registry
  logs it and disables **only that one**. The rest start normally.
- **Handler failures are contained.** An exception in one event handler or command is caught and
  logged. Other handlers still run.
- **No cross-imports.** The import rules above are enforced by a test
  (`server/tests/test_isolation.py`). It fails if, for example, one feature imports another.
- **Config-driven.** `config.toml` lists the enabled features and the chosen adapters. Turning a
  feature off is one line.
- **Shared contract.** The server and the app agree on events and API shapes in `contracts/`, so
  either side can change internally without breaking the other.

## Server layout (`server/edith/`)

| Path | Purpose |
|---|---|
| `core/events.py` | `Event` and `EventBus` (publish/subscribe, per-handler isolation) |
| `core/registry.py` | Loads the enabled features and adapters by name, isolating failures |
| `core/context.py` | `Context` passed to each feature: bus, ports, its own config, command/route registration |
| `ports/*.py` | Interfaces: `AgentBackend`, `Frontend`, `SpeechToText`, `Notifier` |
| `common/` | Shared helpers (e.g. `text.py`: message chunking, SEND_FILE/REACT directives, voice summary) |
| `adapters/<port>/<name>/` | One implementation per folder, each exposing `create(config)` |
| `features/<name>/` | One feature per folder, each exposing `FEATURE = Feature(name, setup)` |
| `main.py` | Wires it all together from `config.toml` |

## App layout (`app/src/`)

The app uses the same idea, in TypeScript:

| Path | Purpose |
|---|---|
| `core/events.ts` | `EventBus` and the contract's event types (`EventDataMap`) |
| `core/api.ts` | Typed App API client over the `Transport` port; `ApiError` |
| `core/connection.ts` | The one connection: saved server, stream → bus, link state; publishes `app.connected` on every (re)connect |
| `core/store.ts` | Tiny external store + `useStore(store, selector)` with memoized selectors |
| `core/feature.ts` | `FeatureModule` (screens, settings, `tool` tile, `panels`) and `loadFeatures` (isolates failures) |
| `core/ports.ts` | Interfaces: `Transport`, `SecureStorage` (Phase 2); `SpeechToText`, `TextToSpeech`, `Recorder`, `WakeWord` (later) |
| `common/` | Shared helpers (e.g. `format.ts`: `timeAgo`, `voiceSummary`) |
| `adapters/<port>/<name>/` | `transport/edith-api`, `storage/secure-store`; later `stt/server-whisper`, `tts/android`, `wakeword/openwakeword` |
| `features/<name>/` | `live-session`, `sessions`, `approvals`, `commands`; each exports a `FeatureModule`, logic in a testable `model.ts` |
| `shell/` | Composition root UI: connect gate, header, tabs, banner slot, Tools grid, Settings, navigation |
| `ui/` | Shared components only, with no feature logic |
| `../android-modules/` | Native Kotlin modules (wake-word service, assistant role, widget) behind the ports above |

The app's import rules are enforced by `app/src/__tests__/isolation.test.ts`. `shell/`, `App.tsx` and
`features/index.ts` form the composition root and may import anything. See [app/README.md](../app/README.md).

See [ADDING_A_FEATURE.md](ADDING_A_FEATURE.md) for the step-by-step guide.
