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
| `command.reply` | `{ref, text, buttons}` | A command or button the app used answers later (e.g. a conversation switch); `ref` is the one its request returned |

| `turn.retrying` | `{ref, lane, reason}` | A turn starts over (a side lane whose conversation is gone runs again fresh); frontends drop that turn's status message |
| `voice.turn` | `{ref}` | The App API accepted a `POST /v1/messages` with `voice: true` (sent before the turn's own events). Origin `app` |
| `voice.reply` | `{ref, outcome, speak}` | What the app says aloud for that voice turn (see "Voice" below). Origin `app` |

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
- Live view on open: connect `/v1/stream` first (buffer events), then fetch the newest page, then
  apply buffered events whose `cursor` is not in that page. After a reconnect: `after=<last cursor>`
  until `more` is false.

## App API (v1)

Base `http://<edith's Tailscale IP>:8787`, reachable over Tailscale only. Every request carries
`Authorization: Bearer <token>`; without it: `401 {"error": "unauthorized"}`. Errors are
`{"error": "<message>"}` with 400, 404, 405, 413 (body too large) or 429. JSON in and out.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `/v1/messages` | `{text, voice?: bool, queue?: bool, attachments?: [id]}` | `{ref, lane}`; the turn's events then arrive on the stream with this `ref`. `attachments`: ids from `POST /v1/attachments` (contracts/attachments.md) |
| POST | `/v1/attachments` | the raw file (image or audio), `x-filename?` | `{id, name, type, size, sha256}` (contracts/attachments.md) |
| GET | `/v1/stream` | WebSocket | every event above as one JSON text message `{type, ts, session_id, origin, data}`; the server pings every 25 s (protocol ping) when the line is quiet. The app may send `{"type": "ping", "id"?: any}`; the answer is `{"type": "pong", "ts", "session_id": null, "origin": "system", "data": {"id"?}}` (`id` echoed). Any frame from the app counts as alive; three quiet periods without one and the server drops it. Other text from the app is ignored |
| POST | `/v1/stop` | | `{running, dropped: [ref]}` |
| GET | `/v1/status` | | `{main: busy/idle, queued, runs: [{ref, lane, seconds, step}], tmux: running/down, conversation: bool, session: {id, title} \| null}` |
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
