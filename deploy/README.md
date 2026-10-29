# Deploy (edith)

systemd user units, install scripts and the whisper.cpp build script for the edith server.
Every change on edith is shown as a change list and approved by Arpit before it is applied.

## Where live code runs from

The live system runs from a **separate clone pinned to a release tag**, never from the dev repo:

| What | Where |
|---|---|
| Dev repo (branches, PRs) | `~/Projects/Personal Projects/edith-app` |
| Live code | `~/edith-app-live` (a clone of `Arpit098/edith-app`, detached at a tag) |
| Live config (not in git) | `~/.config/edith/config.toml`, `~/.config/edith/app-token` |
| Backups | `~/edith-backups/p1-stepN/` |

Switching branches in the dev repo never changes what is live.

## Tags

Each Phase 1 step that changes something live gets a tag on `main` after its PR is merged:
`p1-step1`, `p1-step2`, … (see [docs/PHASE1_PLAN.md](../docs/PHASE1_PLAN.md)).

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

1. The step's PR is merged and tagged.
2. Send Arpit the change list: the exact commands, files and services, the downtime, and the rollback command.
3. Wait for Arpit's "yes" for that step. A "yes" covers only that change list.
4. Back up every file that will be replaced: `mkdir -p ~/edith-backups/p1-stepN && cp -p <file> ~/edith-backups/p1-stepN/`.
5. Apply the change, verify it with the step's checklist, and check that Telegram still works.
6. If anything is off, run the rollback command straight away, then report.

Never edit `~/edith/.claude/settings.json`, the `edith-bridge` / `edith-claude` units or the guard
hook in `~/.claude/hooks/` without that step's explicit "yes".
