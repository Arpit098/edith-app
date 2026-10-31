# Push contract (server → ntfy → app)

When the app is closed, nothing holds `/v1/stream`, so edith pushes the news through its own ntfy,
reachable over Tailscale only (PLAN.md, Phase 5). The app keeps one ntfy subscription and shows each
message as a local notification.

## When edith pushes

The `notifications` feature pushes only while **the app isn't connected** (update alerts aside, below) (the app open, or held by
its foreground service, shows the news itself). It asks the App API at push time, on its worker
thread: only clients that connected as `/v1/stream?client=app` count (a tool on the stream doesn't
silence pushes), and one not heard from in the last 2 s gets a protocol ping and counts only if it
answers within 3 s, so a half-open socket (a phone asleep or off the network) never holds a push back.

| Event | Pushed when | Tag |
|---|---|---|
| `turn.done` | origin `app` | `turn:<ref>` |
| `turn.failed` | origin `app` | `turn:<ref>` |
| `permission.request` | origin not `telegram` (Telegram shows its own) | `perm:<id>` |
| `permission.resolved` | its request was pushed: a `cancel` for `perm:<id>` | `perm:<id>` |
| `reminder.due` | always | `rem:<id>:<due>` (once per due time of a repeating reminder) |
| `app.update_available` | always, **even while the app is connected** (it may not check for hours); off with `[features.notifications] update_alerts = false` | `update:<kind>:<id>` (`update:ota:<update id>`, `update:apk:<versionCode>`) |

Each tag is pushed at most once (a cancel aside), and counts as pushed only once ntfy took it: a
publish that failed, or one skipped because the app was there, can go when the next event with that
tag comes. An approval answered before its push went out is never sent. One worker thread publishes, so the bus never
waits on ntfy. A publish has a 5 s timeout; an unreachable ntfy (or a 5xx/429) is retried after 1 s
and 2 s, then the push is dropped and logged. Approvals go at ntfy priority 4, cancels at 1, the rest at 3.
Update alerts go at priority 3 with the ntfy tag `arrow_up` (only plain ntfy clients show it).

Update alerts (`app.update_available`):

| Kind | Title | Text |
|---|---|---|
| `ota` | `EDITH update ready` | the event's `summary` (first 3 `New:`/`Fix:` items), else `Restart EDITH to use it.` |
| `apk` | `New EDITH app version` | the event's `summary`, else `Install it from Settings → Updates.` |

Both link to `edith://settings/updates` and use the channel `updates`. Apps whose native push code
predates that channel show them on the replies channel (an unknown channel falls back to it).

## Topic and access

- ntfy listens on edith's Tailscale IP, port 2586. Access is deny-all: edith publishes with a
  write-only token, the phone subscribes with a read-only one. Both live in mode-600 files, never in git.
- One topic, `edith` by default (`[adapter.ntfy] topic`).
- The phone's token is handed to the app by edith (below); it is never pasted by hand unless
  Settings → Push → Advanced is used (the fallback, e.g. for an older edith).

## Turning it on

Settings → Push → **Turn on** calls `GET /v1/push/config` with the app's App API bearer token (like every
route; 401 without it) and gets what the phone subscribes with:

```json
{ "url": "http://100.78.124.98:2586", "topic": "edith", "token": "tk_…" }
```

| Field | Meaning |
|---|---|
| `url` | edith's ntfy over Tailscale (`[adapter.ntfy] url`) |
| `topic` | The topic to subscribe to (`[adapter.ntfy] topic`) |
| `token` | The phone's **read-only** token, read from `[adapter.ntfy] phone_token_file` (default `~/.config/edith/ntfy-phone-token`, mode 600) each time it is asked for |

- Only the subscribe-only token is ever returned. The publish token never is: a phone token file that
  is the publish token file, or holds the same token as the publish file or the publish token edith
  last used, is refused (503). So is any request while the publish token file can't be read (missing
  or not mode 600), since the phone token can't then be checked against it.
- 404 `{error}`: no ntfy notifier is configured. 503 `{error}`: the phone token file is missing, open to
  others (not mode 600) or not exactly an ntfy token (`tk_` and 29 letters or digits, the shape the app
  accepts). Neither error carries the token.
- The answer has `Cache-Control: no-store`. The token never appears in edith's logs or the audit log
  (the audit line is `{path, status, "push": "config"}`), and status text redacts `tk_…` tokens.
- The app hands the token straight to the native push service, which keeps it encrypted with an
  Android Keystore key (as it does a pasted one); it is never shown or kept in the app's JS state.
- The phone subscribes with `GET /<topic>/json?since=<last message id>` (one long-lived stream), so
  nothing is missed across reconnects. ntfy keeps messages 1 h (`cache-duration`).
- In the 15-minute check mode (Settings → Push) there is no stream: a periodic job fetches
  `GET /<topic>/json?poll=1&since=<last message id>` and shows what came. Android may stretch the
  period in deep sleep; anything older than the 1 h cache is then gone (the always-on mode doesn't
  have this gap).

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
| `tag` | The local notification tag (`perm:<id>`, `turn:<ref>`, `rem:<id>:<due>`, `update:<kind>:<id>`), the same the app uses when open: a push and a local notification for one thing replace each other |
| `channel` | `approvals`, `replies`, `errors`, `reminders` or `updates` (the app's channels) |
| `title`, `text` | Ready to show; `text` is a plain one-line preview (at most 300 characters) |
| `link` | Where a tap goes: `edith://live`, `edith://approvals` or `edith://settings/updates` (`edith://<screen>/<settings page>`) |
| `permission` | Approvals only: the id. The app adds Allow/Deny that call `POST /v1/permissions/{id}` with its own App API token (no token ever goes through ntfy) |
| `cancel` | `true`: remove the notification with this `tag` (an approval answered or timed out); only `v` and `tag` come with it |
