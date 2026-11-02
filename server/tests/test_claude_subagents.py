"""EDITH's subagents (contracts/status.md, "Subagents"): her Agent calls, foreground and background,
read from the transcript (tests/data/transcript_subagents.jsonl, shaped like Claude Code's own
entries), their last activity from their own transcripts, and the live view's part: the session
file's last word, a conversation switch and subagents.changed. No threads: parts are called directly."""
import datetime as dt
import json
import os
import pathlib
import shutil
import tempfile
import unittest
from types import SimpleNamespace

from edith.adapters.agents.claude_tmux.background import Background
from edith.adapters.agents.claude_tmux.live import LiveView
from edith.adapters.agents.claude_tmux.subagents import RETAIN, Subagents, last_activity
from edith.common.claude_sessions import proc_stat

FIXTURE = pathlib.Path(__file__).parent / "data" / "transcript_subagents.jsonl"
LINES = [json.loads(line) for line in FIXTURE.read_text().splitlines()]


def ts(s):
    return dt.datetime.fromisoformat(s).timestamp()


def states(sa, now):
    return [(a["id"], a["state"]) for a in sa.entries(now)]


REV = {"id": "toolu_rev", "description": "Review PR 61", "type": "general-purpose", "model": "claude-opus-5-5",
       "effort": "medium", "background": True, "state": "running", "started": ts("2026-11-02T10:00:10.000Z"), "ended": None}
FIX = {"id": "toolu_fix", "description": "Fix PR 61 review findings", "type": "general-purpose", "model": "sonnet",
       "effort": None, "background": True, "state": "running", "started": ts("2026-11-02T10:00:20.000Z"), "ended": None}
FG = {"id": "toolu_fg", "description": "Find the CI config", "type": "Explore", "model": "claude-haiku-5", "effort": None,
      "background": False, "state": "done", "started": ts("2026-11-02T10:00:30.000Z"), "ended": ts("2026-11-02T10:01:30.000Z")}
NOW = ts("2026-11-02T10:31:00.000Z")
SOON = ts("2026-11-02T10:05:00.000Z")


