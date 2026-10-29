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
| `tool.call` | `{name, summary}` | Claude starts a tool (e.g. `Bash: npm test`) |
| `tool.result` | `{name, ok, summary}` | A tool finishes |
| `file.diff` | `{path, diff}` | A file is edited |
| `turn.started` | `{ref}` | A main-lane turn begins |
| `turn.done` | `{ref, text, steps, elapsed}` | A main-lane turn ends with a reply |
| `turn.stopped` | `{ref}` | A turn is interrupted |
| `permission.request` | `{id, tool, detail}` | Claude needs approval |
| `permission.resolved` | `{id, decision}` | Approved, denied or timed out |
| `session.changed` | `{session_id, title, source}` | New, resumed or cleared session |
| `lane.status` | `{main: idle/busy, side: n, queued: n}` | Lane state changes |
| `turn.queued` | `{ref, position}` | A message waits for the main lane (all lanes busy, or `/queue`) |
| `turn.progress` | `{ref, lane, steps, step, elapsed}` | A running turn moves on (`step` is the latest tool summary, e.g. `$ npm test`) |
| `turn.failed` | `{ref, reason, detail}` | A turn ends without a reply. `reason`: `not_ready`, `crashed` or `error` |
| `reminder.due` | `{id, text, every, due, late}` | A reminder fires. `due` is a unix time; `late` is true if it fired over 2 minutes late |
| `message.system` | `{text, buttons}` | A feature has something for Arpit that isn't a reply to a turn (a reminder, the crash notice). Frontends show it; Telegram sends it to the first allowed chat |

| `turn.retrying` | `{ref, lane, reason}` | A turn starts over (a side lane whose conversation is gone runs again fresh); frontends drop that turn's status message |

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
