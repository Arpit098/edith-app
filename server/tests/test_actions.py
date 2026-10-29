"""Reply buttons and button actions (contracts/events.md, "Replies and buttons")."""
import sys
import types
import unittest

from edith.core import (ActionResult, Button, EventBus, Feature, Ports, Registry, Reply,
                        load_features)


def fake_feature(name, setup):
    module = types.ModuleType(f"fakefeatures.{name}")
    module.FEATURE = Feature(name=name, setup=setup)
    sys.modules[module.__name__] = module


class ButtonTest(unittest.TestCase):
    def test_legacy_action_strings_fit(self):
        # Today's longest: a session switch with a full session id.
        Button("1. title", "sess:8268e354-0b1c-4d2e-9f3a-1234567890ab")
        Reply("⏰ x", [[Button("+15m", "rem:snooze:15:ab12cd"), Button("✅ Done", "rem:done:ab12cd")]])

    def test_over_64_bytes_or_empty_is_rejected(self):
        with self.assertRaises(ValueError):
            Button("x", "quick:" + "é" * 30)
        with self.assertRaises(ValueError):
            Button("x", "")


class ActionTest(unittest.TestCase):
    def setUp(self):
        sys.modules["fakefeatures"] = types.ModuleType("fakefeatures")
        self.bus, self.registry = EventBus(), Registry()

    def load(self, names):
        return load_features(names, self.bus, Ports(), self.registry, {}, package="fakefeatures")

    def test_press_routes_by_prefix(self):
        presses, sent = [], []

        def setup(ctx):
            def snooze(call):
                presses.append((call.origin, call.args))
                call.reply("new message")
                return ActionResult(toast="Snoozed", note="💤 Snoozed")
            ctx.add_action("rem", snooze)

        fake_feature("reminders", setup)
        self.assertEqual(self.load(["reminders"]).loaded, ["reminders"])
        result = self.registry.press("rem:snooze:15:ab12cd", "telegram", sent.append)
        self.assertEqual(result, ActionResult("Snoozed", "💤 Snoozed"))
        self.assertEqual(presses, [("telegram", ["snooze", "15", "ab12cd"])])
        self.assertEqual(sent, ["new message"])
        self.assertIsNone(self.registry.press("nobody:x", "app", sent.append))

    def test_bad_or_duplicate_prefix_fails_only_that_feature(self):
        fake_feature("one", lambda ctx: ctx.add_action("perm", lambda c: None))
        fake_feature("two", lambda ctx: ctx.add_action("perm", lambda c: None))
        fake_feature("bad", lambda ctx: ctx.add_action("a:b", lambda c: None))
        report = self.load(["one", "two", "bad"])
        self.assertEqual(report.loaded, ["one"])
        self.assertEqual(set(report.failed), {"two", "bad"})

    def test_failed_setup_rolls_back_actions(self):
        def broken(ctx):
            ctx.add_action("sess", lambda c: None)
            raise RuntimeError("boom")
        fake_feature("broken", broken)
        self.load(["broken"])
        self.assertEqual(self.registry.actions, {})


class PortsTest(unittest.TestCase):
    def test_all_day_event(self):
        from datetime import date, datetime, timezone
        from edith.ports import CalendarEvent
        day = CalendarEvent("e1", "primary", "Arpit", "Holiday", date(2026, 11, 1), date(2026, 11, 2))
        timed = CalendarEvent("e2", "primary", "Arpit", "Call", datetime(2026, 11, 1, 9, tzinfo=timezone.utc),
                              datetime(2026, 11, 1, 10, tzinfo=timezone.utc))
        self.assertTrue(day.all_day)
        self.assertFalse(timed.all_day)


if __name__ == "__main__":
    unittest.main()
