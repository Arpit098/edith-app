"""The agent adapter (docs/PHASE1_PLAN.md, step 4): main lane in tmux, side lanes, queue, /stop,
conversations and the permission relay, with the legacy bridge's rules. Runs against FakeTmux
(playing the tmux Claude and its hooks) and the fake `claude -p`, in a temporary HOME."""
import json
import os
import pathlib
import re
import shutil
import tempfile
import threading
import time
import unittest
from unittest import mock

from edith.adapters.agents.claude_tmux.backend import NOTES_HEADER, ClaudeTmux
from edith.adapters.agents.claude_tmux.tmux import Tmux
from edith.core import EventBus
from tests.fakes import FAKE_CLAUDE, FakeTmux
from tests.fakes.claude import plan
from tests.golden import assert_matches
from tests.home import temp_home

REF = re.compile(r"\[tg-ref ([0-9a-f]+)\]")


class Harness:
    """One adapter in a temp HOME. `mode` says what the tmux Claude does with a submitted message:
    "done" (prompt, one tool, reply) or "hang" (prompt and one tool, then keeps working)."""

    def __init__(self, test, side_plan=None, **config):
        self.home = pathlib.Path(tempfile.mkdtemp())
        test.addCleanup(shutil.rmtree, self.home)
        self.state_dir = self.home / ".cache/edith"
        self.work_dir = self.home / "edith"
        self.transcripts = self.home / ".claude/projects" / re.sub(r"[^A-Za-z0-9]", "-", str(self.work_dir))
        for d in (self.state_dir, self.work_dir, self.transcripts):
            d.mkdir(parents=True)
        self.set_session("s1")
        self.mode, self.reply = "done", "Main reply"
        self.fake = FakeTmux(on_submit=self.on_submit, on_key=self.on_key)
        tmux = Tmux(runner=self.fake, start_service=lambda: None, settle_limit=0.5, settle_step=0.01)
        self.plan_file = self.home / "plan.json"
        self.plan_file.write_text(json.dumps(side_plan or plan(session_id="fork-1", reply="Side reply")))
        self.argv_log = self.home / "argv.jsonl"
        # HOME too: every path the adapter derives (transcripts, telegram, …) must be in the temp home.
        env = mock.patch.dict(os.environ, {"HOME": str(self.home), "FAKE_CLAUDE_PLAN": str(self.plan_file),
                                           "FAKE_CLAUDE_LOG": str(self.argv_log)})
        env.start()
        test.addCleanup(env.stop)
        cfg = {"work_dir": str(self.work_dir), "state_dir": str(self.state_dir), "claude_bin": FAKE_CLAUDE,
               "chat_key": "111", "ready_timeout": 1, "check_alive_every": 0.05, "stop_grace": 0.1, **config}
        self.agent = ClaudeTmux(cfg, tmux=tmux)
        p = self.agent.paths
        for path in (p.work_dir, p.state_dir, p.perm_dir, p.telegram_dir, p.transcripts, self.agent.launch,
                     self.agent.mcp_config):
            assert path.startswith(str(self.home) + "/"), path
        assert p.transcripts == str(self.transcripts)
        self.bus, self.events, self.cond = EventBus(), [], threading.Condition()
        self.bus.subscribe("*", self._record)
        self.agent.start(self.bus)
        test.addCleanup(self.agent.shutdown)

    def set_session(self, sid, ts=0.0, source="resume"):
        transcript = self.transcripts / f"{sid}.jsonl"
        transcript.touch()
        tmp = self.state_dir / "tmux-session.json.tmp"
        tmp.write_text(json.dumps({"session_id": sid, "transcript_path": str(transcript), "source": source, "ts": ts}))
        os.replace(tmp, self.state_dir / "tmux-session.json")
        self.transcript = transcript

    def _record(self, ev):
        with self.cond:
            self.events.append(ev)
            self.cond.notify_all()

    def wait(self, type, ref=None, timeout=5):
        def find():
            return next((e for e in self.events if e.type == type and (ref is None or e.data.get("ref") == ref)), None)
        with self.cond:
            self.cond.wait_for(find, timeout)
            return find()

    def wait_id(self, type, id, timeout=5):
        def find():
            return next((e for e in self.events if e.type == type and e.data.get("id") == id), None)
        with self.cond:
            self.cond.wait_for(find, timeout)
            return find()

    def types(self, ref):
        return [e.type for e in self.events if e.data.get("ref") == ref]

    def hook_event(self, **ev):
        with open(self.state_dir / "tmux-events.jsonl", "a") as f:
            f.write(json.dumps({"ts": time.time(), **ev}) + "\n")

    def transcript_line(self, entry):
        with open(self.transcript, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def on_submit(self, text):
        m = REF.search(text)
        if not m:
            return
        self.hook_event(event="prompt", session_id="s1", ref=m[1])
        self.transcript_line({"type": "user", "message": {"content": text}})
        self.transcript_line({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Bash", "input": {"command": "df -h", "description": "Check disk"}}]}})
        if self.mode == "done":
            self.finish()

    def finish(self):
        self.hook_event(event="stop", session_id="s1", text=self.reply)

    def on_key(self, key):
        if key == "Escape" and self.mode == "hang":
            self.transcript_line({"type": "user", "message": {"content": "[Request interrupted by user]"}})

    def state(self):
        return json.loads((self.state_dir / "bridge-state.json").read_text())


class MainLaneTest(unittest.TestCase):
    def test_turn_runs_in_tmux_and_reports_events(self):
        h = Harness(self)
        self.assertEqual(h.agent.send("[Telegram message from Arpit]\nhi", "telegram", "m1").lane, "main")
        done = h.wait("turn.done", "m1")
        self.assertEqual(done.data | {"elapsed": 0}, {"ref": "m1", "lane": "main", "text": "Main reply", "steps": 1,
                                                      "elapsed": 0, "is_error": False, "subtype": "success"})
        self.assertEqual(h.types("m1"), ["turn.started", "turn.progress", "turn.done"])
        self.assertEqual(h.wait("turn.progress", "m1").data["step"], "$ Check disk")
        self.assertEqual(done.origin, "telegram")
        self.assertRegex(h.fake.submitted[0], r"^\[Telegram message from Arpit\]\nhi\n\[tg-ref [0-9a-f]{6}\]$")
        self.assertEqual(h.state()["sessions"], {"111": "s1"})
        self.assertFalse((h.state_dir / "tmux-run").exists())

    def test_not_ready(self):
        h = Harness(self, ready_timeout=0.05)
        h.fake.pane = "Loading…"
        h.agent.send("hi", "telegram", "m1")
        failed = h.wait("turn.failed", "m1")
        self.assertEqual(failed.data["reason"], "not_ready")
        self.assertEqual(h.types("m1"), ["turn.failed"])  # no turn.started before it

    def test_stop_interrupts_and_drops_the_queue(self):
        h = Harness(self, max_side_lanes=0)
        h.mode = "hang"
        h.agent.send("long task", "telegram", "m1")
        h.wait("turn.progress", "m1")
        self.assertEqual(h.agent.send("next", "telegram", "m2").lane, "queued")
        self.assertEqual(h.wait("turn.queued", "m2").data["position"], 1)
        self.assertTrue(h.agent.busy())
        result = h.agent.stop()
        self.assertEqual((result.running, result.dropped), (1, ["m2"]))
        self.assertEqual(h.wait("turn.stopped", "m1", timeout=2).data["lane"], "main")
        self.assertIn("Escape", h.fake.keys)
        self.assertEqual(h.types("m2"), ["turn.queued", "turn.stopped"])  # never ran
        self.assertEqual(h.wait("turn.stopped", "m2").data["lane"], "queued")

    def test_stop_grace_when_no_interrupt_shows(self):
        h = Harness(self)
        h.mode = "hang"
        h.fake.on_key = None  # Claude ignores Esc
        h.agent.send("long task", "telegram", "m1")
        h.wait("turn.progress", "m1")
        t = time.monotonic()
        h.agent.stop()
        self.assertIsNotNone(h.wait("turn.stopped", "m1", timeout=3))
        self.assertLess(time.monotonic() - t, 1)  # stop_grace 0.1 s, not a polling interval later

    def test_crash(self):
        h = Harness(self)
        h.mode = "hang"
        h.agent.send("task", "telegram", "m1")
        h.wait("turn.progress", "m1")
        h.fake.alive = False
        self.assertEqual(h.wait("turn.failed", "m1", timeout=3).data["reason"], "crashed")

    def test_waits_on_events_not_a_fixed_interval(self):
        h = Harness(self, check_alive_every=30)  # only the hook events can end this wait quickly
        h.mode = "hang"
        h.agent.send("task", "telegram", "m1")
        h.wait("turn.progress", "m1")
        t = time.monotonic()
        h.finish()
        self.assertIsNotNone(h.wait("turn.done", "m1", timeout=3))
        self.assertLess(time.monotonic() - t, 1)
        has_session = [c for c in h.fake.calls if c[0] == "has-session"]
        self.assertLess(len(has_session), 5)  # legacy ran it every 0.5 s


class SideLaneTest(unittest.TestCase):
    def test_busy_main_lane_sends_to_a_side_lane_and_hands_over_notes(self):
        h = Harness(self)
        h.agent.state.update(lambda s: s.setdefault("sessions", {}).__setitem__("111", "s1"))  # an earlier turn's
        h.mode = "hang"
        h.agent.send("first", "telegram", "m1")
        h.wait("turn.progress", "m1")
        self.assertEqual(h.agent.send("[Telegram message from Arpit, x]\nquick question", "telegram", "m2").lane, "side")
        done = h.wait("turn.done", "m2")
        self.assertEqual((done.data["lane"], done.data["text"], done.data["steps"]), ("side", "Side reply", 1))
        self.assertEqual(h.types("m2"), ["turn.started", "turn.progress", "turn.done"])
        argv = json.loads(h.argv_log.read_text().splitlines()[0])
        self.assertEqual(argv[-3:], ["--resume", "s1", "--fork-session"])  # forks the main conversation
        state = h.state()
        self.assertEqual(state["side_notes"], [{"q": "quick question", "a": "Side reply"}])
        self.assertEqual(state["side_sessions"], ["fork-1"])
        h.finish()
        h.wait("turn.done", "m1")
        h.mode = "done"
        h.agent.send("third", "telegram", "m3")
        h.wait("turn.done", "m3")
        self.assertTrue(h.fake.submitted[-1].startswith(NOTES_HEADER + "\n- Arpit: quick question\n  EDITH: Side reply\n\nthird"))
        self.assertNotIn("side_notes", h.state())

    def test_force_queue_and_lane_limit(self):
        h = Harness(self, max_side_lanes=1, side_plan=plan(hang=True))
        h.mode = "hang"
        h.agent.send("first", "telegram", "m1")
        h.wait("turn.progress", "m1")
        self.assertEqual(h.agent.send("forced", "telegram", "m2", force_queue=True).lane, "queued")
        self.assertEqual(h.agent.send("side", "telegram", "m3").lane, "side")
        self.assertEqual(h.agent.send("no lane left", "telegram", "m4").lane, "queued")
        self.assertEqual(h.wait("turn.queued", "m4").data["position"], 2)
        runs, queued = h.agent.status()
        self.assertEqual(queued, 2)

    def test_errors_retry_and_stop(self):
        h = Harness(self, side_plan=plan(events=[], exit_code=1, stderr="x" * 1000 + "\nboom\n"))
        h.agent.state.update(lambda s: s.setdefault("sessions", {}).__setitem__("111", "s1"))
        h.agent.main_busy.set()  # pretend the main lane is busy
        h.agent.send("q", "telegram", "m1")
        failed = h.wait("turn.failed", "m1")
        self.assertEqual((failed.data["reason"], failed.data["code"]), ("error", 1))
        self.assertTrue(failed.data["stderr"].endswith("boom") and len(failed.data["stderr"]) == 800)

        h.plan_file.write_text(json.dumps(plan(reply="fresh", if_resume=plan(events=[], exit_code=1,
                                                                               stderr="No conversation found"))))
        h.agent.send("q2", "telegram", "m2")
        self.assertEqual(h.wait("turn.done", "m2").data["text"], "fresh")
        self.assertEqual(h.types("m2"), ["turn.started", "turn.retrying", "turn.started", "turn.progress", "turn.done"])
        self.assertNotIn("111", h.state().get("sessions", {}))

        h.plan_file.write_text(json.dumps(plan(hang=True)))
        h.agent.send("slow", "telegram", "m3")
        h.wait("turn.progress", "m3")
        self.assertEqual(h.agent.stop().running, 1)
        self.assertIsNotNone(h.wait("turn.stopped", "m3", timeout=3))

    def test_shutdown_leaves_no_process_or_thread(self):
        h = Harness(self, side_plan=plan(hang=True))
        h.agent.main_busy.set()
        h.agent.send("slow", "telegram", "m1")
        h.wait("turn.progress", "m1")
        proc = next(r.proc for r in h.agent._runs.values())
        h.agent.send("not started yet", "telegram", "m2")  # waits in the side queue... or is refused a lane
        h.agent.shutdown(timeout=5)
        self.assertIsNotNone(proc.poll())
        alive = [t.name for t in h.agent._threads if t.is_alive() and not t.name.endswith(":main")]
        self.assertEqual(alive, [])
        self.assertNotIn("turn.started", h.types("m2"))

    def test_chatty_stderr_cannot_block_claude(self):
        h = Harness(self, side_plan=plan(reply="ok", stderr_first="w" * 200_000))
        h.agent.main_busy.set()
        h.agent.send("q", "telegram", "m1")
        self.assertEqual(h.wait("turn.done", "m1", timeout=10).data["text"], "ok")

    def test_side_lane_command_matches_legacy(self):
        """Same `claude -p` arguments and environment as the legacy bridge's run_claude."""
        with temp_home(CLAUDE_BIN=FAKE_CLAUDE) as home, tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "argv.jsonl")
            with mock.patch.dict(os.environ, {"FAKE_CLAUDE_PLAN": str(pathlib.Path(tmp, "p.json")), "FAKE_CLAUDE_LOG": log}):
                pathlib.Path(tmp, "p.json").write_text(json.dumps(plan()))
                agent = ClaudeTmux({"claude_bin": FAKE_CLAUDE, "chat_key": "111"})
                agent.state.update(lambda s: s.setdefault("sessions", {}).__setitem__("111", "s1"))
                agent._run_side("hello\nworld", "telegram", "r1")
            new = json.loads(pathlib.Path(log).read_text())
            self.assertIn(str(home), new[new.index("--mcp-config") + 1])
            # legacy run_claude(111, "hello\nworld", 5, side=True)'s argv, its HOME shown as ~
            assert_matches(self, "claude/side_lane_argv.json", [a.replace(str(home), "~") for a in new])


class LiveViewTest(unittest.TestCase):
    def test_every_transcript_entry_becomes_an_event(self):
        h = Harness(self)
        self.assertTrue(h.agent._live.ready.wait(5))
        h.transcript_line({"type": "user", "message": {"content": "typed in tmux"}})
        h.transcript_line({"type": "user", "message": {"content": "<command-name>/clear</command-name>"}})
        h.transcript_line({"type": "user", "isSidechain": True, "message": {"content": "a subagent"}})
        h.transcript_line({"type": "user", "message": {"content": "[Telegram message from Arpit]\nhi [voice]\n[tg-ref abc123]"}})
        h.transcript_line({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "Fixing it."},
            {"type": "tool_use", "id": "tu1", "name": "Edit",
             "input": {"file_path": "/x/a.py", "old_string": "x = 1\n", "new_string": "x = 2\n"}}]}})
        h.transcript_line({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "tu1", "is_error": False, "content": "Updated /x/a.py\nmore"}]}})
        result = h.wait("tool.result")
        self.assertIsNotNone(result)
        live = [(e.type, e.origin, e.data) for e in h.events if e.type.startswith(("message.", "tool.", "file."))]
        self.assertEqual(live[:4], [
            ("message.user", "terminal", {"text": "typed in tmux", "voice": False}),
            ("message.user", "telegram", {"text": "[Telegram message from Arpit]\nhi [voice]", "voice": True}),
            ("message.assistant", "system", {"text": "Fixing it."}),
            ("tool.call", "system", {"name": "Edit", "summary": "Edit: /x/a.py"})])
        self.assertEqual(live[4][0], "file.diff")
        self.assertIn("-x = 1\n+x = 2\n", live[4][2]["diff"])
        self.assertEqual(live[5], ("tool.result", "system", {"name": "Edit", "ok": True, "summary": "Updated /x/a.py"}))
        self.assertEqual(result.session_id, "s1")

    def test_follows_a_new_transcript_without_replaying_a_resumed_one(self):
        h = Harness(self)
        self.assertTrue(h.agent._live.ready.wait(5))
        # A resumed conversation: its history is not replayed, only what comes next.
        (h.transcripts / "s2.jsonl").write_text(json.dumps({"type": "user", "message": {"content": "s2 history"}}) + "\n")
        h.set_session("s2", source="resume")
        live = h.agent._live
        with live.switched:  # it has moved on to s2 (so "new in s2" is really new to it)
            self.assertTrue(live.switched.wait_for(lambda: live.following == str(h.transcripts / "s2.jsonl"), 5))
        h.transcript_line({"type": "user", "message": {"content": "new in s2"}})
        self.assertEqual(h.wait("message.user").data["text"], "new in s2")
        # A fresh conversation (/clear): read from its start, even if Claude wrote before we noticed.
        (h.transcripts / "s3.jsonl").write_text(json.dumps({"type": "user", "message": {"content": "first in s3"}}) + "\n")
        h.set_session("s3", source="clear")
        with h.cond:
            h.cond.wait_for(lambda: any(e.data.get("text") == "first in s3" for e in h.events), 5)
        texts = [e.data["text"] for e in h.events if e.type == "message.user"]
        self.assertEqual(texts, ["new in s2", "first in s3"])


