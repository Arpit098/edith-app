"""The agent adapter (docs/PHASE1_PLAN.md, step 4): main lane in tmux, side lanes, queue, /stop,
conversations and the permission relay, with the legacy bridge's rules. Runs against FakeTmux
(playing the tmux Claude and its hooks) and the fake `claude -p`, in a temporary HOME."""
import datetime as dt
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
from edith.adapters.agents.claude_tmux.live import events_of
from edith.adapters.agents.claude_tmux.tmux import Tmux
from edith.core import CommandCall, EventBus, Ports, Registry, load_features
from edith.ports.agent import TurnHandle
from tests.fakes import FAKE_CLAUDE, FakeTmux
from tests.fakes.tmux import PROMPT
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
        self.running, self.fold, self.backlog = False, True, []  # a turn in progress; what typing during it does
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

    def types(self, ref, messages=False):
        """The event types for a ref; message.* (accepted, delivered, side replies) only if asked."""
        return [e.type for e in self.events if e.data.get("ref") == ref and (messages or not e.type.startswith("message."))]

    def hook_event(self, **ev):
        with open(self.state_dir / "tmux-events.jsonl", "a") as f:
            f.write(json.dumps({"ts": time.time(), **ev}) + "\n")

    def transcript_line(self, entry):
        with open(self.transcript, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def folded(self, text):
        """What Claude Code writes when a message typed during a turn reaches it at a tool boundary."""
        self.transcript_line({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t0", "content": "ok"},
            {"type": "text", "text": f"The user sent a new message while you were working:\n{text}\n\nThis is how "
                                     "Claude Code surfaces messages the user sends mid-turn."}]}})

    def on_submit(self, text):
        m = REF.search(text)
        if not m:
            return
        if self.mode == "mid_turn":  # Claude was busy: Claude Code folds the message into the running turn
            self.folded(text)
            self.finish()
            return
        if self.running:  # typed while Claude works: folded in, or (fold off) sent as the next turn
            self.folded(text) if self.fold else self.backlog.append(text)
            return
        self.start_turn(text)

    def start_turn(self, text):
        self.running = True
        self.hook_event(event="prompt", session_id="s1", ref=REF.search(text)[1])
        self.transcript_line({"type": "user", "message": {"content": text}})
        self.transcript_line({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Bash", "input": {"command": "df -h", "description": "Check disk"}}]}})
        if self.mode == "done":
            self.finish()

    def finish(self):
        self.hook_event(event="stop", session_id="s1", text=self.reply)
        self.running = False
        if self.backlog:  # Claude Code sends what it held back as the next turn
            self.start_turn(self.backlog.pop(0))

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
                                                      "elapsed": 0, "is_error": False, "subtype": "success",
                                                      "display_text": "Main reply", "files": [], "reaction": None})
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
        self.assertEqual(h.agent.send("next", "telegram", "m2", force_queue=True).lane, "queued")  # /queue: a turn of its own
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


class HoldTest(unittest.TestCase):
    """While a Claude account switch runs, the agent starts nothing (accounts feature, contracts/accounts.md)."""

    def test_hold_queues_everything_and_never_starts_the_tmux_claude(self):
        h = Harness(self)
        starts = []
        h.agent.tmux._start_service = lambda: starts.append(1)
        h.fake.alive = False  # the switch stopped edith-claude
        h.agent.hold()
        self.assertTrue(h.agent.held())
        self.assertEqual(h.agent.send("one", "telegram", "m1").lane, "queued")
        self.assertEqual(h.agent.send("two", "app", "m2").lane, "queued")  # not a side lane either
        self.assertEqual([h.wait("turn.queued", r).data["position"] for r in ("m1", "m2")], [1, 2])
        self.assertEqual(h.agent.resume("s2"), "busy")
        self.assertEqual(h.agent.new_session(), "busy")
        self.assertEqual(h.agent.compact()[0], "busy")
        time.sleep(0.2)  # nothing may happen while held: give a wrong start the chance to show
        self.assertEqual(starts, [])
        self.assertEqual(h.types("m1"), ["turn.queued"])
        self.assertEqual(h.agent.status(), ([], 2))  # both wait
        h.fake.alive = True  # the switch started her again
        h.agent.release()
        self.assertIsNotNone(h.wait("turn.done", "m1"))
        self.assertIsNotNone(h.wait("turn.done", "m2"))

    def test_stop_drops_what_waits_for_a_hold(self):
        h = Harness(self)
        h.agent.hold()
        h.agent.send("one", "telegram", "m1")
        h.agent.send("two", "telegram", "m2")
        h.wait("turn.queued", "m2")
        self.assertEqual(sorted(h.agent.stop().dropped), ["m1", "m2"])
        h.agent.release()
        self.assertEqual(h.types("m1"), ["turn.queued", "turn.stopped"])
        self.assertFalse(h.agent.busy())


