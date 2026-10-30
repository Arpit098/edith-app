# edith-app: notes for Claude (EDITH)

This repo is Arpit's personal tools app for Android (voice with EDITH is the first tool; more tools
come as features), plus the modular server it talks to. You are EDITH, and you build it from this
server. Arpit reviews the work.

## Start here
- **PLAN.md** has the goals, constraints and the phase order. Work phase by phase and update the
  status line at the top when a phase is done.
- **docs/ARCHITECTURE.md** and **docs/ADDING_A_FEATURE.md** cover ports, adapters, `common/` and feature folders.
- **contracts/events.md** is the server ⇄ app event contract. Change it first, then both sides.
- **The legacy code is gone** (Phase 1 migrated it all; the live bridge runs from this repo). What it
  did is kept as golden files in `server/tests/golden/data/`: the new code must still match them.
  Change a golden file only by a reviewed edit, when the behaviour is meant to change.

## Rules
- **Times:** always report times in IST (Asia/Kolkata, UTC+5:30), never UTC, in every message and summary.
- **Architecture:** one feature per folder. Features never import other features or adapters;
  shared code goes in `common/`, which imports core only. `server/tests/test_isolation.py` enforces this.
- **Tests:** run `cd server && make test` before every commit. Add tests with every feature.
- **Git:**
  - Only big phases get a PR: each phase is one branch (`phase-1`, `phase-2`, …) and one PR for Arpit
    to review. Each step inside a phase is a few small commits on that branch.
  - Small work (doc fixes, tiny tweaks) goes straight to `main`, with no PR.
  - Live deploys use tags made from the phase branch (see `deploy/README.md`).
  - No co-author lines in commits.
  - **Every PR body has a `## Release notes` block** (`.github/pull_request_template.md`). The app's update
    screen shows these lines to Arpit, so write them for him:
    - `New: <one plain sentence>` and `Fix: <one plain sentence>`, one line per item, zero or more of each;
    - plain words, no jargon, at most about 12 words a line;
    - CI, refactor or test-only PRs: one line, `Internal: no user-visible change`.
- **Quality:** the architecture must be solid and efficient, with no brute-force methods.
  - Wait on events (hook event, file change, socket, `Condition`/`Queue`), never fixed sleeps or busy
    loops. If polling can't be avoided, poll with backoff and a timeout, and say why in a comment.
  - Don't re-read or re-parse whole files repeatedly. Tail transcripts and event logs from a saved
    byte offset; cache parsed config and state, and reload only when the file changes.
  - Use the right data structures: dict/set lookups, `heapq` for due reminders, bounded queues, no
    O(n²) loops over sessions or messages.
  - One thread per job, never one per message. Shut down cleanly, with no leaked processes, fds or tmux panes.
  - Shared state: atomic writes (tmp + `os.replace`) and file locks, no read-modify-write races.
  - Every network call (Telegram, Google, whisper) has a timeout and retries with backoff; failures
    stay inside their adapter or feature.
  - Keep it simple: stdlib first, no extra layers, frameworks or dependencies unless they remove real complexity.
  - The legacy code defines the behaviour, not the design. Keep its outputs identical (golden tests),
    fix brute-force internals while migrating, and list each fix in the step summary.
- **Live system is separate from this repo.** The running Telegram bridge lives in `~/edith/bridge/`,
  with services `edith-bridge` and `edith-claude` (systemd --user).
  - Never edit, restart or replace them (or `~/edith/.claude/settings.json`) without first sending
    Arpit a change list and getting an explicit "yes".
  - Phase 1 migrates the bridge into `server/` one feature at a time, and **Telegram must keep
    working the same way at every step**.
  - Before any change, keep a backup and a rollback command.
- **Free only:** no paid APIs or services. The voice stack is open source: openWakeWord for the
  wake word (a manual toggle, off by default) and whisper.cpp on this server for speech-to-text.
- **Private:** the App API binds to the Tailscale IP only. Never open public ports or change the OCI
  security list.
- **Secrets:** tokens, keystores and recordings never go in git (see `.gitignore`).
- **APK:** built by GitHub Actions on x86 runners, not on this ARM server.
