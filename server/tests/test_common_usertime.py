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


LIMIT = "5-hour limit reached ∙ "


def ist(text, now=NOW):
    return localize_limit_text(text, "Asia/Kolkata", now)


def lim(text, now=NOW):
    """`text` after Claude's limit wording, converted, with that wording taken off again."""
    out = ist(LIMIT + text, now)
    return out[len(LIMIT):] if out.startswith(LIMIT) else out


class LocalizeTest(unittest.TestCase):
    def test_am_pm(self):
        self.assertEqual(ist("5-hour limit reached ∙ resets 4pm (UTC)"), "5-hour limit reached ∙ resets 9:30 PM IST")
        self.assertEqual(lim("resets 9am (Etc/UTC)"), "resets 2:30 PM IST")
        self.assertEqual(lim("resets 12pm (UTC)"), "resets 5:30 PM IST")
        self.assertEqual(lim("resets 12am (GMT)"), "resets 5:30 AM IST")
        self.assertEqual(lim("resets 4 p.m. (UTC)"), "resets 9:30 PM IST")

    def test_minutes_and_24_hour(self):
        self.assertEqual(lim("resets 4:30pm (UTC)"), "resets 10:00 PM IST")
        self.assertEqual(lim("resets at 16:45 (UTC)"), "resets at 10:15 PM IST")
        self.assertEqual(ist("Your limit will reset at 4pm (UTC)"), "Your limit will reset at 9:30 PM IST")

    def test_date(self):
        self.assertEqual(ist("You've hit your limit · resets Nov 2, 4pm (UTC)"),
                         "You've hit your limit · resets Nov 2, 9:30 PM IST")
        self.assertEqual(ist("weekly limit reached ∙ resets Nov 5 at 3am (Etc/UTC)"),
                         "weekly limit reached ∙ resets Nov 5, 8:30 AM IST")
        # in December, "Jan 3" is next year's
        self.assertEqual(lim("resets Jan 3, 4pm (UTC)", dt.datetime(2026, 12, 30, tzinfo=dt.timezone.utc)),
                         "resets Jan 3, 9:30 PM IST")

    def test_midnight_roll(self):
        self.assertEqual(lim("resets Nov 2, 8pm (UTC)"), "resets Nov 3, 1:30 AM IST")
        self.assertEqual(lim("resets Oct 31, 11pm (UTC)"), "resets Nov 1, 4:30 AM IST")
        self.assertEqual(lim("resets 7pm (UTC)"), "resets 12:30 AM IST")

    def test_epoch_form(self):
        ts = int(dt.datetime(2026, 11, 1, 14, 0, tzinfo=dt.timezone.utc).timestamp())
        self.assertEqual(ist(f"Claude AI usage limit reached|{ts}"), "Claude AI usage limit reached ∙ resets 7:30 PM IST")
        self.assertEqual(ist(f"Claude AI usage limit reached|{ts + 86400}"),
                         "Claude AI usage limit reached ∙ resets Nov 2, 7:30 PM IST")

    def test_unknown_formats_untouched(self):
        for text in ("resets 4pm (America/New_York)", "resets soon (UTC)", "resets 4 (UTC)", "resets 13pm (UTC)",
                     "resets Foo 2, 4pm (UTC)", "resets Feb 30, 4pm (UTC)", "the meeting is at 4pm (UTC)"):
            self.assertEqual(ist(LIMIT + text), LIMIT + text)
        for text in ("rate limit reached", "", "a | b (c)"):
            self.assertEqual(ist(text), text)
        self.assertIsNone(localize_limit_text(None))

    def test_other_text_with_a_utc_reset_untouched(self):
        for text in ("The cron job resets at 16:00 (UTC) daily",
                     "quota resets 00:00 (GMT)",
                     "See https://example.com/docs?q=resets+4pm+(UTC) for when it resets 4pm (UTC)",
                     "rate limit reached; the bucket resets 4pm (UTC)",  # not Claude's wording
                     # Claude's wording, but far before the time
                     "You've hit your limit. " + "x" * 80 + " the counter resets 4pm (UTC)",
                     # on another line than the time
                     "5-hour limit reached\nthe counter resets 4pm (UTC)",
                     # in fenced code, even with the wording
                     "Example:\n```\n# 5-hour limit reached: counter resets 4pm (UTC)\n```",
                     "~~~python\nmsg = 'weekly limit reached ∙ resets 4pm (UTC)'\n~~~"):
            self.assertEqual(ist(text), text)
        # after the fence closes, a real limit line is still converted
        self.assertEqual(ist("```\ncode resets 4pm (UTC)\n```\n5-hour limit reached ∙ resets 4pm (UTC)"),
                         "```\ncode resets 4pm (UTC)\n```\n5-hour limit reached ∙ resets 9:30 PM IST")

    def test_idempotent_on_local_text(self):
        once = ist("5-hour limit reached ∙ resets 4pm (UTC)")
        self.assertEqual(ist(once), once)
        self.assertEqual(lim("resets 9:30pm (Asia/Kolkata)"), "resets 9:30pm (Asia/Kolkata)")

    def test_other_zone_and_rest_of_text_kept(self):
        text = "Done.\n\n5-hour limit reached ∙ resets 4pm (UTC)\nmore"
        self.assertEqual(localize_limit_text(text, "Europe/London", NOW), "Done.\n\n5-hour limit reached ∙ resets 4:00 PM GMT\nmore")

    def test_default_zone_and_configure(self):
        self.assertEqual(usertime.tz_name(), "Asia/Kolkata")
        self.assertEqual(usertime.env({"A": "1"}), {"A": "1", "TZ": "Asia/Kolkata"})
        try:
            self.assertEqual(usertime.configure("Europe/London"), "Europe/London")
            self.assertEqual(usertime.env()["TZ"], "Europe/London")
            self.assertEqual(usertime.configure(None), "Asia/Kolkata")  # unset: the default
        finally:
            usertime.configure(usertime.DEFAULT_TZ)

    def test_bad_config_falls_back_without_failing(self):
        try:
            for bad in ("Not/AZone", 5, ["Asia/Kolkata"], {"x": 1}, True, "../etc/passwd"):
                usertime.configure("Europe/London")
                with self.assertLogs("edith.common.usertime", "WARNING"):
                    self.assertEqual(usertime.configure(bad), "Asia/Kolkata", bad)
            for config in ({"general": "Asia/Kolkata"}, {"general": 5}, {"general": {"timezone": 5}},
                           {"general": ["x"]}):
                usertime.configure("Europe/London")
                with self.assertLogs("edith.common.usertime", "WARNING"):
                    self.assertEqual(usertime.configure_from(config), "Asia/Kolkata", config)
            self.assertEqual(usertime.configure_from({}), "Asia/Kolkata")
            self.assertEqual(usertime.configure_from({"general": {"timezone": "Europe/London"}}), "Europe/London")
        finally:
            usertime.configure(usertime.DEFAULT_TZ)

    def test_main_build_survives_bad_timezone(self):
        from edith.main import build
        try:
            for general in (5, {"timezone": ["a"]}):
                with self.assertLogs("edith.common.usertime", "WARNING"):
                    build({"general": general, "features": {"enabled": []}})
                self.assertEqual(usertime.tz_name(), "Asia/Kolkata")
        finally:
            usertime.configure(usertime.DEFAULT_TZ)

    def test_stamp(self):
        self.assertEqual(usertime.stamp(NOW), "2026-11-01 15:30 IST")


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
        self.assertEqual(preview("You've hit your limit · resets Nov 2, 4pm (UTC)"),
                         "You've hit your limit · resets Nov 2, 9:30 PM IST")
        self.assertEqual(preview("The cron job resets at 16:00 (UTC) daily"), "The cron job resets at 16:00 (UTC) daily")

    def test_telegram_sends_text_as_given(self):
        from edith.adapters.frontends.telegram import TelegramFrontend
        sent = []
        fe = TelegramFrontend.__new__(TelegramFrontend)
        fe.api = lambda method, **kw: sent.append(kw["text"])
        fe.send_text(1, "The cron job resets at 16:00 (UTC) daily")
        self.assertEqual(sent, ["The cron job resets at 16:00 (UTC) daily"])


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
