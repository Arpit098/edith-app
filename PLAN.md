# EDITH App — Plan

Arpit's **personal tools app** for Android, built around E.D.I.T.H, the Claude Code agent running on
the `edith` server. Talking to EDITH by voice ("Hey Edith"), like Siri but driving Arpit's own Claude
Code session and showing it live, is the first and main tool. Reminders, mail, calendar and more
tools are added over time, each as its own feature on the app and the server.

_Created 2026-10-29, updated 2026-10-29 (battery-light triggers; modular codebase; existing tools migration; Phase 1 plan approved; Phase 1 done). Status: **Phase 1 (server) done** in the repo and live (tag `p1-live-3`); next is Phase 2 (app v1). See [docs/PHASE1_PLAN.md](docs/PHASE1_PLAN.md)._

**Phase 1 wrap-up**
- Done ahead of Phase 3: the server side of voice (`voice.turn`/`voice.reply`, spoken summaries)
  is live, and the `[voice]` output-style rule was applied on 2026-10-29 with Arpit's "yes".
- Live clean-up done 2026-10-29: the old `edith.service`, `edith-check.service/.timer`,
  `~/.local/bin/edith-{start,check,notify}` and the staging units and dirs are removed (backup in
  `~/edith-backups/cleanup-20261029/`). The staging run was skipped.
- Open items: Arpit's Telegram checklist on the live bot; the `edith-claude.sh` swap (the only
  file the drift check still reports); Hindi clips for the whisper benchmark.
- For Phase 2: the App API has history by cursor, a JSON ping/pong, tool ids and `session.switched`
  (contracts/events.md). The Android package name is `com.arpit.edith` (confirmed).

---

## 1. Goals

- Talk to EDITH by voice or text from an Android phone, **light on battery by default**. There is no
  background listening unless Arpit chooses to turn on the **"Hey Edith"** wake word (see 4.8).
- See the **live Claude Code session**: messages, tool calls, file edits and diffs as they happen.
- Do everything the Telegram bot can: switch sessions, stop tasks, Allow/Deny permission prompts.
- Long-press the power button to open EDITH, by making it Android's **default digital assistant**.
- **A home for Arpit's tools.** Voice is one feature. Each tool (reminders, mail, calendar, and others
  later) is a self-contained feature on the server and in the app, opened from a **Tools** grid, so a new
  tool never means reworking the others. See [docs/ADDING_A_FEATURE.md](docs/ADDING_A_FEATURE.md).

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
- **Stack:** Python standard library only: `ThreadingHTTPServer` plus a small WebSocket server
  kept in this repo, so the bridge keeps running on the system `python3` with no venv. (Decided 2026-10-29.)
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
  | POST | `/v1/actions` | Press a reply button (`{action}`), e.g. snooze a reminder |

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
- **Package name:** `com.arpit.edith` (confirmed).
- **Framework:** React Native (Expo, prebuild / dev client, TypeScript), plus native Kotlin modules.
- **Screens:**
  - **Live**:
    - The session stream: chat bubbles, collapsible tool-call cards, diff view, status bar.
    - Mic button (push-to-talk), text box and Stop button.
    - Allow/Deny cards shown inline.
  - **Sessions**: list, switch, rename, new.
  - **Tools**: a launcher grid with one tile per tool (`FeatureModule.tool` in `app/src/core/feature.ts`).
    Only a few main screens are in the navigation menu (top right of the header); every other tool lives here.
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
**Workflow (decided 2026-10-29):**
1. **Record in the app.** A guided "Train wake word" screen asks for "Hey Edith" near, across the
   room and whispered, plus a few minutes of home and TV noise. It checks each clip (length, level,
   clipping) and lets Arpit redo bad ones.
2. **Clips go to edith** through the App API (token, Tailscale only), into
   `~/.cache/edith/wakeword/recordings/<session>/` (mode 0600) with a `manifest.json`. They never go in git.
3. **Training runs on Arpit's MacBook (M5)**, started by Arpit through the Claude agent on the Mac,
   which works from a clone of this repo.
   - It fetches the clips from edith over Tailscale, using an App API download route with the
     token, so no SSH access to the Mac is needed and the server never connects to the Mac.
   - It runs `wakeword/training/` (openWakeWord pipeline, PyTorch on MPS) and writes
     `wakeword/models/hey_edith.onnx` and `metrics.md`.
