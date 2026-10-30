"""/compact (control feature + claude_tmux adapter): Claude Code's /compact in the tmux Claude, only
when idle, done when the SessionStart hook reports source "compact", with errors and a timeout.
Runs the real adapter against the fake tmux Claude (tests/test_claude_tmux.Harness)."""
import time
import unittest

from edith.core import CommandCall, EventBus, Ports, Registry, load_features
from tests.fakes import run_workers
from tests.test_claude_tmux import Harness


def compacts(h, error=None):
    """The fake Claude answers /compact like Claude Code: the SessionStart hook (source "compact"),
    or an error on screen."""
    def on_submit(text):
        if not text.startswith("/compact"):
            return
        if error:
            h.fake.pane += f"\n  ⎿  Error during compaction: {error}\n"
        else:
            h.set_session("s1", ts=time.time(), source="compact")
    h.fake.on_submit = on_submit


class AdapterTest(unittest.TestCase):
    def test_compacts_with_instructions_after_clearing_the_input(self):
        h = Harness(self)
        compacts(h)
        h.fake("send-keys", "-t", "edith", "-l", "a ghost suggestion")  # something already in the input box
        self.assertEqual(h.agent.compact("keep the\nmanager   context"), ("ok", ""))
        self.assertEqual(h.fake.submitted[-1], "/compact keep the manager context")  # one line, nothing else
        self.assertLess(h.fake.keys.index("C-u"), len(h.fake.keys) - 1)  # cleared before the Enter
        self.assertFalse(h.agent.busy())

    def test_busy_when_anything_is_going_on(self):
        h = Harness(self)
        compacts(h)
        (h.state_dir / "tmux-run").write_text("abc")  # a main-lane turn
        self.assertEqual(h.agent.compact(), ("busy", ""))
        (h.state_dir / "tmux-run").unlink()
        perms = h.state_dir / "perms"
        perms.mkdir(exist_ok=True)
        (perms / "x1.req.json").write_text("{}")  # an approval waiting
        self.assertEqual(h.agent.compact(), ("busy", ""))
        (perms / "x1.req.json").unlink()
        h.agent.main_busy.set()
        self.assertEqual(h.agent.compact(), ("busy", ""))
        h.agent.main_busy.clear()
        self.assertEqual(h.fake.submitted, [])  # nothing was typed
        self.assertEqual(h.agent.compact(), ("ok", ""))

    def test_an_error_on_screen(self):
        h = Harness(self)
        compacts(h, error="Conversation too long")
        result, detail = h.agent.compact()
        self.assertEqual((result, detail), ("failed", "Error during compaction: Conversation too long"))
        self.assertFalse(h.agent.busy())

    def test_no_answer_times_out(self):
        h = Harness(self, compact_timeout=0.2)
        h.fake.on_submit = lambda text: None  # Claude never finishes
        started = time.monotonic()
        self.assertEqual(h.agent.compact(), ("failed", "no answer from Claude in 0 s"))
        self.assertLess(time.monotonic() - started, 2)
        self.assertFalse(h.agent.busy())


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.h = Harness(self)
        compacts(self.h)
        self.registry = Registry()
        report = load_features(["control"], EventBus(), Ports(agent=self.h.agent), self.registry, {})
        assert report.loaded == ["control"], report.failed
        self.replies = []

    def run_command(self, args=""):
        out = self.registry.commands["compact"].handler(CommandCall(args, "app", self.replies.append, "r1"))
        run_workers(self.registry)  # the compact job, here and now
        return out

    def test_command_replies_now_and_when_done(self):
        self.assertEqual(self.run_command("keep the manager context"), "🗜 Compacting the conversation…")
        self.assertEqual(self.replies, ["✅ Compacted."])
        self.assertEqual(self.h.fake.submitted[-1], "/compact keep the manager context")

    def test_busy_reply(self):
        self.h.agent.main_busy.set()
        self.assertEqual(self.run_command(), "⚠️ EDITH is busy; try /compact when the task ends.")
        self.assertEqual(self.h.fake.submitted, [])

    def test_listed_for_the_app_and_help(self):
        command = self.registry.commands["compact"]
        self.assertEqual((command.usage, bool(command.help), command.menu), ("[instructions]", True, False))
        self.assertIn("/compact [instructions] – compact the conversation (optional: what to keep)",
                      self.registry.help_lines())


if __name__ == "__main__":
    unittest.main()
