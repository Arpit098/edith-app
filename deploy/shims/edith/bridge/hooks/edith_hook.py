#!/usr/bin/env python3
"""Wrapper installed at ~/edith/bridge/hooks/edith_hook.py (docs/PHASE1_PLAN.md, step 4).

~/edith/.claude/settings.json keeps running `python3 -I $HOME/edith/bridge/hooks/edith_hook.py` on
every hook event; the code lives in ~/edith-app-live/server (or $EDITH_APP_SERVER). It imports only
the hook module. If that can't be imported, Python exits with code 1 and prints nothing on stdout:
the same result as the legacy hook failing (Claude Code carries on, no decision is made).
"""
import os
import sys

sys.path.insert(0, os.environ.get("EDITH_APP_SERVER") or os.path.expanduser("~/edith-app-live/server"))

from edith.adapters.agents.claude_tmux.hook import main  # noqa: E402

if __name__ == "__main__":
    main()
