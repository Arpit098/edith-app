# Phase 1 plan: server

_Approved by Arpit 2026-10-29. App API stack: standard library (decided 2026-10-29)._

Goal (PLAN.md §6): rebuild the live EDITH code in `server/legacy/` as features and adapters in
`server/edith/`, add the App API, whisper.cpp and Tailscale, and run the live Telegram bot from this
repo. **Telegram must work exactly the same at every step.**

## How the migration stays safe

1. **Replace one piece at a time, using wrappers.** Today EDITH (`CLAUDE.md`, its memory, the
   quick-action prompts) and the guard hook (`~/.claude/hooks`, which asks before `gmail.py send` /
   `gcal.py create|delete`) call tools by fixed paths: `~/edith/bin/remind.py`,
   `~/edith/google/gmail.py` and so on. Each of those files becomes a few lines that run the repo
   code, and it **keeps its path, arguments and output**. Nothing that calls them changes,
   including the guard hook, which is never edited.
2. **State files keep the same format.** The new code reads and writes the same `~/.cache/edith/`
   files the bridge uses (`bridge-state.json`, `tmux-session.json`, `tmux-events.jsonl`,
   `tmux-run`, `perms/`, `reminders.json`) and the same Telegram `callback_data` strings
   (`rem:…`, `perm:…`, `sess:…`, `quick:…`). Buttons on old messages keep working after the
   switch, and **rolling back is always just pointing back at the old file**.
3. **Live code runs from a pinned deploy checkout, not the dev repo.** A separate clone at
   `~/edith-app-live`, checked out at a release tag (`p1-step1`, `p1-step2`, …). Switching branches
   in the dev repo never changes what is live. Deploying a step means checking out its tag, and
   rolling back means checking out the previous tag.
4. **The bridge itself (one Telegram poller) switches over once** (step 6), after the new code
   has passed a full run on a **separate test bot** with a separate tmux session.
5. **Backups before every live change** go to `~/edith-backups/p1-stepN/`. Each step below lists
   its rollback command.
6. **Per step:** a few commits on the `phase-1` branch (all of Phase 1 is one PR) → `make test`
   before each commit → I tag the step's last commit and push the tag → I send the change list →
   Arpit says "yes" → I deploy that tag and verify → I remove that piece from `server/legacy/` in
   the next step's commits.

Golden tests: before a piece is rewritten, I record what the legacy code outputs for fixed inputs
(CLI output, Telegram API calls made, files written). The new code must match it exactly. These
tests stay in the repo after `legacy/` is gone.

---

## Step 0: groundwork (repo only, nothing live changes)

**Repo**
- `contracts/events.md`: add what the migration needs, before any code.
  - Reply buttons: a generic `{label, action}`, where `action` is today's `callback_data` string.
  - `ctx.add_action(prefix, handler)` for button presses.
  - New events: `turn.progress {ref, steps, step, elapsed}`, `turn.queued {ref, position}`,
    `turn.failed {ref, reason}` and `reminder.due {id, text, every, late}`.
- `server/edith/core/`: button and action support in `Context`/`Registry`, `Ports` for `mail` and `calendar`.
- `server/edith/ports/`: `mail.py`, `calendar.py`.
- `server/edith/common/paths.py`: one place for `~/.cache/edith/…`, `~/edith/…` paths, all
  overridable from config and env (needed so staging can run against separate dirs).
- `server/tests/fakes/`: a fake Telegram API (records calls), a fake tmux and a fake `claude -p`.
- `server/tests/golden/`: golden-output harness.
- `deploy/README.md`: deploy checkout, tags, backup and rollback conventions.

**Live:** nothing. **Test:** `make test`. **Rollback:** n/a.

## Step 1: reminders

**Repo**
- `server/edith/features/reminders/`:
  - `store.py`: from `legacy/edith/bridge/reminders.py`, with the same JSON, lock file and IST rules.
  - `cli.py`: from `bin/remind.py`, with the same arguments and output.
  - `__init__.py`: the feature (`/reminders`, Cancel/Snooze/Done actions, firing via `reminder.due`).
    It is used from step 6; until then the legacy bridge imports `store.py` through the wrapper.
- `deploy/shims/edith/bridge/reminders.py` and `deploy/shims/edith/bin/remind.py`: wrappers that put
  `~/edith-app-live/server` on `sys.path` (they work with and without `python3 -I`) and re-export
  or call the repo code.
- Tests: `next_due` (month ends, weekdays), snooze/done/cancel, `pop_due`, CLI golden output,
  `/reminders` rendering against the fake Telegram API.

**Live (needs "yes")**
- `git clone` the repo to `~/edith-app-live` and check out tag `p1-step1`. This is new and touches
  nothing existing.
