# Claude accounts (server ⇄ app)

Settings → Claude accounts: the Claude logins saved on the server, which one is in use, and switching
EDITH and the coding agents to another one, adding one and removing one (PLAN.md §4.12). Every route
needs the bearer token like the rest of the App API.

**Secrets:** the API never returns a token. An account is only `{id, label, email, plan, active}`.
The logins live in `~/.config/edith/claude-accounts/<id>/` (folders 700, files 600): a copy of
Claude Code's `~/.claude/.credentials.json` and the `oauthAccount` block of `~/.claude.json` that goes
with it. Tokens are copied file to file only; they never reach the API, logs, the audit log, tmux or git.

## Routes

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/v1/accounts` | | `{accounts: [account], switch: switch \| null, login: {id, url} \| null}` |
| POST | `/v1/accounts/{id}/switch` | | `{status: "switching", run}`; progress arrives as `accounts.switch` events. 409 `{error}` when it can't start now (below), 404 for an unknown id, 503 if the switch couldn't be started |
| POST | `/v1/accounts/login` | | `{id, url}`: a sign-in started (any earlier unfinished one is cancelled). 502 `{error}` if Claude's login gave no link |
| POST | `/v1/accounts/login/{login}` | `{code, label?}` | `{account}`, the saved account (the same account signed in again updates its profile). 400 `{error}` with Claude's own message for a wrong or expired code (the sign-in is then over; a code that doesn't even look like one keeps it open), 404 if it has expired |
| DELETE | `/v1/accounts/login/{login}` | | `{cancelled: bool}` |
| DELETE | `/v1/accounts/{id}` | | `{removed: id}`; 409 for the account in use or while a switch runs, 404 for an unknown id |

`account`: `{id, label, email, plan, active}`. `id` is 8 hex characters; `label` is what Arpit typed
when adding it, else the account's name; `plan` is Claude's subscription type (`pro`, `max`, …) or
`null`; exactly one account is `active` when Claude is logged in. The login in use the first time the
list is read is saved as an account, so there is always one to switch back to. Sorted: the active one
first, then by label.

`login.url` is Claude's sign-in page. Arpit opens it on the phone, signs in, and the page shows a code
to paste back. The server runs Claude's own `claude auth login` with a private config folder (the live
login is never touched); the code goes to its input. A sign-in left open expires after 10 minutes.

## Switch

A switch moves every Claude on the server to the chosen account: the coding agents (each Claude in a
tmux pane on the default socket) and EDITH herself (edith-claude). The chat drops for about 30 s.

**Only when idle.** Otherwise 409 with `error` saying why, e.g. `Can't switch while edith-dev is
busy; 2 messages queued`. The reasons: EDITH is working on a task, parallel tasks are running, messages
are queued, an approval is waiting, an agent is busy or waiting for approval (each named), EDITH's own
Claude is busy with background work, another Claude is running outside tmux, a switch is already
running, or the account is already in use. Busy is read from each Claude's own session file
(`~/.claude/sessions/<pid>.json`): anything but `idle` counts as busy, background subagents and shells
included. A Claude whose process isn't named `claude` blocks too (it can't be checked). An agent that
only hit its usage limit doesn't block. The switch checks all of this again
right before it stops anything, and ends `failed` (nothing changed) if it no longer holds.

**While it runs** EDITH takes no new work: messages from the app and Telegram wait in her queue (each
gets `turn.queued`) and run in order once the switch has ended, however it ended.

**Steps** (`step`), in order: `starting` (accepted), `stopping` (every agent's Claude, then
edith-claude), `saving` (the old account's refreshed credentials back into its profile), `installing`,
`starting_edith` (edith-claude alone, resuming her conversation, until her input box shows: if the
token needs a refresh, she does it on her own, and it is saved), `starting_agents` (each pane again
in its folder, resuming its conversation; one with no known conversation starts a fresh one),
`checking` (the live credentials are still the account's, Claude reports the new account, and every
Claude reaches its input box without a login error, within 90 s). If installing or anything after
fails, it does `rolling_back`: everything is stopped and started again on the old account. Whatever
happens, edith-claude is started again and every stopped agent restarted at the end.

The switch runs on its own (a transient systemd unit), so it finishes even though it restarts
EDITH's Claude, and even if the bridge restarts. The app's stream drops while it runs; after
reconnecting, the app reads `switch` from `GET /v1/accounts` to show where it is.

`switch` (in `GET /v1/accounts`, and the `data` of each `accounts.switch` event):

```json
{ "run": "a1b2c3d4", "target": "9f8e7d6c", "previous": "01234567", "state": "running",
  "step": "starting_agents", "detail": null, "started": 1793351234.5, "ts": 1793351240.1,
  "agents": ["edith-app", "edith-dev"] }
```

- `state`: `running`, then `done`, `rolled_back` (the new account didn't come up; the old one is back;
  `detail` says why) or `failed` (`detail` says why; also when a switch stopped before finishing).
- `previous` is the account switched from (`null` until it is known, at `saving`). `agents` are the
  tmux sessions being restarted.
- A finished switch stays in `GET /v1/accounts` for an hour; `null` when there was none.

## Event

| Type | `data` | Emitted when |
|---|---|---|
| `accounts.switch` | `switch` (above) | A switch starts, moves to another step, and ends. Origin `system` |
