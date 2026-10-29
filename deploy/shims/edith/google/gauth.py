"""Wrapper installed at ~/edith/google/gauth.py (docs/PHASE1_PLAN.md, step 3).

Anything that still does `from gauth import service` (or creds, TOKEN) gets the repo's shared
Google session: one token load, refreshed only when expired, services built once.
"""
import os
import sys

sys.path.insert(0, os.environ.get("EDITH_APP_SERVER") or os.path.expanduser("~/edith-app-live/server"))

from edith.adapters.google.auth import *  # noqa: E402,F401,F403
