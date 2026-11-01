"""common/usertime.py: the user's timezone and Claude Code's usage-limit times rewritten into it."""
import datetime as dt
import subprocess
import unittest

from edith.adapters.agents.claude_tmux.live import events_of
from edith.adapters.agents.claude_tmux.tmux import Tmux
from edith.common import usertime
from edith.common.claude_screen import read_screen
from edith.common.usertime import localize_limit_text
from edith.features.notifications import preview

NOW = dt.datetime(2026, 11, 1, 10, 0, tzinfo=dt.timezone.utc)  # 3:30 PM IST


def ist(text, now=NOW):
    return localize_limit_text(text, "Asia/Kolkata", now)


class LocalizeTest(unittest.TestCase):
    def test_am_pm(self):
        self.assertEqual(ist("5-hour limit reached ∙ resets 4pm (UTC)"), "5-hour limit reached ∙ resets 9:30 PM IST")
        self.assertEqual(ist("resets 9am (Etc/UTC)"), "resets 2:30 PM IST")
        self.assertEqual(ist("resets 12pm (UTC)"), "resets 5:30 PM IST")
        self.assertEqual(ist("resets 12am (GMT)"), "resets 5:30 AM IST")
        self.assertEqual(ist("resets 4 p.m. (UTC)"), "resets 9:30 PM IST")

    def test_minutes_and_24_hour(self):
        self.assertEqual(ist("resets 4:30pm (UTC)"), "resets 10:00 PM IST")
        self.assertEqual(ist("resets at 16:45 (UTC)"), "resets at 10:15 PM IST")

    def test_date(self):
        self.assertEqual(ist("You've hit your limit · resets Nov 2, 4pm (UTC)"),
                         "You've hit your limit · resets Nov 2, 9:30 PM IST")
        self.assertEqual(ist("weekly limit reached ∙ resets Nov 5 at 3am (Etc/UTC)"),
                         "weekly limit reached ∙ resets Nov 5, 8:30 AM IST")
        # in December, "Jan 3" is next year's
        self.assertEqual(ist("resets Jan 3, 4pm (UTC)", dt.datetime(2026, 12, 30, tzinfo=dt.timezone.utc)),
                         "resets Jan 3, 9:30 PM IST")

    def test_midnight_roll(self):
        self.assertEqual(ist("resets Nov 2, 8pm (UTC)"), "resets Nov 3, 1:30 AM IST")
        self.assertEqual(ist("resets Oct 31, 11pm (UTC)"), "resets Nov 1, 4:30 AM IST")
        self.assertEqual(ist("resets 7pm (UTC)"), "resets 12:30 AM IST")

    def test_epoch_form(self):
        ts = int(dt.datetime(2026, 11, 1, 14, 0, tzinfo=dt.timezone.utc).timestamp())
        self.assertEqual(ist(f"Claude AI usage limit reached|{ts}"), "Claude AI usage limit reached ∙ resets 7:30 PM IST")
        self.assertEqual(ist(f"Claude AI usage limit reached|{ts + 86400}"),
                         "Claude AI usage limit reached ∙ resets Nov 2, 7:30 PM IST")

    def test_unknown_formats_untouched(self):
        for text in ("resets 4pm (America/New_York)", "resets soon (UTC)", "resets 4 (UTC)", "resets 13pm (UTC)",
                     "resets Foo 2, 4pm (UTC)", "resets Feb 30, 4pm (UTC)", "the meeting is at 4pm (UTC)",
                     "rate limit reached", "", "a | b (c)"):
            self.assertEqual(ist(text), text)
        self.assertIsNone(localize_limit_text(None))

    def test_idempotent_on_local_text(self):
        once = ist("5-hour limit reached ∙ resets 4pm (UTC)")
        self.assertEqual(ist(once), once)
        self.assertEqual(ist("resets 9:30pm (Asia/Kolkata)"), "resets 9:30pm (Asia/Kolkata)")

    def test_other_zone_and_rest_of_text_kept(self):
        text = "Done.\n\n5-hour limit reached ∙ resets 4pm (UTC)\nmore"
        self.assertEqual(localize_limit_text(text, "Europe/London", NOW), "Done.\n\n5-hour limit reached ∙ resets 4:00 PM GMT\nmore")

    def test_default_zone_and_configure(self):
        self.assertEqual(usertime.tz_name(), "Asia/Kolkata")
        self.assertEqual(usertime.configure("Not/AZone"), "Asia/Kolkata")  # unknown: kept
        self.assertEqual(usertime.env({"A": "1"}), {"A": "1", "TZ": "Asia/Kolkata"})
        try:
            self.assertEqual(usertime.configure("Europe/London"), "Europe/London")
            self.assertEqual(usertime.env()["TZ"], "Europe/London")
        finally:
            usertime.configure(usertime.DEFAULT_TZ)


class AppliedTest(unittest.TestCase):
    """The text paths that can carry a limit line show it in the user's zone."""

    def test_screen_last_line(self):
        seen = read_screen("● 5-hour limit reached ∙ resets 4pm (UTC)\n\n❯ \n")
        self.assertEqual(seen["blocked"], "usage_limit")
        self.assertTrue(seen["last"].endswith(":30 PM IST"), seen["last"])

    def test_transcript_assistant_message(self):
        e = {"type": "assistant", "isApiErrorMessage": True,
             "message": {"content": [{"type": "text", "text": "5-hour limit reached ∙ resets 4pm (UTC)"}]}}
        [(kind, _, data)] = events_of(e, {})
        self.assertEqual(kind, "message.assistant")
        self.assertRegex(data["text"], r"resets \d{1,2}:30 PM IST$")

    def test_push_preview(self):
        self.assertRegex(preview("resets Nov 2, 4pm (UTC)"), r"^resets Nov 2, 9:30 PM IST$")


class LaunchEnvTest(unittest.TestCase):
    def test_respawn_sets_tz(self):
        calls = []
        tmux = Tmux(runner=lambda *a, input=None: calls.append(a) or subprocess.CompletedProcess(a, 0, "", ""))
        tmux.respawn("launch.sh abc", env=usertime.env())
        self.assertEqual(calls, [("respawn-pane", "-k", "-e", "TZ=Asia/Kolkata", "-t", "edith", "launch.sh abc")])
        tmux.respawn("launch.sh")
        self.assertEqual(calls[-1], ("respawn-pane", "-k", "-t", "edith", "launch.sh"))


if __name__ == "__main__":
    unittest.main()