class SideLaneTest(unittest.TestCase):
    """The legacy busy_policy "side_lane": every message sent while the main lane is busy runs in a side lane."""
    def test_busy_main_lane_sends_to_a_side_lane_and_hands_over_notes(self):
        h = Harness(self, busy_policy="side_lane")
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
        h = Harness(self, busy_policy="side_lane", max_side_lanes=1, side_plan=plan(hang=True))
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
        h = Harness(self, busy_policy="side_lane", side_plan=plan(events=[], exit_code=1, stderr="x" * 1000 + "\nboom\n"))
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
        h = Harness(self, busy_policy="side_lane", side_plan=plan(hang=True))
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
        h = Harness(self, busy_policy="side_lane", side_plan=plan(reply="ok", stderr_first="w" * 200_000))
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


class BusyPolicyTest(unittest.TestCase):
    """busy_policy "queue" (the default): a message sent while the main lane works is typed into the
    running turn at once and read before its answer; /btw (parallel) runs in a side lane instead."""

    def busy(self, **config):
        h = Harness(self, **config)
        h.mode = "hang"
        h.agent.send("long task", "app", "m1")
        h.wait("turn.progress", "m1")
        return h

    def test_a_busy_message_is_read_by_the_running_turn_before_its_answer(self):
        h = self.busy()
        self.assertEqual(h.agent.send("also check the logs", "app", "m2").lane, "queued")
        self.assertTrue(h.wait("turn.queued", "m2").data["fold"])
        self.assertEqual(h.wait("message.delivered", "m2").data["delivery"], "mid_turn")  # before m1 is done
        self.assertIsNone(h.wait("turn.done", "m1", timeout=0.2))
        self.assertTrue(any("also check the logs" in s and "[tg-ref " in s for s in h.fake.submitted))
        self.assertEqual(h.agent.status()[1], 0)  # not waiting any more: it's in the turn
        h.finish()
        self.assertEqual(h.wait("turn.done", "m1").data["text"], "Main reply")  # the one reply answers both
        self.assertEqual(h.types("m2"), ["turn.queued"])  # no turn of its own
        self.assertEqual([e.data["delivery"] for e in h.events if e.type == "message.user" and e.data.get("ref") == "m2"],
                         ["queued"])  # the live view didn't show it again
        self.assertFalse(h.agent.busy())

    def test_one_typed_too_late_for_the_turn_becomes_the_next_turn_without_typing_it_again(self):
        h = self.busy()
        h.fold = False  # Claude Code holds it back until the turn ends
        h.agent.send("then this", "app", "m2")
        h.wait("turn.queued", "m2")
        with h.cond:
            h.cond.wait_for(lambda: len(h.backlog) == 1, 5)
        h.mode = "done"
        h.finish()  # m1 ends; Claude Code sends m2 as its own turn
        self.assertIsNotNone(h.wait("turn.done", "m1"))
        self.assertEqual(h.wait("message.delivered", "m2").data["delivery"], "main")
        self.assertIsNotNone(h.wait("turn.done", "m2"))
        self.assertEqual(h.types("m2"), ["turn.queued", "turn.started", "turn.progress", "turn.done"])  # its own steps
        self.assertEqual(sum("then this" in s for s in h.fake.submitted), 1)  # typed once

    def test_stop_also_stops_a_typed_message_the_turn_hadnt_read(self):
        h = self.busy()
        h.fold = False
        h.agent.send("then this", "app", "m2")
        with h.cond:
            h.cond.wait_for(lambda: len(h.backlog) == 1, 5)
        h.agent.stop()
        self.assertEqual(h.wait("turn.stopped", "m1").data["lane"], "main")
        self.assertEqual(h.wait("turn.stopped", "m2").data["lane"], "main")
        self.assertIn("C-u", h.fake.keys)  # its text can't ride along with the next message

    def test_btw_runs_in_a_side_lane(self):
        h = self.busy()
        self.assertEqual(h.agent.send("what time is it", "app", "m2", parallel=True).lane, "side")
        self.assertEqual(h.wait("message.delivered", "m2").data["delivery"], "side_lane")
        self.assertIsNotNone(h.wait("turn.done", "m2"))
        self.assertFalse(any("what time is it" in s for s in h.fake.submitted))  # never typed into the main turn

    def test_btw_with_no_side_lane_free_waits_like_any_message(self):
        h = self.busy(max_side_lanes=0)
        self.assertEqual(h.agent.send("what time is it", "app", "m2", parallel=True).lane, "queued")
        self.assertTrue(h.wait("turn.queued", "m2").data["fold"])
        self.assertEqual(h.wait("message.delivered", "m2").data["delivery"], "mid_turn")

    def test_a_held_session_and_queue_wait_for_a_turn_of_their_own(self):
        h = self.busy()
        self.assertEqual(h.agent.send("after it", "app", "m2", force_queue=True).lane, "queued")  # /queue
        self.assertFalse(h.wait("turn.queued", "m2").data["fold"])
        self.assertIsNone(h.wait("message.delivered", "m2", timeout=0.3))
        h.agent.hold()
        self.assertEqual(h.agent.send("while held", "app", "m3").lane, "queued")
        self.assertFalse(h.wait("turn.queued", "m3").data["fold"])
        self.assertFalse(any("after it" in s or "while held" in s for s in h.fake.submitted))
        self.assertEqual(h.agent.status()[1], 2)

    def test_the_side_lane_policy_keeps_the_old_behaviour(self):
        h = self.busy(busy_policy="side_lane")
        self.assertEqual(h.agent.send("what's up", "app", "m2").lane, "side")
        with self.assertLogs("edith.adapter.claude_tmux", "WARNING") as logs:
            self.assertEqual(Harness(self, busy_policy="parallel").agent.busy_policy, "queue")  # never a crash
        self.assertIn("busy_policy 'parallel'", logs.output[0])

    def test_the_turns_end_names_the_messages_it_answered(self):
        h = self.busy()
        h.agent.send("also check the logs", "app", "m2")
        h.wait("message.delivered", "m2")
        h.finish()
        self.assertEqual(h.wait("turn.done", "m1").data["answers"], ["m2"])

    def test_nothing_is_typed_into_a_dialog(self):
        for dialog in ("Do you want to proceed?\n❯ 1. Yes\n  2. No",                       # a permission
                       "What do you want to do?\n❯ 1. Stop and wait for limit to reset",    # the rate-limit menu
                       "Which one?\n❯ 1. Postgres\n  2. SQLite\nEnter to select · ↑/↓ to navigate · Esc to cancel"):
            with self.subTest(dialog=dialog.splitlines()[0]):
                h = self.busy()
                h.fake.pane = dialog
                h.agent.send("also this", "app", "m2")
                h.wait("turn.queued", "m2")
                h.transcript_line({"type": "assistant", "message": {"content": [{"type": "text", "text": "…"}]}})  # a wake-up
                self.assertIsNone(h.wait("message.delivered", "m2", timeout=0.5))
                self.assertFalse(any("also this" in s for s in h.fake.submitted))  # Enter never reached the dialog
                h.fake.pane = PROMPT  # answered: the next wake-up types it
                h.transcript_line({"type": "assistant", "message": {"content": [{"type": "text", "text": "…"}]}})
                self.assertEqual(h.wait("message.delivered", "m2").data["delivery"], "mid_turn")
        h = self.busy()
        req = pathlib.Path(h.agent.paths.perm_dir) / "x.req.json"
        req.write_text("{}")  # a permission request waiting on Telegram or the app
        h.agent.send("also this", "app", "m2")
        h.wait("turn.queued", "m2")
        h.transcript_line({"type": "assistant", "message": {"content": [{"type": "text", "text": "…"}]}})
        self.assertIsNone(h.wait("message.delivered", "m2", timeout=0.5))
        req.unlink()  # answered: the next wake-up types it
        h.transcript_line({"type": "assistant", "message": {"content": [{"type": "text", "text": "…"}]}})
        self.assertEqual(h.wait("message.delivered", "m2").data["delivery"], "mid_turn")

    def test_folded_messages_fail_too_if_following_the_turn_breaks(self):
        h = self.busy()
        h.agent.send("also check the logs", "app", "m2")
        h.wait("message.delivered", "m2")
        publish = h.agent._publish

        def broken(type, *a, **kw):
            if type == "turn.done":
                raise RuntimeError("bus down")
            return publish(type, *a, **kw)
        h.agent._publish = broken
        h.finish()
        self.assertEqual(h.wait("turn.failed", "m2").data["reason"], "bridge_error")
        self.assertEqual(h.wait("turn.failed", "m1").data["detail"], "bus down")


