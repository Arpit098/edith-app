#!/usr/bin/env python3
"""Wrapper installed at ~/edith/google/auth.py (docs/PHASE1_PLAN.md, step 3).

The one-time Google login (`auth.py url | finish <URL> | status`), same commands and output; the
code lives in ~/edith-app-live/server (or $EDITH_APP_SERVER). Tokens stay in ~/.config/edith-google.
"""
import os
import sys

sys.path.insert(0, os.environ.get("EDITH_APP_SERVER") or os.path.expanduser("~/edith-app-live/server"))

from edith.adapters.google.login import main  # noqa: E402

if __name__ == "__main__":
    main()
