# edith-app: notes for Claude (EDITH)

This repo is the Android voice assistant for EDITH, plus the modular server it talks to. You are
EDITH, and you build it from this server. Arpit reviews the work.

## Start here
- **PLAN.md** has the goals, constraints and the phase order. Work phase by phase and update the
  status line at the top when a phase is done.
- **docs/ARCHITECTURE.md** and **docs/ADDING_A_FEATURE.md** cover ports, adapters, `common/` and feature folders.
- **contracts/events.md** is the server ⇄ app event contract. Change it first, then both sides.

## Rules
- **Architecture:** one feature per folder. Features never import other features or adapters;
  shared code goes in `common/`, which imports core only. `server/tests/test_isolation.py` enforces this.
- **Tests:** run `cd server && make test` before every commit. Add tests with every feature.
- **Git:**
  - Work on a branch and open a PR for Arpit to review. Don't push to `main` directly.
  - Keep commits small, one feature or step each.
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
