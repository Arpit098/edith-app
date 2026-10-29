# edith-app

Android voice assistant ("Hey Edith") for **E.D.I.T.H**, the Claude Code agent on the `edith` server.

- **[PLAN.md](PLAN.md)**: goals, phases and decisions
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**: ports, adapters and feature folders
- **[docs/ADDING_A_FEATURE.md](docs/ADDING_A_FEATURE.md)**: how to add a feature without touching the others
- **[contracts/](contracts/)**: event and API shapes shared by the server and the app

| Folder | What |
|---|---|
| `server/` | edith-core + adapters (Telegram, App API, tmux Claude, whisper.cpp, ntfy) + features |
| `app/` | React Native (Expo) app + native Kotlin modules |
| `contracts/` | Server ⇄ app contract |
| `wakeword/` | openWakeWord "Hey Edith" training and models |
| `deploy/` | systemd units and install scripts for edith |
| `docs/` | Architecture and guides |

Status: **Phase 0**. The scaffold and plan are in place; nothing is deployed yet.
