"""Golden recordings of the legacy Telegram bridge's command replies (exact Telegram API calls).

The new Telegram adapter and features must make the same calls (docs/PHASE1_PLAN.md, steps 5-6).
Deleted with server/legacy/; the files in tests/golden/data/bridge/ stay.
"""
import json
import time
import unittest
from unittest import mock

from tests.fakes import FakeTelegram, FakeTmux, callback, message
from tests.golden import assert_golden
from tests.legacy import ALLOWED, legacy_home, load

# Fixed reminders (the ids would otherwise be random). Due Mon 2026-11-02 08:00 IST and Fri 2026-11-06 17:30 IST.
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


class StopLoop(Exception):
    pass


def fire_once(bridge):
    """One pass of the legacy bridge's reminder_loop (its sleep is turned into an exit)."""
    with mock.patch.object(time, "time", return_value=NOW), \
            mock.patch.object(time, "sleep", side_effect=StopLoop):
        try:
            bridge.reminder_loop()
        except StopLoop:
            pass


class LegacyBridgeGolden(unittest.TestCase):
    def setUp(self):
        self._home = legacy_home()
        self.home = self._home.__enter__()
        self.addCleanup(self._home.__exit__, None, None, None)
        self.bridge = load("bridge/edith_bridge.py")
        self.tg = self.bridge.tg = FakeTelegram()
        self.bridge.tmux = FakeTmux()

    def send(self, text):
        self.bridge.handle_message(message(text))

    def test_help(self):
        self.send("/help")
        assert_golden(self, "bridge/help.json", self.tg.record())

    def test_menu(self):
        self.send("/menu")
        assert_golden(self, "bridge/menu.json", self.tg.record())

    def test_status_idle(self):
        self.send("/status")
        assert_golden(self, "bridge/status_idle.json", self.tg.record())

    def test_name_without_title(self):
        self.send("/name")
        assert_golden(self, "bridge/name_usage.json", self.tg.record())

    def test_reminders_empty(self):
        self.send("/reminders")
        assert_golden(self, "bridge/reminders_empty.json", self.tg.record())

    def test_reminders_list_and_cancel(self):
        with open(self.home / ".cache/edith/reminders.json", "w") as f:
            json.dump(REMINDERS, f)
        self.send("/reminders")
        self.bridge.handle_callback(callback("rem:cancel:cc22dd"))
        self.bridge.handle_callback(callback("rem:cancel:cc22dd", cb_id="cb2"))  # already gone
        assert_golden(self, "bridge/reminders_list_cancel.json", self.tg.record())

    def test_reminder_snooze_buttons(self):
        with open(self.home / ".cache/edith/reminders.json", "w") as f:
            json.dump(REMINDERS, f)
        with mock.patch.object(time, "time", return_value=NOW):
            self.bridge.handle_callback(callback("rem:snooze:15:cc22dd", text="⏰ Renew the domain"))
            self.bridge.handle_callback(callback("rem:snooze:60:aa11bb", text="⏰ Pay rent", cb_id="cb2"))
        assert_golden(self, "bridge/reminder_snooze.json", self.tg.record())

    def test_reminder_fire(self):
        with open(self.home / ".cache/edith/reminders.json", "w") as f:
            json.dump(FIRE, f)
        fire_once(self.bridge)
        assert_golden(self, "bridge/reminder_fire.json", self.tg.record())

    def test_strangers_are_ignored(self):
        self.bridge.handle_message(message("/help", chat_id=999, user_id=999))
        self.bridge.handle_message(message("/help", chat_id=-100, user_id=ALLOWED,
                                           chat={"id": -100, "type": "group"}))
        self.bridge.handle_callback(callback("perm:allow:abcd", user_id=999))
        assert_golden(self, "bridge/strangers.json", self.tg.record())


if __name__ == "__main__":
    unittest.main()
