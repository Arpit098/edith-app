"""Claude's usage-limit and login errors: what kind they are, and when the limit resets.

Claude Code writes them into the transcript as a synthetic assistant message (`isApiErrorMessage`,
model `<synthetic>`) with an `error` code: `rate_limit` ("You've hit your 5-hour limit · resets
6:20pm (UTC)"), `authentication_failed` ("Not logged in · Please run /login"), `billing_error`
("Credit balance is too low"). A `claude -p` run prints the same text as its result, with
`is_error`. Used by the claude_tmux adapter (to publish `agent.limit`) and the accounts feature.
"""
import datetime as dt
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import usertime
from .usertime import MONTHS, USAGE_LIMIT

LOGIN_ERROR = re.compile(r"Please run /login|Invalid API key|OAuth token (?:has )?expired|authentication_error"
                         r"|Not logged in", re.I)
BILLING = re.compile(r"credit balance is too low", re.I)
KINDS = ("usage_limit", "login", "billing")
ERROR_CODES = {"rate_limit": "usage_limit", "authentication_failed": "login", "billing_error": "billing"}
SHORT = 300  # characters: Claude's own error lines are short; a long reply quoting them is not one

# After usertime.localize_limit_text: "resets 9:30 PM IST", "resets Nov 3, 1:30 AM IST", or a Claude
# started with TZ set: "resets 6:20pm (Asia/Kolkata)".
RESET = re.compile(
    r"\bresets?(?:\s+at)?\s+"
    r"(?:(?P<mon>[A-Za-z]{3})[A-Za-z]*\.?\s+(?P<day>\d{1,2})(?:\s*,\s*|\s+at\s+|\s+))?"
    r"(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?:(?P<ap>[ap])\.?m\b\.?)?"
    r"(?:\s*\((?P<zone>[A-Za-z_+/-]+)\))?", re.I)


def classify(error: str | None, text: str | None) -> str | None:
    """`usage_limit`, `login` or `billing` for Claude's own error (its transcript `error` code, else
    its text when short), None for anything else."""
    if error in ERROR_CODES:
        return ERROR_CODES[error]
    text = (text or "").strip()
    if not text or len(text) > SHORT:
        return None
    first = text.split("\n", 1)[0]
    if USAGE_LIMIT.search(first):
        return "usage_limit"
    if LOGIN_ERROR.search(first):
        return "login"
    if BILLING.search(first):
        return "billing"
    return None


def reset_time(text: str | None, now: dt.datetime | None = None) -> float | None:
    """When the limit in Claude's text resets (unix seconds), or None if it names no time. A time
    without a date is its next occurrence after `now`; a zone in brackets is used if known, else the
    user's zone (localize_limit_text writes local times with the user's abbreviation)."""
    if not text:
        return None
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    text = usertime.localize_limit_text(text, now=now)
    for line in text.split("\n"):
        if not USAGE_LIMIT.search(line):
            continue
        m = RESET.search(line)
        if not m:
            continue
        h, mins, ap = int(m["h"]), int(m["m"] or 0), (m["ap"] or "").lower()
        if (not ap and m["m"] is None) or mins > 59 or (h > 23 if not ap else not 1 <= h <= 12):
            continue
        if ap:
            h = h % 12 + (12 if ap == "p" else 0)
        zone = usertime.user_tz()
        if m["zone"]:
            try:
                zone = ZoneInfo(m["zone"])
            except (ZoneInfoNotFoundError, ValueError):
                pass
        local_now = now.astimezone(zone)
        if m["mon"]:
            mon = m["mon"].lower()
            if mon not in MONTHS:
                continue
            try:
                at = dt.datetime(local_now.year, MONTHS.index(mon) + 1, int(m["day"]), h, mins, tzinfo=zone)
            except ValueError:
                continue
            if at < local_now - dt.timedelta(days=183):
                at = at.replace(year=local_now.year + 1)
        else:
            at = local_now.replace(hour=h, minute=mins, second=0, microsecond=0)
            if at <= local_now:
                at += dt.timedelta(days=1)
        return at.timestamp()
    return None
