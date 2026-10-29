# Phase 3 (app): the assistant overlay

_Draft 2026-10-29, for Arpit's review. Nothing here is built yet._

When EDITH is called by the power or home long-press (default assistant), the earbud button, the
widget or, in Phase 4, the "Hey Edith" wake word, it opens **on top of the app that is already open**:
a translucent dim and a panel that springs up from the bottom. Along the bottom edge a flowing
gradient glow follows the voice while EDITH listens, changes while it thinks, and pulses while it
speaks. The words show up as they are said, then the answer fills the panel. Tap outside or swipe down
to close it; a button opens the full app. The design is our own: EDITH colours, shapes and motion,
inspired by that interaction but not copied from Google (no Google assets, logos or exact visuals).

Server side, voice is already done (`POST /v1/stt`, `voice: true`, `voice.turn` / `voice.reply` with
a speakable summary; contracts/events.md, "Voice").

---

## 1. Recommendation in one paragraph

**Kotlin owns the window and the hardware; React Native draws the overlay.** A small Kotlin module
(`android-modules/assistant`) provides the `VoiceInteractionService` and `VoiceInteractionSession`
(the system's own window above the current app, the same one that serves as the default assistant),
plus audio capture, VAD, loudness (RMS) and TTS. The overlay itself (dim, sheet, glow, transcript,
answer) is one React Native component tree, `features/assistant/overlay/`. On the phone it runs inside
the session window as a React Native surface; for screenshots it runs on the web at a phone viewport
(see §8). Animations run on the UI thread: Reanimated for the sheet and gestures, a Skia shader for the
glow. Both also run on the web, so **the preview renders the same components as the phone**. The
overlay shares the app's JS runtime, so it reuses `core/` (connection, API client, event bus, token)
instead of a second client.

## 2. Options considered

| | A. RN overlay in the session window (**recommended**) | A′. RN overlay in a translucent Activity (fallback) | B. Pure Kotlin overlay |
|---|---|---|---|
| Window | `VoiceInteractionSession.onCreateContentView()` hosts a React Native surface | The session calls `startAssistantActivity()` with a translucent, no-animation `AssistantActivity` (a `ReactActivity` with its own root component) | Session content view built from Android Views/Compose |
| Over the current app | Yes: a system voice-interaction window, no task switch | Yes visually: the app below stays visible but is paused, as under any translucent activity | Yes |
| Same components in the web preview | **Yes** | **Yes** (the same RN tree) | **No.** Would need a separate web mock, which Arpit ruled out |
| App API, token, events | Shared `core/` in the one JS runtime | Shared | A second client in Kotlin, and the token must be readable from Kotlin too |
| Risk | RN surfaces outside an Activity (some modules expect a current Activity) | Activity launch timing, recents and lock-screen flags | The most code, two UIs to keep in sync |
| Open latency | Instant when the JS runtime is warm (see §6) | About one activity launch | Instant |

**Plan:** step 0 is a one-day spike on Arpit's phone that hosts a React Native surface with Reanimated
and Skia inside a `VoiceInteractionSession`, and measures time-to-first-frame. If it holds 60 fps and
opens in under ~300 ms (warm), go with A. If not, go with A′; the components, the preview and
everything below stay the same. B is the last resort.

## 3. Architecture

```
 System (power/home long-press, earbud, assist intent)        Widget tap / wake word (Phase 4)
            │                                                          │ broadcast → our receiver
            ▼                                                          ▼
 EdithVoiceService : VoiceInteractionService  ◄── showSession() ───────┘   (only while EDITH is the
            │ (bound by the system while EDITH is the default assistant)    default assistant; else the
            ▼                                                               widget opens AssistantActivity)
 EdithSessionService → EdithSession : VoiceInteractionSession
            │  onCreateContentView(): React Native surface "assistant-overlay" (app's ReactHost)
            │  onShow(args, flags)/onHide(): start/stop everything; nothing runs while hidden
            ▼
 ┌───────────── JS (same runtime as the app) ─────────────────────────────────────────┐
 │ features/assistant/                                                                  │
 │   model.ts      state machine: idle → listening → transcribing → thinking →          │
 │                 answering → speaking → done | dismissed | error  (pure, jest-tested) │
 │   overlay/      Overlay, Sheet, Glow (Skia shader), Transcript, Answer               │
 │                 props: state + a `level` shared value; no I/O inside                 │
 │   uses ports:   recorder (start/stop, level, end-of-speech), stt, tts, transport     │
 └──────────────────────────────────────────────────────────────────────────────────────┘
            │ ports                                    │ core/api + bus
            ▼                                          ▼
 android-modules/assistant (Kotlin):           App API over Tailscale:
   AudioRecord 16 kHz mono → RMS, VAD,           POST /v1/stt (WAV) → text
   WAV in cache; TextToSpeech with word          POST /v1/messages {voice:true} → ref
   events; showSession(); expand to app           stream: turn events, voice.reply{speak}
```

- **Manifest:** `<service android:name=".EdithVoiceService" android:permission="android.permission.BIND_VOICE_INTERACTION">`
  with `<meta-data android:name="android.voice_interaction" android:resource="@xml/edith_voice">`
  (`sessionService`, `recognitionService` (a stub `RecognitionService`, still needed for EDITH to be
  listed as an assistant app), `supportsAssist="true"`, `supportsLaunchVoiceAssistFromKeyguard`, and
  `settingsActivity`). It's added by an Expo config plugin in `android-modules/assistant`; prebuild
  stays clean.
- **Becoming the assistant:** Settings → Apps → Default apps → Digital assistant app → EDITH. The app's
  Settings shows whether EDITH is the default (`RoleManager.ROLE_ASSISTANT`) and a button that opens
  that screen. On Pixels, "press and hold power" must also be set to the assistant (not the power menu).
- **Show sources:** `onShow(args, flags)` tells the triggers apart (`SHOW_SOURCE_ASSIST_GESTURE`,
  `SHOW_SOURCE_PUSH_TO_TALK`, ours via `args`), so a widget or wake-word open can start already listening.
- **Expand to the full app:** `startAssistantActivity()` (or `startActivity`) with `edith://live?ref=<ref>`,
  then `hide()`. The Live tab already loads history, so the turn is there.
- **Lock screen:** the session can show over the keyguard. While the phone is locked, the overlay lets
  you talk and listen, but "Open app" asks to unlock first (`KeyguardManager.requestDismissKeyguard`).
- **New ports** (`core/ports.ts`; `Recorder`, `TextToSpeech` and `SpeechToText` already exist):
  `Recorder.start` gains `onLevel` and `onEndOfSpeech`; `TextToSpeech.speak` gains `onWord`. The
  adapters are `recorder/vad` and `tts/android` (the Kotlin module) and `stt/server-whisper` (HTTP).
  Features still never touch native code.
- **The token** stays where it is (expo-secure-store, read by JS); option A needs no Kotlin access to it.

## 4. Animation

- **Sheet:** Reanimated `withSpring` (damping ~18, stiffness ~180) for open and close. A
  react-native-gesture-handler pan on the sheet: past 30% of its height or a fast fling, it closes, else
  it springs back. Tapping the dim closes it. Everything runs in UI-thread worklets, so a busy JS thread
  can't stutter the motion.
- **Glow:** one Skia `RuntimeEffect` (SkSL fragment shader) drawn in a strip about 120 dp high at the
  bottom: a few soft colour bands in EDITH colours (cyan → violet → teal, our palette) flow sideways and
  bloom upward. The uniforms come from shared values:
  - `time` (a frame clock, running only while the overlay shows),
  - `level` (smoothed mic loudness: fast attack ~40 ms, slow release ~250 ms),
  - `mode` (listening / thinking / speaking, blended over ~300 ms).
  Listening: height and brightness follow `level`. Thinking: a slow travelling shimmer at a lower
  height. Speaking: pulses on TTS word events.
- **Budget:** one draw per frame for the glow, no JS work per frame, nothing allocated per frame. The
  frame clock and shader stop on `onHide`, and the surface is detached when hidden, so **nothing
  animates or holds the GPU while the overlay is closed**. Check with `adb shell dumpsys gfxinfo`
  (janky frames under 1%) on Arpit's phone.
- **Text:** the transcript and answer are plain `Text` with a short fade/slide per new block (Reanimated
  `entering` animations). No per-character animation, so it stays cheap.

## 5. Audio, VAD, speech-to-text and TTS

- **Capture (Kotlin):** `AudioRecord`, `VOICE_RECOGNITION` source, 16 kHz mono PCM16, only between
  start and end of speech. Frames of 20 ms: RMS in dBFS → 0..1, sent to JS about 30 times a second.
  The JS side only writes it into the `level` shared value. The utterance goes to a WAV file in the
  cache, deleted after upload. `RECORD_AUDIO` is asked for the first time the overlay opens.
- **VAD:** energy-based with an adaptive noise floor (the floor follows the quietest 10% of recent
  frames; speech is above floor + ~10 dB). It needs speech to start (≥ 150 ms), ends after 700 ms of
  silence, gives up after 8 s with no speech, and has a hard cap of 30 s (the server allows 60 s).
  Behind an interface so **Silero VAD** (MIT, ONNX) can replace it in Phase 4, when ONNX Runtime comes in
  for openWakeWord anyway. No extra native libraries in Phase 3.
- **Final transcript:** `POST /v1/stt` with the WAV (16 kHz mono WAV needs no ffmpeg conversion on the
  server). The server runs whisper.cpp `small-q8_0`. Then `POST /v1/messages {text, voice: true}`.
- **Live partial transcript:** whisper.cpp isn't a streaming recognizer, so this needs a server
  addition and a decision:
  - **Proposed:** while speaking, every ~1.2 s the app sends the audio so far to
    `POST /v1/stt?partial=1`. At most one request is in flight, the newest audio wins, and nothing is
    sent if under ~0.8 s of new audio has arrived. The server answers partials with a faster setting
    (a smaller model such as `base-q8_0`, `max_tokens` capped, greedy decoding) and never queues them
    behind finals (it drops a partial instead, answering 429). The final transcript still uses `small`.
    This needs `deploy/whisper/bench.sh` numbers for `base` on 3–10 s clips. If a partial takes over ~1 s
    on edith's 2 OCPU, partials lag too much to be worth it.
  - **If not worth it:** the panel shows a lively "Listening…" with the glow, then the final
    transcript. Android's built-in `SpeechRecognizer` would give real partials, but it's Google's
    closed service, against the open-source voice constraint (PLAN.md §2). Only with Arpit's OK.
- **Answer:** the turn's `message.assistant` events for that `ref` stream into the panel as they come
  (per text block; the transcript gives blocks, not tokens). `voice.reply.speak` is what is spoken.
  Tool steps show as one line ("Running: `$ df -h`") from `turn.progress`.
- **TTS (Kotlin):** Android `TextToSpeech`, with `UtteranceProgressListener.onRangeStart` word events
  driving the speaking glow. The engine starts on first use and shuts down 30 s after the last speech.
  Speech stops when the overlay is dismissed. Any free engine works; Google's on-device voices are the
  phone's default.
- **Audio focus:** `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` while listening and speaking, released after.

## 6. Battery and resources

- Nothing runs unless the overlay is open: no mic, no frame clock, no TTS engine, no extra socket. The
  `VoiceInteractionService` itself is bound by the system and idle (no threads or timers of ours).
- **Warm JS:** being the default assistant keeps EDITH's process alive and cached, so the JS runtime
  is usually warm and the overlay opens at once. If the process was killed, the first open waits for
  JS to boot (~0.5–1 s on a mid phone): the native session shows the dim and an empty sheet at once,
  and the React Native content fades in when ready. We measure it in the spike, and if the cold open
  is too slow, start the ReactHost in `onReady()`. That costs memory, not CPU.
- The overlay uses the app's single WebSocket. If the app was backgrounded long enough for it to close
  (60 s), opening the overlay reconnects it (same reconnect path). The HTTP calls don't wait for it.
  Transcript events missed while it reconnects are caught up with `history?after=<last cursor>` (as
  Live does), and `voice.reply` arrives after `turn.done`, so a socket that opens within the turn still
  gets it.
- On dismiss: stop recording, delete the WAV, stop TTS, cancel a pending partial, and leave the turn
  running on the server (it shows in Live and on Telegram as usual).

## 7. What is built, in order (one branch `phase-3`, small commits)

0. **Spike** (go/no-go for A vs A′): RN surface + Reanimated + Skia in a `VoiceInteractionSession`;
   fps and open time on Arpit's phone.
1. `features/assistant/model.ts` (state machine) + jest tests; the new port methods with fakes.
2. Overlay components + the **web preview harness** (§8) → screenshots for Arpit **before** any device work.
3. `android-modules/assistant`: Expo module and config plugin, VoiceInteractionService, Session, stub
   RecognitionService, `edith_voice.xml`. Settings shows the assistant role.
4. Recorder + VAD + RMS (Kotlin) → `recorder/vad` adapter; `stt/server-whisper` adapter.
5. TTS with word events → `tts/android` adapter; speaking glow.
6. Widget (one tap → `showSession`), expand-to-app deep link, lock-screen behaviour.
7. Partial transcripts (if the server side lands), then polish on the device: haptics, spring tuning, gfxinfo.

New dependencies (all free, MIT; versions pinned to Expo SDK 57's list):
- `react-native-reanimated` + `react-native-worklets`, `react-native-gesture-handler`,
  `@shopify/react-native-skia`. Skia adds roughly 6–8 MB to the arm64 APK.
- For the web preview only (devDependencies, not in the APK): `react-dom`, `react-native-web`,
  `@expo/metro-runtime`. Skia's web build loads CanvasKit (WASM) in the preview.

## 8. Preview harness (Arpit's screenshots before using it)

Goal: see what the overlay looks like in every state, and record its motion, from edith, with
Playwright, **rendering the same overlay components as the phone**.

- **Same components:** `features/assistant/overlay/*` take only props (`state`, `transcript`,
  `answer`, a `level` shared value, callbacks) and do no I/O. The phone feeds them from the model and
  the native recorder/TTS. The preview feeds them from the URL. There's no web-only copy of any overlay
  component.
- **Entry:** `app/src/entry.web.tsx` (Metro picks `.web.tsx` for the web build only, so none of the
  preview code is in the Android bundle). It renders `PreviewApp`: a static sample app screen (a made-up
  chat app drawn with plain views; nothing from a real product) filling a 412 × 915 frame, and the real
  `Overlay` on top of it.
- **Build and serve on edith:** `npx expo export --platform web --output-dir dist-preview`, then serve
  `dist-preview` with `python3 -m http.server` on **127.0.0.1** only (it's a static site; no public
  port). Playwright on edith opens it with `viewport 412×915`, `deviceScaleFactor 2.6`, `isMobile`, `hasTouch`.
- **URL parameters:**

  | Param | Values | Meaning |
  |---|---|---|
  | `state` | `idle-open`, `listening`, `thinking`, `speaking`, `answer-streamed`, `dismissed` | The overlay state |
  | `level` | `0`–`1`, or `sim` | Mic loudness for listening: fixed, or a synthetic speech envelope (syllable-like bursts) |
  | `t` | ms | Freeze the animation clock at this time: identical pixels for every screenshot |
  | `play` | `1` | Run the clock live (for video). With `state=sequence` it plays open → listening → thinking → answer → speaking → dismiss on a fixed timeline |
  | `text` | `short`, `long` | Sample transcript and answer lengths (to check wrapping and scrolling) |

  Example: `/?state=listening&level=sim&t=1200`. When the frame is ready, the page sets
  `document.body.dataset.ready = "1"` (after fonts and CanvasKit load) so Playwright waits on that
  instead of a sleep.
- **Script:** `app/preview/shoot.mjs` (Playwright, run on edith) saves one PNG per state to
  `app/preview/out/` (gitignored) and records a ~10 s WebM of `state=sequence&play=1`.
- **Fonts:** the overlay uses a bundled font (one open-licence family loaded through `expo-font`) on both
  the phone and the web, so text metrics match.

**What the preview can't show honestly** (each needs the real phone):

| Seen only on the device | Why the preview differs |
|---|---|
| The system's own window dim, and the session window's insets (status bar, navigation bar, cutout, keyboard) | The preview draws our dim over a static image and fakes 24 dp/16 dp insets; on the phone the session window and edge-to-edge insets decide |
| The app behind the overlay | The preview shows a static sample screen; on the phone it's whatever app is open, live (and paused under A′) |
| Exact glow rendering | Skia on the web uses CanvasKit/WebGL in Chrome's colour pipeline; on Android it's Skia on the GPU. Blur and colours can differ slightly |
| Smoothness | Desktop Chrome at 60 fps says nothing about the phone. Frame timing is measured on the device (gfxinfo) |
| Real voice dynamics and timing | `level=sim` is synthetic; real RMS, VAD end-of-speech, STT latency and TTS word timing only exist on the phone |
| Open latency, cold start, haptics, the lock screen, the power-button and earbud triggers | System behaviour |
| Gesture feel | Swipe-down works with a mouse/touch emulation, but the feel (velocity, overscroll) is only real on a touchscreen |

The preview page shows a small "Preview: device differs" tag in a corner (outside the 412 × 915 frame,
or hidden with `&clean=1` for screenshots), so no one mistakes a screenshot for the phone.

## 9. Proposal: over-the-air JS updates, self-hosted on edith

Most changes in Phase 3 and later are JavaScript (screens, the overlay's look, feature logic). Today
each one means a new APK (about 8 minutes of CI, a download and an install). With **expo-updates**
(MIT, part of Expo) the app fetches a new JS bundle from **our own server on edith** and uses it on
the next launch, with no EAS and no Expo account. A new APK is needed only when native code changes.

- **What decides OTA vs APK:** `runtimeVersion: { policy: "fingerprint" }`. `@expo/fingerprint` (already
  in the tree) hashes everything native: dependencies with native code, config plugins, `app.json`
  native fields, `android-modules/`. An APK accepts only updates with its exact fingerprint, so a JS
  bundle can never reach an APK whose native side doesn't match. When the fingerprint changes, CI builds
  an APK instead.
- **Build (CI, x86):** in the same workflow, `npx expo export --platform android` (Hermes bytecode needs
  the x86 `hermesc`; it doesn't run on edith's ARM) → `dist/` with the bundle, assets and
  `metadata.json` → uploaded as an `ota-<fingerprint>-<sha>` artifact. The APK build is skipped when
  the fingerprint matches the last APK's, which saves most CI minutes.
- **Publish (on edith, pull only):** `deploy/ota-publish.sh <run-id>` uses `gh run download` to fetch
  that artifact and checks its fingerprint and size. It **signs the manifest** with a private key that
  lives only on edith (`~/.config/edith/ota-signing-key.pem`, 0600, never in git), and moves it into
  `~/.local/share/edith/updates/<runtimeVersion>/<updateId>/`. Nothing reaches edith from outside;
  GitHub never needs access to the tailnet.
- **Serve:** a small server feature `updates` (`server/edith/features/updates/`) implementing the Expo
  Updates protocol v1:
  - `GET /v1/updates/manifest`, which reads the `expo-runtime-version` / `expo-platform` headers and
    answers a signed `multipart/mixed` manifest (or "no update" / "roll back to embedded");
  - `GET /v1/updates/assets/<hash>`, which serves files by content hash with long cache headers.
  It runs on the App API, so it's on the **Tailscale IP only**, like everything else.
- **Auth:** expo-updates sends fixed request headers set at build time, so it can't use Arpit's
  bearer token (which is entered at runtime and must never be baked into the APK). Proposal: a separate
  **read-only updates token** (it allows only the two `updates` routes) is injected into
  `app.json`'s `updates.requestHeaders` by CI from a GitHub secret. Even if it leaked, it would allow only
  downloading our own signed app code, and only inside the tailnet. The manifest signature (the app
  embeds the public certificate, `updates.codeSigningCertificate`) means the app runs only bundles
  signed on edith.
- **On the phone:**
  - `checkAutomatically: ON_LOAD` with `fallbackToCacheTimeout: 0`: launch never waits for the
    network; a new bundle downloads in the background and applies on the next cold start.
  - Settings gets "Check for update" (download and reload now) and shows the running update id and date in IST.
  - expo-updates' error recovery rolls back to the previous bundle if a new one crashes at launch.
- **Rollback:** `deploy/ota-publish.sh --rollback` points the manifest back at the previous update id,
  or "roll back to embedded" (the APK's own bundle).
- **Cost:** free. Each check is one small HTTP request at cold start, over Tailscale, and is skipped
  when offline. No polling.
- **Needs approval** (it changes the live service): the `updates` server feature, the signing key on
  edith, the updates token (GitHub secret + server config), and one APK that adds expo-updates (a native
  module). After that, JS-only changes ship as OTA bundles.

## 10. Open questions for Arpit

1. **Partial transcripts:** worth the server work (a faster partial mode on whisper.cpp, §5), or show
   "Listening…" and only the final transcript in Phase 3?
2. **Colours:** the glow palette (proposal: cyan `#4EA1FF` → violet `#8B6CFF` → teal `#2DD4BF`, matching
   the app's accent). Alternatives can be shown in the preview with `&palette=`.
3. **Spoken answer length:** keep the server's 2-sentence `speak`, or longer?
4. **Over the lock screen:** allow talking to EDITH while the phone is locked (answers shown and spoken),
   or require unlocking first?
