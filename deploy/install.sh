#!/bin/bash
# Drift check: compares the files this repo tracks for edith with the live ones. Read-only: it
# never installs, copies or changes anything (live changes go through a change list and Arpit's "yes").
#
#   deploy/install.sh            # one line per file: same / DIFFERS / MISSING, plus when it should match
#   deploy/install.sh --diff     # also show what differs
#
# Exit status: 0 if every file matches, 1 if any differs or is missing.
# LIVE_HOME (default $HOME) is the home folder to compare against (tests use a temp one).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LIVE="${LIVE_HOME:-$HOME}"
SHOW_DIFF=0
[ "${1:-}" = "--diff" ] && SHOW_DIFF=1

# repo file | live file | when it should match (until then a difference is expected)
FILES=(
  "deploy/edith/CLAUDE.md|edith/CLAUDE.md|now"
  "deploy/edith/.claude/settings.json|edith/.claude/settings.json|now"
  "deploy/edith/.claude/output-styles/edith.md|edith/.claude/output-styles/edith.md|now"
  "deploy/edith/bridge/mcp.json|edith/bridge/mcp.json|now"
  "deploy/local-bin/edith-attach|.local/bin/edith-attach|now"
  "deploy/systemd/edith-claude.service|.config/systemd/user/edith-claude.service|now"
  "deploy/shims/edith/bridge/reminders.py|edith/bridge/reminders.py|after step 1"
  "deploy/shims/edith/bin/remind.py|edith/bin/remind.py|after step 1"
  "deploy/shims/edith/bin/changes.py|edith/bin/changes.py|after step 2"
  "deploy/shims/edith/google/gmail.py|edith/google/gmail.py|after step 3"
  "deploy/shims/edith/google/gcal.py|edith/google/gcal.py|after step 3"
  "deploy/shims/edith/google/auth.py|edith/google/auth.py|after step 3"
  "deploy/shims/edith/google/gauth.py|edith/google/gauth.py|after step 3"
  "deploy/shims/edith/bridge/hooks/edith_hook.py|edith/bridge/hooks/edith_hook.py|after step 4"
  "deploy/shims/edith/bridge/perm_mcp.py|edith/bridge/perm_mcp.py|after step 4"
  "deploy/systemd/edith-bridge.service|.config/systemd/user/edith-bridge.service|after step 6"
  "deploy/config/edith.toml|.config/edith/config.toml|after step 6"
  "deploy/edith/bridge/edith-claude.sh|edith/bridge/edith-claude.sh|after step 10"
)

drift=0
printf "%-8s %-14s %s\n" state "should match" "live file"
for entry in "${FILES[@]}"; do
  IFS="|" read -r ours theirs when <<<"$entry"
  live="$LIVE/$theirs"
  if [ ! -e "$live" ]; then
    state=MISSING
  elif cmp -s "$REPO/$ours" "$live"; then
    state=same
  else
    state=DIFFERS
  fi
  [ "$state" = same ] || drift=1
  printf "%-8s %-14s ~/%s\n" "$state" "$when" "$theirs"
  if [ "$SHOW_DIFF" = 1 ] && [ "$state" = DIFFERS ]; then
    diff -u "$live" "$REPO/$ours" | sed 's/^/    /'
  fi
done
exit "$drift"