class BtwCommandTest(unittest.TestCase):
    """/btw from the app or Telegram: the registry's command, the same on every frontend."""

    def setUp(self):
        class Agent:
            max_side_lanes, busy_policy = 2, "queue"

            def __init__(self):
                self.sent = []

            def send(self, text, origin, ref, force_queue=False, parallel=False):
                self.sent.append((text, origin, ref, force_queue, parallel))
                return TurnHandle(ref, "side")
        self.agent, self.registry = Agent(), Registry()
        load_features(["control"], EventBus(), Ports(agent=self.agent), self.registry, {})

    def run_text(self, text, origin="app"):
        found = self.registry.find_command(text)
        if not found:
            return None
        command, args = found
        prompt = f"[App message from Arpit, x]\n{args}" if command.takes_prompt and args.strip() else None
        return command.handler(CommandCall(args, origin, lambda out: None, "r1", prompt))

    def test_btw_sends_the_rest_in_parallel(self):
        for text, rest in (("/btw what time is it", "what time is it"), ("/BTW what time is it", "what time is it"),
                           ("/btw\nline one\nline two", "line one\nline two")):
            with self.subTest(text=text):
                self.agent.sent.clear()
                self.run_text(text)
                self.assertEqual(self.agent.sent, [(f"[App message from Arpit, x]\n{rest}", "app", "r1", False, True)])

    def test_btw_alone_says_how_and_other_prefixes_are_plain_text(self):
        self.assertIn("/btw <task>", self.run_text("/btw"))
        self.assertEqual(self.agent.sent, [])
        for text in ("/btwx do it", "btw do it", " /btw do it"):
            self.assertIsNone(self.registry.find_command(text), text)  # goes to Claude as an ordinary message
        self.assertIn("btw", [c["command"] for c in self.registry.menu()])  # Telegram's menu and the app's list


