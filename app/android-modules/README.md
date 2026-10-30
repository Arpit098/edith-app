# Native Android modules (Kotlin, Expo modules)

| Module | What | Phase |
|---|---|---|
| `edith-glass` | Liquid Glass view (AGSL lens on Android 13+, blur on 12), battery saver, frame-time measurement ([README](edith-glass/README.md)) | 2b |
| `assistant-role` | VoiceInteractionService so EDITH can be the default digital assistant (power button, earbud button) | 3 |
| `widget` | Home-screen widget that opens EDITH listening | 3 |
| `wakeword-service` | Foreground service running openWakeWord (ONNX Runtime) only while the toggle is on, with a sound gate | 4 |

Each module is exposed to JS through a port in `src/core/ports.ts`. Features never call it directly.
