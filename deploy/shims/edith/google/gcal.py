#!/usr/bin/env python3
"""Wrapper installed at ~/edith/google/gcal.py (docs/PHASE1_PLAN.md, step 3).

EDITH keeps running `cd ~/edith/google && ~/edith/venv/bin/python gcal.py …` as before (and the
guard hook keeps matching it); the code lives in ~/edith-app-live/server (or $EDITH_APP_SERVER).
"""
import os
import sys

sys.path.insert(0, os.environ.get("EDITH_APP_SERVER") or os.path.expanduser("~/edith-app-live/server"))

from edith.features.calendar.cli import main  # noqa: E402

if __name__ == "__main__":
    main()