class ConstructionTest(unittest.TestCase):
    def test_building_the_adapter_reads_no_file(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"HOME": home}), \
                mock.patch("builtins.open", side_effect=AssertionError("opened a file")):
            ClaudeTmux({})


class SessionsTest(unittest.TestCase):
    def write(self, h, sid, first, mtime):
        path = h.transcripts / f"{sid}.jsonl"
        path.write_text("\n".join(json.dumps(e) for e in [
            {"type": "user", "isMeta": True, "message": {"content": "meta"}},
            {"type": "user", "message": {"content": "<command-name>/clear</command-name>"}},
            {"type": "user", "message": {"content": [{"type": "text", "text": f"[Telegram message from Arpit]\n{first}"}]}},
        ]) + "\n")
        os.utime(path, (mtime, mtime))

    def test_list_titles_forks_names_and_find(self):
        h = Harness(self)
        self.write(h, "aaaa1111", "YouTube automation ideas", 100)
        self.write(h, "bbbb2222", "Fix the disk alert", 300)
        self.write(h, "cccc3333", "YouTube automation ideas", 200)  # an untracked old fork: same title, older
        self.write(h, "dddd4444", "side lane fork", 400)
        (h.transcripts / "s1.jsonl").unlink()
        h.agent.state.update(lambda s: s.update(side_sessions=["dddd4444"], session_names={"aaaa1111": "yt"}))
        listing = h.agent.list_sessions()
        self.assertEqual([(x["session_id"], x["title"]) for x in listing],
                         [("bbbb2222", "Fix the disk alert"), ("cccc3333", "YouTube automation ideas"), ("aaaa1111", "yt")])
        self.assertEqual(h.state()["last_listing"], ["bbbb2222", "cccc3333", "aaaa1111"])
        self.assertEqual([h.agent.find_session(a) for a in ("2", "YT", "bbbb", "zz", "9")],
                         ["cccc3333", "aaaa1111", "bbbb2222", None, None])
        with mock.patch.object(h.agent.sessions, "_first_message", side_effect=AssertionError("re-read")):
            h.agent.list_sessions()  # titles are cached: no transcript is opened again

    def test_resume_new_and_name(self):
        h = Harness(self)
        (h.transcripts / "other.jsonl").write_text("")
        self.assertEqual(h.agent.resume("nope"), "missing")
        self.assertEqual(h.agent.resume("s1"), "already")
        h.fake.on_key = None
        respawned = []

        def respawn_runner(*args, input=None):
            r = FakeTmux.__call__(h.fake, *args, input=input)
            if args[0] == "respawn-pane":  # Claude restarts and the SessionStart hook fires
                respawned.append(args[-1])
                threading.Timer(0.05, h.set_session, args=("other", time.time() + 1)).start()
            return r
        h.agent.tmux._runner = respawn_runner
        before = []
        self.assertEqual(h.agent.resume("other", before=lambda: before.append(1)), "ok")
        self.assertEqual((before, respawned), ([1], [f"{h.work_dir}/bridge/edith-claude.sh other"]))
        self.assertEqual(h.state()["sessions"]["111"], "other")
        self.assertEqual(h.agent.name_session("x" * 80), "other")
        self.assertEqual(h.state()["session_names"]["other"], "x" * 60)
        self.assertEqual(h.agent.new_session(), "ok")
        self.assertEqual(h.fake.typed[-1], "/clear")
        self.assertNotIn("111", h.state()["sessions"])
        h.agent.main_busy.set()
        self.assertEqual((h.agent.resume("s1"), h.agent.new_session()), ("busy", "busy"))


