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

## 9. Updating the app from inside the app

Two paths, both served by edith over Tailscale only, both behind Arpit's App API token:

| Change | Path | On the phone |
|---|---|---|
| JavaScript only (screens, overlay look, feature logic) | **(a) OTA bundle** via expo-updates | Downloads in the background, used on the next launch, rolled back on its own if it crashes at start |
| Native (new library, Kotlin module, permissions, SDK upgrade) | **(b) New APK** from edith | Settings → "Update available" → download → sha256 check → Android's installer (one tap) |

Both depend on **(c) one stable signing key**, so read (c) first: it decides when (b) can ship.

### 9a. Over-the-air JS updates (expo-updates, self-hosted)

Most changes in Phase 3 and later are JavaScript (screens, the overlay's look, feature logic). Today
each one means a new APK (about 8 minutes of CI, a download and an install). With **expo-updates**
(MIT, part of Expo) the app fetches a new JS bundle from **our own server on edith** and uses it on
the next launch, with no EAS and no Expo account. A new APK is needed only when native code changes.

- **What decides OTA vs APK:** `runtimeVersion: { policy: "fingerprint" }`. `@expo/fingerprint` (already
  in the tree) hashes everything native: dependencies with native code, config plugins, `app.json`
  native fields, `android-modules/`. An APK accepts only updates with its exact fingerprint, so a JS
  bundle can never reach an APK whose native side doesn't match. When the fingerprint changes, CI builds
  an APK instead.
- **Build and sign (CI, x86):** _as built (2026-10-29), see contracts/app-updates.md:_ in the same
  workflow, `npx expo export --platform android` (Hermes bytecode needs the x86 `hermesc`; it doesn't
  run on edith's ARM) → `scripts/ota.js` builds the manifest and **signs it with the OTA key from GitHub
  Secrets** (`EDITH_UPDATES_KEY_PEM`; also kept on edith in `~/.config/edith-signing/ota/`) → the
  `edith-ota` artifact. The server serves the signed bytes unchanged and holds no private key.
  (Earlier draft: sign on edith. Changed so the server stays simple.) Later: skip the APK build when
  the fingerprint matches the last APK's.
- **Publish (on edith, pull only):** a server job uses `gh run download` to fetch the artifacts of
  successful `main` runs into `~/.local/share/edith/updates/` and `~/.local/share/edith/apk/`. Nothing
  reaches edith from outside; GitHub never needs access to the tailnet.
- **Serve:** a small server feature `updates` (`server/edith/features/updates/`) implementing the Expo
  Updates protocol v1:
  - `GET /v1/updates/manifest`, which reads the `expo-runtime-version` / `expo-platform` headers and
    answers a signed `multipart/mixed` manifest (or "no update" / "roll back to embedded");
  - `GET /v1/updates/assets/<hash>`, which serves files by content hash with long cache headers.
  It runs on the App API, so it's on the **Tailscale IP only**, like everything else.
- **Auth: Arpit's token, set at runtime.** expo-updates 57.0.26 has
  `Updates.setUpdateRequestHeadersOverride({ Authorization: 'Bearer …' })`, which needs no
  `disableAntiBrickingMeasures`. The app calls it at startup with the token from secure storage, so the
  token is **never baked into the APK** and the `updates` routes use the same bearer check as every other
  route. The URL is set at build time: `http://edith:8787/v1/updates/manifest`, with the Tailscale
  MagicDNS name, which works whatever IP edith has. Changing the URL at runtime would need
  `setUpdateURLAndRequestHeadersOverride`, which only works with the anti-bricking measures switched off,
  so we avoid it.
  - Caveats: this API is marked **experimental**. The first launch after install has no override yet,
    so that first check gets a 401 (harmless: the app just stays on its bundle). Both are checked in the step-0 spike.
  - Fallback if it misbehaves: a separate read-only updates token (allowed only on the `updates` routes)
    injected into `updates.requestHeaders` at build time from a GitHub secret.
- **Verified:** the manifest is **code-signed** (expo-updates code signing: the app embeds the public
  certificate `updates.codeSigningCertificate`; the private key stays on edith). The app refuses any
  bundle not signed on edith, even one served from the right URL with the right token. Assets are fetched
  by content hash and checked against the manifest.
- **On the phone:**
  - `checkAutomatically: ON_LOAD` with `fallbackToCacheTimeout: 0`: launch never waits for the
    network; a new bundle downloads in the background and applies on the next cold start.
  - Settings gets "Check for update" (download and reload now) and shows the running update id and date in IST.
  - **Crash on start → rollback:** expo-updates' error recovery marks a bundle that throws a fatal
    error before the first render settles as failed, and launches the previous working one (in the
    end, the APK's embedded bundle). The app then reports the failed update id to edith
    (`POST /v1/app/events`, logged in the audit log) so it isn't served again.
- **Rollback:** `deploy/ota-publish.sh --rollback` points the manifest back at the previous update id,
  or "roll back to embedded" (the APK's own bundle).
- **Cost:** free. Each check is one small HTTP request at cold start, over Tailscale, and is skipped
  when offline. No polling.
- **Needs approval** (it changes the live service): the `updates` server feature, the OTA signing key
  on edith, and one APK that adds expo-updates (a native module). After that, JS-only changes ship as
  OTA bundles.

### 9b. In-app APK updates (native changes)

- **Collect (on edith, pull only):** a server job (`features/app_updates`, `ctx.add_worker` plus a
  scheduled check every 30 min, with backoff and a timeout on each `gh` call; no tight loop) runs
  `gh run list --workflow build-apk.yml --branch main --status success`. For each new run it does
  `gh run download <id>` into `~/.local/share/edith/apk/<versionCode>-<sha>/`. It records
  `{versionName, versionCode, sha, run_id, size, sha256, built_at}` in `index.json` (atomic write), and
  keeps the newest 5. A new `apk` artifact also carries a `version.json`, written by CI, with
  `versionName`, `versionCode` and the signing certificate's SHA-256 digest.
- **Verify on edith before offering it:** the signing certificate digest (`apksigner verify
  --print-certs`, from the Android build-tools package on edith, a one-time install that needs approval)
  must equal the pinned release digest in the server config. An APK signed by any other key is never
  offered, which also stops a debug-signed build from reaching the phone once (c) is done.
- **App API** (bearer token, Tailscale IP only; added to contracts/events.md first):

  | Method | Path | Answer |
  |---|---|---|
  | GET | `/v1/app/latest` | `{versionName, versionCode, sha, size, sha256, cert_sha256, built_at, notes}` (`notes`: the commit subjects since the last APK) or 404 when there's none |
  | GET | `/v1/app/apk?versionCode=` | The APK bytes (`application/vnd.android.package-archive`), with `Content-Length` and resumable with `Range`. Streamed from disk, never loaded whole |

- **On the phone** (a `features/app-update` feature plus a `PackageInstaller` port and a small Kotlin adapter):
  1. On `app.connected` (at most once per 6 h) and from Settings → "Check for updates": `GET /v1/app/latest`;
     if `versionCode` is above the running one, Settings shows **Update available** (and a dot on the tab).
  2. Download to the app's cache with progress (resumable; a timeout per chunk; one download at a time).
  3. **Check the sha256** of the file against `latest.sha256`. On mismatch, delete it and say so.
  4. Hand it to **Android's installer** (`PackageInstaller` session API, which needs the
     `REQUEST_INSTALL_PACKAGES` permission). The first time, Android sends Arpit to "Install unknown apps"
     to allow EDITH. Android **always** asks for one confirmation tap per install for apps that aren't
     from a store; that can't be skipped, and we don't try.
  5. Android itself rejects an APK whose signature differs from the installed app, which is a second,
     independent check (see (c)).
- **Rollback:** Android can't install an older `versionCode` over a newer one without uninstalling.
  So a bad APK is fixed forward (a new build). JS mistakes are fixed with an OTA bundle (9a).

### 9c. Signing: what we have now, and the release key

**Checked 2026-10-29 (17:56 IST):** our CI APKs are all signed with **the same fixed debug keystore**,
not a new one per run.
- `expo prebuild` copies `android/app/debug.keystore` from Expo's template package
  (`expo-template-bare-minimum`). The file is byte-identical in SDK 54, 56, 57 and 58 (sha256
  `221e0a3106aa4c3c…`), and `build.gradle` signs the release build with it (`storePassword 'android'`,
  alias `androiddebugkey`).
- So **the signature is stable**: today's CI APKs install over each other, and an SDK upgrade won't
  change the key.
- **But that key is public.** Every Expo/React Native project ships the same file with the same
  password, so anyone can sign an APK that Android accepts as an update to `com.arpit.edith`. That's
  fine for testing. It's not acceptable for in-app updates of an app that can run commands on edith.

**Plan for the release key** (before 9b ships):
1. **Arpit creates it once, on his own machine** (never on edith, never by an agent):
   `keytool -genkeypair -v -keystore edith-release.jks -alias edith -keyalg RSA -keysize 4096 -validity 10000`
   with a strong password. Android requires the same key for every future update, so this key is the
   app's identity for good.
2. **Offline backup:** two copies (e.g. an encrypted USB stick and a password manager attachment), plus
   the passwords in the password manager. If it's lost, the app can only be reinstalled under a new key
   (an uninstall).
3. **GitHub Secrets** (repo `Arpit098/edith-app`): `ANDROID_KEYSTORE_BASE64` (the `.jks`, base64),
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. CI decodes it to
   `$RUNNER_TEMP` (never into the repo), and a small config plugin adds a `release` `signingConfig` read
   from environment variables. The keystore file is deleted at the end of the job (`if: always()`).
   PR builds from forks don't get secrets. That can't happen in this private repo, but release signing
   runs only on `main` anyway.
4. **Pin it on edith:** the release certificate's SHA-256 digest goes in the server config, so 9b only
   offers APKs signed with it.
5. **One-time reinstall:** going from the debug key to the release key changes the signature, and
   Android won't update across that. So **once**, Arpit uninstalls the debug-signed EDITH and installs
   the first release-signed APK. That deletes the app's data: he enters the server address and token
   again (the token stays on edith; nothing is lost there). After that, every update (OTA or APK) keeps
   the data.
6. Optional later: APK Signature Scheme v3 key rotation (`apksigner rotate`) lets a future key change
   happen without a reinstall, but only if planned from the release key onwards.

### 9d. Order

1. Release key (Arpit) → CI release signing → the one-time reinstall.
2. 9b (APK updates), since it needs the stable key.
3. 9a (OTA). The APK that adds expo-updates is delivered through 9b.

## 10. Open questions for Arpit

1. **Partial transcripts:** worth the server work (a faster partial mode on whisper.cpp, §5), or show
   "Listening…" and only the final transcript in Phase 3?
2. **Colours:** the glow palette (proposal: cyan `#4EA1FF` → violet `#8B6CFF` → teal `#2DD4BF`, matching
   the app's accent). Alternatives can be shown in the preview with `&palette=`.
3. **Spoken answer length:** keep the server's 2-sentence `speak`, or longer?
4. **Over the lock screen:** allow talking to EDITH while the phone is locked (answers shown and spoken),
   or require unlocking first?
5. **Release key:** when will you create it (9c)? Everything in 9 waits for it, and the one-time
   reinstall happens then.
