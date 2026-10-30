"""Status details (contracts/status.md): GET /v1/status/details, the main lane's state from events,
the coding agents read from tmux (parsed, cached, read-only) and the transcript numbers."""
import json
import os
import pathlib
import subprocess
import tempfile
import time
import unittest
from unittest import mock

from edith.adapters.agents.claude_tmux.backend import entry_time
from edith.adapters.agents.claude_tmux.stats import SessionStats
import edith.features.status as status
from edith.core import Event, EventBus, Ports, Registry, load_features
from edith.features.status import one_line, redact
from edith.features.status.agents import Agents, git_branch, read_screen
from edith.ports.agent import RunInfo


class FakeAgent:
    max_side_lanes = 2

    def __init__(self):
        self.runs, self.queued, self.sid = [], 0, "s1"

    def status(self):
        return list(self.runs), self.queued

    def tmux_alive(self):
        return True

    def current_session(self):
        return self.sid

    def session_title(self, sid):
        return "Phase 2 app"

    def session_stats(self, sid=None):
        return {"started": 100.0, "messages": 7, "context_tokens": 1234}


def load(agent, config=None):
    bus, registry = EventBus(), Registry()
    cfg = {"agents": False, "live_dir": tempfile.gettempdir(), **(config or {})}
    report = load_features(["status"], bus, Ports(agent=agent), registry, {"status": cfg})
    assert report.loaded == ["status"], report.failed
    route = registry.routes[("GET", "/v1/status/details")]
    return bus, lambda: route.handler({"body": None, "params": {}, "query": {}, "headers": {}, "origin": "app"})


def ev(type, ts, **data):
    return Event(type, data, ts=ts)


class MainLaneTest(unittest.TestCase):
    def setUp(self):
        self.agent = FakeAgent()
        self.bus, self.get = load(self.agent)

    def run_main(self, ref="r1", step=None, started=10.0):
        self.agent.runs = [RunInfo(ref, "main", started, step)]

    def test_idle_at_start(self):
        e = self.get()["edith"]
        self.assertEqual((e["state"], e["since"], e["ref"], e["tmux"]), ("idle", None, None, "running"))

    def test_turn_states_and_since(self):
        self.run_main()
        self.bus.publish(ev("turn.started", 10.0, ref="r1", lane="main"))
        self.assertEqual({k: self.get()["edith"][k] for k in ("state", "since", "ref", "turn_started")},
                         {"state": "thinking", "since": 10.0, "ref": "r1", "turn_started": 10.0})
        self.bus.publish(ev("tool.call", 12.0, id="t1", name="Bash", summary="$ npm test"))
        e = self.get()["edith"]
        self.assertEqual((e["state"], e["tool"], e["step"], e["since"]), ("tool", "Bash", "$ npm test", 12.0))
        self.bus.publish(ev("turn.progress", 13.0, ref="r1", lane="main", step="$ npm test"))
        self.assertEqual(self.get()["edith"]["since"], 12.0)  # the same step: still since the call
        self.bus.publish(ev("tool.result", 20.0, id="t1", name="Bash", ok=True))
        self.assertEqual((self.get()["edith"]["state"], self.get()["edith"]["since"]), ("thinking", 20.0))
        self.bus.publish(ev("turn.done", 25.0, ref="r1", lane="main"))
        self.agent.runs = []
        e = self.get()["edith"]
        self.assertEqual((e["state"], e["since"], e["ref"], e["turn_started"]), ("idle", 25.0, None, None))

    def test_side_lane_events_leave_the_main_lane_alone(self):
        self.bus.publish(ev("turn.started", 10.0, ref="s9", lane="side"))
        self.bus.publish(ev("turn.progress", 11.0, ref="s9", lane="side", step="$ ls"))
        self.assertEqual(self.get()["edith"]["state"], "idle")

    def test_waiting_for_approval(self):
        self.run_main()
        self.bus.publish(ev("turn.started", 10.0, ref="r1", lane="main"))
        self.bus.publish(ev("tool.call", 11.0, id="t1", name="Bash", summary="$ rm x"))
        self.bus.publish(ev("permission.request", 12.0, id="ab", tool="Bash", detail="rm x", ref="r1", lane="main"))
        self.bus.publish(ev("tool.call", 12.5, id="t2", name="Read", summary="Read: y"))  # doesn't hide the prompt
        d = self.get()
        self.assertEqual((d["edith"]["state"], d["edith"]["tool"], d["edith"]["since"]), ("waiting_approval", "Bash", 12.0))
        self.assertEqual(d["lanes"]["approvals"], 1)
        self.bus.publish(ev("permission.resolved", 15.0, id="ab", decision="allow", ref="r1", lane="main"))
        d = self.get()
        self.assertEqual((d["edith"]["state"], d["edith"]["since"], d["lanes"]["approvals"]), ("thinking", 15.0, 0))

    def test_side_lane_approval_counts_but_main_stays(self):
        self.bus.publish(ev("permission.request", 12.0, id="cd", tool="Bash", detail="x", ref="s1", lane="side"))
        d = self.get()
        self.assertEqual((d["edith"]["state"], d["lanes"]["approvals"]), ("idle", 1))

    def test_missed_end_is_idle(self):
        self.bus.publish(ev("turn.started", 10.0, ref="r1", lane="main"))
        self.assertEqual(self.get()["edith"]["state"], "idle")  # no main run: it isn't really running

    def test_missed_start_uses_the_run(self):
        self.run_main(ref="r2", step="$ make", started=50.0)
        e = self.get()["edith"]
        self.assertEqual((e["state"], e["step"], e["ref"], e["since"]), ("tool", "$ make", "r2", 50.0))