class LiveViewTest(unittest.TestCase):
    def test_every_transcript_entry_becomes_an_event(self):
        h = Harness(self)
        self.assertTrue(h.agent._live.ready.wait(5))
        h.transcript_line({"type": "user", "message": {"content": "typed in tmux"}})
        h.transcript_line({"type": "user", "message": {"content": "<command-name>/clear</command-name>"}})
        h.transcript_line({"type": "user", "isSidechain": True, "message": {"content": "a subagent"}})
        h.transcript_line({"type": "user", "message": {"content": "[Telegram message from Arpit, x] [voice]\nhi\n[tg-ref abc123]"}})
        h.transcript_line({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "Fixing it."},
            {"type": "tool_use", "id": "tu1", "name": "Edit",
             "input": {"file_path": "/x/a.py", "old_string": "x = 1\n", "new_string": "x = 2\n"}}]}})
        h.transcript_line({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "tu1", "is_error": False, "content": "Updated /x/a.py\nmore"}]}})
        result = h.wait("tool.result")
        self.assertIsNotNone(result)
        live = [(e.type, e.origin, e.data) for e in h.events if e.type.startswith(("message.", "tool.", "file."))]
        cursors = [d.pop("cursor") for _, _, d in live]
        self.assertEqual(live[:4], [
            ("message.user", "terminal", {"text": "typed in tmux", "voice": False, "rid": None, "attachments": [],
                                          "replying_to": None}),
            ("message.user", "telegram", {"text": "hi", "voice": True, "rid": "abc123", "attachments": [],
                                          "replying_to": None}),
            ("message.assistant", "system", {"text": "Fixing it.", "files": [], "lane": "main"}),
            ("tool.call", "system", {"id": "tu1", "name": "Edit", "summary": "Edit: /x/a.py"})])
        self.assertEqual((live[4][0], live[4][2]["id"]), ("file.diff", "tu1"))
        self.assertIn("-x = 1\n+x = 2\n", live[4][2]["diff"])
        self.assertEqual(live[5], ("tool.result", "system", {"id": "tu1", "name": "Edit", "ok": True, "summary": "Updated /x/a.py"}))
        self.assertEqual(result.session_id, "s1")
        # Each event's cursor is its entry's end in the transcript: the same as history() gives.
        lines = h.transcript.read_bytes().splitlines(keepends=True)
        ends = [sum(map(len, lines[:i + 1])) for i in range(len(lines))]
        self.assertEqual(cursors, [f"s1:{ends[i]}" for i in (0, 3, 4, 4, 4, 5)])
        self.assertEqual([e["data"]["cursor"] for e in h.agent.history(limit=50)["events"]], cursors)

    def test_a_command_typed_for_a_frontend_is_not_echoed_as_terminal(self):
        h = Harness(self)
        self.assertTrue(h.agent._live.ready.wait(5))
        h.agent._type_command("/compact keep  the plan")  # as compact() does for the app's /compact
        self.assertEqual(h.fake.typed[-1], "/compact keep  the plan")
        h.transcript_line({"type": "user", "message": {"content": "<command-name>/compact</command-name>"}})
        h.transcript_line({"type": "user", "message": {"content": "/compact keep the plan"}})  # Claude's bare copy
        h.transcript_line({"type": "user", "message": {"content": "/compact keep the plan"}})  # then typed in tmux by hand
        h.transcript_line({"type": "user", "message": {"content": "after"}})
        with h.cond:
            h.cond.wait_for(lambda: any(e.data.get("text") == "after" for e in h.events), 5)
        users = [(e.origin, e.data["text"]) for e in h.events if e.type == "message.user"]
        self.assertEqual(users, [("terminal", "/compact keep the plan"), ("terminal", "after")])  # each typed command matches once

    def test_compacts_echo_is_skipped_even_when_it_comes_minutes_after_typing(self):
        h = Harness(self)
        self.assertTrue(h.agent._live.ready.wait(5))
        clock, result = [1000.0], []
        with mock.patch("edith.adapters.agents.claude_tmux.backend.time.monotonic", lambda: clock[0]):
            t = threading.Thread(target=lambda: result.append(h.agent.compact("keep the plan")))
            t.start()
            deadline = time.monotonic() + 5  # (the real clock) until compact() has typed it
            while not any(k.startswith("/compact") for k in h.fake.typed) and time.monotonic() < deadline:
                time.sleep(0.01)
            clock[0] += 120  # compaction takes two minutes
            h.set_session("s1", ts=time.time() + 1, source="compact")  # the SessionStart hook: done
            t.join(5)
            self.assertEqual(result, [("ok", "")])
            clock[0] += 5  # Claude writes its bare "/compact …" entry after compacting
            h.transcript_line({"type": "user", "message": {"content": "/compact keep the plan"}})
            h.transcript_line({"type": "user", "message": {"content": "after"}})
            with h.cond:
                h.cond.wait_for(lambda: any(e.data.get("text") == "after" for e in h.events), 5)
        users = [e.data["text"] for e in h.events if e.type == "message.user"]
        self.assertEqual(users, ["after"])  # not a "Terminal" /compact

    def test_a_typed_command_is_remembered_for_30_seconds_only(self):
        h = Harness(self)
        clock = [1000.0]
        with mock.patch("edith.adapters.agents.claude_tmux.backend.time.monotonic", lambda: clock[0]):
            h.agent._type_command("/clear")
            clock[0] += 29
            self.assertTrue(h.agent._typed_echo("/clear"))
            self.assertFalse(h.agent._typed_echo("/clear"))  # used up
            h.agent._type_command("/clear")
            clock[0] += 31
            self.assertFalse(h.agent._typed_echo("/clear"))  # too late: typed in tmux
            self.assertFalse(h.agent._typed_echo("/compact"))
            for i in range(40):  # bounded, whatever is typed
                h.agent._type_command(f"/x{i}")
            self.assertEqual(len(h.agent._typed), 16)

    def test_only_a_bare_slash_entry_is_checked_against_typed_commands(self):
        asked = []

        def echo(text):
            asked.append(text)
            return True

        def entry(text):
            return {"type": "user", "message": {"content": text}}
        self.assertEqual(events_of(entry("/compact\n"), {}, typed_echo=echo), [])
        self.assertEqual(asked, ["/compact"])
        for text in ("hello", "[App message from Arpit, x]\n/compact\n[tg-ref ab12]", "/compact\n[tg-ref cd34]"):
            self.assertEqual(events_of(entry(text), {}, typed_echo=echo)[0][0], "message.user")
        self.assertEqual(asked, ["/compact"])  # never asked about a message with a header or a ref

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


