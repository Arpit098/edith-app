"""Claude's limit and login errors (common/claude_limits.py), the reset time, and common/timer.py."""
import datetime as dt
import threading
import time
import unittest

from edith.common import usertime
from edith.common.claude_limits import classify, reset_time
from edith.common.timer import Timers

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 11, 2, 10, 0, tzinfo=UTC)  # 3:30 PM IST


def ist(y, mo, d, h, mi):
    return dt.datetime(y, mo, d, h, mi, tzinfo=usertime.user_tz()).timestamp()


class ClassifyTest(unittest.TestCase):
    def test_error_codes_win(self):
        self.assertEqual(classify("rate_limit", "anything"), "usage_limit")
        self.assertEqual(classify("authentication_failed", ""), "login")
        self.assertEqual(classify("billing_error", None), "billing")

    def test_claude_text(self):
        for text, kind in (("You've hit your 5-hour limit · resets 6:20pm (UTC)", "usage_limit"),
                           ("You've hit your weekly limit · resets 12pm (UTC)", "usage_limit"),
                           ("Claude AI usage limit reached|1761998400", "usage_limit"),
                           ("Not logged in · Please run /login", "login"),
                           ("Invalid API key · Please run /login", "login"),
                           ("Credit balance is too low", "billing")):
            self.assertEqual(classify(None, text), kind, text)

    def test_ordinary_replies_are_not_errors(self):
        for text in ("The rate limit reached 100 rps.", "", None, "Done. " + "x" * 400 + " usage limit reached",
                     "Fixed it.\nThe 5-hour limit reached message is now localized"):
            self.assertIsNone(classify(None, text), text)
        self.assertIsNone(classify("overloaded", "Overloaded"))


class ResetTimeTest(unittest.TestCase):
    def test_utc_and_local_forms(self):
        cases = (("You've hit your 5-hour limit · resets 6:20pm (UTC)", ist(2026, 11, 2, 23, 50)),
                 ("You've hit your 5-hour limit · resets 9am (UTC)", ist(2026, 11, 3, 14, 30)),  # tomorrow
                 ("You've hit your limit · resets 3pm (Asia/Kolkata)", ist(2026, 11, 3, 15, 0)),  # 3 PM is past
                 ("You've hit your limit · resets 4pm (Asia/Kolkata)", ist(2026, 11, 2, 16, 0)),
                 ("You've hit your 5-hour limit · resets 9:30 PM IST", ist(2026, 11, 2, 21, 30)),
                 ("You've hit your weekly limit · resets Nov 5, 8pm (UTC)", ist(2026, 11, 6, 1, 30)),
                 ("Claude AI usage limit reached|1793700000", 1793700000.0))
        for text, want in cases:
            self.assertEqual(reset_time(text, NOW), want, text)

    def test_no_time(self):
        for text in ("Not logged in · Please run /login", "You've hit your limit", "", None,
                     "the cron job resets at 16:00 (UTC)"):
            self.assertIsNone(reset_time(text, NOW), text)

    def test_when(self):
        now = NOW.timestamp()
        self.assertEqual(usertime.when(ist(2026, 11, 2, 21, 30), now), "9:30 PM IST")
        self.assertEqual(usertime.when(ist(2026, 11, 3, 1, 5), now), "Nov 3, 1:05 AM IST")
        self.assertEqual(usertime.when(None), "unknown")


class TimersTest(unittest.TestCase):
    def test_runs_in_order_replaces_and_cancels(self):
        timers, ran, done = Timers("t"), [], threading.Event()
        self.addCleanup(timers.stop)
        now = time.time()
        timers.schedule("b", now + 0.10, lambda: ran.append("b"))
        timers.schedule("a", now + 0.05, lambda: ran.append("a"))
        timers.schedule("x", now + 0.02, lambda: ran.append("x"))
        timers.cancel("x")
        timers.schedule("b", now + 0.15, lambda: ran.append("b2"))  # replaces b
        timers.schedule("end", now + 0.2, done.set)
        self.assertEqual(timers.when("end"), now + 0.2)
        self.assertTrue(done.wait(3))
        self.assertEqual(ran, ["a", "b2"])
        self.assertIsNone(timers.when("end"))

    def test_a_failing_timer_doesnt_stop_the_others(self):
        timers, done = Timers("t"), threading.Event()
        self.addCleanup(timers.stop)
        timers.schedule("bad", time.time(), lambda: 1 / 0)
        timers.schedule("good", time.time() + 0.02, done.set)
        self.assertTrue(done.wait(3))


if __name__ == "__main__":
    unittest.main()