4. **Results:** the model (a few hundred KB) and `metrics.md` are pushed to `main`. The app bundles
   the model, so it reaches the phone as an OTA update. The app then asks Arpit to say "Hey Edith"
   a few times to confirm.
- **App status:** the screen shows the clips recorded and uploaded, then "waiting for training",
  then the installed model's version and metrics. There's no live progress during training,
  because training runs by hand on the Mac.
- **Mac safety:** Mac on Tailscale with nothing listening (Remote Login off). Optional Tailscale ACL:
  Mac → edith:8787 allowed, edith → Mac denied. Arpit applies it in the admin console, then the
  phone ↔ edith connection is re-checked.
- **Fallback:** the same scripts run on edith's CPU (slow, at low priority) if the Mac isn't available.

**Training details:** openWakeWord's training pipeline, scripted in `wakeword/training/`:
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
  - Built in Phase 2b (`features/notifications`, native `edith-system`): channels for replies and
    finished tasks, approval needed (Allow/Deny buttons answer without opening the app), reminders,
    errors. Nothing already on screen is notified; each ref or id notifies once.
  - While a turn runs or an approval waits, a `specialUse` foreground service keeps the stream
    alive (it stops the moment that's over; Android 12+ won't start it from the background).
- **Phase 5:** self-hosted **ntfy** (open source) on edith, reachable only over Tailscale. It pushes "task
  done" and "approval needed" even when the app is closed.

### 4.7 Voice mode for EDITH
- Messages from voice are tagged `[voice]`.
- An EDITH output-style rule: start with a 1–2 sentence speakable summary, then the details. The
  app speaks only the summary and shows everything.

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

### 4.9 Existing EDITH tools move into edith-app
The tools EDITH already uses on the server move into this repo as features and adapters. Today they
lived untracked in `~/edith`; Phase 1 migrated all of them (the legacy copy is deleted; its recorded
behaviour stays as golden files in `server/tests/golden/`).

| Today (on edith) | Moves to | Notes |
|---|---|---|
| `bridge/reminders.py`, `bin/remind.py` | `features/reminders/` | Same `reminders.json` data in `~/.cache/edith/`. `remind.py add/list/cancel` keeps working for EDITH (CLAUDE.md) via a thin wrapper. Snooze/Done buttons and `/reminders` unchanged |
| `google/gmail.py` | `adapters/google/` (mail port) + `features/mail/` | `/mail`, unread-that-matters summaries. Read-only unless Arpit asks otherwise |
| `google/gcal.py` | `adapters/google/` (calendar port) + `features/calendar/` | `/today`, events, free slots |
| `google/auth.py`, `gauth.py` | `adapters/google/auth.py` | OAuth tokens stay in `~/.config/edith-google/` and never go in git |
| `bin/changes.py` | `features/changes/` | `/changes` |
| Quick actions (`/brief`, `/menu`, …) | `features/quick_actions/` | Use the mail/calendar/reminders features through events and ports, not imports |

Later (optional), the app gets **Reminders, Calendar and Mail screens** that use the same features through the App API.

### 4.10 Scheduled tasks (EDITH messages first)
Today EDITH only runs when Arpit sends a message; reminders are plain text fired by the bridge's
timer. Scheduled tasks let EDITH **do a job at a set time and report back unprompted**, e.g. "check
the BLS Polymers allotment at 19:00 and tell me the result". (Asked for 2026-10-29.)

- **Feature:** `features/scheduled_tasks/`, built on the reminders scheduler (one `heapq` of due
  items, woken by a `Condition`, no polling). Data in `~/.cache/edith/tasks.json`, mode 0600, atomic writes.
- **Running a task:** at the due time it runs as a **side lane** (`claude -p` fork), never the main
  lane, so it can't collide with a live conversation. The reply goes to Telegram (and the app later),
  prefixed with ⏰ and the task name.
- **CLI for EDITH:** `task.py add "<when>" "<prompt>" [--every daily|weekdays|weekly|monthly]`,
  `task.py list`, `task.py cancel <id>`, same time formats as `remind.py`. `/tasks` lists them in Telegram.
- **Safety:**
  - A run has a timeout (default 10 min) and a daily cap on runs, so a bad schedule can't burn
    Claude usage.
  - Permission prompts during a run go to Telegram as Allow/Deny, as today. Nothing is auto-approved.
  - If a run fails or times out, Arpit gets a ❌ message with the reason, never silence.
  - Keep sensitive data (PAN, account numbers) out of task prompts where possible; the file is
    0600 and never goes in git.
