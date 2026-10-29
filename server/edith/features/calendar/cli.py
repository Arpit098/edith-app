#!/usr/bin/env python3
"""EDITH Google Calendar helper (all of Arpit's calendars, times in IST).

  gcal.py today | tomorrow | week      agenda
  gcal.py agenda <days>                next N days
  gcal.py next                         next upcoming event
  gcal.py calendars                    list calendars
  gcal.py create --title T --start "2026-10-28 15:00" [--end ...|--minutes 30] [--desc D] [--where L] [--attendees a,b] [--meet]
  gcal.py delete <eventId> [--calendar ID]      (needs Arpit's OK)
"""
# The docstring above is printed as help, word for word from legacy/edith/google/gcal.py. EDITH
# runs this as `gcal.py …` from ~/edith/google (a wrapper), so the guard hook still sees the same
# command. The calendar comes from the calendar port (EDITH_CALENDAR_ADAPTER, default google).
import argparse
import datetime as dt
import os
import sys
from zoneinfo import ZoneInfo

from edith.core import load_port
from edith.ports.calendar import NewEvent

TZ = ZoneInfo("Asia/Kolkata")
COMMANDS = ("today", "tomorrow", "week", "agenda", "next", "calendars", "create", "delete")


def now():
    return dt.datetime.now(TZ)


def calendar():
    cal = load_port("calendar", "calendar", os.environ.get("EDITH_CALENDAR_ADAPTER", "google"), {})
    if cal is None:
        sys.exit("The calendar adapter failed to load; see the error above.")
    return cal


def fmt(e):
    if not e.all_day:
        a, b = e.start.astimezone(TZ), e.end.astimezone(TZ)
        when = f"{a:%a %d %b %H:%M}–{b:%H:%M}"
    else:
        when = f"{e.start.isoformat()} (all day)"
    extra = [x for x in (e.location, e.meet_link) if x]
    line = f"{when} | {e.title} [{e.calendar}] id={e.id}"
    return line + (f"\n    {' · '.join(extra)}" if extra else "")


def agenda(cal, days, start=None):
    start = start or now()
    end = start.replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(days=days)
    evs = cal.events(start, end)
    print("\n".join(fmt(e) for e in evs) if evs else "Nothing scheduled.")


def parse_time(s):
    return dt.datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=TZ)


def main(argv=None, cal=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in COMMANDS:
        print(__doc__)
        return
    cmd, rest = argv[0], argv[1:]
    cal = cal or calendar()
    today0 = now().replace(hour=0, minute=0, second=0, microsecond=0)
    if cmd == "today":
        agenda(cal, 1, today0)
    elif cmd == "tomorrow":
        agenda(cal, 1, today0 + dt.timedelta(days=1))
    elif cmd == "week":
        agenda(cal, 7, today0)
    elif cmd == "agenda":
        agenda(cal, int(rest[0]) if rest else 3)
    elif cmd == "next":
        t = now()
        evs = [e for e in cal.events(t, t + dt.timedelta(days=14)) if not e.all_day]
        print(fmt(evs[0]) if evs else "Nothing in the next 14 days.")
    elif cmd == "calendars":
        for c in cal.calendars():
            print(f"{c.name} | {c.id} | {c.access_role}")
    elif cmd == "create":
        p = argparse.ArgumentParser()
        p.add_argument("--title", required=True)
        p.add_argument("--start", required=True)
        p.add_argument("--end")
        p.add_argument("--minutes", type=int, default=30)
        p.add_argument("--desc", default="")
        p.add_argument("--where", default="")
        p.add_argument("--attendees", default="")
        p.add_argument("--meet", action="store_true")
        p.add_argument("--calendar", default="primary")
        a = p.parse_args(rest)
        st = parse_time(a.start)
        en = parse_time(a.end) if a.end else st + dt.timedelta(minutes=a.minutes)
        e = cal.create(NewEvent(title=a.title, start=st, end=en, description=a.desc, location=a.where,
                                attendees=[x.strip() for x in a.attendees.split(",") if x.strip()],
                                meet=a.meet, calendar_id=a.calendar))
        print(f"Created: {e.link}" + (f"\nMeet: {e.meet_link}" if e.meet_link else ""))
    else:
        p = argparse.ArgumentParser()
        p.add_argument("event_id")
        p.add_argument("--calendar", default="primary")
        a = p.parse_args(rest)
        cal.delete(a.event_id, a.calendar)
        print("Deleted.")


if __name__ == "__main__":
    main()
