#!/usr/bin/env python3
"""EDITH Google Calendar helper (all of Arpit's calendars, times in IST).

  gcal.py today | tomorrow | week      agenda
  gcal.py agenda <days>                next N days
  gcal.py next                         next upcoming event
  gcal.py calendars                    list calendars
  gcal.py create --title T --start "2026-10-28 15:00" [--end ...|--minutes 30] [--desc D] [--where L] [--attendees a,b] [--meet]
  gcal.py delete <eventId> [--calendar ID]      (needs Arpit's OK)
"""
import argparse
import datetime as dt
import sys
import uuid
from zoneinfo import ZoneInfo

from gauth import service

TZ = ZoneInfo("Asia/Kolkata")
C = service("calendar", "v3")


def calendars():
    return [c for c in C.calendarList().list().execute().get("items", []) if c.get("selected", True)]


def events_between(start, end):
    out = []
    for cal in calendars():
        res = C.events().list(calendarId=cal["id"], timeMin=start.isoformat(), timeMax=end.isoformat(),
                              singleEvents=True, orderBy="startTime", maxResults=100).execute()
        for e in res.get("items", []):
            if e.get("status") == "cancelled":
                continue
            # all-day events from calendars in other time zones can leak in from yesterday
            if "date" in e["end"] and e["end"]["date"] <= start.astimezone(TZ).date().isoformat():
                continue
            e["_cal"] = cal.get("summaryOverride") or cal.get("summary", "")
            e["_calId"] = cal["id"]
            out.append(e)
    key = lambda e: e["start"].get("dateTime") or e["start"].get("date")
    return sorted(out, key=key)


def fmt(e):
    s, en = e["start"], e["end"]
    if "dateTime" in s:
        a = dt.datetime.fromisoformat(s["dateTime"]).astimezone(TZ)
        b = dt.datetime.fromisoformat(en["dateTime"]).astimezone(TZ)
        when = f"{a:%a %d %b %H:%M}–{b:%H:%M}"
    else:
        when = f"{s['date']} (all day)"
    extra = []
    if e.get("location"):
        extra.append(e["location"])
    if e.get("hangoutLink"):
        extra.append(e["hangoutLink"])
    line = f"{when} | {e.get('summary', '(no title)')} [{e['_cal']}] id={e['id']}"
    return line + (f"\n    {' · '.join(extra)}" if extra else "")


def agenda(days, start=None):
    now = dt.datetime.now(TZ)
    start = start or now
    end = (start.replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(days=days))
    evs = events_between(start, end)
    print("\n".join(fmt(e) for e in evs) if evs else "Nothing scheduled.")


def parse_time(s):
    return dt.datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=TZ)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd, rest = sys.argv[1], sys.argv[2:]
    today0 = dt.datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    if cmd == "today":
        agenda(1, today0)
    elif cmd == "tomorrow":
        agenda(1, today0 + dt.timedelta(days=1))
    elif cmd == "week":
        agenda(7, today0)
    elif cmd == "agenda":
        agenda(int(rest[0]) if rest else 3)
    elif cmd == "next":
        now = dt.datetime.now(TZ)
        evs = [e for e in events_between(now, now + dt.timedelta(days=14)) if "dateTime" in e["start"]]
        print(fmt(evs[0]) if evs else "Nothing in the next 14 days.")
    elif cmd == "calendars":
        for c in calendars():
            print(f"{c.get('summary')} | {c['id']} | {c.get('accessRole')}")
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
        body = {"summary": a.title, "description": a.desc, "location": a.where,
                "start": {"dateTime": st.isoformat(), "timeZone": "Asia/Kolkata"},
                "end": {"dateTime": en.isoformat(), "timeZone": "Asia/Kolkata"}}
        if a.attendees:
            body["attendees"] = [{"email": x.strip()} for x in a.attendees.split(",") if x.strip()]
        if a.meet:
            body["conferenceData"] = {"createRequest": {"requestId": uuid.uuid4().hex,
                                                        "conferenceSolutionKey": {"type": "hangoutsMeet"}}}
        e = C.events().insert(calendarId=a.calendar, body=body, conferenceDataVersion=1 if a.meet else 0,
                              sendUpdates="all" if a.attendees else "none").execute()
        print(f"Created: {e.get('htmlLink')}" + (f"\nMeet: {e.get('hangoutLink')}" if e.get("hangoutLink") else ""))
    elif cmd == "delete":
        p = argparse.ArgumentParser()
        p.add_argument("event_id")
        p.add_argument("--calendar", default="primary")
        a = p.parse_args(rest)
        C.events().delete(calendarId=a.calendar, eventId=a.event_id).execute()
        print("Deleted.")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