class HistoryTest(unittest.TestCase):
    """The app's Live view: the newest events on open, older pages, and catching up after a reconnect."""

    def setUp(self):
        self.h = Harness(self, live_view=False)
        self.h.transcript.write_text("")
        self.entries = []
        for i in range(10):
            self.add({"type": "user", "timestamp": f"2026-11-02T05:{i:02d}:00Z",
                      "message": {"content": f"[App message from Arpit, x]\nq{i}\n[tg-ref ab{i}]"}})
            self.add({"type": "assistant", "message": {"content": [
                {"type": "text", "text": f"a{i}"}, {"type": "tool_use", "id": f"t{i}", "name": "Bash", "input": {"command": "ls"}}]}})
            self.add({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": "ok"}]}})

    def add(self, entry):
        self.h.transcript_line(entry)

    def texts(self, page):
        return [e["data"].get("text") or e["data"]["id"] for e in page["events"]]

    def test_newest_page_then_older_ones(self):
        page = self.h.agent.history(limit=8)
        # Whole entries only: 8 events = the last 2 turns (4 events each).
        self.assertEqual(self.texts(page), ["q8", "a8", "t8", "t8",
                                            "q9", "a9", "t9", "t9"])
        first = page["events"][0]
        self.assertEqual((first["type"], first["origin"], first["session_id"]), ("message.user", "app", "s1"))
        self.assertEqual(first["ts"], dt.datetime(2026, 11, 2, 5, 8, tzinfo=dt.timezone.utc).timestamp())
        result = page["events"][3]
        self.assertEqual(result["data"], {"id": "t8", "name": "Bash", "ok": True, "summary": "ok",
                                          "cursor": result["data"]["cursor"]})
        self.assertEqual(page["cursor"], f"s1:{self.h.transcript.stat().st_size}")
        self.assertTrue(page["more"])
        seen = self.texts(page)
        while page["more"]:
            page = self.h.agent.history(before=page["start"], limit=7)  # 7: never splits an entry's 3 events
            seen = self.texts(page) + seen
        self.assertEqual(len(seen), 40)
        self.assertEqual(seen[:2], ["q0", "a0"])

    def test_catch_up_after_a_cursor(self):
        page = self.h.agent.history(limit=4)
        self.add({"type": "user", "message": {"content": "typed later"}})
        self.add({"type": "assistant", "message": {"content": [{"type": "text", "text": "answer"}]}})
        with open(self.h.transcript, "a") as f:
            f.write('{"type": "assistant", "mess')  # being written: not read yet
        later = self.h.agent.history(after=page["cursor"])
        self.assertEqual(self.texts(later), ["typed later", "answer"])
        self.assertEqual([e["origin"] for e in later["events"]], ["terminal", "system"])
        self.assertFalse(later["more"])
        self.assertEqual(self.h.agent.history(after=later["cursor"])["events"], [])
        # Paged: limit 1 hands back one entry at a time, `more` until the end.
        one = self.h.agent.history(after=page["cursor"], limit=1)
        self.assertEqual((self.texts(one), one["more"]), (["typed later"], True))
        two = self.h.agent.history(after=one["cursor"], limit=1)
        self.assertEqual(self.texts(two), ["answer"])

    def test_reads_only_what_it_needs(self):
        size = self.h.transcript.stat().st_size
        real_open, read = open, []

        class Counting:
            def __init__(self, f):
                self.f = f

            def __getattr__(self, name):
                return getattr(self.f, name)

            def read(self, n=-1):
                data = self.f.read(n)
                read.append(len(data))
                return data

            def __enter__(self):
                return self

            def __exit__(self, *a):
                self.f.close()

        with mock.patch("builtins.open", lambda *a, **k: Counting(real_open(*a, **k))), \
                mock.patch("edith.adapters.agents.claude_tmux.transcript.read_backward.__defaults__", (64,)):
            self.h.agent.history(limit=4)
        self.assertLess(sum(read), size / 3)  # the newest entries, not the whole file

    def test_other_conversations_and_bad_cursors(self):
        other = self.h.transcripts / "s2.jsonl"
        other.write_text(json.dumps({"type": "user", "message": {"content": "in s2"}}) + "\n")
        self.assertEqual(self.texts(self.h.agent.history("s2")), ["in s2"])
        self.assertIsNone(self.h.agent.history("nope"))
        self.assertIsNone(self.h.agent.history("../etc/passwd"))
        page = self.h.agent.history(after="s2:0", limit=2)  # a cursor from another conversation
        self.assertTrue(page["reset"])
        self.assertEqual(self.texts(page), ["t9"])  # the newest page instead (the entry before has 2 events)
        with self.assertRaises(ValueError):
            self.h.agent.history(after="s1:abc")


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
