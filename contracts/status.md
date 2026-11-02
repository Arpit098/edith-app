# Status details (server ⇄ app)

The app's status panel (the bar under the Live header, and the card it opens). The bar itself is kept
up to date from stream events (contracts/events.md, "Working state", `lane.status` and
`background.changed`); the card also fetches the details below, only while it is open and the app is
on screen (every 10 s).

`GET /v1/status/details`, read-only, with the bearer token like every App API route. `GET /v1/status`
also carries `background` (below) and `subagents` (below, without `last`), and the answer to
`POST /v1/stop` carries `background` (what a stop leaves running).

```json
{
  "ts": 1793351234.5,
  "edith": {
    "state": "tool", "tool": "Bash", "step": "$ npm test", "since": 1793351190.2,
    "ref": "a1b2c3", "turn_started": 1793351101.0, "tmux": "running",
    "background": [
      { "id": "toolu_014w…", "kind": "shell", "label": "Wait for PR 41 CI to finish", "started": 1793444774.3 }
    ],
    "subagents": [
      { "id": "toolu_01Ey…", "description": "Review PR 61", "type": "general-purpose", "model": "claude-opus-5-5",
        "effort": "medium", "background": true, "state": "running", "started": 1793444780.1, "ended": null,
        "last": "$ gh pr diff 61" }
    ]
  },
  "lanes": {
    "side": [{ "ref": "d4e5f6", "seconds": 42, "step": "Read: server/x.py", "summary": "check the disk" }],
    "max_side": 2, "queued": 2, "approvals": 1
  },
  "session": {
    "id": "8268e354-…", "title": "Phase 2 app", "started": 1793290000.0,
    "messages": 157, "context_tokens": 320562
  },
  "agents": [
    { "name": "edith-dev", "dir": "edith-app", "branch": "release-notes",
      "state": "busy", "blocked": null, "last": "Running the tests on release-notes…", "background": null }
  ],
  "server": { "tag": "p1-live-7", "started": 1793300000.0, "uptime": 51234 }
}
```

Times are unix seconds; `ts` is the server's time when it answered (for elapsed times, use it rather
than the phone's clock).

**`edith`**: the main lane.
- `state` is one of the "Working state" names: `idle`, `thinking`, `tool` (a tool is running),
  `waiting_approval`, or `waiting`: no turn runs, but work a turn started in the background still
  does (`background` isn't empty). `since` is when that state began (for `waiting`, when the turn
  ended; `null` if nothing happened since the bridge started). It covers turns the bridge runs (app,
  Telegram, `/queue`); a turn typed straight into tmux shows as `idle` (or `waiting`).
- `tool` is the tool's name (`Bash`, `Edit`, …; for `waiting_approval`, the tool asking), or `null`.
  `step` is the tool summary (`$ npm test`), or `null`.