class SubagentsTest(unittest.TestCase):
    def test_states_follow_the_transcript(self):
        sa, seen = Subagents(), []
        for e in LINES:
            changed = sa.feed(e)
            seen.append((changed, [s for _, s in states(sa, NOW)]))
        self.assertEqual(seen, [
            (False, []),
            (True, ["running"]),                                  # an Agent call, async by default
            (True, ["running"]),                                  # async_launched: its id and model
            (True, ["running", "running"]),                       # run_in_background true
            (True, ["running", "running"]),
            (True, ["running", "running", "running"]),            # a foreground one…
            (False, ["running", "running", "running"]),           # (a subagent's own Agent call isn't EDITH's)
            (True, ["running", "running", "done"]),               # …ends with its answer
            (True, ["running", "running", "done", "running"]),
            (True, ["running", "running", "done", "failed"]),     # an error result: failed
            (False, ["running", "running", "done", "failed"]),    # the reply: the turn ends, they go on
            (True, ["done", "running", "done", "failed"]),        # the reviewer's notification
            (False, ["done", "running", "done", "failed"]),       # TaskStop asked…
            (True, ["done", "stopped", "done", "failed"]),        # …and done
            (True, ["done", "stopped", "done", "failed", "running"]),
            (True, ["done", "stopped", "done", "failed", "running"]),
            (True, ["done", "stopped", "done", "failed", "stopped"]),  # an orphan notice: several task ids
        ])

    def test_what_an_entry_says_and_never_the_prompt(self):
        sa = Subagents()
        for e in LINES[:8]:
            sa.feed(e)
        self.assertEqual(sa.entries(NOW), [REV, FIX, FG])
        self.assertEqual(sa.running(), [("toolu_rev", "arev0000000000001"), ("toolu_fix", "afix0000000000002")])
        for e in LINES[8:]:
            sa.feed(e)
        dumped = json.dumps(sa.entries(NOW))
        self.assertNotIn("SECRET_PROMPT", dumped)
        self.assertNotIn("ghp_", dumped)
        rev = sa.entries(NOW)[0]
        self.assertEqual((rev["state"], rev["ended"]), ("done", ts("2026-11-02T10:20:00.000Z")))

    def test_finished_ones_are_kept_for_a_while(self):
        sa = Subagents()
        for e in LINES:
            sa.feed(e)
        ended_fg = FG["ended"]
        self.assertIn("toolu_fg", [a["id"] for a in sa.entries(ended_fg + RETAIN)])
        self.assertNotIn("toolu_fg", [a["id"] for a in sa.entries(ended_fg + RETAIN + 1)])
        self.assertEqual(sa.entries(NOW + 2 * RETAIN), [])

    def test_stop_running_and_a_bounded_list(self):
        sa = Subagents()
        for e in LINES[:5]:
            sa.feed(e)
        self.assertTrue(sa.stop_running(FIX["started"], REV["started"] + 5))  # idle after the reviewer began only
        self.assertEqual(states(sa, SOON), [("toolu_rev", "stopped"), ("toolu_fix", "running")])
        self.assertEqual(sa.entries(SOON)[0]["ended"], REV["started"] + 5)
        self.assertFalse(sa.stop_running(0, 0))
        for i in range(60):
            sa.feed({"type": "assistant", "timestamp": f"2026-11-02T11:{i:02d}:00Z", "message": {"content": [
                {"type": "tool_use", "id": f"t{i}", "name": "Agent", "input": {"description": f"job {i}"}}]}})
        self.assertEqual(len(sa.entries(NOW)), 50)
        self.assertNotIn("toolu_rev", [a["id"] for a in sa.entries(NOW)])  # the finished one went first
        self.assertFalse(sa.feed("not an entry") or sa.feed({"type": "user", "message": {"content": None}}))

    def test_an_interrupted_foreground_agent_is_stopped(self):
        sa = Subagents()
        sa.feed(LINES[5])
        sa.feed({"type": "user", "timestamp": "2026-11-02T10:00:40Z", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_fg", "is_error": True,
             "content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]}]}})
        self.assertEqual(states(sa, SOON), [("toolu_fg", "stopped")])


class BackgroundAsyncAgentTest(unittest.TestCase):
    def test_an_async_agent_without_run_in_background_is_background_work(self):
        bg = Background()
        for e in LINES[:8]:
            bg.feed(e)
        self.assertEqual([j["id"] for j in bg.jobs()], ["toolu_rev", "toolu_fix"])  # not the foreground one
        for e in LINES:
            bg.feed(e)
        self.assertEqual(bg.jobs(), [])  # the notification, the TaskStop and the orphan notice end them all


class LastActivityTest(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)

    def write(self, *entries):
        path = self.dir / "agent-a1.jsonl"
        path.write_text("".join(json.dumps(e) + "\n" for e in entries))
        return str(path)

    def test_the_latest_tool_or_text(self):
        tool = {"type": "assistant", "isSidechain": True, "message": {"content": [
            {"type": "text", "text": "Running the tests"}, {"type": "tool_use", "name": "Bash", "input": {"command": "npm test"}}]}}
        result = {"type": "user", "isSidechain": True, "message": {"content": [{"type": "tool_result", "content": "ok"}]}}
        self.assertEqual(last_activity(self.write(tool, result, {"type": "api-request"})), "$ npm test")
        text = {"type": "assistant", "message": {"content": [{"type": "text", "text": "\nAll good. " + "x" * 200}]}}
        line = last_activity(self.write(tool, text))
        self.assertTrue(line.startswith("All good.") and line.endswith("…") and len(line) == 100)
        self.assertIsNone(last_activity(self.write(result)))
        self.assertIsNone(last_activity(str(self.dir / "nope.jsonl")))


class LiveSubagentsTest(unittest.TestCase):
    def setUp(self):
        self.home = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home)
        (self.home / ".claude/sessions").mkdir(parents=True)
        self.transcript = self.home / "s1.jsonl"
        self.subdir = self.home / "s1" / "subagents"
        self.subdir.mkdir(parents=True)
        self.state = {"session_id": "s1", "transcript_path": str(self.transcript)}
        self.published = []
        self.live = LiveView(SimpleNamespace(home=str(self.home)), lambda: dict(self.state),
                             lambda *a: self.published.append(a), lambda rid: None)
        self.live.now = lambda: SOON

    def claude(self, status, updated, sid="s1"):
        pid = os.getpid()
        (self.home / f".claude/sessions/{pid}.json").write_text(json.dumps(
            {"pid": pid, "sessionId": sid, "procStart": proc_stat(pid)[1], "status": status, "statusUpdatedAt": updated * 1000}))

    def sub_transcript(self, agent_id, command, tool_use_id=None):
        (self.subdir / f"agent-{agent_id}.jsonl").write_text(json.dumps({"type": "assistant", "isSidechain": True, "message": {
            "content": [{"type": "tool_use", "name": "Bash", "input": {"command": command}}]}}) + "\n")
        if tool_use_id:
            (self.subdir / f"agent-{agent_id}.meta.json").write_text(json.dumps({"toolUseId": tool_use_id, "agentType": "x"}))

    def published_of(self, kind):
        key = "agents" if kind == "subagents.changed" else "jobs"
        return [a[3][key] for a in self.published if a[0] == kind]

    def test_seeded_with_last_activity_and_the_session_files_word(self):
        self.transcript.write_text("".join(json.dumps(e) + "\n" for e in LINES[:6]))  # the foreground one still runs
        self.claude("busy", 0)
        self.sub_transcript("arev0000000000001", "gh pr diff 61")
        self.sub_transcript("afg00000000000003", "ls .github", tool_use_id="toolu_fg")  # its id only in the meta file
        self.live._seed(str(self.transcript))
        got = {a["id"]: (a["state"], a["last"]) for a in self.live.subagents()}
        self.assertEqual(got, {"toolu_rev": ("running", "$ gh pr diff 61"), "toolu_fix": ("running", None),
                               "toolu_fg": ("running", "$ ls .github")})
        self.sub_transcript("arev0000000000001", "gh pr review 61")  # it moved on: read again
        self.assertEqual(self.live.subagents()[0]["last"], "$ gh pr review 61")

        self.claude("idle", FG["started"] + 5)  # idle after all three began: they're over
        self.assertEqual({a["state"] for a in self.live.subagents(max_age=0)}, {"stopped"})
        [agents] = self.published_of("subagents.changed")
        self.assertEqual([(a["id"], a["state"], a["ended"]) for a in agents],
                         [(k, "stopped", FG["started"] + 5) for k in ("toolu_rev", "toolu_fix", "toolu_fg")])
        self.assertNotIn("last", agents[0])  # the event leaves it to the status details

    def test_no_claude_running_the_conversation_stops_them(self):
        self.transcript.write_text("".join(json.dumps(e) + "\n" for e in LINES[:3]))
        self.live._seed(str(self.transcript))  # no session file: the Claude that ran it is gone
        [a] = self.live.subagents()
        self.assertEqual(a["state"], "stopped")
        self.assertEqual(a["ended"], SOON)  # when that was found

    def test_a_switch_starts_afresh(self):
        self.transcript.write_text("".join(json.dumps(e) + "\n" for e in LINES[:3]))
        self.claude("busy", 0)
        self.live._seed(str(self.transcript))
        self.assertEqual([a["id"] for a in self.live.subagents()], ["toolu_rev"])
        other = self.home / "s2.jsonl"
        other.write_text("".join(json.dumps(e) + "\n" for e in LINES[3:5]))  # a resumed conversation with its own
        self.state.update(session_id="s2", transcript_path=str(other))
        self.claude("busy", 0, sid="s2")
        self.live._switch(str(other), seed=True)
        self.assertEqual([a["id"] for a in self.live.subagents()], ["toolu_fix"])
        self.assertEqual([[a["id"] for a in x] for x in self.published_of("subagents.changed")], [["toolu_fix"]])
        self.live._switch(str(self.home / "s3.jsonl"), seed=False)  # /clear: a new conversation has none
        self.assertEqual(self.live.subagents(), [])
        self.assertEqual(self.published_of("subagents.changed")[-1], [])
        self.assertEqual(self.published_of("background.changed")[-1], [])


if __name__ == "__main__":
    unittest.main()
