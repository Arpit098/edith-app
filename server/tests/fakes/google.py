"""Fake Gmail and Calendar API services (the googleapiclient object shape), so nothing in the tests
reads ~/.config/edith-google or reaches Google.

Both the legacy scripts (given a fake `gauth` module) and the new adapter run against these.
`round_trips` counts HTTP round trips (one per execute(), one per batch), `calls` records every
request, and `fail` injects errors: {"messages.get": [error, …]} raises them in order.
"""
import base64
from datetime import date, datetime, time
from types import SimpleNamespace
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")


class HttpError(Exception):
    """Looks like googleapiclient.errors.HttpError to the adapter (exc.resp.status)."""

    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.resp = SimpleNamespace(status=status)


class Request:
    def __init__(self, api, kind, kwargs, fn):
        self.api, self.kind, self.kwargs, self.fn = api, kind, kwargs, fn

    def run(self):
        self.api.calls.append((self.kind, self.kwargs))
        queued = self.api.fail.get(self.kind)
        if queued:
            raise queued.pop(0)
        return self.fn()

    def execute(self, num_retries=0, http=None):
        self.api.round_trips += 1
        self.api.retries_asked.append(num_retries)
        return self.run()


class Batch:
    def __init__(self, api, callback):
        self.api, self.callback, self.items = api, callback, []

    def add(self, request, callback=None, request_id=None):
        self.items.append((request, request_id))

    def execute(self):
        self.api.round_trips += 1
        self.api.batch_sizes.append(len(self.items))
        for request, rid in self.items:
            try:
                response = request.run()
            except Exception as e:
                self.callback(rid, None, e)
            else:
                self.callback(rid, response, None)


class FakeApi:
    def __init__(self):
        self.calls, self.round_trips, self.batch_sizes, self.retries_asked = [], 0, [], []
        self.fail = {}

    def _req(self, kind, kwargs, fn):
        return Request(self, kind, kwargs, fn)

    def new_batch_http_request(self, callback=None):
        return Batch(self, callback)

    def writes(self):
        """The requests that change something, for golden files."""
        return [{"kind": k, **kw} for k, kw in self.calls if k in self.WRITES]


# ---------- Gmail ----------

def b64(text):
    return base64.urlsafe_b64encode(text.encode()).decode()


def mail(id, thread, sender, subject, date, labels, snippet="", to="arpit@example.com", plain=None, html=None,
         extra_headers=()):
    """A message as Gmail returns it with format=full."""
    parts = []
    if plain is not None:
        parts.append({"mimeType": "text/plain", "body": {"data": b64(plain)}})
    if html is not None:
        parts.append({"mimeType": "text/html", "body": {"data": b64(html)}})
    headers = [{"name": "From", "value": sender}, {"name": "To", "value": to},
               {"name": "Subject", "value": subject}, {"name": "Date", "value": date}, *extra_headers]
    return {"id": id, "threadId": thread, "labelIds": labels, "snippet": snippet,
            "payload": {"mimeType": "multipart/alternative", "headers": headers, "parts": parts}}


class FakeGmail(FakeApi):
    WRITES = {"messages.batchModify", "drafts.create", "messages.send"}

    def __init__(self, messages):
        super().__init__()
        self.store = {m["id"]: m for m in messages}

    def users(self):
        return self

    def messages(self):
        api = self

        class Messages:
            def list(self, userId, q, maxResults):
                def run():
                    found = [m for m in api.store.values()
                             if q != "is:unread in:inbox" or {"UNREAD", "INBOX"} <= set(m["labelIds"])]
                    found = found[:maxResults]
                    return {"messages": [{"id": m["id"], "threadId": m["threadId"]} for m in found]} if found else {}
                return api._req("messages.list", {"q": q, "maxResults": maxResults}, run)

            def get(self, userId, id, format, metadataHeaders=None):
                def run():
                    m = api.store[id]
                    if format != "metadata":
                        return m
                    keep = {h.lower() for h in metadataHeaders or ()}
                    headers = [h for h in m["payload"]["headers"] if h["name"].lower() in keep]
                    return {"id": m["id"], "threadId": m["threadId"], "labelIds": m["labelIds"],
                            "snippet": m["snippet"], "payload": {"headers": headers}}
                return api._req("messages.get", {"id": id, "format": format}, run)

            def batchModify(self, userId, body):
                return api._req("messages.batchModify", {"body": body}, lambda: {})

            def send(self, userId, body):
                return api._req("messages.send", {"body": body}, lambda: {"id": "sent1"})

        return Messages()

    def threads(self):
        api = self

        class Threads:
            def get(self, userId, id, format):
                return api._req("threads.get", {"id": id}, lambda: {
                    "id": id, "messages": [m for m in api.store.values() if m["threadId"] == id]})

        return Threads()

    def drafts(self):
        api = self

        class Drafts:
            def create(self, userId, body):
                return api._req("drafts.create", {"body": body}, lambda: {"id": "draft1"})

        return Drafts()

    def getProfile(self, userId):
        return self._req("getProfile", {}, lambda: {"emailAddress": "arpit@example.com", "messagesTotal": 1234})


# ---------- Calendar ----------

def _when(t):
    if "dateTime" in t:
        return datetime.fromisoformat(t["dateTime"])
    return datetime.combine(date.fromisoformat(t["date"]), time(0), IST)


class FakeCalendar(FakeApi):
    WRITES = {"events.insert", "events.delete"}

    def __init__(self, calendars, events):
        super().__init__()
        self.cals, self.events_by_cal = calendars, events

    def calendarList(self):
        api = self

        class CalendarList:
            def list(self):
                return api._req("calendarList.list", {}, lambda: {"items": api.cals})

        return CalendarList()

    def events(self):
        api = self

        class Events:
            def list(self, calendarId, timeMin, timeMax, singleEvents, orderBy, maxResults):
                def run():
                    lo, hi = datetime.fromisoformat(timeMin), datetime.fromisoformat(timeMax)
                    items = [e for e in api.events_by_cal.get(calendarId, [])
                             if _when(e["start"]) < hi and _when(e["end"]) > lo]
                    return {"items": sorted(items, key=lambda e: _when(e["start"]))[:maxResults]}
                return api._req("events.list", {"calendarId": calendarId, "timeMin": timeMin, "timeMax": timeMax}, run)

            def insert(self, calendarId, body, conferenceDataVersion, sendUpdates):
                def run():
                    out = {"id": "new1", "htmlLink": "https://calendar.example/new1"}
                    if "conferenceData" in body:
                        out["hangoutLink"] = "https://meet.example/abc"
                    return out
                return api._req("events.insert", {"calendarId": calendarId, "body": body,
                                                  "conferenceDataVersion": conferenceDataVersion,
                                                  "sendUpdates": sendUpdates}, run)

            def delete(self, calendarId, eventId):
                return api._req("events.delete", {"calendarId": calendarId, "eventId": eventId}, lambda: "")

        return Events()
