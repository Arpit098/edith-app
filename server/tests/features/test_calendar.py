"""Calendar (docs/PHASE1_PLAN.md, step 3): the repo's gcal.py must print exactly what
legacy/edith/google/gcal.py prints and send Calendar the same changes, with fewer round trips.
Everything runs against tests/fakes/google.py; nothing reads ~/.config/edith-google or calls Google."""
import contextlib
import datetime as dt
import io
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
import uuid
from unittest import mock

from edith.adapters.google.auth import Session
from edith.adapters.google.gcal import GoogleCalendar
from edith.features.calendar import cli
from tests.fakes.google import IST, FakeCalendar
from tests.golden import assert_golden
from tests.legacy import legacy_home, load

SERVER = pathlib.Path(__file__).resolve().parents[2]
SHIMS = SERVER.parent / "deploy" / "shims" / "edith" / "google"
NOW = dt.datetime(2026, 11, 2, 10, 0, tzinfo=IST)  # Monday


def at(day, hh, mm=0):
    return {"dateTime": dt.datetime(2026, 11, day, hh, mm, tzinfo=IST).isoformat(), "timeZone": "Asia/Kolkata"}


def calendars():
    return [
        {"id": "primary", "summary": "arpit@example.com", "accessRole": "owner"},
        {"id": "work@x", "summary": "Work", "summaryOverride": "Office", "accessRole": "writer", "selected": True},
        {"id": "hol@x", "summary": "Holidays in India", "accessRole": "reader"},
        {"id": "hidden@x", "summary": "Hidden", "accessRole": "reader", "selected": False},
    ]


def events():
    return {
        "primary": [
            {"id": "e1", "summary": "Standup", "start": at(2, 9), "end": at(2, 9, 30)},
            {"id": "e2", "summary": "Design review", "start": at(2, 14), "end": at(2, 15),
             "location": "Room 4", "hangoutLink": "https://meet.example/xyz"},
            {"id": "e3", "summary": "Cancelled", "status": "cancelled", "start": at(2, 16), "end": at(2, 17)},
            {"id": "e4", "summary": "UTC call", "start": {"dateTime": "2026-11-03T11:00:00Z"},
             "end": {"dateTime": "2026-11-03T11:30:00Z"}},
            {"id": "e5", "start": at(5, 8), "end": at(5, 9)},
            {"id": "e6", "summary": "Next week", "start": at(10, 9), "end": at(10, 10)},
        ],
        "work@x": [
            {"id": "w1", "summary": "1:1", "start": at(2, 10, 30), "end": at(2, 11)},
            {"id": "w2", "summary": "Offsite", "start": at(4, 9), "end": at(4, 17), "location": "Pune"},
        ],
        "hol@x": [
            {"id": "h1", "summary": "Yesterday's holiday", "start": {"date": "2026-11-01"}, "end": {"date": "2026-11-02"}},
            {"id": "h2", "summary": "Holiday", "start": {"date": "2026-11-03"}, "end": {"date": "2026-11-04"}},
        ],
        "hidden@x": [{"id": "x1", "summary": "Never shown", "start": at(2, 12), "end": at(2, 13)}],
    }


SCRIPT = [
    [], ["bogus"], ["today"], ["tomorrow"], ["week"], ["agenda"], ["agenda", "2"], ["agenda", "0"], ["next"],
    ["calendars"],
    ["create", "--title", "Lunch", "--start", "2026-11-04 13:00", "--minutes", "45", "--where", "Cafe",
     "--attendees", "a@example.com, b@example.com", "--meet"],
    ["create", "--title", "Solo", "--start", "2026-11-04 18:00", "--end", "2026-11-04 19:30", "--desc", "Focus",
     "--calendar", "work@x"],
    ["delete", "e6"],
    ["delete", "w1", "--calendar", "work@x"],
]


class Frozen(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz)


class Creds:
    valid, scopes = True, []


def new_calendar(api):
    return GoogleCalendar(Session("/nonexistent", load=lambda p: Creds(), build=lambda n, v, c: api))


def transcript(main):
    out = io.StringIO()
    for argv in SCRIPT:
        out.write(f"$ gcal.py {' '.join(argv)}\n")
        with mock.patch.object(sys, "argv", ["gcal.py", *argv]), contextlib.redirect_stdout(out), \
                mock.patch("uuid.uuid4", return_value=uuid.UUID(int=1)):
            main(argv)
    return out.getvalue()


def legacy_gcal(api):
    gauth = types.ModuleType("gauth")
    gauth.service = lambda name, version: api
    with legacy_home():
        legacy = load("google/gcal.py", modules={"gauth": gauth})
    legacy.dt = types.SimpleNamespace(datetime=Frozen, timedelta=dt.timedelta)  # legacy's clock, frozen
    return legacy


class CalendarParityTest(unittest.TestCase):
    def test_legacy_and_new_match_golden(self):
        old_api, new_api = FakeCalendar(calendars(), events()), FakeCalendar(calendars(), events())
        legacy = legacy_gcal(old_api)
        old = transcript(lambda argv: legacy.main())
        with mock.patch.object(cli, "now", return_value=NOW):
            new = transcript(lambda argv: cli.main(argv, cal=new_calendar(new_api)))
        # Only legacy records golden files; the new code is held to legacy directly.
        assert_golden(self, "google/gcal.txt", old)
        assert_golden(self, "google/gcal_writes.json", old_api.writes())
        self.maxDiff = None
        self.assertEqual(new, old)
        self.assertEqual(new_api.writes(), old_api.writes())

    def test_one_batch_for_all_calendars(self):
        old_api, new_api = FakeCalendar(calendars(), events()), FakeCalendar(calendars(), events())
        legacy = legacy_gcal(old_api)
        start = NOW.replace(hour=0)
        with contextlib.redirect_stdout(io.StringIO()):
            legacy.agenda(1, start)
        new_calendar(new_api).events(start, start + dt.timedelta(days=1))
        self.assertEqual((old_api.round_trips, new_api.round_trips), (4, 2))  # 1 list + 3 calendars vs 1 + 1 batch


class WrapperTest(unittest.TestCase):
    def test_help_needs_no_token_or_network(self):
        with tempfile.TemporaryDirectory() as home:
            env = {"HOME": home, "EDITH_APP_SERVER": str(SERVER), "PATH": "/usr/bin:/bin"}
            r = subprocess.run([sys.executable, "-I", str(SHIMS / "gcal.py"), "help"], capture_output=True,
                               text=True, env=env)
        self.assertEqual(r.stdout, cli.__doc__ + "\n")


if __name__ == "__main__":
    unittest.main()
