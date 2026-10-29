#!/bin/bash
# Interactive Claude Code for E.D.I.T.H, run inside tmux (-L edith) by edith-claude.service.
# The bridge pastes Telegram messages into it; Arpit can watch or join with edith-attach.
# Usage: edith-claude.sh [session-id]   (default: resume the last session if it still exists)
#
# From legacy/edith/bridge/edith-claude.sh. The only change: the work and state folders can be moved
# with EDITH_WORK_DIR / EDITH_STATE_DIR (for staging); unset, it behaves exactly like the original.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
export EDITH_TMUX=1
WORK_DIR="${EDITH_WORK_DIR:-$HOME/edith}"
export EDITH_STATE_DIR="${EDITH_STATE_DIR:-$HOME/.cache/edith}"
cd "$WORK_DIR" || exit 1

sid="$1"
if [ -z "$sid" ]; then
  sid=$(python3 -I - <<'EOF' 2>/dev/null
import json, os
for name in ("tmux-session.json", "bridge-state.json"):
    try:
        with open(os.path.join(os.environ["EDITH_STATE_DIR"], name)) as f:
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

# Claude's transcript folder for WORK_DIR (legacy hardcoded -home-ubuntu-edith: the same folder on edith)
project="$HOME/.claude/projects/$(printf '%s' "$WORK_DIR" | sed 's/[^A-Za-z0-9]/-/g')"
if [ -n "$sid" ] && [ -f "$project/$sid.jsonl" ]; then
  exec claude --resume "$sid"
fi
exec claude