- Back up `~/edith/bridge/reminders.py` and `~/edith/bin/remind.py`, then replace them with the wrappers.
- `systemctl --user restart edith-bridge`, because the bridge imports `reminders` at startup.
  About 5 s of Telegram downtime, done when `/status` shows idle.

**Verify**
- `remind.py list` output is identical before and after.
- Add `+2m test` → it fires on Telegram with buttons → Snooze +15m works → cancel it.
- `/reminders` looks the same as before.

**Rollback:** `cp ~/edith-backups/p1-step1/{reminders.py,remind.py}` back to their places, then `systemctl --user restart edith-bridge`.

## Step 2: changes

**Repo:** `features/changes/` (`report.py` from `bin/changes.py`, plus the `/changes` command for
step 6), and the wrapper `deploy/shims/edith/bin/changes.py`. Golden test on a temporary git repo
with modified, added, deleted and untracked files: the text summary and the HTML.

**Live (needs "yes"):** back up `~/edith/bin/changes.py`, swap in the wrapper, and `git checkout p1-step2` in
the deploy clone. **No restart**, because EDITH runs it fresh each time.

**Verify:** the old and new outputs for `changes.py edith` are the same, apart from the timestamp. Then "show changes" on Telegram.

**Rollback:** `cp ~/edith-backups/p1-step2/changes.py ~/edith/bin/changes.py`.

## Step 3: Google adapter, mail and calendar

**Repo**
- `server/edith/adapters/google/`:
  - `auth.py`: from `google/auth.py` + `gauth.py`, with tokens still in `~/.config/edith-google/`.
  - `gmail.py` and `gcal.py`: implement the new ports. `api.py`: retries and batching. `login.py`: the `auth.py` login.
  - `requirements.txt`: the Google libraries (already installed in `~/edith/venv`, so nothing new is installed).
- `features/mail/` and `features/calendar/`: `cli.py` with the same commands and output as
  `gmail.py` / `gcal.py`. They get the adapter through `ctx.ports` / `load_adapter`, never by
  importing it, which `test_isolation.py` checks.
- Wrappers `deploy/shims/edith/google/{gmail,gcal,auth,gauth}.py`. They are run as
  `~/edith/venv/bin/python gmail.py …` from `~/edith/google`, the same as today.
- Tests use a fake Google service: unread/search/read formatting, HTML-to-text, reply threading
  headers, the agenda across time zones and all-day events, create/delete request bodies. No real
  Google calls run in tests.

**Live (needs "yes"):** back up the four files in `~/edith/google/`, swap in the wrappers, and check out `p1-step3`.
**No restart.**

**Verify:** read-only commands compared side by side: `gmail.py unread 5`, `gcal.py today` and
`week`, and `auth.py status`. Outputs go to a scratch dir, and I report only whether they match, not
their content. Then `/mail` and `/today` on Telegram. Send, create and delete are not exercised live.

**Note:** EDITH's memory says the Google token is in Testing mode and expires around 2026-11-03.
If it has expired, Arpit re-runs the login over Telegram (`auth.py url` / `finish`), the same as today.

**Rollback:** `cp ~/edith-backups/p1-step3/*.py ~/edith/google/`.

## Step 4: Claude agent adapter (tmux main lane, side lanes, hooks, permission relay)

**Repo**
- `server/edith/adapters/agents/claude_tmux/`:
  - `tmux.py`: ready check, paste, Esc, respawn.
  - `transcript.py`: JSONL tailing. All Claude Code format parsing goes here (PLAN.md §8).
  - `lanes.py`: main lane plus up to 2 side lanes, the queue, side notes and `/queue`, the same rules as `dispatch()`.
  - `sessions.py`: list, title, resume and new, plus `/name` storage in `bridge-state.json`.
  - `hook.py` and `perm_mcp.py`: copied over unchanged. The `[tg-ref <id>]` marker and the file
    formats stay the same, and the state dir can be overridden by `EDITH_STATE_DIR` for staging.
  - The adapter emits events from `contracts/events.md` and does no Telegram I/O.
- Wrappers `deploy/shims/edith/bridge/hooks/edith_hook.py` and `deploy/shims/edith/bridge/perm_mcp.py`.
- Tests:
  - Lanes against the fake tmux and fake `claude -p`: busy → side lane, 2 side lanes → queued,
    stop, a crash, "No conversation found" → retry fresh.
  - Hook: feed it the recorded stdin JSON for SessionStart, UserPromptSubmit, Stop and
    PermissionRequest, and check that the files it writes match legacy byte for byte.
  - `auto_allow` rules for protected paths.

