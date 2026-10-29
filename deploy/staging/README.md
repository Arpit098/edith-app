# Staging run for step 6 (files only until Arpit says yes)

Before the live bot switches to the new code, the new bridge runs on a **separate test bot** with
its own tmux Claude, work dir and state. Nothing here touches the live bot, `~/edith`,
`~/.cache/edith`, the `edith-bridge`/`edith-claude` services or the live tmux session.

| | Live | Staging |
|---|---|---|
| Bot | the real bot (`~/.claude/channels/telegram`) | a test bot from @BotFather (`~/.config/edith-staging/telegram`) |
| tmux | `-L edith`, service `edith-claude` | `-L edith-staging`, service `edith-claude-staging` |
| Work dir | `~/edith` | `~/edith-staging` (a copy of `CLAUDE.md`, `.claude/`, `bridge/mcp.json`) |
| State | `~/.cache/edith` | `~/.cache/edith-staging` |
| Config | `~/.config/edith/config.toml` | `~/.config/edith-staging/config.toml` |

The staging copies of `.claude/settings.json` and `bridge/mcp.json` are pointed at the clone's
hook and permission wrappers (`~/edith-app-live/deploy/shims/…`), which honour `EDITH_STATE_DIR`.
`edith-claude-staging.service` sets it, so every hook event and reminder of the staging Claude goes
to `~/.cache/edith-staging`, and side lanes get `EDITH_PERM_DIR` there too. (The live files under
`~/edith/bridge/` are not used by staging, so this works before or after step 4 is deployed.)

**Needs steps 1–4 live first.** The staging Claude follows `CLAUDE.md` and runs
`~/edith/bin/remind.py`, `changes.py` and the Google scripts. Only their step 1–3 wrappers honour
`EDITH_STATE_DIR`; the legacy files would write staging reminders into the live store.

## Set up (needs Arpit's "yes"; Arpit provides the test bot token)

```bash
mkdir -p ~/edith-staging/bridge ~/.cache/edith-staging ~/.config/edith-staging/telegram
cp -r ~/edith/CLAUDE.md ~/edith/.claude ~/edith-staging/
W=/home/ubuntu/edith-app-live/deploy/shims/edith/bridge
sed -i "s#\$HOME/edith/bridge/hooks/edith_hook.py#$W/hooks/edith_hook.py#g" ~/edith-staging/.claude/settings.json
sed "s#/home/ubuntu/edith/bridge/perm_mcp.py#$W/perm_mcp.py#" ~/edith/bridge/mcp.json > ~/edith-staging/bridge/mcp.json
grep -c "edith-app-live" ~/edith-staging/.claude/settings.json ~/edith-staging/bridge/mcp.json   # 4 and 1
printf 'TELEGRAM_BOT_TOKEN=%s\n' '<test bot token>' > ~/.config/edith-staging/telegram/.env
cp ~/.claude/channels/telegram/access.json ~/.config/edith-staging/telegram/access.json
chmod 600 ~/.config/edith-staging/telegram/.env
cp ~/edith-app-live/deploy/config/edith-staging.toml ~/.config/edith-staging/config.toml
cp ~/edith-app-live/deploy/systemd/edith-{claude-,}staging.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start edith-claude-staging edith-staging
```

## Checklist on the test bot (Arpit, about 10 minutes)

1. `/help`, `/menu`, `/status`: same texts and buttons as the live bot.
2. A normal message: 👀 → 👨‍💻 → "⏳ On it…" → "Working…" edits → the reply → "✅ Done in …" → 👍.
3. While it works, a second message: ⚡, "⚡ ⏳ On it (parallel lane)…", the reply quoting it.
4. `/queue <task>` while busy: 🥱 and "📥 Queued (#1)…", then it runs after the current task.
5. Something that needs approval (`sudo true`): 🙏, Allow/Deny buttons; press Deny.
6. Ask the staging EDITH "remind me in 2 minutes to test". It fires on the test bot with its
   buttons (the staging Claude's `remind.py` writes to `~/.cache/edith-staging`, not the live store).
7. `/sessions`, tap another conversation, `/name test`, `/new`.
8. `/stop` during a task; `/restart` (it comes back; no crash notice).
9. A photo with a caption, and a reply that uses `SEND_FILE:`.

## Tear down (after the test)

```bash
systemctl --user stop edith-staging edith-claude-staging
rm ~/.config/systemd/user/edith-staging.service ~/.config/systemd/user/edith-claude-staging.service
systemctl --user daemon-reload
rm -rf ~/edith-staging ~/.cache/edith-staging ~/.config/edith-staging
```

Note: the staging Claude writes its transcripts to `~/.claude/projects/-home-ubuntu-edith-staging/`;
remove that folder too if Arpit doesn't want to keep them.
