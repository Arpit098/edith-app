"""Google Calendar, implementing ports.calendar.Calendar (from legacy/edith/google/gcal.py).

Events from all selected calendars are fetched in one batched request instead of one per calendar.
"""
import uuid
from datetime import date, datetime
from zoneinfo import ZoneInfo

from edith.ports.calendar import CalendarEvent, CalendarInfo, CreatedEvent

from .api import batch, execute

DEFAULT_TZ = "Asia/Kolkata"  # Arpit's time zone


def _when(t):
    return datetime.fromisoformat(t["dateTime"]) if "dateTime" in t else date.fromisoformat(t["date"])


class GoogleCalendar:
    def __init__(self, session):
        self._session = session

    @property
    def _c(self):
        return self._session.service("calendar", "v3")

    def _selected(self):
        return [c for c in execute(self._c.calendarList().list()).get("items", []) if c.get("selected", True)]

    def calendars(self):
        return [CalendarInfo(id=c["id"], name=c.get("summary"), access_role=c.get("accessRole")) for c in self._selected()]

    def events(self, start, end):
        c, cals = self._c, self._selected()
        lists = [c.events().list(calendarId=cal["id"], timeMin=start.isoformat(), timeMax=end.isoformat(),
                                 singleEvents=True, orderBy="startTime", maxResults=100) for cal in cals]
        first_day = start.astimezone(ZoneInfo(DEFAULT_TZ)).date().isoformat()
        out = []
        for cal, res in zip(cals, batch(c, lists)):
            for e in res.get("items", []):
                if e.get("status") == "cancelled":
                    continue
                # all-day events from calendars in other time zones can leak in from yesterday
                if "date" in e["end"] and e["end"]["date"] <= first_day:
                    continue
                key = e["start"].get("dateTime") or e["start"].get("date")  # legacy order: by the raw string
                out.append((key, CalendarEvent(
                    id=e["id"], calendar_id=cal["id"], calendar=cal.get("summaryOverride") or cal.get("summary", ""),
                    title=e.get("summary", "(no title)"), start=_when(e["start"]), end=_when(e["end"]),
                    location=e.get("location") or "", meet_link=e.get("hangoutLink") or "")))
        out.sort(key=lambda pair: pair[0])
        return [ev for _, ev in out]

    def create(self, event):
        tz = getattr(event.start.tzinfo, "key", DEFAULT_TZ)
        body = {"summary": event.title, "description": event.description, "location": event.location,
                "start": {"dateTime": event.start.isoformat(), "timeZone": tz},
                "end": {"dateTime": event.end.isoformat(), "timeZone": tz}}
        if event.attendees:
            body["attendees"] = [{"email": a} for a in event.attendees]
        if event.meet:
            body["conferenceData"] = {"createRequest": {"requestId": uuid.uuid4().hex,
                                                        "conferenceSolutionKey": {"type": "hangoutsMeet"}}}
        e = execute(self._c.events().insert(calendarId=event.calendar_id, body=body,
                                            conferenceDataVersion=1 if event.meet else 0,
                                            sendUpdates="all" if event.attendees else "none"))
        return CreatedEvent(id=e.get("id", ""), link=e.get("htmlLink"), meet_link=e.get("hangoutLink") or "")

    def delete(self, event_id, calendar_id="primary"):
        execute(self._c.events().delete(calendarId=calendar_id, eventId=event_id))
