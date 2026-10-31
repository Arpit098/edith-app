# Event contract (server ⇄ app)

Every event on the bus, and on the app's `/v1/stream` WebSocket, has this shape:

```json
{ "type": "turn.done", "ts": 1793187449.77, "session_id": "8268e354-…", "origin": "app", "data": { } }
```

- `origin` is where the turn came from: `telegram`, `app`, `terminal` or `system`. Replies are sent to the origin.
- **Adding an event type:** add it here first. Never change the meaning of an existing field.
  Add a new field or a new type instead.

| Type | `data` | Emitted when |
|---|---|---|
| `message.user` | `{text, voice: bool}` | A user message enters the main lane |
| `message.assistant` | `{text}` | Claude writes text (partial or final) |
| `tool.call` | `{id, name, summary}` | Claude starts a tool (e.g. `Bash: npm test`). `id` is Claude's tool_use id |
| `tool.result` | `{id, name, ok, summary}` | A tool finishes. `id` is the `tool.call.id` it answers |
| `file.diff` | `{id, path, diff}` | A file is edited (`id`: the Edit/Write `tool.call.id`) |
| `turn.started` | `{ref}` | A main-lane turn begins |
| `turn.done` | `{ref, text, steps, elapsed}` | A main-lane turn ends with a reply |
| `turn.stopped` | `{ref}` | A turn is interrupted |
| `permission.request` | `{id, tool, detail}` | Claude needs approval |
| `permission.resolved` | `{id, decision}` | Approved, denied or timed out |
| `session.changed` | `{session_id, title, source}` | New, resumed or cleared session |
| `session.switched` | `{ref, result, session_id}` | A conversation switch (`/resume`, a `sess:` button, `POST /v1/sessions/{id}/resume`) is over: always the last event of that switch, after its `command.reply` messages and `session.changed`. `result`: `ok`, `already`, `busy`, `missing` or `failed`; `ref` is the one the request returned (for Telegram, its message id) |
| `lane.status` | `{main: idle/busy, side: n, queued: n}` | Lane state changes |
| `turn.queued` | `{ref, position}` | A message waits for the main lane (all lanes busy, or `/queue`) |
| `turn.progress` | `{ref, lane, steps, step, elapsed}` | A running turn moves on (`step` is the latest tool summary, e.g. `$ npm test`) |
| `turn.failed` | `{ref, reason, detail}` | A turn ends without a reply. `reason`: `not_ready`, `crashed` or `error` |
| `reminder.due` | `{id, text, every, due, late}` | A reminder fires. `due` is a unix time; `late` is true if it fired over 2 minutes late |
| `message.system` | `{text, buttons}` | A feature has something for Arpit that isn't a reply to a turn (a reminder, the crash notice). Frontends show it; Telegram sends it to the first allowed chat |
| `command.reply` | `{ref, text, buttons}` | A command or button the app used answers later (e.g. a conversation switch); `ref` is the one its request returned. A command typed in the chat sends all its replies this way (see "Typed commands") |

