# EDITH App — Plan

An Android voice assistant ("Hey Edith") for E.D.I.T.H, the Claude Code agent running on the
`edith` server. Like Siri, but it drives Arpit's own Claude Code session, and shows that session live.

_Created 2026-10-29, updated 2026-10-29 (battery-light triggers). Status: Phase 0 (planning)._

---

## 1. Goals

- Talk to EDITH by voice or text from an Android phone, **light on battery by default**. There is no
  background listening unless Arpit chooses to turn on the **"Hey Edith"** wake word (see 4.8).
- See the **live Claude Code session**: messages, tool calls, file edits and diffs as they happen.
- Do everything the Telegram bot can: switch sessions, stop tasks, Allow/Deny permission prompts.
- Long-press the power button to open EDITH, by making it Android's **default digital assistant**.

## 2. Constraints

- **Free only.** No paid APIs or services.
- **Open source for voice.**
  - Wake word: **openWakeWord** (Apache-2.0), with no vendor SDK.
  - Speech-to-text: **whisper.cpp** (MIT), running on edith.
- **Android only.** The APK is installed manually. No Play Store.
- **Private.**
  - The API is reachable only over **Tailscale**.
  - No public ports, and no changes to the OCI security list.
- **Reuse what exists.**
  - The tmux Claude session, hooks, session switching and permission relay stay as they are.
  - The Telegram bot keeps working alongside the app.
- **Edith is a small server**: 2 OCPU and 12 GB RAM, ARM64, Always Free.
- **Change control.** Every change on edith gets a change list and Arpit's approval before it's applied.

## 3. Architecture

```
 📱 EDITH app (Android)                               🖥 edith (OCI, ARM64)
 ┌────────────────────────────┐                      ┌──────────────────────────────────────┐
 │ WakeWordService (Kotlin)   │                      │ edith-bridge.service                 │
 │  openWakeWord (ONNX)       │                      │  ┌────────────────────────────────┐  │
 │  + VAD → record utterance  │                      │  │ edith-core (lane manager)       │  │
 │ React Native UI            │ Tailscale (WireGuard)│  │  main lane → tmux Claude        │  │
 │  live session view         │ ◄──────────────────► │  │  side lanes → claude -p forks   │  │
 │  chat / sessions / approve │  encrypted, private  │  │  sessions, permissions, stop    │  │
 │  push-to-talk, TTS         │   bearer token       │  ├───────────────┬────────────────┤  │
 │ VoiceInteractionService    │                      │  │ Telegram front │ App API front  │  │
 │  (default assistant)       │                      │  │ (existing)     │ HTTP + WS (new)│  │
 └────────────────────────────┘                      │  └───────────────┴────────────────┘  │
                                                     │ whisper-server (whisper.cpp, local)  │
                                                     │ edith-claude.service (tmux Claude)   │
                                                     └──────────────────────────────────────┘
```

**Key decision:** there must be one owner of the main lane. Two separate programs typing into the
same tmux session would collide. So the current bridge is split into:

- **edith-core**, which owns the lane and holds the tmux, hooks, sessions and permission logic.
- **Two front-ends**: Telegram (existing) and the App API (new).

All of them run in the same `edith-bridge` service, and the existing behaviour must not change.

## 4. Components

### 4.1 App API (on edith)
- **Stack:** Python. The bridge is stdlib-only, so the API will use either the stdlib or one small
  async dependency in `~/edith/venv`. This is decided in Phase 1.
- **Network and auth:**
  - Binds **only to the Tailscale IP** (100.x.y.z).
  - Auth is a long random bearer token, stored on the phone in the Android Keystore.
- **Endpoints (v1):**

  | Method | Path | Purpose |
  |---|---|---|
  | POST | `/v1/messages` | Send text, optionally tagged `voice`, to the main lane (or a side lane if busy) |
  | POST | `/v1/stt` | Upload audio (16 kHz mono) → whisper.cpp → text |
  | WS | `/v1/stream` | Live events: user msg, assistant text, tool call, tool result summary, diff, status, permission request, turn done |
  | POST | `/v1/stop` | Interrupt the current task (Esc) |
  | GET | `/v1/sessions` | Recent conversations (same list as `/sessions`) |
  | POST | `/v1/sessions/{id}/resume` | Switch conversation |
  | POST | `/v1/sessions/new` | `/clear` |
  | PATCH | `/v1/sessions/{id}` | Rename |
  | POST | `/v1/permissions/{id}` | Allow / deny |
  | GET | `/v1/status` | Lane state, tmux state, current session |

