# Backup AI (server ⇄ app)

When Claude can't answer (its usage limit, a broken login, a billing problem), EDITH first switches to
another saved Claude account that isn't limited (contracts/accounts.md, "Automatic switch at the
limit"). Only when none is free does a free backup AI answer Arpit on Telegram and in the app, until
Claude is back. The backup can only **read and look things up**: it never writes, runs commands,
sends, deploys or restarts. Anything like that goes to Claude's queue.

## Account switch first

1. The agent (claude_tmux) publishes `agent.limit` when Claude writes its own error: a transcript entry
   with `isApiErrorMessage` (`error`: `rate_limit`, `authentication_failed`, `billing_error`), or a side
   lane's `claude -p` error result in Claude's wording. A line older than 15 minutes (a resumed
   conversation) is ignored.
2. The accounts feature marks the account limited, switches to a free one and tells Arpit, or publishes
   `accounts.limit` with `action` `none_free`, `refused` or `switch_failed`.
3. The backup takes over on that `accounts.limit` (anything but `switching`), or straight on
   `agent.limit` when the accounts feature isn't enabled.

## Events

| Type | `data` | Emitted when |
|---|---|---|
| `agent.limit` | `{kind, text, resets, lane}` | Claude's usage limit (`kind` `usage_limit`), login (`login`) or billing (`billing`) error. `resets`: the reset time Claude printed (unix seconds) or `null`; `text` Claude's line (≤ 300 characters, times in IST); `lane` `main` or `side`. Origin `system` |
| `accounts.limit` | see contracts/accounts.md | The accounts feature acted on an `agent.limit` |
| `backup.changed` | `backup` (below) | The mode changed, the backup took over or handed back, a provider answered, or the queue changed. Origin `system` |

`message.assistant` from the live view carries `api_error` (Claude's `error` code) and `at` (the entry's
time) on Claude's own error lines.

## Modes and hand-back

- `auto` (the default): takes over as above; hands back on its own.
- `on`: answers instead of Claude now, until `/backup auto` or `/backup off`. No hand-back checks.
- `off`: never answers; at the limit Arpit is told that messages wait for Claude.

