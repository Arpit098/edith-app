"""Reminder store shared by the bridge (which fires reminders) and ~/edith/bin/remind.py
(which EDITH uses to add/list/cancel them). Times are stored as unix timestamps and shown
in IST. One-off reminders stay in the file for 2 days after firing so Snooze/Done work.
"""
import calendar
import fcntl
import json
import os
import secrets
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Kolkata")
FILE = os.path.expanduser("~/.cache/edith/reminders.json")
REPEATS = ("daily", "weekdays", "weekly", "monthly")
KEEP_FIRED = 2 * 86400


@contextmanager
def locked():
    """Yield the reminder list under an exclusive lock; changes are saved on exit."""
    os.makedirs(os.path.dirname(FILE), exist_ok=True)
    with open(FILE + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try:
            with open(FILE) as f:
                items = json.load(f)
        except (OSError, ValueError):
            items = []
        yield items
        tmp = FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(items, f, indent=1)
        os.replace(tmp, FILE)


def fmt(ts):
    return datetime.fromtimestamp(ts, TZ).strftime("%a %d %b, %H:%M")


def next_due(due, every, now=None):
    now = now or time.time()
    dt = datetime.fromtimestamp(due, TZ)
    while dt.timestamp() <= now:
        if every == "daily":
            dt += timedelta(days=1)
        elif every == "weekdays":
            dt += timedelta(days=1)
            while dt.weekday() >= 5:
                dt += timedelta(days=1)
        elif every == "weekly":
            dt += timedelta(days=7)
        elif every == "monthly":
            y, m = (dt.year + 1, 1) if dt.month == 12 else (dt.year, dt.month + 1)
            dt = dt.replace(year=y, month=m, day=min(dt.day, calendar.monthrange(y, m)[1]))
        else:
            raise ValueError(f"unknown repeat: {every}")
    return dt.timestamp()


def add(due, text, every=None, chat_id=None):
    if every and every not in REPEATS:
        raise ValueError(f"repeat must be one of {REPEATS}")
    item = {"id": secrets.token_hex(3), "due": float(due), "text": text, "every": every,
            "chat_id": chat_id, "created": time.time()}
    with locked() as items:
        items.append(item)
    return item


def pending():
    with locked() as items:
        return sorted((r for r in items if not r.get("fired")), key=lambda r: r["due"])


def cancel(rid):
    with locked() as items:
        for r in items:
            if r["id"] == rid:
                items.remove(r)
                return r
    return None


def snooze(rid, until):
    """Push a reminder to `until`. Repeating ones keep their schedule; a one-off copy is made."""
    with locked() as items:
        for r in items:
            if r["id"] == rid:
                if r.get("every"):
                    copy = dict(r, id=secrets.token_hex(3), every=None, due=float(until))
                    items.append(copy)
                    return copy
                r["due"] = float(until)
                r.pop("fired", None)
                return r
    return None


def pop_due(now=None):
    """Return reminders that are due (as they were before firing) and advance/mark them."""
    now = now or time.time()
    fired = []
    with locked() as items:
        for r in list(items):
            if r.get("fired"):
                if now - r["fired"] > KEEP_FIRED:
                    items.remove(r)
                continue
            if r["due"] <= now:
                fired.append(dict(r))
                if r.get("every"):
                    r["due"] = next_due(r["due"], r["every"], now)
                else:
                    r["fired"] = now
    return fired


def tomorrow_at(hour=9):
    dt = datetime.now(TZ) + timedelta(days=1)
    return dt.replace(hour=hour, minute=0, second=0, microsecond=0).timestamp()
