#!/usr/bin/env python3
"""Manage Arpit's Telegram reminders (the bridge fires them).

  remind.py add "<when>" "<text>" [--every daily|weekdays|weekly|monthly]
  remind.py list
  remind.py cancel <id>

<when> is IST: "2026-10-31 17:00", "2026-10-31" (09:00), "17:00" (next occurrence),
or relative "+30m", "+2h", "+1d".
"""
import argparse
import os
import re
import sys
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.expanduser("~/edith/bridge"))
import reminders as R  # noqa: E402


def parse_when(s):
    s = s.strip()
    m = re.fullmatch(r"\+(\d+)\s*([mhd])", s)
    if m:
        n, unit = int(m[1]), m[2]
        return time.time() + n * {"m": 60, "h": 3600, "d": 86400}[unit]
    now = datetime.now(R.TZ)
    for f in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s, f).replace(tzinfo=R.TZ)
            return (dt.replace(hour=9) if f == "%Y-%m-%d" else dt).timestamp()
        except ValueError:
            pass
    try:
        t = datetime.strptime(s, "%H:%M")
    except ValueError:
        sys.exit(f"Can't parse time: {s!r}")
    dt = now.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
    if dt <= now:
        dt += timedelta(days=1)
    return dt.timestamp()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("when")
    a.add_argument("text")
    a.add_argument("--every", choices=R.REPEATS)
    sub.add_parser("list")
    c = sub.add_parser("cancel")
    c.add_argument("id")
    args = p.parse_args()

    if args.cmd == "add":
        due = parse_when(args.when)
        if due < time.time() - 60:
            sys.exit(f"That time is in the past: {R.fmt(due)}")
        r = R.add(due, args.text, args.every)
        print(f"Added {r['id']}: {R.fmt(r['due'])} IST{' (' + r['every'] + ')' if r['every'] else ''} - {r['text']}")
    elif args.cmd == "list":
        items = R.pending()
        if not items:
            print("No reminders.")
        for r in items:
            print(f"{r['id']}  {R.fmt(r['due'])} IST{'  [' + r['every'] + ']' if r.get('every') else ''}  {r['text']}")
    else:
        r = R.cancel(args.id)
        print(f"Cancelled: {r['text']}" if r else f"No reminder with id {args.id}")


if __name__ == "__main__":
    main()
