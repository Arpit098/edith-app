# Deploy (edith)

systemd user units, config, wrappers and tracked copies of the live files for the edith server.
Every change on edith is shown as a change list and approved by Arpit before it is applied.

| Path | What |
|---|---|
| `bin/edith-bridge` | Launcher the bridge unit runs (`python3 -I`, stdlib only) |
| `config/edith.toml` | The live config (as `~/.config/edith/config.toml`; no secrets) |
| `systemd/` | `edith-bridge` (new `ExecStart`), `edith-claude` (as live), `whisper-server` |
| `shims/edith/…` | Wrappers that replace files under `~/edith/` at the same paths (steps 1–4) |
| `edith/` | Tracked copies of `~/edith/CLAUDE.md`, `.claude/settings.json`, the output style, `bridge/mcp.json`, and the parametrized `bridge/edith-claude.sh` |
| `local-bin/edith-attach` | Copy of `~/.local/bin/edith-attach` |
| `install.sh` | **Drift check, read-only:** each tracked file vs the live one (`same` / `DIFFERS` / `MISSING`, and the step after which it should match); `--diff` shows the differences. It never installs anything |

## Where live code runs from

The live system runs from a **separate clone pinned to a release tag**, never from the dev repo:

| What | Where |
|---|---|
| Dev repo (phase branches) | `~/Projects/Personal Projects/edith-app` |
| Live code | `~/edith-app-live` (a clone of `Arpit098/edith-app`, detached at a tag) |
| Live config (not in git) | `~/.config/edith/config.toml`, `~/.config/edith/app-token` |
| Backups | `~/edith-backups/p1-stepN/` |

Switching branches in the dev repo never changes what is live.

## Branches and tags

All of a phase's work is on one branch (`phase-1`, …) with one PR, merged when the phase is done.
Each step that changes something live gets a tag on its last commit on that branch: `p1-step1`,
`p1-step2`, … (see [docs/PHASE1_PLAN.md](../docs/PHASE1_PLAN.md)). Tags are pushed, so they keep
their commits even if the branch is later rebased.

```bash
git -C ~/edith-app-live fetch --tags
git -C ~/edith-app-live checkout p1-stepN     # deploy
git -C ~/edith-app-live checkout p1-step(N-1) # roll back the code
```

## Wrappers (`deploy/shims/`)

EDITH, its memory, `~/edith/CLAUDE.md` and the guard hook call tools by fixed paths
(`~/edith/bin/remind.py`, `~/edith/google/gmail.py`, …). Each of those files is replaced by a small
wrapper that runs the repo code from `~/edith-app-live/server`, with the same path, arguments and
output. `deploy/shims/<path under ~>` mirrors where each one is installed. The wrappers stay
permanently.

## Steps for every live change

1. The step's commits pass `make test` and its tag is pushed.
2. Send Arpit the change list: the exact commands, files and services, the downtime, and the rollback command.
3. Wait for Arpit's "yes" for that step. A "yes" covers only that change list.
4. Back up every file that will be replaced: `mkdir -p ~/edith-backups/p1-stepN && cp -p <file> ~/edith-backups/p1-stepN/`.
5. Apply the change, verify it with the step's checklist, and check that Telegram still works.
6. If anything is off, run the rollback command straight away, then report.

Never edit `~/edith/.claude/settings.json`, the `edith-bridge` / `edith-claude` units or the guard
hook in `~/.claude/hooks/` without that step's explicit "yes".