- **When:** a step at the end of Phase 1, after reminders move into `features/reminders/`.
- **Done when:** a task set for +2 min runs on its own, its answer arrives in Telegram, a
  repeating task fires on schedule, and `/tasks` and `task.py cancel` work.

### 4.11 Design: Liquid Glass theme, logo and Live Alerts (asked for 2026-10-29)
Arpit wants the app to look like Apple's new **Liquid Glass** interface (macOS Tahoe 26): black
and grey, translucent frosted panels, and edges that catch the light. EDITH's states should also
show in the phone's "dynamic island".

- **Theme:** dark only to begin with: near-black background, grey glass surfaces, white text, and
  the logo's soft blue as the one accent colour.
  - Android can't refract light the way Apple's glass does. We approximate it with real-time blur
    (`RenderEffect`, Android 12+) behind translucent layers, a thin light edge (a gradient border)
    and a subtle inner highlight.
  - Without blur (older Android, or battery saver) it falls back to flat translucent grey.
  - Tokens live in one theme module (`app/src/core/theme/`: colours, glass levels, radii, motion).
    Screens use the tokens and no raw colours, so each feature keeps its own look in step.
  - Blur only on a few large surfaces (header, cards, sheets), never in lists, to keep
    scrolling at 60 fps and spare the battery.
- **Real Liquid Glass (asked for 2026-10-30):** a native `GlassView` in our module
  `android-modules/edith-glass`, by Android version:
  - **Android 13+:** `RenderEffect.createRuntimeShaderEffect` with an AGSL shader of our own over
    the blurred backdrop. The shader does lens refraction (the backdrop bends towards the rim of the
    rounded shape), chromatic dispersion at the rim, a specular highlight from the top-left, and
    blur plus a little extra saturation inside.
  - **Android 12:** blur and saturation only (`createBlurEffect` chained with a colour matrix).
  - **Below 12, or in battery saver:** the flat translucent fallback.
  - Where it goes: chrome surfaces only (header, the navigation menu, composer, sheets, the floating mic),
    never list rows or bubbles.
  - How it works: the backdrop is the screen content's display list, recorded into a `RenderNode`
    (no bitmap copies). The glass redraws only when the content draws (a pre-draw listener), never
    on a timer.
  - The same module reports battery saver (`PowerManager`, plus its change broadcast).
  - Any open-source shader code we use is credited in the module's README with its MIT or Apache
    licence. The shader we use now is our own.
- **Liquid motion (Reanimated, all on the UI thread):**
  - navigation is a hamburger at the top right of the header (asked for 2026-10-30, replacing the
    bottom tab bar); its glass drop-down sheet grows out of the button and shrinks back on springs;
  - sheets grow out of the control that opened them;
  - controls squish slightly when pressed;
  - new bubbles settle in on a spring;
  - the "working" indicator is a morphing glass blob.
  - With Android's "Remove animations" setting on, everything jumps straight to its end state.
- **Performance:** frame times are measured by the module (`FrameMetrics`: p50/p95/p99, janky
  frames) while scrolling and switching tabs, with the glass on and off. The target is 60–120 fps
  (the 13R's 120 Hz) with no extra janky frames from the glass. Numbers from an emulator are labelled
  as such, and device numbers come from a readout in Settings → About.
- **Before merge:** screenshots of the main screens and a short screen recording (tab switch,
  scrolling under the glass, a sheet) go to Arpit for approval.
- **Logo:** Arpit's image (`app/assets/brand/edith-logo-source.jpg`: glowing blue and white glass rings
  on near-black) becomes the launcher icon (adaptive foreground and background, plus a monochrome
  version for themed icons) and the splash screen. The source is 838 px, which is enough for
  launcher icons; ask Arpit for a larger or vector version if the splash looks soft.
