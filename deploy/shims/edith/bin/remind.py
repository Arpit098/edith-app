#!/usr/bin/env python3
"""Wrapper installed at ~/edith/bin/remind.py (docs/PHASE1_PLAN.md, step 1).

EDITH keeps running `python3 -I ~/edith/bin/remind.py add|list|cancel …` as before; the code lives
in ~/edith-app-live/server (or $EDITH_APP_SERVER). Same arguments, same output.
"""
import os
import sys

sys.path.insert(0, os.environ.get("EDITH_APP_SERVER") or os.path.expanduser("~/edith-app-live/server"))

from edith.features.reminders.cli import main  # noqa: E402

if __name__ == "__main__":
    main()
