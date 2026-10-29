# Legacy: today's live EDITH code (verbatim copy)

A snapshot of what runs on edith right now, taken 2026-10-29 so it has version history. **The live
system still runs from `~/edith`, not from here.** Copying it here changed nothing on the server.

- Don't edit files here. Migrate each piece into `server/edith/` (PLAN.md §4.9 and Phase 1), deploy,
  check that Telegram still works, then delete that piece from `legacy/`.
- Secrets and data were left out on purpose and must stay out:
  - Google OAuth tokens: `~/.config/edith-google/`
  - Telegram bot token and `access.json`: `~/.claude/channels/telegram/`
  - Reminders and bridge state: `~/.cache/edith/`

| Path here | Live location on edith | Migrates to |
|---|---|---|
| `edith/bridge/edith_bridge.py` | `~/edith/bridge/` | `adapters/frontends/telegram`, `adapters/agents/claude_tmux`, features `sessions`, `approvals`, `control`, `quick_actions` |
| `edith/bridge/perm_mcp.py`, `edith/bridge/hooks/edith_hook.py`, `edith/bridge/mcp.json` | `~/edith/bridge/` | `adapters/agents/claude_tmux` + feature `approvals` |
| `edith/bridge/edith-claude.sh` | `~/edith/bridge/` | `deploy/` |
| `edith/bridge/reminders.py`, `edith/bin/remind.py` | `~/edith/bridge/`, `~/edith/bin/` | feature `reminders` |
| `edith/google/*.py` | `~/edith/google/` | `adapters/google` + features `mail`, `calendar` |
| `edith/bin/changes.py` | `~/edith/bin/` | feature `changes` |
| `edith/CLAUDE.md`, `edith/.claude/settings.json`, `edith/.claude/output-styles/edith.md` | `~/edith/` | `deploy/edith/` |
| `systemd/edith-bridge.service`, `systemd/edith-claude.service` | `~/.config/systemd/user/` (active) | `deploy/systemd/` |
| `systemd/edith.service`, `systemd/edith-check.*` | `~/.config/systemd/user/` (**inactive**, from the old tmux + plugin setup) | Review, then likely delete |
| `local-bin/edith-attach` | `~/.local/bin/` (in use) | `deploy/` |
| `local-bin/edith-start`, `edith-check`, `edith-notify` | `~/.local/bin/` (from the old setup) | Review, then likely delete |
