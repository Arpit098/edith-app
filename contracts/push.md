# Push contract (server → ntfy → app)

When the app is closed, nothing holds `/v1/stream`, so edith pushes the news through its own ntfy,
reachable over Tailscale only (PLAN.md, Phase 5). The app keeps one ntfy subscription and shows each
message as a local notification.

## When edith pushes

The `notifications` feature pushes only while **no `/v1/stream` client is connected** (the app
open or held by its foreground service shows the news itself). It follows `app.clients` (contracts/events.md).

| Event | Pushed when | Tag |
|---|---|---|
| `turn.done` | origin `app` | `turn:<ref>` |
| `turn.failed` | origin `app` | `turn:<ref>` |
| `permission.request` | origin not `telegram` (Telegram shows its own) | `perm:<id>` |
| `permission.resolved` | its request was pushed: a `cancel` for `perm:<id>` | `perm:<id>` |
| `reminder.due` | always | `rem:<id>:<due>` (once per due time of a repeating reminder) |

Each tag is pushed at most once (a cancel aside). One worker thread publishes, so the bus never
waits on ntfy. A publish has a 5 s timeout; an unreachable ntfy (or a 5xx/429) is retried after 1 s
and 2 s, then the push is dropped and logged. Approvals go at ntfy priority 4, cancels at 1, the rest at 3.

## Topic and access

- ntfy listens on edith's Tailscale IP, port 2586. Access is deny-all: edith publishes with a
  write-only token, the phone subscribes with a read-only one. Both live in mode-600 files, never in git.
- One topic, `edith` by default (`[adapter.ntfy] topic`).
- The phone subscribes with `GET /<topic>/json?since=<last message id>` (one long-lived stream), so
  nothing is missed across reconnects. ntfy keeps messages 12 h (`cache-duration`).

## Message

The ntfy `message` is one compact JSON object; ntfy's own `title` and `priority` are set too, so a
plain ntfy client still shows something readable. The app reads only the JSON:

```json
{ "v": 1, "tag": "perm:7f3a", "channel": "approvals", "title": "Approve Bash?", "text": "npm test",
  "link": "edith://approvals", "permission": "7f3a" }
```

| Field | Meaning |
|---|---|
| `v` | 1. A higher major version the app doesn't know is shown as title and text only |
| `tag` | The local notification tag (`perm:<id>`, `turn:<ref>`, `rem:<id>:<due>`), the same the app uses when open: a push and a local notification for one thing replace each other |
| `channel` | `approvals`, `replies`, `errors` or `reminders` (the app's channels) |
| `title`, `text` | Ready to show; `text` is a plain one-line preview (at most 300 characters) |
| `link` | Where a tap goes: `edith://live` or `edith://approvals` |
| `permission` | Approvals only: the id. The app adds Allow/Deny that call `POST /v1/permissions/{id}` with its own App API token (no token ever goes through ntfy) |
| `cancel` | `true`: remove the notification with this `tag` (an approval answered or timed out); only `v` and `tag` come with it |
