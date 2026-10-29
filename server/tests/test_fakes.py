"""The fakes behave like the real things, as far as the bridge relies on them."""
import json
import os
import subprocess
import tempfile
import unittest

from tests.fakes import FAKE_CLAUDE, FakeTelegram, FakeTmux, write_plan


class FakeClaudeTest(unittest.TestCase):
    def test_plays_its_plan_and_logs_argv(self):
        with tempfile.TemporaryDirectory() as d:
            env = dict(os.environ, FAKE_CLAUDE_PLAN=write_plan(d, stderr="warn", exit_code=0),
                       FAKE_CLAUDE_LOG=os.path.join(d, "argv.jsonl"))
            r = subprocess.run([FAKE_CLAUDE, "-p", "hi", "--resume", "s0", "--fork-session"],
                               capture_output=True, text=True, env=env)
            events = [json.loads(line) for line in r.stdout.splitlines()]
            self.assertEqual([e["type"] for e in events], ["system", "assistant", "result"])
            self.assertEqual(events[-1]["result"], "Done.")
            self.assertEqual((r.returncode, r.stderr), (0, "warn"))
            with open(env["FAKE_CLAUDE_LOG"]) as f:
                self.assertEqual(json.loads(f.readline()), ["-p", "hi", "--resume", "s0", "--fork-session"])

    def test_exit_code(self):
        with tempfile.TemporaryDirectory() as d:
            env = dict(os.environ, FAKE_CLAUDE_PLAN=write_plan(d, events=[], exit_code=1,
                                                               stderr="No conversation found"))
            r = subprocess.run([FAKE_CLAUDE], capture_output=True, text=True, env=env)
            self.assertEqual((r.returncode, r.stdout), (1, ""))


class FakeTmuxTest(unittest.TestCase):
    def test_paste_then_enter_submits(self):
        seen = []
        t = FakeTmux(on_submit=seen.append)
        t("load-buffer", "-b", "tg", "-", input="hello\n[tg-ref ab12cd]")
        t("paste-buffer", "-p", "-d", "-b", "tg", "-t", "edith")
        t("send-keys", "-t", "edith", "Enter")
        t("send-keys", "-t", "edith", "-l", "/clear")
        t("send-keys", "-t", "edith", "Enter")
        t("send-keys", "-t", "edith", "Escape")
        self.assertEqual(t.submitted, ["hello\n[tg-ref ab12cd]", "/clear"])
        self.assertEqual(seen, t.submitted)
        self.assertEqual(t.typed, ["/clear"])
        self.assertEqual(t.keys, ["Enter", "Enter", "Escape"])

    def test_alive_and_pane(self):
        t = FakeTmux(alive=False)
        self.assertEqual(t("has-session", "-t", "edith").returncode, 1)
        t("respawn-pane", "-k", "-t", "edith", "launch.sh abc")
        self.assertEqual(t("capture-pane", "-p", "-t", "edith").stdout, "❯ ")
        self.assertEqual(t.respawned, ["launch.sh abc"])


class FakeTelegramTest(unittest.TestCase):
    def test_records_and_answers(self):
        tg = FakeTelegram()
        sent = tg("sendMessage", chat_id=1, text="hi", reply_markup=None)
        self.assertEqual(sent["message_id"], 1000)
        self.assertEqual(tg.calls, [("sendMessage", {"chat_id": 1, "text": "hi"})])
        tg.updates = [{"update_id": 5}]
        self.assertEqual(tg("getUpdates"), [{"update_id": 5}])
        self.assertEqual(tg("getUpdates"), [])


if __name__ == "__main__":
    unittest.main()
