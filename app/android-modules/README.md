# Native Android modules (Kotlin, Expo modules)

| Module | What | Phase |
|---|---|---|
| `edith-system` | Live status (Android 16 Live Update / Live Alerts) with `EdithSessionService` (specialUse foreground service, only while a turn runs or an approval waits), and local notifications with Allow/Deny buttons (OngoingStatus, Notifier ports). A debug-only receiver lets CI post each state | 2b |
| `assistant-role` | VoiceInteractionService so EDITH can be the default digital assistant (power button, earbud button) | 3 |
| `widget` | Home-screen widget that opens EDITH listening | 3 |
| `wakeword-service` | Foreground service running openWakeWord (ONNX Runtime) only while the toggle is on, with a sound gate | 4 |

Each module is exposed to JS through a port in `src/core/ports.ts`. Features never call it directly.