- **Live Alerts ("dynamic island"):** Arpit's phone is a OnePlus 13R. On OxygenOS 16 (Android 16),
  the Live Alerts pill shows any app's **Android 16 Live Updates**: a promoted ongoing notification,
  using `Notification.ProgressStyle` where it fits.
  - States shown: listening, thinking, speaking, task running (with its progress), and waiting for
    approval (it opens the approval screen).
  - Driven by the same session events the app already streams; no polling.
  - Built as a small native module behind an `OngoingStatus` port, so other features (timers,
    reminders) can use it later.
  - Before Android 16 it's a normal ongoing notification.
  - Arpit turns on "Show Live Updates on Live Alerts" for EDITH once (OxygenOS asks this for each app).
- **Phase 3 overlay:** its glow colours (cyan → violet → teal in `docs/PHASE3_APP_PLAN.md`) should
  follow this theme. Settle that when Arpit approves Phase 3.
- **Done when:** Arpit has approved screenshots of the main screens (a web preview harness plus
  Playwright on edith) **before** the APK is built, the release APK shows the new icon and theme,
  and a voice or text task shows its live state in the Live Alerts pill on the 13R.

## 5. Repository layout (`Arpit098/edith-app`, private)

The code is organised as **ports, adapters and feature folders**, so a feature can be added or
removed without touching the others. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/ADDING_A_FEATURE.md](docs/ADDING_A_FEATURE.md).

```
edith-app/
├── PLAN.md                 ← this file
├── docs/                   ARCHITECTURE.md, ADDING_A_FEATURE.md
├── contracts/              events.md: the event/API contract shared by server and app
├── server/edith/           (deployed to edith in Phase 1)
│   ├── core/               event bus, registry, feature context
│   ├── ports/              interfaces: agent, frontend, stt, notifier
│   ├── common/             shared helpers (imports core only)
│   ├── adapters/           frontends/{telegram,app_api}, agents/claude_tmux, stt/whisper_cpp, notifiers/{telegram,ntfy}
│   └── features/           sessions, approvals, control, reminders, quick_actions, voice, notifications (+ _template)
├── app/
│   ├── src/core/           events, ports, feature loader
│   ├── src/common/         shared helpers (imports core only)
│   ├── src/adapters/       transport, stt, tts, recorder, wakeword, storage
│   ├── src/features/       live-session, sessions, approvals, settings, voice, assistant, widget, wakeword
│   ├── src/ui/             shared components
│   └── android-modules/    Kotlin: assistant-role, widget, wakeword-service
├── wakeword/               training notebook, recordings manifest, exported models
├── deploy/                 systemd units, install scripts, whisper build script
└── .github/workflows/      build-apk.yml (signed release APK as an artifact; Phase 2)
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
| **1. Server** | Tailscale on edith; bridge split into edith-core + Telegram + App API (same service); **reminders, Gmail and Calendar code moved into edith-app (§4.9)**; whisper.cpp built and benchmarked; whisper-server on localhost | `curl` over Tailscale can send a message, stream the live session, list/switch sessions, approve a permission and transcribe a WAV. `/reminders`, `/mail`, `/today`, `/brief` run from the repo code. **Telegram works exactly as before**; `server/legacy/` is empty |
| **2. App v1** | RN app: connect (address + token), live session view, text send, stop, sessions, approvals, and the **Tools grid screen** (tiles from features' `tool`); Actions builds a signed APK | Arpit installs the APK and runs a full task from the phone while watching it live |
| **2b. Design** | Liquid Glass theme, new logo as icon and splash, EDITH states in Live Alerts (§4.11) | Arpit approves the screenshots; the release APK has the new look; a task shows live in the Live Alerts pill on the 13R |
| **3. Voice & triggers** | Push-to-talk → whisper → send; TTS of voice summaries; `[voice]` output-style rule (applied in Phase 1); listening overlay with VAD end-of-speech; **default-assistant role (power button + earbud button)**; **home-screen widget** | Long-press power → "check the server disk space" → spoken answer, under ~10 s plus task time. Same from the widget and the earbuds |
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
- **Phase 2b:**
  - Checks that the 13R is on OxygenOS 16 (Settings → About device).
  - Approves the theme screenshots.
  - Turns on "Show Live Updates on Live Alerts" for EDITH.
- **Phase 4:**
  - Records about 30–50 "Hey Edith" samples and a few minutes of normal home noise on the app's training screen.
  - Puts the MacBook on Tailscale.
  - Asks the Claude agent on the Mac to run the training (§4.5).

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
| Wake-word training (Arpit's MacBook; edith CPU as fallback) | Free |
| APK distribution (sideload) | Free |
| Edith server | Always Free (OCI) |
