# Server features

One folder per feature, each exposing `FEATURE = Feature(name, setup)`. Turn a feature on or off in `config.toml`.

| Feature | What it owns | Phase |
|---|---|---|
| `sessions` | `/sessions`, `/resume`, `/name`, `/new`; `GET/POST /v1/sessions…` | 1 |
| `approvals` | Allow/Deny for permission prompts on every frontend | 1 |
| `control` | `/stop`, `/status`, `/queue`, `/restart` | 1 |
| `reminders` | `/reminders`, `remind.py` CLI, firing due reminders (from `legacy/edith/bridge/reminders.py`, `bin/remind.py`) | 1 |
| `mail` | Gmail: unread-that-matters, `/mail` (from `legacy/edith/google/gmail.py`, via `adapters/google`) | 1 |
| `calendar` | Google Calendar: `/today`, events, free slots (from `legacy/edith/google/gcal.py`, via `adapters/google`) | 1 |
| `changes` | `/changes` (from `legacy/edith/bin/changes.py`) | 1 |
| `quick_actions` | `/menu`, `/brief`, `/mail`, `/today`, `/servers`, `/changes` | 1 |
| `voice` | `POST /v1/stt`, the `[voice]` tag, spoken summaries | 3 |
| `app_updates` | Collects app builds from GitHub (`gh`); serves OTA updates and APKs (`/v1/updates/…`, `/v1/app/…`; contracts/app-updates.md) | 3 |
| `message_log` | What happened to each message (accepted, delivered, reactions for the app), a log per conversation, and `GET /v1/sessions/{id}/history` merged with it | 2 |
| `wakeword` | "Hey Edith" recording sessions (streamed WAV uploads, checked), downloads for the Mac trainer, model status (`/v1/wakeword/…`; contracts/wakeword.md) | 4 |
| `status` | `GET /v1/status/details`: the app's status panel (main lane, lanes, conversation, coding agents in tmux, live tag; contracts/status.md) | 2 |
| `accounts` | Claude accounts: saved logins, switch the agents and EDITH to another (a detached `systemd-run` unit, only when idle, rolled back if it fails), add one with Claude's headless login, remove (`/v1/accounts…`; contracts/accounts.md) | 2 |
| `notifications` | Pushes through ntfy while the app is closed: replies, failures, approvals (cancelled once answered), reminders; `GET /v1/push/config` hands the app ntfy's address and the phone's read-only token (contracts/push.md) | 5 |

The Phase 1 features were migrated from the legacy bridge one at a time, so Telegram behaved the same at every step; tests hold them to its recorded output (`server/tests/golden/`).