class PermissionTest(unittest.TestCase):
    def test_request_resolve_and_gone(self):
        h = Harness(self)
        perms = h.state_dir / "perms"
        (perms / "ab12cd34.req.json").write_text(json.dumps(
            {"id": "ab12cd34", "tool_name": "Bash", "input": {"command": "sudo ls"}, "ts": 1, "run": None}))
        req = h.wait("permission.request")
        self.assertEqual(req.data, {"id": "ab12cd34", "tool": "Bash", "detail": "sudo ls", "ref": None, "lane": None})
        self.assertTrue(h.agent.resolve_permission("ab12cd34", True))
        self.assertEqual((perms / "ab12cd34.decision").read_text(), "allow")
        (perms / "ab12cd34.req.json").unlink()  # perm.py cleans up after reading the decision
        self.assertEqual(h.wait("permission.resolved").data["decision"], "allow")
        self.assertFalse(h.agent.resolve_permission("ab12cd34", False))  # already gone

        (perms / "ee55ff66.req.json").write_text(json.dumps(
            {"id": "ee55ff66", "tool_name": "Write", "input": {"file_path": "~/.ssh/x"}, "run": None}))
        self.assertEqual(h.wait_id("permission.request", "ee55ff66").data["detail"], "~/.ssh/x")
        (perms / "ee55ff66.req.json").unlink()  # timed out in perm.py
        self.assertEqual(h.wait_id("permission.resolved", "ee55ff66").data["decision"], "gone")

    def test_request_from_a_running_turn_names_it(self):
        h = Harness(self)
        h.mode = "hang"
        h.agent.send("task", "telegram", "m1")
        h.wait("turn.progress", "m1")
        rid = (h.state_dir / "tmux-run").read_text()
        (h.state_dir / "perms" / "11aa22bb.req.json").write_text(json.dumps(
            {"id": "11aa22bb", "tool_name": "Bash", "input": {"command": "sudo x"}, "run": rid}))
        req = h.wait("permission.request")
        self.assertEqual((req.data["ref"], req.data["lane"], req.origin), ("m1", "main", "telegram"))


if __name__ == "__main__":
    unittest.main()
