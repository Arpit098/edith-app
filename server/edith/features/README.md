# Server features

One folder per feature, each exposing `FEATURE = Feature(name, setup)`. Turn a feature on or off in `config.toml`.

| Feature | What it owns | Phase |
|---|---|---|
| `sessions` | `/sessions`, `/resume`, `/name`, `/new`; `GET/POST /v1/sessions…` | 1 |
| `approvals` | Allow/Deny for permission prompts on every frontend | 1 |
| `control` | `/stop`, `/status`, `/queue`, `/restart` | 1 |
| `reminders` | `/reminders` + firing due reminders (moved from the bridge) | 1 |
| `quick_actions` | `/menu`, `/brief`, `/mail`, `/today`, `/servers`, `/changes` | 1 |
| `voice` | `POST /v1/stt`, the `[voice]` tag, spoken summaries | 3 |
| `notifications` | "Task done" / "approval needed" pushes through the notifier ports | 5 |

Each one is migrated out of today's `edith_bridge.py` in Phase 1, one at a time, so Telegram behaves the same at every step.
