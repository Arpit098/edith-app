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
