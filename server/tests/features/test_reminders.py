"""Reminders (docs/PHASE1_PLAN.md, step 1): the repo code must behave exactly like the legacy
reminders.py, remind.py and the bridge's reminder parts, as recorded from them in tests/golden/data/."""
import contextlib
import io
import itertools
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime
from unittest import mock

from edith.core import EventBus, Ports, Registry, load_features
from edith.features.reminders import cli, store
from edith.features.reminders.store import Store, next_due
from tests.golden import DATA, assert_matches
from tests.home import temp_home

SERVER = pathlib.Path(__file__).resolve().parents[2]
REPO = SERVER.parent
SHIMS = REPO / "deploy" / "shims" / "edith"

# The fixtures the golden files were recorded with (the ids would otherwise be random).
# Due Mon 2026-11-02 08:00 IST and Fri 2026-11-06 17:30 IST.
REMINDERS = [
    {"id": "aa11bb", "due": 1793586600.0, "text": "Pay rent", "every": "monthly", "chat_id": None, "created": 0},
    {"id": "cc22dd", "due": 1793966400.0, "text": "Renew the domain", "every": None, "chat_id": None, "created": 0},
]
NOW = 1793500000.0  # Sun 01 Nov 2026, 07:56 IST
# For firing at NOW: one 10 minutes late (repeating), one just due, one not yet due.
FIRE = [
    {"id": "a1b2c3", "due": NOW - 600, "text": "Stand up", "every": "daily", "chat_id": None, "created": 0},
    {"id": "d4e5f6", "due": NOW - 30, "text": "Call mum", "every": None, "chat_id": None, "created": 0},
    {"id": "0a0b0c", "due": NOW + 3600, "text": "Later", "every": None, "chat_id": None, "created": 0},
]


def golden(name):
    return json.loads((DATA / name).read_text())


def frozen(now=NOW):
    """Fixed time and ids ("000001", "000002", …) so legacy and new runs can be compared."""
    ids = itertools.count(1)
    stack = contextlib.ExitStack()
    stack.enter_context(mock.patch("time.time", return_value=now))
    stack.enter_context(mock.patch("secrets.token_hex", side_effect=lambda n: f"{next(ids):06x}"))
    return stack


def telegram_markup(rows):
    """What the Telegram adapter (step 6) will send for a reply's buttons."""
    return {"inline_keyboard": [[{"text": b["label"], "callback_data": b["action"]} for b in row] for row in rows]}


class StoreParityTest(unittest.TestCase):
    """The same operations give the legacy module's results and file contents, step by step."""

    def test_same_results_and_file(self):
        want = golden("reminders/store_steps.json")
        with temp_home() as home:
            new = Store(str(home / "new" / "reminders.json"))
            steps = [
                ("add", (NOW - 100, "Pay rent", "monthly")),
                ("add", (NOW + 50, "Renew the domain")),
                ("add", (NOW + 7200, "Standup", "weekdays")),
                ("pending", ()),
                ("snooze", ("000001", NOW + 900)),     # repeating: a one-off copy is made
                ("snooze", ("000002", NOW + 30)),
                ("cancel", ("000003",)),
                ("cancel", ("nope",)),
                ("pop_due", (NOW + 60,)),               # fires the rent (and advances it) and the domain
                ("pending", ()),
                ("snooze", ("000002", NOW + 120)),      # a fired one-off can still be snoozed
                ("pop_due", (NOW + 4 * 86400,)),        # fires again; old fired ones expire
                ("pending", ()),
            ]
            self.assertEqual([w["step"] for w in want], [name for name, _ in steps])
            for (name, args), expected in zip(steps, want):
                with frozen():
                    got = getattr(new, name)(*args)
                self.assertEqual(json.loads(json.dumps(got)), expected["result"], name)  # tuples -> lists, as recorded
                self.assertEqual(pathlib.Path(new.path).read_text(), expected["file"], name)

    def test_next_due(self):
        ist = store.TZ
        ts = lambda *a: datetime(*a, tzinfo=ist).timestamp()
        self.assertEqual(next_due(ts(2026, 1, 31, 9), "monthly", ts(2026, 2, 1)), ts(2026, 2, 28, 9))
        self.assertEqual(next_due(ts(2026, 10, 30, 9), "weekdays", ts(2026, 10, 30, 10)), ts(2026, 11, 2, 9))
        self.assertEqual(next_due(ts(2026, 12, 15, 9), "monthly", ts(2026, 12, 16)), ts(2027, 1, 15, 9))
        with self.assertRaises(ValueError):
            next_due(0, "yearly", 10)


class StoreEfficiencyTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.store = Store(os.path.join(self.dir, "reminders.json"))

    def test_nothing_due_means_no_lock_and_no_write(self):
        self.store.add(time.time() + 3600, "later")
        mtime = os.stat(self.store.path).st_mtime_ns
        with mock.patch("fcntl.flock") as flock:
            self.assertEqual(self.store.pop_due(), [])
            self.store.pending()
        flock.assert_not_called()
        self.assertEqual(os.stat(self.store.path).st_mtime_ns, mtime)

    def test_parsed_once_until_the_file_changes(self):
        self.store.add(time.time() + 3600, "a")
        with mock.patch("json.load", side_effect=json.load) as parse:
            for _ in range(5):
                self.store.pending()
                self.store.next_wake()
            self.assertEqual(parse.call_count, 0)  # cached from our own write
            other = Store(self.store.path)        # another process (remind.py) adds one
            other.add(time.time() + 60, "b")
            self.assertEqual([r["text"] for r in self.store.pending()], ["b", "a"])
            self.assertEqual(parse.call_count, 2)  # `other` read it once, then we re-read once

    def test_next_wake_follows_the_earliest(self):
        self.assertIsNone(self.store.next_wake())
        self.store.add(NOW + 300, "b")
        self.store.add(NOW + 60, "a")
        self.assertEqual(self.store.next_wake(NOW), 60)
        self.assertEqual(self.store.next_wake(NOW + 100), 0)

    def test_unchanged_write_is_skipped(self):
        self.store.add(NOW + 60, "a")
        mtime = os.stat(self.store.path).st_mtime_ns
        self.assertIsNone(self.store.cancel("missing"))
        self.assertEqual(os.stat(self.store.path).st_mtime_ns, mtime)

    def test_corrupt_file_is_kept_aside_not_overwritten(self):
        with open(self.store.path, "w") as f:
            f.write("{not json")
        self.assertEqual(self.store.pending(), [])
        with self.assertLogs("edith.feature.reminders", "ERROR"):
            self.store.add(NOW + 60, "new")
        aside = [n for n in os.listdir(self.dir) if ".corrupt-" in n]
        self.assertEqual(len(aside), 1)
        with open(os.path.join(self.dir, aside[0])) as f:
            self.assertEqual(f.read(), "{not json")
        self.assertEqual([r["text"] for r in self.store.pending()], ["new"])


def run_cli(main, argv):
    """Run a remind.py main() the way the shell does; returns its output (and exit message)."""
    out = io.StringIO()
    with mock.patch.object(sys, "argv", ["remind.py", *argv]), contextlib.redirect_stdout(out):
        try:
            main()
        except SystemExit as e:
            if e.code not in (None, 0):
                out.write(f"[exit] {e.code}\n")
    return out.getvalue()


CLI_SCRIPT = [
    ["list"],
    ["add", "2026-11-02 08:00", "Pay rent", "--every", "monthly"],
    ["add", "2026-11-06", "Renew the domain"],
    ["add", "+30m", "Stretch"],
    ["add", "2020-01-01 10:00", "Too late"],
    ["add", "next friday", "x"],
    ["list"],
    ["cancel", "000002"],
    ["cancel", "nope"],
    ["list"],
]


CLOCK = datetime(2026, 11, 2, 10, 43, tzinfo=store.TZ)  # a fixed "now" for clock-time parsing
CLOCK_INPUTS = ("00:00", "10:43", "12:30", "23:59", "+2h", "+1d", "2026-12-01T10:00", "2026-12-01")


class CliTest(unittest.TestCase):
    def transcript(self, main):
        with frozen():
            return "".join(f"$ remind.py {' '.join(argv)}\n{run_cli(main, argv)}" for argv in CLI_SCRIPT)

    def test_same_output_as_legacy(self):
        self.maxDiff = None
        with temp_home():
            assert_matches(self, "reminders/cli.txt", self.transcript(cli.main))

    def test_clock_times_match_legacy(self):
        want = golden("reminders/parse_when.json")  # recorded from legacy with its clock frozen at CLOCK
        self.assertEqual(sorted(want), sorted(CLOCK_INPUTS))
        for when in CLOCK_INPUTS:
            with mock.patch("time.time", return_value=NOW):
                self.assertEqual(cli.parse_when(when, now=CLOCK), want[when], when)


