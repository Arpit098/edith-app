# EDITH Android app

React Native (Expo, prebuild / dev client, TypeScript). The Expo project itself is generated in
**Phase 2** around this folder structure. Until then, this folder holds the architecture and the core contracts.

```
app/
├── src/
│   ├── core/        events.ts (bus + contract types), ports.ts (interfaces), feature.ts (FeatureModule + loader)
│   ├── common/      shared helpers used by several features (may import core/ only)
│   ├── adapters/    implementations of the ports, one folder each
│   │   ├── transport/edith-api/        HTTP + WebSocket to the App API over Tailscale
│   │   ├── stt/server-whisper/         uploads audio to /v1/stt
│   │   ├── tts/android/                Android TextToSpeech
│   │   ├── recorder/vad/               microphone + end-of-speech detection
│   │   ├── wakeword/openwakeword/      bridge to the native WakeWordService
│   │   └── storage/secure-store/       token in the Android Keystore
│   ├── features/    one folder each, exporting a FeatureModule; enabled in features/index.ts
│   │   ├── live-session/   sessions/   approvals/   settings/      (Phase 2)
│   │   ├── voice/   assistant/   widget/                           (Phase 3)
│   │   └── wakeword/                                               (Phase 4, manual toggle)
│   └── ui/          shared presentational components (no feature logic)
└── android-modules/ native Kotlin (Expo modules): wakeword-service, assistant-role, widget
```

**Rules**
- A feature imports only `core/`, `common/` and `ui/`. Never another feature, never `adapters/`.
- A feature that needs a device capability uses a **port** from `core/ports.ts`. The adapter behind it can change freely.
- See [../docs/ADDING_A_FEATURE.md](../docs/ADDING_A_FEATURE.md).