- **Live view source:** the session transcript (JSONL), tailed, plus hook events. Every turn is
  shown in the app, whether it came from Telegram, the app or the terminal. A reply is *sent*
  (spoken or posted) only to the place the message came from.
- **Audit log:** every API call is recorded with time, endpoint and a short summary.

### 4.2 Speech-to-text: whisper.cpp (on edith)
- Build from source with ARM NEON enabled.
- Run `whisper-server` on **localhost only**. The App API calls it.
- **Model:** benchmark `base` and `small` (multilingual, for Hindi and English mixed) on 2 OCPU.
  - Target: under 5 s for a 5–10 s utterance.
  - Use quantized models (q5/q8) if they help.
- Convert audio with `ffmpeg` if needed.

### 4.3 Network: Tailscale
- Install on edith (one `sudo` command; Arpit logs in) and on the phone.
- Use the MagicDNS name `edith`. The free personal plan is enough.
- Fully self-hosted alternative if wanted later: Headscale.

### 4.4 Android app
- **Framework:** React Native (Expo, prebuild / dev client, TypeScript), plus native Kotlin modules.
- **Screens:**
  - **Live**:
    - The session stream: chat bubbles, collapsible tool-call cards, diff view, status bar.
    - Mic button (push-to-talk), text box and Stop button.
    - Allow/Deny cards shown inline.
  - **Sessions**: list, switch, rename, new.
  - **Settings**: server address and token, **"Hey Edith" toggle (off by default)** and sensitivity, voice (TTS) on/off, auto-send after speech.
- **Home-screen widget**: one tap opens EDITH already listening.
- **Voice out:** Android TextToSpeech (`expo-speech`). It speaks EDITH's short voice summary (see 4.7).
- **Native Kotlin modules:**
  - **WakeWordService** (foreground service, microphone type). It runs **only while the "Hey Edith"
    toggle is on**. Its ongoing notification has a "Turn off" button.
    - `AudioRecord` at 16 kHz feeds the openWakeWord pipeline: `melspectrogram` → `embedding` → `hey_edith` model.
    - Runs on ONNX Runtime Android (MIT), or TFLite (Apache-2.0).
    - On detection: beep, then open the listening overlay.
    - It records until silence, detected with Silero VAD (MIT, ONNX) or an energy-based VAD, then uploads to `/v1/stt`.
  - **Assistant role**: `VoiceInteractionService` + `VoiceInteractionSessionService` (+ a stub
    `RecognitionService`). EDITH then appears under Settings → Default digital assistant app, and a
    long press on power opens the listening overlay.

### 4.5 Wake-word model: "Hey Edith"
- Train with **openWakeWord's training notebook** on free Google Colab:
  - Positives:
    - Synthetic: "hey edith" in many Piper TTS voices, with augmentation (noise, reverb, speed).
    - Real: 30–50 recordings of Arpit, in different rooms and distances, plus some at a whisper.
  - Negatives: openWakeWord's precomputed negative features, plus recordings of Arpit's own
    household and TV noise for validation.
- **Targets:**
  - False accepts: under 1 per hour of normal background audio.
  - False rejects: under 5%.
  - Tune the threshold on the device.
- **Output:** `hey_edith.onnx` (and `.tflite`), versioned in the repo under `wakeword/models/`.

### 4.6 Notifications
- **Phase 2–3:** local notifications from the app while it's connected.
- **Phase 5:** self-hosted **ntfy** (open source) on edith, reachable only over Tailscale. It pushes "task
  done" and "approval needed" even when the app is closed.

### 4.8 Triggers and battery
Light by default. **Nothing listens in the background unless Arpit turns it on.**

| Trigger | How | Idle battery |
|---|---|---|
| **Power button long-press** | EDITH set as the default digital assistant | Zero |
| **Home-screen widget** | Tap, and EDITH opens already listening | Zero |
| **Earbud / headset button** | The headset assistant gesture (long-press on most Bluetooth earbuds) goes to the default assistant | Zero |
| **"Hey Edith" wake word** | **Manual toggle, off by default.** Arpit turns it on when hands-free is wanted and off afterwards. In the app's Settings, and "Turn off" in its notification | Only while on, roughly 5–15%/day if left on all day (to be measured) |

While the wake word is on, a cheap **sound gate** (a loudness check) keeps the openWakeWord model idle in
silence. This reduces the cost without changing how it behaves. The toggle's state is
remembered, but after a phone reboot Android requires the app to be opened once before listening
can resume.

