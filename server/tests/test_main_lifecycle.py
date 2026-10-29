"""The real launcher (deploy/bin/edith-bridge) as a process, the way edith-bridge.service runs it:
start, SIGTERM -> clean exit 0 (clean_exit saved); a required frontend that can't start -> exit 1
so systemd retries, as the legacy bridge did. Temp HOME, no network (Telegram is never reached)."""
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
LAUNCHER = REPO / "deploy" / "bin" / "edith-bridge"


def config(home, frontends, required):
    path = pathlib.Path(home, "config.toml")
    path.write_text(f"""
[adapters]
agent = "claude_tmux"
frontends = {json.dumps(frontends)}
required_frontends = {json.dumps(required)}
[adapter.claude_tmux]
tmux_socket = "edith-test-{os.getpid()}"
[features]
enabled = ["sessions", "control", "quick_actions", "approvals", "reminders"]
""")
    return path


def start(home, cfg):
    env = {"HOME": home, "PATH": "/usr/bin:/bin"}
    return subprocess.Popen([sys.executable, "-I", str(LAUNCHER), "--config", str(cfg)], env=env, cwd=home,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


class LifecycleTest(unittest.TestCase):
    def test_sigterm_shuts_down_cleanly(self):
        with tempfile.TemporaryDirectory() as home:
            p = start(home, config(home, [], []))
            self.addCleanup(p.stdout.close)
            out = ""
            deadline = time.monotonic() + 15
            while "E.D.I.T.H running" not in out and time.monotonic() < deadline:
                out += p.stdout.readline()
            self.assertIn("E.D.I.T.H running", out)
            t = time.monotonic()
            p.send_signal(signal.SIGTERM)
            self.assertEqual(p.wait(10), 0)
            self.assertLess(time.monotonic() - t, 8)
            self.assertIn("shutting down", p.stdout.read())

    def test_required_frontend_failing_exits_1(self):
        with tempfile.TemporaryDirectory() as home:  # no bot token anywhere
            p = start(home, config(home, ["telegram"], ["telegram"]))
            self.addCleanup(p.stdout.close)
            self.assertEqual(p.wait(15), 1)
            out = p.stdout.read()
            self.assertIn("frontend telegram failed to start", out)
            self.assertIn("not running; exiting so systemd restarts us", out)


if __name__ == "__main__":
    unittest.main()
