#!/usr/bin/env python3
"""Wrapper installed at ~/edith/bin/changes.py (docs/PHASE1_PLAN.md, step 2).

EDITH keeps running `python3 -I ~/edith/bin/changes.py [filter]` as before; the code lives in
~/edith-app-live/server (or $EDITH_APP_SERVER). Same output, same HTML report.
"""
import os
import sys

sys.path.insert(0, os.environ.get("EDITH_APP_SERVER") or os.path.expanduser("~/edith-app-live/server"))

from edith.features.changes.report import main  # noqa: E402

if __name__ == "__main__":
    main()
