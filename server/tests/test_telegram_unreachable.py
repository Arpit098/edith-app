"""Telegram unreachable (as on 2026-10-29, when edith couldn't reach its API): the bridge must still
start at once and say so, make each startup call once (as legacy), and poll with backoff."""
import json
import os
import pathlib
import shutil
import socket
import tempfile
import threading
import time
import unittest
from unittest import mock

from edith.adapters.frontends.telegram import TelegramFrontend
from edith.adapters.frontends.telegram.api import BotApi
from edith.core import EventBus, Registry


class Blocking:
    """A Bot API whose every call hangs until released, like a TCP connect that never completes."""

    def __init__(self):
        self.release, self.calls = threading.Event(), []

    def __call__(self, method, timeout=40, **params):
        return self.once(method, **params)

    def once(self, method, timeout=40, **params):
        self.calls.append(method)
        self.release.wait(10)
        return None  # failed

    def get_updates(self, offset, timeout=30):
        self.calls.append("getUpdates")
        return None  # failed


def closed_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]  # nothing listens here once the socket is closed


class UnreachableTest(unittest.TestCase):
    def setUp(self):
        self.home = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home)
        (self.home / ".cache/edith").mkdir(parents=True)
        (self.home / ".cache/edith/bridge-state.json").write_text(json.dumps({"clean_exit": False, "offset": 7}))

    def frontend(self, api, poll=True):
        f = TelegramFrontend({"state_dir": str(self.home / ".cache/edith"), "telegram_dir": str(self.home / "tg"),
                              "poll": poll}, api=api)
        self.addCleanup(f.stop)
        return f

    def test_start_returns_at_once_and_logs_first(self):
        api = Blocking()
        self.addCleanup(api.release.set)
        f = self.frontend(api)
        with self.assertLogs("edith.adapter.telegram", "INFO") as logs:
            started = time.monotonic()
            f.start(EventBus(), Registry(), None)
            self.assertLess(time.monotonic() - started, 0.5)  # not waiting on the hung deleteWebhook
        self.assertEqual(logs.output[0], "INFO:edith.adapter.telegram:Telegram frontend starting")
        self.assertFalse(f.startup_done.is_set())
        state = json.loads((self.home / ".cache/edith/bridge-state.json").read_text())
        self.assertFalse(state["clean_exit"])  # set at start, as legacy, network or not

    def test_each_startup_call_once_then_polls_with_backoff(self):
        api = Blocking()
        api.release.set()  # every call fails at once
        f = self.frontend(api)
        waits = []

        def wait(seconds):  # record the backoff instead of sleeping; stop after six polls
            waits.append(seconds)
            if len(waits) == 6:
                f._stopping.set()
            return f._stopping.is_set()
        with mock.patch.object(f._stopping, "wait", side_effect=wait):
            with self.assertLogs("edith.adapter.telegram", "WARNING"):
                f.start(EventBus(), Registry(), None)
                self.assertTrue(f.startup_done.wait(5))
                f._threads[-1].join(5)  # the poller gives up when wait() says "stopping"
        self.assertEqual(api.calls[:2], ["deleteWebhook", "setMyCommands"])
        self.assertNotIn("deleteWebhook", api.calls[2:])  # no retries of the startup calls
        self.assertEqual(waits, [1, 2, 4, 8, 16, 30])  # polling backs off, capped at 30 s

    def test_real_client_against_a_closed_port(self):
        sleeps = []
        api = BotApi("TOKEN", sleep=sleeps.append, server=f"http://127.0.0.1:{closed_port()}")
        with self.assertLogs("edith.adapter.telegram", "WARNING"):
            self.assertIsNone(api.once("deleteWebhook", timeout=2))
        self.assertEqual(sleeps, [])  # one attempt, no retry
        self.assertIsNone(api.get_updates(0, timeout=1))
        self.assertEqual(sleeps, [])  # the poll loop does the backing off, not the client
        with self.assertLogs("edith.adapter.telegram", "WARNING"):
            self.assertIsNone(api("sendMessage", timeout=2, chat_id=1, text="x"))
        self.assertEqual(sleeps, [1, 2, 4])  # ordinary calls still retry a refused connection


if __name__ == "__main__":
    unittest.main()
