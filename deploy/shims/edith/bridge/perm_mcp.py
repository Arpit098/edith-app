#!/usr/bin/env python3
"""Wrapper installed at ~/edith/bridge/perm_mcp.py (docs/PHASE1_PLAN.md, step 4).

~/edith/bridge/mcp.json keeps starting `python3 -I /home/ubuntu/edith/bridge/perm_mcp.py` as the
edith_perm MCP server for side lanes; the code lives in ~/edith-app-live/server (or
$EDITH_APP_SERVER). `import perm_mcp` still gives ask(), auto_allow(), PERM_DIR and TIMEOUT.
"""
import os
import sys

sys.path.insert(0, os.environ.get("EDITH_APP_SERVER") or os.path.expanduser("~/edith-app-live/server"))

from edith.adapters.agents.claude_tmux.perm import *  # noqa: E402,F401,F403
from edith.adapters.agents.claude_tmux.perm import main  # noqa: E402

if __name__ == "__main__":
    main()