`/backup` shows the state; `/backup on|off|auto` sets the mode (Telegram and the app's typed commands).
The mode and the state live in `<state_dir>/backup/state.json` (folder 700, file 600), so a restart
keeps answering where it was.

**Hand-back.** At Claude's reset time (15 minutes from the takeover when Claude named none) the agent
runs one tiny test turn (`agent.probe()`: `claude -p` with no tools, MCP or saved session). If it works,
the backup stops and Arpit is told; if not, it checks again after 15, 30, then every 60 minutes. A
done account switch while the backup answers makes it check a minute later. Arpit is told at both
ends (`message.system`). If the turn the limit cut off is still open at hand-back, the message says
to `/stop` it and send it again.

## While it answers

Every message meant for Claude is taken before it reaches the agent (`core/divert.py`), from Telegram,
the app and buttons alike:

- `message.user` with `delivery: "backup"`, `lane: "backup"`, then `message.delivered`
  (`delivery: "backup"`, `rid: null`);
- `turn.started` `{ref, lane: "backup"}`, `turn.progress` per tool (`step` is the tool's name);
- `message.assistant` `{text, files: [], lane: "backup", ref}` and `turn.done` `{ref, lane: "backup",
  text, display_text, steps, elapsed, is_error: false, subtype: "success", files: [], reaction: null,
  provider}`. The text starts with the provider's label: `Backup (Nemotron): …`.
- `POST /v1/messages` answers `lane: "backup"`. One message is answered at a time; at most 10 wait
  (more: `turn.failed` `reason: "queue_full"`).
- `/queue <text>` goes straight to Claude's queue (`turn.done`: "📥 Queued for Claude (#id)…").
- When no provider can answer, the message goes to Claude's queue and the reply says why ("Nemotron:
  rate limited until 9:31 PM IST").
- The backup's model sees its own last 10 messages only (never Claude's replies), and no attachment
  contents unless it reads them with its tools.
- `SEND_FILE:`/`REACT:` lines in its answer are dropped: the backup sends no files.

**Claude's queue.** Things the backup won't do (the model calls `queue_for_claude`, or `/queue`) are kept
(at most 20). At hand-back each comes to Arpit as a `message.system` with two buttons:
`Send to Claude` (`bk:send:<id>`: sent to Claude as a new message, with Arpit's original text) and
`Drop` (`bk:drop:<id>`).

## Providers

All speak the OpenAI chat-completions API, so one adapter (`adapters/llm/openai_compat`) covers them;
tests use a fake (`tests/fakes/llm.py`). Tried in this order:

| Name | Label | API | Model | Key file |
|---|---|---|---|---|
| `nemotron` | Nemotron | `https://integrate.api.nvidia.com/v1` | `nvidia/nemotron-3-super-120b-a12b` | `~/.config/edith/nvidia-key` |
| `gemini` | Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-flash-latest` | `~/.config/edith/gemini-key` |
| `mistral` (on hold) | Mistral | `https://api.mistral.ai/v1` | `mistral-medium-latest` | `~/.config/edith/mistral-key` |

Key files are mode 600; a missing one, or one others can read, switches that provider off. Keys are
read per call, sent only in the `Authorization` header, and never logged, stored elsewhere or returned.

**Skip and retry** (`<state_dir>/backup/skips.json`, so a restart keeps them):
- 429: skip until `Retry-After` (seconds or a date; Gemini's `retryDelay` too); with none, until the
  provider's daily reset when its daily quota is gone (Gemini: midnight Pacific; others: midnight UTC),
  else for 60 s;
- down or slow (timeout, connection error, 5xx, an unreadable answer): one retry at once, then the next
  provider; 3 such failures in a row skip it for 10 minutes; a success clears the count;
- key refused (401/403): skip for an hour; another 4xx: next provider.

A message that starts on one provider keeps using it; if it fails mid-answer the next one carries on
the same conversation, and the label names the one that gave the answer.

## Tools (read-only)

At most 8 tool uses per message (more in one reply are refused), each with a time limit (20 s; 15 s
for the web), and 4 minutes for the whole answer. No shell.

| Tool | What |
|---|---|
| `read_file {path, start_line?, max_lines?}` | A text file (≤ 256 KB read, ≤ 500 lines shown) |
| `list_dir {path}` | A folder; blocked entries are left out |
| `grep {text, path}` | Plain text, case-insensitive; ≤ 4000 files, ≤ 60 hits |
| `service_status {unit}` / `service_logs {unit, lines?}` | `systemctl --user status` / `journalctl --user -u` (≤ 200 lines) of units named `edith…`; log lines of the mail, calendar and Google parts are dropped |
| `system_info` | Disk, memory, load, uptime |
| `edith_status` | `GET /v1/status` |
| `web_search {query}` / `fetch_url {url}` | DuckDuckGo results; a public http(s) page as text (≤ 512 KB). Loopback, private, link-local, CGNAT/Tailscale and metadata addresses are refused, redirects included |
| `queue_for_claude {task}` | Puts a task in Claude's queue |
| EDITH's tools (below) | |

**EDITH's tools** (`~/edith/bin`) are a registry in `server/edith/features/backup/tools.py`,
`BIN_TOOLS`: one line each with the tool name, the argv template, a pattern every argument must fully
match, and a read-only flag. Only read-only entries are offered; each runs as `python3 -I <script> …`
with no shell, a 20 s timeout and a small environment (HOME, PATH, LANG, TZ). Today:

| Tool | Runs | Arguments |
|---|---|---|
| `reminders_list` | `remind.py list` | |
| `project_changes {project}` | `changes.py <project>`: the summary only (the HTML diff stays on the server; its path may be mentioned) | `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` |
| `agents_status` | `agent.py status` | |

Never offered: `remind.py add/cancel`, `agent.py send/compact/watch/read`, or anything else that
changes state; such requests go to Claude's queue. Adding a tool is one `BinTool(...)` line.

**Paths.** Only under `~/edith`, `~/Projects` and the inbox. Both the path as written (`..` collapsed,
`~`/`$HOME` expanded; relative paths are under `~/edith`) and its real path (every symlink followed)
must pass, and a file is opened with `O_NOFOLLOW`. Blocked anywhere: `~/.config`, `~/.claude`, `~/.ssh`,
every dot-file and dot-folder (`.git` and `.env*` included) except `.github`, `.gitignore`,
`.editorconfig` and a few like them, names with key, token, secret, credential, password, cookie,
oauth or auth as a word, certificates and keystores (`.pem`, `.key`, `.p12`, `.jks`, …), SSH keys,
`.sqlite`/`.db` files, `~/edith/google` (mail and calendar), the state folder (the message log) and the
Telegram folder.

## Privacy

Both free providers may train on what they get. **Mail and calendar never go to a provider**: no tool
reads them, their log lines are dropped, and the model's history is the backup's own conversation.
Everything sent out (the prompt, the history, every tool result, tool-call arguments, web queries)
goes through `features/backup/redact.py` at one place, just before the call: PEM and PuTTY key
blocks, `.env`-style `*_KEY=`/`*_TOKEN=`/`*_SECRET=`/`*_PASSWORD=` values, `key=`/`token=`/`sig=` URL
parameters, `user:pass@` in URLs, known key shapes (`nvapi-`, `sk-`, `sk-ant-`, `ghp_`, `xox…-`, `AIza`,
`ya29.`, `1//`, `AKIA`, `GOCSPX-`, `glpat-`, `hf_`, JWTs, bot tokens…), long hex and base64 runs,
high-entropy words of 24+ characters, and paths into `~/.config`, `~/.claude`, `~/.ssh` and similar,
are replaced by `[redacted]` or `[blocked path]`.

## API

Bearer token like every App API route.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/v1/backup` | | `backup` |
| POST | `/v1/backup` | `{mode: "auto" \| "on" \| "off"}` | `backup`; 400 for another mode, 409 for `on` with no provider set up |

`backup`:

```json
{ "mode": "auto", "active": true, "since": 1793351234.5, "reason": "usage_limit",
  "resets": 1793369234.0, "next_check": 1793369234.0, "provider": "Nemotron", "queued": 1,
  "providers": [{ "name": "nemotron", "label": "Nemotron", "available": true, "skipped_until": null, "why": null }] }
```

`reason`: `usage_limit`, `login`, `billing` or `manual` (`/backup on`); `provider` the label of the last
one that answered; `next_check` when Claude is tested next (`null` when not answering, or `on`);
`skipped_until` a unix time while a provider is skipped, `why` its reason (`rate limited`, `daily quota
used up`, `key refused`, `3 failures in a row`).
