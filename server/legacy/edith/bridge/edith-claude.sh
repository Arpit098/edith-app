#!/bin/bash
# Interactive Claude Code for E.D.I.T.H, run inside tmux (-L edith) by edith-claude.service.
# The bridge pastes Telegram messages into it; Arpit can watch or join with edith-attach.
# Usage: edith-claude.sh [session-id]   (default: resume the last session if it still exists)
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
export EDITH_TMUX=1
cd "$HOME/edith" || exit 1

sid="$1"
if [ -z "$sid" ]; then
  sid=$(python3 -I - <<'EOF' 2>/dev/null
import json, os
for name in ("tmux-session.json", "bridge-state.json"):
    try:
        with open(os.path.expanduser("~/.cache/edith/" + name)) as f:
            d = json.load(f)
    except (OSError, ValueError):
        continue
    sid = d.get("session_id") or next(iter(d.get("sessions", {}).values()), "")
    if sid:
        print(sid)
        break
EOF
)
fi

if [ -n "$sid" ] && [ -f "$HOME/.claude/projects/-home-ubuntu-edith/$sid.jsonl" ]; then
  exec claude --resume "$sid"
fi
exec claude