| `turn.retrying` | `{ref, lane, reason}` | A turn starts over (a side lane whose conversation is gone runs again fresh); frontends drop that turn's status message |
| `voice.turn` | `{ref}` | The App API accepted a `POST /v1/messages` with `voice: true` (sent before the turn's own events). Origin `app` |
| `voice.reply` | `{ref, outcome, speak}` | What the app says aloud for that voice turn (see "Voice" below). Origin `app` |
| `accounts.switch` | `{run, target, previous, state, step, detail, started, ts, agents}` | A Claude account switch starts, moves on a step and ends (contracts/accounts.md). Origin `system` |

Fields the agent adds (new fields only; existing meanings unchanged):
- `turn.started`, `turn.progress`, `turn.done`, `turn.stopped` and `turn.failed` carry `lane` (`main`
  or `side`). `turn.started` is sent once the turn is really running (for the main lane, after the
  tmux Claude is ready), so a `not_ready` failure has no `turn.started` before it.
- `turn.done` also carries `is_error` and `subtype` (Claude's result subtype, e.g. `success`).
- `turn.failed` with `reason: error` carries `code` (the exit code) and `stderr` (its last 800 characters).
  Two more reasons: `queue_full` (too many messages already waiting) and `bridge_error` (a bug;
  `detail` has the message).
- `permission.request` and `permission.resolved` also carry `ref` and `lane` of the turn that asked
  (both `null` when unknown).
- `turn.stopped` with `lane: queued` is a queued message dropped by /stop (it never ran).
- `message.system` may carry `key`, a feature's name for that message. A later
  `message.buttons_cleared {key}` removes its buttons (e.g. an approval answered elsewhere or timed out).
  It may also carry `ref`, the turn it belongs to: frontends then send it where that turn came from.
- `permission.resolved.decision` is `allow`, `deny` or `gone` (answered elsewhere or timed out).

## Replies and buttons

A command's reply, and the `data` of `message.system`, can carry buttons:

```json
{ "text": "⏰ Renew the domain", "buttons": [[{ "label": "+15m", "action": "rem:snooze:15:ab12cd" }]] }
```

- `buttons` is a list of rows; each button has a `label` and an `action` string.
- `action` is `<prefix>:<args…>`, at most 64 bytes (Telegram's `callback_data` limit). The feature that
  registered `<prefix>` handles it. **Existing action strings never change**, so buttons on old
  Telegram messages keep working: `rem:…` (reminders), `perm:allow|deny:<id>` (approvals),
  `sess:<session_id>` (sessions), `quick:<name>` (quick actions).
- Pressing a button returns `{toast, note}`, both optional. `toast` is a short popup. `note` is
  appended to the pressed message, which then loses its buttons. Telegram shows these with
  `answerCallbackQuery` and `editMessageText`; the app gets them from `POST /v1/actions`.

## Live view

`message.user`, `message.assistant`, `tool.call`, `tool.result` and `file.diff` come from the
conversation's transcript, for every turn, whoever started it. `message.user.origin` is
`telegram`, `app` or `terminal` (typed in tmux); the others have origin `system`. `session_id` is set.
`file.diff.diff` is a unified diff of an Edit/MultiEdit/Write (at most 20,000 characters).
`tool.result.id` equals the `tool.call.id` it answers, so the two pair exactly (`name` of a result
whose call came before the window read can be `""`; pair by `id`).

Every live-view event's `data` also carries `cursor`: `"<session_id>:<byte offset>"`, the end of its
transcript entry (several events from one entry share it). Cursors are opaque to the app; compare
them only by equality, or use them with History below.

## Messages from Arpit: accepted, delivered, reacted to

Every message a frontend hands to EDITH (app or Telegram, including `/queue`) gets these events, so a
message never vanishes from the app, whichever way it reaches Claude. All carry the frontend's `ref`
(the one `POST /v1/messages` returned; `tg:<chat>:<message>` for Telegram). Times are the top-level `ts`.

| Type | `data` | Emitted when |
|---|---|---|
| `message.user` | `{ref, text, voice, delivery, lane, attachments, replying_to}` (origin `app` or `telegram`) | At once, when the message is accepted (before Claude sees it) |
| `message.delivered` | `{ref, delivery, rid}` | When Claude actually takes it in (see `delivery`) |
| `message.reaction` | `{ref, emoji}` | App-origin messages only: the reaction Telegram would show for it; the latest one wins |

- `message.user` from a frontend:
  - `text` is clean: the bridge header (`[App message from Arpit, …]` / `[Telegram message from Arpit, …]`),
    `[voice]`, `[tg-ref …]`, the `[Attached file saved at: …]` lines and the "[Arpit is replying to …]"
    line are taken out.
  - `attachments` is the list of saved file paths (`[]` if none); `replying_to` is the quoted text or `null`.
  - `delivery` is the expected route: `main` (the main lane takes it now), `queued` (it waits for the main
    lane), `side_lane` (a parallel lane runs it now) or `command` (see "Typed commands" below). `lane`
    is `main`, `queued`, `side` or `command`.
- `message.delivered.delivery` is what happened:
  - `main`: it started a main-lane turn;
  - `mid_turn`: Claude was still working, and Claude Code folded the message into the running turn
    (the transcript then has it inside a tool result, not as a user message);
  - `side_lane`: a parallel lane (a fork of the conversation) started on it;
  - `command`: the bridge ran it as a command (`rid` is `null`).

  A queued message gets `message.delivered` when its turn starts. `rid` is the run id in the prompt's
  `[tg-ref <rid>]` tag.
- **Typed commands.** An app message whose first word is a registered command (`/compact`, `/stop`,
  `/status`, `/queue`, `/help`, …; the same list as `GET /v1/commands` plus unlisted ones like `/start`)
  runs that command through the registry, exactly as on Telegram; Claude never sees it. In order: `message.user`
  and `message.delivered`, both with `delivery: "command"`, then each reply as `command.reply {ref, text,
  buttons}` with the message's `ref`, including late ones (e.g. "✅ Compacted." minutes later). The
  reaction is 👌, as on Telegram. A command that hands text to Claude (`/queue …`, quick actions) then
  sends the usual `message.user`/`message.delivered` for the same `ref`, which win. An unknown `/word`
  is an ordinary message to Claude.
- `message.reaction.emoji`, the same as Telegram's for the same moment:
  - 👀 accepted; 🥱 queued; 👨‍💻 a main-lane turn started (or back to work after an approval); ⚡ a
    side lane started (or back to work after an approval); 🙏 waiting for Arpit's approval;
  - at the end: EDITH's `REACT:` pick (the last one in the reply) or 👍 when done, 😢 when done with
    an error, 🫡 stopped, 🕊 dropped from the queue by /stop, 💔 failed.
- The transcript's own copy of a frontend message is not sent again: the live view skips a `message.user`
  whose `[tg-ref <rid>]` belongs to a message the server accepted (history drops it too, see below).
  Messages typed in tmux still come from the transcript (origin `terminal`).

**Side lanes** (`claude -p` forks; the main transcript never has their turns):
- `message.assistant {text, lane: "side", ref, files}` carries the side lane's reply when it is done, plus
  the existing `turn.started` / `turn.progress` / `turn.done` with `lane: "side"` and the same `ref`.
- The note the main lane later gets ("[While you were busy, parallel lanes … handled these …]") is never
  shown as a message: the live view and history strip that preamble from user messages.

**Clean text everywhere:**
- `message.assistant.text` has EDITH's `REACT:` and `SEND_FILE:` lines taken out; `files` lists the
  `SEND_FILE` paths (`[]` if none). Also from the transcript, `lane` is `main` there.
- `turn.done` gains `display_text` (the reply without `REACT:`/`SEND_FILE:` lines), `files` and `reaction`
  (the `REACT:` pick or `null`). `text` stays the raw reply.
- Transcript user messages that Claude Code wrapped in `<pasted_content …>` (long or multi-line pastes)
  are unwrapped, not skipped.

**Working state** ("EDITH is working…"). These existing events already cover it; there is no separate
`turn.state` event:

| State | Starts with |
|---|---|
| thinking | `turn.started` (and after each `tool.result`) |
| tool | `turn.progress {step}` / `tool.call` (`step` is the tool summary, e.g. `$ npm test`) |
| waiting_approval | `permission.request {ref, lane}`, until `permission.resolved` |
| idle | `turn.done` / `turn.stopped` / `turn.failed` for that `ref` and `lane` |

**Message log:** `message.user` (from frontends), `message.delivered`, `message.reaction`, the side-lane
`message.assistant`, side-lane `turn.started`/`turn.done`, and the `command.reply` answers to a typed
command (those whose `ref` is a logged message) are also kept per conversation in
`~/.cache/edith/message-log/<session>.json` (atomic writes, the newest 500 events), so they survive a
restart and appear in History. Logged events carry `data.log_id` (unique) and no `cursor`.

### History

`GET /v1/sessions/{id}/history?after=&before=&limit=` (`{id}` is a session id or `current`) returns
the same events as the live view, read from the transcript by byte offset (never the whole file):

```json
{ "session_id": "…", "events": [{type, ts, session_id, origin, data: {…, cursor}}],
  "start": "<cursor>", "cursor": "<cursor>", "more": true, "reset": false }
```

- No `after`/`before`: the newest `limit` events (default 50, at most 500). `more`: older ones exist; get
  them with `before=<start>`.
- `after=<cursor>`: what came after it, oldest first. `more`: there is more past `cursor`; ask again with
  `after=<cursor>`.
- Whole entries only: a page may hold a few events more than `limit` (one entry can make several
  events), and it never splits one. `ts` is the entry's own time.
- `reset: true`: the cursor given belongs to another conversation (Claude switched); the page is the
  newest of the current one instead. A malformed cursor is a 400; an unknown session a 404.
- **Merged with the message log:** each page also holds the logged events whose `ts` falls in the time
  span of its transcript entries (from the entry before the page, exclusive, to its last entry; the newest
  page runs to now), all sorted by `ts`. A transcript `message.user` for a logged message (same `rid`,
  or the same clean text within 5 minutes) is left out, so nothing shows twice.
- Live view on open: connect `/v1/stream` first (buffer events), then fetch the newest page, then
  apply buffered events whose `cursor` is not in that page. After a reconnect: `after=<last cursor>`
  until `more` is false.

## App API (v1)

Base `http://<edith's Tailscale IP>:8787`, reachable over Tailscale only. Every request carries
`Authorization: Bearer <token>`; without it: `401 {"error": "unauthorized"}`. Errors are
`{"error": "<message>"}` with 400, 404, 405, 413 (body too large) or 429. JSON in and out.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `/v1/messages` | `{text, voice?: bool, queue?: bool, attachments?: [id]}` | `{ref, lane}`; the turn's events then arrive on the stream with this `ref`. A typed command answers `lane: "command"` and its replies come as `command.reply` (see "Typed commands"). `attachments`: ids from `POST /v1/attachments` (contracts/attachments.md) |
| POST | `/v1/attachments` | the raw file (image or audio), `x-filename?` | `{id, name, type, size, sha256}` (contracts/attachments.md) |
| GET | `/v1/stream` | WebSocket | every event above as one JSON text message `{type, ts, session_id, origin, data}`; the server pings every 25 s (protocol ping) when the line is quiet. The app connects as `/v1/stream?client=app` (the push decision counts only those, contracts/push.md). The app may send `{"type": "ping", "id"?: any}`; the answer is `{"type": "pong", "ts", "session_id": null, "origin": "system", "data": {"id"?}}` (`id` echoed). Any frame from the app counts as alive; two quiet periods without one (a ping left unanswered for 25 s) and the server drops it. Other text from the app is ignored |
| POST | `/v1/stop` | | `{running, dropped: [ref]}` |
| GET | `/v1/status` | | `{main: busy/idle, queued, runs: [{ref, lane, seconds, step}], tmux: running/down, conversation: bool, session: {id, title} \| null}` |
| GET | `/v1/status/details` | | `{ts, edith, lanes, session, agents, server}`: the status panel (contracts/status.md) |
| GET | `/v1/push/config` | | `{url, topic, token}`: edith's ntfy and the phone's read-only token, for turning push on (contracts/push.md, "Turning it on"). 404 when push isn't set up, 503 when the phone token file is unusable |
| GET | `/v1/accounts` | | `{accounts, switch, login}`; also `PATCH /v1/accounts/{id}` (rename), `POST /v1/accounts/{id}/switch`, `POST /v1/accounts/login`, `POST`/`DELETE /v1/accounts/login/{login}`, `DELETE /v1/accounts/{id}` (contracts/accounts.md) |
| GET | `/v1/sessions` | | `{sessions: [{session_id, title, updated, current}]}` |
| POST | `/v1/sessions/{id}/resume` | | `{status: "switching", ref}`; the messages come as `command.reply`, then `session.changed` (if it switched) and last `session.switched {ref, result}` |
| GET | `/v1/sessions/{id}/history` | `?after=&before=&limit=` | `{session_id, events, start, cursor, more, reset}` (see History) |
| POST | `/v1/sessions/new` | | `{result: ok/busy}` |
| PATCH | `/v1/sessions/{id}` | `{title}` | `{session_id, title}` |
| GET | `/v1/permissions` | | `{pending: [{id, tool, detail, ref, lane}]}` |
| POST | `/v1/permissions/{id}` | `{allow: bool}` | `{id, decision}`; 404 if it has expired |
| POST | `/v1/actions` | `{action}` | `{ref, toast, note, replies: [{text, buttons}]}` (a button from any reply) |
| GET | `/v1/commands` | | `{commands: [{name, description, usage, help}]}` |
| POST | `/v1/commands/{name}` | `{args?}` | `{ref, replies: [{text, buttons}]}`; later replies come as `command.reply` |
| POST | `/v1/stt?language=` | audio body, or multipart with a `file` part | `{text, language, seconds, duration}` |

`/v1/stt`: the audio is any format ffmpeg reads; 16 kHz mono 16-bit WAV is fastest (no conversion), and
M4A/AAC from Android's recorder works. `language` (optional, e.g. `hi`) skips language detection.
`text` is `""` when there was no speech; `language` is the detected or given code; `seconds` is the
transcription time and `duration` the audio length. Limits: 8 MB (413) and 60 s of audio (413).
More errors: 400 (unreadable audio), 429 (transcriptions already waiting), 503 (whisper is down or
loading its model, or stt is not configured), 504 (no transcript within max(5 s, 1.5 × the audio
length), e.g. a runaway decode; not retried) and 502 (whisper failed).

App messages reach Claude as `[App message from Arpit, <time>]` (plus ` [voice]` for speech) and
the text on the next line.

## Voice

The flow for a spoken request: record → `POST /v1/stt` → `{text}` → `POST /v1/messages {text, voice: true}`
→ `{ref}` → the turn's events on the stream as usual (the live view shows everything) → `voice.reply` for
that `ref`, which the app speaks with its TTS.

- The `[voice]` tag asks EDITH to open with a 1–2 sentence spoken summary, then the details
  (`server/edith/features/voice/output_style.md`).
- `voice.reply.outcome` is `queued` (it waits for the main lane; a later reply follows), `done`, `failed` or
  `stopped`. Each voice turn gets exactly one of `done`/`failed`/`stopped`, after `turn.done`/`turn.failed`/
  `turn.stopped`.
- `speak` is plain text for TTS: the reply's first paragraph without code, markdown, links, emoji or
  `SEND_FILE`/`REACT` lines, at most 2 sentences and about 300 characters (`"Done."` if nothing in the reply
  is speakable). For `failed`/`stopped`/`queued` it is a short fixed line, e.g. `"Stopped."`.
- The app should speak `speak` and not the full `turn.done.text`. Only the app that sent the message acts on
  it; other clients may ignore `voice.reply`.