### 4.7 Voice mode for EDITH
- Messages from voice are tagged `[voice]`.
- An EDITH output-style rule: start with a 1–2 sentence speakable summary, then the details. The
  app speaks only the summary and shows everything.

## 5. Repository layout (`Arpit098/edith-app`, private)

```
edith-app/
├── PLAN.md                 ← this file
├── server/                 edith-core + App API (deployed to ~/edith/bridge on edith)
├── app/                    React Native app (+ android/ native Kotlin modules)
├── wakeword/               training notebook, recordings manifest, exported models
├── deploy/                 systemd units, install scripts, whisper build script
└── .github/workflows/      build-apk.yml (signed release APK as an artifact)
```

**APK builds** run in GitHub Actions on x86 Ubuntu runners. The Android build tools don't run well
on edith's ARM64.
- The private repo gets 2,000 free minutes a month, and a build is about 10–15 minutes.
- Signing keystore:
  - Created once and stored in GitHub Secrets; Arpit keeps an offline copy.
  - It must never change, or app updates won't install over the old version.

## 6. Phases

| Phase | Deliverable | Done when |
|---|---|---|
| **0. Plan** | This plan; private repo created | Arpit approves the plan |
| **1. Server** | Tailscale on edith; bridge split into edith-core + Telegram + App API (same service); whisper.cpp built and benchmarked; whisper-server on localhost | `curl` over Tailscale can send a message, stream the live session, list/switch sessions, approve a permission and transcribe a WAV. **Telegram works exactly as before** |
| **2. App v1** | RN app: connect (address + token), live session view, text send, stop, sessions, approvals; Actions builds a signed APK | Arpit installs the APK and runs a full task from the phone while watching it live |
| **3. Voice & triggers** | Push-to-talk → whisper → send; TTS of voice summaries; `[voice]` output-style rule; listening overlay with VAD end-of-speech; **default-assistant role (power button + earbud button)**; **home-screen widget** | Long-press power → "check the server disk space" → spoken answer, under ~10 s plus task time. Same from the widget and the earbuds |
| **4. Wake word (optional toggle)** | Trained `hey_edith` model; WakeWordService behind the Settings toggle (off by default) with sound gate | Triggers reliably across the room; under 1 false wake per hour; battery cost measured while on |
| **5. Notifications & polish** | ntfy notifications; polish | EDITH replaces Google Assistant in daily use |

## 7. What Arpit does

- Approves each phase's change list before anything on edith is changed.
- **Phase 1:**
  - Runs the Tailscale install on edith (one `sudo` command) and logs in.
  - Installs Tailscale on the phone.
- **Phase 2:**
  - Enables "Install unknown apps" for the browser or file manager.
  - Keeps an offline copy of the signing keystore.
- **Phase 4:** records about 30–50 "Hey Edith" samples and a few minutes of normal home noise. The app will have a recorder screen for this.

## 8. Risks and open questions

- **Android 14+ microphone limits:**
  - A microphone foreground service can't start from the background or at boot.
  - After a reboot, EDITH must be opened once for "Hey Edith" to start listening again.
  - The power-button assistant still works.
- **Battery:**
  - Handled by design: the wake word is a manual toggle, off by default.
  - All other triggers use no battery while idle.
  - The cost while the toggle is on will be measured in Phase 4.
- **whisper.cpp speed on 2 OCPU:**
  - If `small` is too slow, use `base`, or a quantized `small`.
  - It uses roughly 0.5–1 GB of RAM, which is fine on 12 GB.
- **Telegram and app at the same time:**
  - edith-core serializes the main lane.
  - Messages that arrive while it's busy use side lanes, exactly as Telegram does today.
- **Claude Code updates:**
  - The transcript format or the interface may change.
  - Mitigation: rely on hooks wherever possible, and keep the parsing in one module.
- **Claude usage limits:** voice makes it easy to send many requests, so the app should show when EDITH is busy or rate-limited.
- **Security:**
  - This app can run shell commands on edith. It needs Tailscale, a token and the permission prompts, and is never exposed publicly.
  - If the phone is lost: rotate the token and remove the device from Tailscale.

## 9. Cost

| Item | Cost |
|---|---|
| openWakeWord, whisper.cpp, ONNX Runtime, Silero VAD, React Native, ntfy | Free (open source) |
| Tailscale personal plan | Free |
| GitHub private repo + Actions (2,000 min/month) | Free |
| Google Colab for wake-word training | Free tier |
| APK distribution (sideload) | Free |
| Edith server | Always Free (OCI) |