class DetailsTest(unittest.TestCase):
    def test_lanes_session_and_server(self):
        agent = FakeAgent()
        bus, get = load(agent)
        bus.publish(Event("message.user", {"ref": "s9", "text": "check the disk\nand more", "lane": "side"}))
        agent.runs, agent.queued = [RunInfo("s9", "side", time.time() - 3, None)], 2
        d = get()
        self.assertEqual(d["lanes"]["side"][0]["summary"], "check the disk")
        self.assertEqual((d["lanes"]["max_side"], d["lanes"]["queued"]), (2, 2))
        self.assertEqual(d["session"], {"id": "s1", "title": "Phase 2 app", "started": 100.0, "messages": 7,
                                        "context_tokens": 1234})
        self.assertEqual(d["agents"], [])
        self.assertIsNone(d["server"]["tag"])  # live_dir isn't a repo
        self.assertGreaterEqual(d["server"]["uptime"], 0)
        json.dumps(d)

    def test_no_session(self):
        agent = FakeAgent()
        agent.sid = None
        self.assertIsNone(load(agent)[1]()["session"])

    def test_live_tag(self):
        with tempfile.TemporaryDirectory() as repo:
            env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
                   "GIT_COMMITTER_EMAIL": "t@x", "GIT_CONFIG_NOSYSTEM": "1"}
            for args in (["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "x"], ["tag", "p1-live-9"]):
                subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, env=env)
            self.assertEqual(load(FakeAgent(), {"live_dir": repo})[1]()["server"]["tag"], "p1-live-9")


class RedactTest(unittest.TestCase):
    def test_secrets(self):
        for text in ("token=abc123def", "Authorization: Bearer abcdef", "sk-ant-api03-abcdefghijklmnop",
                     "ghp_abcdefghijklmnopqrstuvwxyz0123", "123456789:AAEabcdefghijklmnopqrstuvwxyz012345",
                     "a" * 20 + "1" * 20, "xoxb-1234567890-abcdef"):
            self.assertNotIn(text[-6:], redact(f"x {text} y"), text)

    def test_ordinary_text_kept(self):
        for text in ("$ npm test", "Read: server/edith/features/status/__init__.py", "PR #15 is green, 0e563a3"):
            self.assertEqual(redact(text), text)

    def test_one_line(self):
        self.assertEqual(one_line("\n  first line  \nsecond"), "first line")
        self.assertEqual(len(one_line("x" * 200)), 80)


SCREEN_BUSY = """\
● I'll run the tests now.
● Bash(make test)
  ⎿  Running…
✽ Kneading… (4m 2s · ↓ 10.9k tokens)                                 │
─────────────────────────────────────────
❯
─────────────────────────────────────────
  ⏵⏵ auto mode on · PR #17 · esc to interrupt · ↓ to manage
"""

SCREEN_PERMISSION = """\
● Bash(rm -rf build)
╭──────────────────────────────────────╮
│ Bash command                         │
│   rm -rf build                       │
│ Do you want to proceed?              │
│ ❯ 1. Yes                             │
│   2. No, and tell Claude what to do  │
╰──────────────────────────────────────╯
"""

SCREEN_LIMIT = """\
● Done with the first half.
  ⎿  5-hour limit reached ∙ resets 4pm
─────────────────────────────────────────
❯
"""


class ScreenTest(unittest.TestCase):
    def test_busy(self):
        self.assertEqual(read_screen(SCREEN_BUSY), {"state": "busy", "blocked": None, "last": "Bash(make test)"})

    def test_idle(self):
        s = read_screen("● All done. │\n✻ Worked for 23s\n────\n❯ \n────\n  ⏵⏵ auto mode on\n")
        self.assertEqual(s, {"state": "idle", "blocked": None, "last": "All done."})

    def test_blocked(self):
        self.assertEqual(read_screen(SCREEN_PERMISSION)["blocked"], "permission")
        self.assertEqual(read_screen(SCREEN_PERMISSION)["state"], "blocked")
        self.assertEqual(read_screen(SCREEN_LIMIT)["blocked"], "usage_limit")

    def test_old_permission_text_far_up_is_ignored(self):
        screen = "Do you want to proceed?\n" + "\n".join(f"line {i}" for i in range(30)) + "\n● ok\n"
        self.assertEqual(read_screen(screen)["state"], "idle")

    def test_last_line_cleaned_and_trimmed(self):
        s = read_screen("\x1b[1m●\x1b[0m " + "word " * 40 + "│\n")
        self.assertTrue(s["last"].startswith("word word"))
        self.assertLessEqual(len(s["last"]), 100)
        self.assertTrue(s["last"].endswith("…"))
        self.assertIsNone(read_screen("nothing here\n")["last"])


class GitBranchTest(unittest.TestCase):
    def test_branch_worktree_detached_and_none(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / "repo/.git").mkdir(parents=True)
            (root / "repo/.git/HEAD").write_text("ref: refs/heads/status-panel\n")
            (root / "repo/sub").mkdir()
            self.assertEqual(git_branch(str(root / "repo/sub")), "status-panel")
            (root / "repo/.git/worktrees/wt").mkdir(parents=True)
            (root / "repo/.git/worktrees/wt/HEAD").write_text("0e563a3f00d\n")
            (root / "wt").mkdir()
            (root / "wt/.git").write_text(f"gitdir: {root}/repo/.git/worktrees/wt\n")
            self.assertEqual(git_branch(str(root / "wt")), "0e563a3")
            self.assertIsNone(git_branch(str(root)))


class FakeTmux:
    def __init__(self, panes, screens, code=0, error=None):
        self.panes, self.screens, self.code, self.error, self.calls = panes, screens, code, error, []

    def __call__(self, cmd, capture_output, text, timeout):
        self.calls.append(cmd)
        if self.error:
            raise self.error
        out = self.panes if "list-panes" in cmd else self.screens[cmd[-1]]
        return subprocess.CompletedProcess(cmd, self.code, out, "")


class AgentsTest(unittest.TestCase):
    PANES = ("10\tedith-dev\t%9\t/nowhere/a\n"   # not the active window
             "11\tedith-dev\t%0\t/nowhere/edith-app\n"
             "11\tedith-app\t%2\t/nowhere/edith-app-ui/\n")

    def test_reads_active_panes_only_with_capture(self):
        clock = [0.0]
        tmux = FakeTmux(self.PANES, {"%0": SCREEN_BUSY, "%2": SCREEN_PERMISSION})
        agents = Agents(run=tmux, clock=lambda: clock[0])
        got = agents.get()
        self.assertEqual([(a["name"], a["dir"], a["state"], a["branch"]) for a in got],
                         [("edith-app", "edith-app-ui", "blocked", None), ("edith-dev", "edith-app", "busy", None)])
        self.assertTrue(all(c[1] in ("list-panes", "capture-pane") for c in tmux.calls))  # never send-keys
        self.assertEqual(len(tmux.calls), 3)
        clock[0] = 4.9
        agents.get()
        self.assertEqual(len(tmux.calls), 3)  # cached
        clock[0] = 5.0
        agents.get()
        self.assertEqual(len(tmux.calls), 6)

    def test_socket(self):
        tmux = FakeTmux("", {})
        Agents(socket="other", run=tmux).get()
        self.assertEqual(tmux.calls[0][:3], ["tmux", "-L", "other"])

    def test_no_server_or_timeout(self):
        self.assertEqual(Agents(run=FakeTmux("", {}, code=1)).get(), [])
        self.assertEqual(Agents(run=FakeTmux("", {}, error=subprocess.TimeoutExpired("tmux", 3))).get(), [])

    def test_route_redacts_last_line(self):
        tmux = FakeTmux("11\tedith-dev\t%0\t/x\n", {"%0": "● the token=hunter2abc is set\n"})
        with mock.patch.object(status, "Agents", lambda **kw: Agents(run=tmux, **kw)):
            _, get = load(FakeAgent(), {"agents": True})
        self.assertEqual(get()["agents"][0]["last"], "the [redacted] is set")


class SessionStatsTest(unittest.TestCase):
    def test_counts_incrementally(self):
        def line(**e):
            return json.dumps({"timestamp": "2026-10-30T08:00:00+00:00", **e}) + "\n"
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "s.jsonl")
            with open(path, "w") as f:
                f.write(line(type="user", message={"content": "hello"}))
                f.write(line(type="user", isMeta=True, message={"content": "meta"}))
                f.write(line(type="user", message={"content": "<command-name>/clear</command-name>"}))
                f.write(line(type="assistant", message={"content": [{"type": "text", "text": "hi"}],
                                                        "usage": {"input_tokens": 2, "cache_read_input_tokens": 100,
                                                                  "cache_creation_input_tokens": 8}}))
                f.write(line(type="assistant", message={"content": [{"type": "tool_use", "name": "Bash"}]}))
                f.write(line(type="user", message={"content": [{"type": "tool_result", "content": "x"}]}))
            stats = SessionStats(entry_time)
            got = stats.get(path)
            self.assertEqual(got["messages"], 2)
            self.assertEqual(got["context_tokens"], 110)
            self.assertEqual(got["started"], entry_time({"timestamp": "2026-10-30T08:00:00+00:00"}))
            with open(path, "a") as f:
                f.write(line(type="user", message={"content": [{"type": "text", "text": "more"}]}))
                f.write(line(type="assistant", isSidechain=True, message={"content": [{"type": "text", "text": "sub"}],
                                                                          "usage": {"input_tokens": 9}}))
                f.write('{"partial": ')  # half-written: not read yet
            got = stats.get(path)
            self.assertEqual((got["messages"], got["context_tokens"]), (3, 110))


if __name__ == "__main__":
    unittest.main()