- `ref` is the running turn's ref (`null` when idle); `turn_started` when that turn began.
- `tmux` is `running` or `down` (the interactive Claude's tmux session).
- `background`: see "Background". Listed whatever the state (a running turn can have some too).
- `subagents`: see "Subagents". A running one also makes an idle main lane `waiting`.

**Background.** A turn can end, its reply sent, while work it started goes on: a Bash command or an
Agent (subagent) Claude ran with `run_in_background`, or an Agent call without it that Claude Code ran
async (its default now: the tool_result says `async_launched`), which reports back later and may
start a turn of its own then. Each job: `id` (its tool_use id, stable), `kind` (`shell` or `agent`), `label`
(Claude's description of it, else the command or prompt's first line, at most 80 characters) and
`started` (`null` if unknown); oldest first. Read from the conversation's transcript as it grows (the
tool_use, its result, and the `<task-notification>` that ends it; a TaskStop of it ends it too), and
from the transcript's last 2 MB when the bridge starts. Claude's own session file
(`~/.claude/sessions/<pid>.json`) has the last word, checked at most every 15 s while jobs run: once it
says `idle` after a job started, that job is over (a missed notification); with no Claude running the
conversation there are none. Changes come as `background.changed` events (contracts/events.md).
`POST /v1/stop` ends turns, not background work: its answer's `background` is what still runs.
A job's `started` is on the server's clock, so the app ages it on that clock too: `GET /v1/status` and
`POST /v1/stop` answer with `ts` (the server's time, unix seconds), and every stream event has its `ts`; the
app keeps the difference from its own clock, never comparing `started` with the phone's time directly.

**Subagents.** Every Agent call of the main session (Claude Code's in-session subagents, foreground or
background; not the tmux coding agents under `agents`), oldest first: the running ones and those that
ended in the last 30 minutes (so the app can show ✓ or ✗ before they fade).
- `id` is the Agent tool_use id (stable; a background one's id is also its `background` job's `id`).
- `description` is Claude's description of it (at most 80 characters; "Agent" if none); the prompt is
  never sent. `type` its `subagent_type` (`general-purpose` if none given); `model` the model asked
  for, else the one Claude Code resolved (`null` if unknown); `effort` the effort asked for, or `null`.
- `background`: `true` if it runs in the background, `false` if Claude waits for its answer, `null`
  until known.
- `state`: `running`, `done`, `failed` or `stopped`, from its tool_result (a foreground one's answer;
  an error result: `failed`, or `stopped` if interrupted), its `<task-notification>` (`completed`,
  `failed`, `stopped`/`killed`) or a TaskStop of it. Claude's session file has the last word, as for
  background jobs: once it says `idle` after one started, or no Claude runs the conversation, a
  running one is `stopped` (ended then), or `done` if its `agent-<agentId>.meta.json` says
  `"finished": true`. `<task-notification>` fields are read from its header only (before
  `<summary>`/`<result>`, whose text may quote the tags).
- `started` and `ended` are unix seconds on the server's clock (`ended` is `null` while it runs).
- `last` is a running one's latest step from its own transcript (`~/.claude/projects/<project>/<session
  id>/subagents/agent-<agentId>.jsonl`, found through the `agent-<agentId>.meta.json` next to it for a
  foreground one): its latest step, made safe to show: a shell command by its description, else only
  its program (`$ npm`, never the arguments); another tool as `Read: x.py`, `WebFetch: <url>` with
  any URL's query string and fragment removed; its own free text only as `Writing…`; then redacted;
  at most 100 characters. `null` when finished or unknown. Read only while it runs, and only when
  that file changed (a last line too long to read keeps the step before it).
- A switch to another conversation starts the list afresh (a resumed one is seeded from its own
  transcript's last 2 MB, like the background jobs).
Changes come as `subagents.changed` events (contracts/events.md), without `last`; the expiry after
30 minutes sends no event (the app fades a finished one itself, on the server's clock).

**`lanes`**: `side` lists the running side lanes (oldest first), each with its `ref`, `seconds` running,
latest `step` (`null` while thinking) and `summary`, the first line of the message it runs (at most 80
characters; `null` if unknown). `max_side` is how many may run; `queued` the messages waiting for the
main lane; `approvals` the pending permission prompts (all lanes).

**`session`**: the current conversation, or `null` if there is none. `started` is its first entry's
time, `messages` the user prompts plus replies with text (tool calls and results not counted), and
`context_tokens` the size of the latest prompt (input plus cached tokens), which is how full the
context is. `started`, `messages` and `context_tokens` may be `null`.

**`agents`**: the coding agents, one per tmux session on the server's default tmux socket, sorted by
name (`[]` when tmux isn't running or the list is turned off). Read from each session's active pane,
at most once per 5 s however often the app asks (read-only: `capture-pane`, never keys), and from
the pane's Claude's session file.
- `dir` is the pane's working folder (last part only) and `branch` the git branch checked out there
  (a short sha when detached; `null` outside a repo).
- `state`: `busy` ("esc to interrupt" on screen), `idle`, `blocked`, or `waiting` (at its input box,
  but its session file says it still works: background work); `blocked` says why: `permission` (a
  permission prompt waits) or `usage_limit`, else `null`.
- `background` is that session file's status while `waiting` (`shell`, `busy`…), else `null`.
  (The agents' jobs aren't listed one by one: that would mean reading every agent's transcript.)
- `last` is the last "●" line on screen (Claude's latest message or tool), without ANSI codes and
  box-drawing characters, at most 100 characters; `null` if none is on screen.

**`server`**: `tag` is `git describe --tags --always --dirty` of the live checkout (`null` if unknown),
`started` and `uptime` (seconds) are the bridge process's. `edith.tmux` is checked at most once per 5 s.

**Redaction:** free text (`step`, `summary`, `title`, `last`, a background job's `label`, a subagent's
`description` and `last`) has anything
that looks like a secret replaced by `[redacted]`: `key=value` / `key: value` pairs for token, secret,
password, api key, access token and the like (also as a suffix: `DB_PASSWORD=…`, `GITHUB_TOKEN=…`),
`Bearer …` and `Basic …`, the `user:pass@` of a URL, known key prefixes (`sk-`, `ghp_`, `xox…-`,
`AIza…`, `ya29.`, AWS `AKIA…`), JWTs (`eyJ….…`), Telegram bot tokens and long mixed letter-and-digit
strings (32+ characters, which also catches full git shas and uuids). (`GET /v1/status`, `POST
/v1/stop`, `background.changed` and `subagents.changed` carry labels and descriptions as they are,
like the stream's `tool.call` summaries.)