class FeatureTest(unittest.TestCase):
    """The feature's replies, buttons and messages equal the legacy bridge's recorded Telegram calls."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.bus, self.registry = EventBus(), Registry()
        report = load_features(["reminders"], self.bus, Ports(), self.registry,
                               {"reminders": {"state_dir": self.dir}})
        self.assertEqual(report.loaded, ["reminders"])
        self.path = os.path.join(self.dir, "reminders.json")

    def write(self, items):
        with open(self.path, "w") as f:
            json.dump(items, f)

    def command(self, name):
        return self.registry.commands[name].handler(None)

    def test_empty_list(self):
        self.assertEqual(self.command("reminders"), golden("bridge/reminders_empty.json")[1]["text"])

    def test_list_and_cancel(self):
        want = golden("bridge/reminders_list_cancel.json")
        self.write(REMINDERS)
        reply = self.command("reminders").as_data()
        self.assertEqual((reply["text"], telegram_markup(reply["buttons"])), (want[1]["text"], want[1]["reply_markup"]))
        sent = []
        first = self.registry.press("rem:cancel:cc22dd", "telegram", sent.append)
        second = self.registry.press("rem:cancel:cc22dd", "telegram", sent.append)
        self.assertEqual([first.toast, sent, second.toast], [want[2]["text"], [want[3]["text"]], want[4]["text"]])

    def test_snooze(self):
        want = golden("bridge/reminder_snooze.json")
        self.write(REMINDERS)
        with mock.patch("time.time", return_value=NOW):
            r1 = self.registry.press("rem:snooze:15:cc22dd", "telegram", None)
            r2 = self.registry.press("rem:snooze:60:aa11bb", "telegram", None)
        self.assertEqual([r1.toast, "⏰ Renew the domain\n\n" + r1.note], [want[0]["text"], want[1]["text"]])
        self.assertEqual([r2.toast, "⏰ Pay rent\n\n" + r2.note], [want[2]["text"], want[3]["text"]])
        self.assertEqual(self.registry.press("rem:snooze:15:gone", "telegram", None).toast,
                         "That reminder has expired.")

    def test_done_keeps_repeating_and_clears_one_offs(self):
        self.write(REMINDERS)
        for rid in ("aa11bb", "cc22dd"):
            self.assertEqual(self.registry.press(f"rem:done:{rid}", "telegram", None).note, "✅ Done")
        self.assertEqual([r["id"] for r in Store(self.path).pending()], ["aa11bb"])

    def test_firing_matches_legacy_and_sleeps_until_next(self):
        want = golden("bridge/reminder_fire.json")
        self.write(FIRE)
        messages, due = [], []
        self.bus.subscribe("message.system", lambda ev: messages.append(ev.data))
        self.bus.subscribe("reminder.due", lambda ev: due.append(ev.data["id"]))
        job = self.registry.jobs["reminders.fire"]
        with mock.patch("time.time", return_value=NOW):
            wait = job.run()
            self.assertEqual(job.run(), wait)  # nothing fires twice
        # message.system goes to the first allowed chat; the legacy bridge passes it as a string.
        got = [{"chat_id": "111", "method": "sendMessage", "text": m["text"],
                "reply_markup": telegram_markup(m["buttons"])} for m in messages]
        self.assertEqual(got, want)
        self.assertEqual(due, ["a1b2c3", "d4e5f6"])
        self.assertEqual(wait, 10.0)  # next is an hour away, so it re-checks the file in 10 s


class WrapperTest(unittest.TestCase):
    """deploy/shims: the files that replace ~/edith/bridge/reminders.py and ~/edith/bin/remind.py."""

    def test_remind_wrapper_runs_repo_cli(self):
        with tempfile.TemporaryDirectory() as home:
            env = {"HOME": home, "EDITH_APP_SERVER": str(SERVER), "PATH": os.environ["PATH"]}
            run = lambda *a: subprocess.run([sys.executable, "-I", str(SHIMS / "bin/remind.py"), *a],
                                            capture_output=True, text=True, env=env)
            self.assertEqual(run("list").stdout, "No reminders.\n")
            added = run("add", "+1d", "Water the plants")
            self.assertRegex(added.stdout, r"^Added [0-9a-f]{6}: .* IST - Water the plants\n$")
            self.assertIn("Water the plants", run("list").stdout)
            data = json.loads(pathlib.Path(home, ".cache/edith/reminders.json").read_text())
            self.assertEqual([r["text"] for r in data], ["Water the plants"])

    def test_bridge_wrapper_keeps_the_legacy_module_names(self):
        """~/edith/bridge/reminders.py: anything that still does `import reminders` gets the store."""
        with tempfile.TemporaryDirectory() as home:
            code = ("import reminders; print(sorted(n for n in ('FILE', 'add', 'cancel', 'fmt', 'pending', 'pop_due', "
                    "'snooze', 'tomorrow_at') if hasattr(reminders, n)), reminders.FILE)")
            r = subprocess.run([sys.executable, "-I", "-c", f"import sys; sys.path.insert(0, {str(SHIMS / 'bridge')!r}); {code}"],
                               capture_output=True, text=True,
                               env={"HOME": home, "EDITH_APP_SERVER": str(SERVER), "PATH": os.environ["PATH"]})
            self.assertEqual(r.stdout, "['FILE', 'add', 'cancel', 'fmt', 'pending', 'pop_due', 'snooze', 'tomorrow_at'] "
                                       f"{home}/.cache/edith/reminders.json\n", r.stderr)


if __name__ == "__main__":
    unittest.main()
