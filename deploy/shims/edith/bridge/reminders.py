"""Wrapper installed at ~/edith/bridge/reminders.py (docs/PHASE1_PLAN.md, step 1).

The legacy bridge's `import reminders` gets the repo's reminder store, with the same names and the
same ~/.cache/edith/reminders.json. The code lives in ~/edith-app-live/server (or $EDITH_APP_SERVER).
"""
import os
import sys

sys.path.insert(0, os.environ.get("EDITH_APP_SERVER") or os.path.expanduser("~/edith-app-live/server"))

from edith.features.reminders.store import *  # noqa: E402,F401,F403
