"""/stop and /status with background work (contracts/status.md, "Background"): /stop ends turns, not
the work a finished turn left running, and says so; /status lists that work. Without background
work both answer word for word as before (tests/features/test_bridge_commands.py)."""
import time
import unittest

from edith.core import CommandCall, EventBus, Ports, Registry, load_features
from edith.features.control import background_lines
from edith.ports.agent import StopResult


class FakeAgent:
    max_side_lanes = 2

    def __init__(self, jobs):
        self.jobs = jobs

    def stop(self):
        return StopResult(0, [])

    def status(self):
        return [], 0

    def background(self):
        return list(self.jobs)

    def has_conversation(self):
        return True

    def current_session(self):
        return None

    def tmux_alive(self):
        return True


def run(command, agent):
    registry = Registry()
    report = load_features(["control"], EventBus(), Ports(agent=agent), registry, {})
    assert report.loaded == ["control"], report.failed
    replies = []
    out = registry.commands[command].handler(CommandCall("", "telegram", replies.append, "r1", ""))
    return ([out] if out else []) + replies


class ControlBackgroundTest(unittest.TestCase):
    def test_lines(self):
        now = 1000.0
        self.assertEqual(background_lines([{"kind": "shell", "label": "Wait for PR 41 CI", "started": now - 185},
                                           {"kind": "agent", "label": "Review PR 41", "started": None}], now),
                         ["Shell · Wait for PR 41 CI · 3 min", "Agent · Review PR 41"])

    def test_stop_says_what_it_doesnt_cancel(self):
        agent = FakeAgent([{"id": "t", "kind": "shell", "label": "Wait for PR 41 CI", "started": time.time() - 61}])
        self.assertEqual(run("stop", agent), ["Nothing is running. Still in the background (/stop doesn't cancel it; ask me to):\n"
                                              "• Shell · Wait for PR 41 CI · 1 min"])
        self.assertEqual(run("stop", FakeAgent([])), ["Nothing is running."])  # as before

    def test_status_lists_it(self):
        agent = FakeAgent([{"id": "t", "kind": "agent", "label": "Review PR 41", "started": time.time()}])
        self.assertEqual(run("status", agent), ["💤 Idle. Conversation in progress.", "⏳ In the background:\n• Agent · Review PR 41 · 0 min",
                                                "🖥 tmux session: running\nWatch live: ssh in, then edith-attach"])
        self.assertEqual(len(run("status", FakeAgent([]))), 2)  # as before


if __name__ == "__main__":
    unittest.main()
