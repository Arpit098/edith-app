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
| `notifications` | "Task done" / "approval needed" pushes through the notifier ports | 5 |

The Phase 1 features were migrated from the legacy bridge one at a time, so Telegram behaved the same at every step; tests hold them to its recorded output (`server/tests/golden/`).