**Live (needs "yes"):**
- Back up `~/edith/bridge/hooks/edith_hook.py` and `perm_mcp.py`.
- Before swapping, run the wrapper hook against a temporary `EDITH_STATE_DIR` with sample input.
- Swap in the wrappers and check out `p1-step4`.
- **No restart:** each hook call and each side-lane MCP is a new process.
- `settings.json` and `mcp.json` are **not** changed, since the paths stay the same.

**Verify:**
- One normal Telegram message (main lane), with the same reply and reactions.
- One while busy (side lane).
- A harmless command that asks for permission, then Allow and Deny.
- `/stop` during a task.

**Rollback:** `cp ~/edith-backups/p1-step4/edith_hook.py ~/edith/bridge/hooks/ && cp ~/edith-backups/p1-step4/perm_mcp.py ~/edith/bridge/`.

## Step 5: sessions, approvals, control, quick actions (repo only)

**Repo:** `features/sessions` (`/sessions`, `/resume`, `/name`, `/new`), `features/approvals`
(watches `perms/` and handles Allow/Deny), `features/control` (`/stop`, `/status`, `/queue`,
`/restart`, `/help`) and `features/quick_actions` (`/menu`, `/brief`, `/mail`, `/today`,
`/servers`, `/changes`, with **prompt text identical** to today's). Each one is tested against the
fakes, and golden tests cover the reply text and buttons of every command.

**Live:** nothing. These features only run from step 6 on.

## Step 6: Telegram frontend and switching the bridge over (the one big switch)

**Repo**
- `server/edith/adapters/frontends/telegram/`: polling, allowlist re-read per message, offset in
  `bridge-state.json`, `setMyCommands` (same list), reactions, the "⏳ Working… / ✅ Done in" status
  edits, typing, attachments to `~/edith/inbox`, `SEND_FILE:` / `REACT:`, reply quoting, the
  crash notice and `/restart` via SIGTERM.
- `adapters/notifiers/telegram/`.
- `server/edith/main.py`: start and shut down cleanly (the `clean_exit` flag).
- `deploy/systemd/edith-bridge.service`: the same unit with a new `ExecStart`:
  `/usr/bin/python3 -I -m edith.main --config ~/.config/edith/config.toml` and
  `WorkingDirectory=%h/edith-app-live/server`. That also needs `sys.path`, set up by a small launcher script.
- An end-to-end golden test: a scripted conversation (text, command, buttons, file) against the fake
  Telegram API must produce **the same API calls** from legacy and from the new code.

**Staging run first (needs "yes", no change to the live bot)**
- Arpit creates a **test bot** with @BotFather (free) and gives me its token.
- Run the new code as a temporary `edith-staging` user unit with:
  - the test bot token
  - tmux socket `-L edith-staging` with its own Claude
  - work dir `~/edith-staging` (a copy of `~/edith` config, not data)
  - state dir `~/.cache/edith-staging`
- Arpit goes through a checklist on the test bot: every command, a side lane, the queue, Allow/Deny,
  a reminder, `/sessions` → switch, `/new`, `/stop`, `/restart`, a photo, `SEND_FILE`.
- Then stop and remove `edith-staging`. This uses some Claude usage for test turns.

**Switch over (needs "yes", about 10 s of downtime, done when idle)**
- Back up the unit file and `~/.cache/edith/bridge-state.json`.
- Write `~/.config/edith/config.toml`, install the new unit, run `daemon-reload` and
  `restart edith-bridge`.
- `edith-claude.service` and the tmux Claude session are **not** restarted, so the conversation
  carries on.

**Verify:** the staging checklist again on the real bot, plus a reminder firing and an old button
from before the switch.

**Rollback (about 10 s):** `cp ~/edith-backups/p1-step6/edith-bridge.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user restart edith-bridge`.
The state files never changed format, so the old bridge picks up where the new one stopped.
`~/edith/bridge/edith_bridge.py` stays in place, unused, until step 10.

## Step 7: Tailscale

**Arpit runs** (sudo, installing a package):
`curl -fsSL https://tailscale.com/install.sh | sh` then `sudo tailscale up` (log in via the printed URL), and
installs Tailscale on the phone. Free personal plan. No OCI security-list change and no public port.
Tailscale's outbound connections are enough.

**Verify:** `tailscale ip -4` and `tailscale status`; ping `edith` from the phone. Telegram is unaffected.

**Rollback:** `sudo tailscale down` (or `sudo apt remove tailscale`).

## Step 8: App API

**Stack (decided 2026-10-29):** standard library only. `ThreadingHTTPServer` plus a small
RFC 6455 WebSocket server in the repo (text frames and ping/pong only, with tests), so the
bridge still runs on the system `python3 -I` with no venv.

**Repo**
- `adapters/frontends/app_api/` with every endpoint in PLAN.md §4.1.
- It binds **only to the Tailscale IP**. If the IP isn't there, it logs, retries every 30 s and never
  falls back to `0.0.0.0`. Telegram keeps running either way, because adapters fail in isolation.
- Bearer token from `~/.config/edith/app-token` (mode 600), compared in constant time.
- Audit log at `~/.cache/edith/api-audit.jsonl`.
- Live view: the agent adapter's transcript tail publishes events for every turn, including
  Telegram and terminal ones. Replies are sent only to their origin.
- Routes come from features (`GET /v1/sessions`, `POST /v1/permissions/{id}`, …).
- Tests: auth, every route, WebSocket framing, origin routing, and the bind refusing `0.0.0.0`.

**Live (needs "yes"):**
- Create the token file.
- Add `app_api` to `frontends` in config, check out `p1-step8`, and restart `edith-bridge`.
- Add `After=tailscaled.service` to the unit.

**Verify (from the phone over Tailscale, or from edith using the 100.x IP):** `curl` sends a message, `websocat`
streams it live, plus list/switch sessions and approve a permission. A request without the token gets 401.
`ss -ltnp` shows it bound only to 100.x. Telegram checklist (short).

**Rollback:** remove `app_api` from config, then restart. Or check out `p1-step6`.

## Step 9: whisper.cpp

**Arpit runs** (sudo): `sudo apt install -y cmake ffmpeg`. `g++` and `make` are already installed.

**Repo**
- `deploy/whisper/build.sh` (pinned release tag, NEON, build in `~/opt/whisper.cpp`, models in
  `~/.local/share/whisper/`) and `bench.sh`.
- `deploy/systemd/whisper-server.service`, bound to **127.0.0.1:8178** only.
- `adapters/stt/whisper_cpp/`.
- `features/voice/`, just `POST /v1/stt` for now. The rest comes in Phase 3.
- Tests use a fake whisper HTTP server and an ffmpeg command builder.

**Live (needs "yes"):**
- Build (CPU-heavy for about 10 min).
- Download `base` and `small` (the multilingual ones) plus q5_1/q8_0 versions, about 1 GB of disk.
- Run the benchmark (5 s and 10 s clips, English and Hindi), then pick the model with Arpit.
  Target: under 5 s.
- Enable `whisper-server`, enable the `stt` adapter in config, and restart `edith-bridge`.

**Verify:** `curl -F file=@test.wav` over Tailscale returns the text. `free -g` stays fine. Telegram is unaffected.

**Rollback:** `systemctl --user disable --now whisper-server`, remove `stt` from config, and restart.

## Step 10: clean-up and Phase 1 sign-off

**Repo**
- `server/legacy/` is now empty, so delete it. ✅ Done: deleted with `tests/legacy.py`; the tests
  compare against the recorded golden files only.
- `deploy/edith/` gets tracked copies of `~/edith/CLAUDE.md` (the **live** version, which now has
  a "Projects" section the snapshot lacks), `.claude/settings.json`, the output style,
  `edith-claude.sh` and `edith-attach`.
- `deploy/install.sh` checks them for drift (diff only, no automatic overwrite).
- Mark Phase 1 done in PLAN.md.

**Live (needs "yes", item by item):**
- Remove the inactive leftovers from the old setup: `edith.service`, `edith-check.service/.timer`
  and `~/.local/bin/edith-{start,check,notify}`. They get backed up first, and Arpit confirms each deletion.
- Archive `~/edith/bridge/edith_bridge.py` to backups.
- **The wrappers stay permanently**, because EDITH's memory, `CLAUDE.md` and the guard hook use those paths.

**Done when** the PLAN.md Phase 1 criteria pass:
- `curl` over Tailscale can send, stream, list and switch sessions, approve a permission and transcribe.
- `/reminders`, `/mail`, `/today` and `/brief` run from repo code.
- Telegram works the same as before.
- `server/legacy/` is gone.

---

## What I need from Arpit

| When | What |
|---|---|
| Now | Merge PR #1 and #2 |
| Each step | A "yes" to its change list before I touch anything live |
| End of Phase 1 | Review and merge the `phase-1` PR |
| Step 1 | OK to create `~/edith-app-live` (a clone of this repo at a tag) |
| Step 3 | Re-run the Google login if the Testing-mode token has expired (~2026-11-03) |
| Step 6 | A test bot token from @BotFather; 10 min on the test bot checklist; a quiet time for the switch |
| Step 7 | Run the Tailscale install and `sudo tailscale up` login on edith; install Tailscale on the phone |
| Step 9 | `sudo apt install -y cmake ffmpeg`; pick the whisper model after the benchmark |
| Step 10 | Confirm each deletion of the old, inactive units and scripts |

Cost: all free (Tailscale personal plan, open-source whisper.cpp, BotFather test bot).
