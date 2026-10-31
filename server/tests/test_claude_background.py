"""Background work of the tmux Claude (contracts/status.md, "Background"): read from its transcript
(tests/data/transcript_background.jsonl, shaped like Claude Code's own entries) and checked against
its session file. No threads here: the live view's parts are called directly."""
import datetime as dt
import json
import os
import pathlib
import shutil
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from edith.adapters.agents.claude_tmux import live as live_mod
from edith.adapters.agents.claude_tmux.background import Background
from edith.adapters.agents.claude_tmux.live import LiveView
from edith.common.claude_sessions import proc_stat

FIXTURE = pathlib.Path(__file__).parent / "data" / "transcript_background.jsonl"
LINES = [json.loads(line) for line in FIXTURE.read_text().splitlines()]


def ts(s):
    return dt.datetime.fromisoformat(s).timestamp()


BASH = {"id": "toolu_bash1", "kind": "shell", "label": "Wait for PR 41 CI to finish", "started": ts("2026-10-31T11:06:14.284Z")}
AGENT = {"id": "toolu_agent1", "kind": "agent", "label": "Review PR 41", "started": ts("2026-10-31T11:07:00.000Z")}
TAIL = {"id": "toolu_bash2", "kind": "shell", "label": "tail -f /var/log/x.log", "started": ts("2026-10-31T11:07:10.000Z")}


class BackgroundTest(unittest.TestCase):
    def test_jobs_start_and_end_as_the_transcript_says(self):
        bg, seen = Background(), []
        for e in LINES:
            changed = bg.feed(e)
            seen.append((changed, [j["id"] for j in bg.jobs()]))
        self.assertEqual(seen, [
            (False, []),
            (True, ["toolu_bash1"]),                    # run_in_background "true" (a string)
            (False, ["toolu_bash1"]),                   # its result: the task id, nothing new
            (True, ["toolu_bash1", "toolu_agent1"]),    # an Agent with run_in_background true
            (False, ["toolu_bash1", "toolu_agent1"]),
            (True, ["toolu_bash1", "toolu_agent1", "toolu_bad"]),
            (True, ["toolu_bash1", "toolu_agent1"]),    # an error result: it never started
            (False, ["toolu_bash1", "toolu_agent1"]),   # a subagent's own (sidechain) job isn't the session's
            (True, ["toolu_bash1", "toolu_agent1", "toolu_bash2"]),
            (False, ["toolu_bash1", "toolu_agent1", "toolu_bash2"]),
            (False, ["toolu_bash1", "toolu_agent1", "toolu_bash2"]),  # the reply: the turn ends, the jobs go on
            (False, ["toolu_bash1", "toolu_agent1", "toolu_bash2"]),  # TaskStop asked…
            (True, ["toolu_bash1", "toolu_agent1"]),    # …and done
            (False, ["toolu_bash1", "toolu_agent1"]),   # a queue-operation entry
            (True, ["toolu_bash1"]),                    # the agent's notification (by tool-use id)
            (True, []),                                 # the shell's (by task id; content as blocks)
        ])

    def test_what_a_job_says(self):
        bg = Background()
        for e in LINES[:10]:
            bg.feed(e)
        self.assertEqual(bg.jobs(), [BASH, AGENT, TAIL])  # oldest first; no description: the command
        self.assertTrue(bg.drop_started_before(BASH["started"] + 1))
        self.assertEqual([j["id"] for j in bg.jobs()], ["toolu_agent1", "toolu_bash2"])
        self.assertFalse(bg.drop_started_before(0))

    def test_long_labels_and_a_bounded_list(self):
        bg = Background()
        bg.feed({"type": "assistant", "timestamp": "2026-10-31T11:00:00Z", "message": {"content": [
            {"type": "tool_use", "id": "t0", "name": "Agent", "input": {"prompt": "line one " * 30 + "\nline two",
                                                                         "run_in_background": True}}]}})
        self.assertEqual(len(bg.jobs()[0]["label"]), 80)
        self.assertTrue(bg.jobs()[0]["label"].endswith("…"))
        for i in range(60):
            bg.feed({"type": "assistant", "timestamp": f"2026-10-31T11:{i // 60 + 1:02d}:{i % 60:02d}Z", "message": {"content": [
                {"type": "tool_use", "id": f"t{i + 1}", "name": "Bash", "input": {"command": "x", "run_in_background": True}}]}})
        jobs = bg.jobs()
        self.assertEqual((len(jobs), jobs[0]["id"]), (50, "t11"))  # the oldest ones (never seen to end) go first
        self.assertFalse(bg.feed("not an entry") or bg.feed({"type": "user", "message": {"content": None}}))


class LiveBackgroundTest(unittest.TestCase):
    """The live view's part: seeding at start, the published event and the session file's last word."""

    def setUp(self):
        self.home = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home)
        (self.home / ".claude/sessions").mkdir(parents=True)
        self.transcript = self.home / "s1.jsonl"
        self.published = []
        self.live = LiveView(SimpleNamespace(home=str(self.home)), lambda: {"session_id": "s1", "transcript_path": str(self.transcript)},
                             lambda *a: self.published.append(a), lambda rid: None)

    def claude(self, status, updated):
        """This test process plays the Claude running conversation s1."""
        pid = os.getpid()
        (self.home / f".claude/sessions/{pid}.json").write_text(json.dumps(
            {"pid": pid, "sessionId": "s1", "procStart": proc_stat(pid)[1], "status": status, "statusUpdatedAt": updated * 1000}))

    def test_seeded_from_the_transcript_and_checked_against_the_session_file(self):
        self.transcript.write_text("".join(json.dumps(e) + "\n" for e in LINES[:11]))  # before the bridge started
        self.claude("shell", BASH["started"] + 100)  # Claude says it is still working: the jobs stand
        self.live._seed(str(self.transcript))
        self.assertEqual(self.live.background(), [BASH, AGENT, TAIL])
        self.assertEqual(self.published, [])

        self.claude("idle", TAIL["started"] - 1)  # idle, but before the newest job began: that one stands
        self.live._bg_checked = -1e9
        self.assertEqual(self.live.background(), [TAIL])
        self.assertEqual(self.published, [("background.changed", "system", "s1", {"jobs": [TAIL]})])
        self.claude("idle", TAIL["started"] + 1)
        self.assertEqual(self.live.background(), [TAIL])  # checked at most every max_age seconds
        self.assertEqual(self.live.background(max_age=0), [])

    def test_no_claude_running_the_conversation_means_no_jobs(self):
        self.transcript.write_text("".join(json.dumps(e) + "\n" for e in LINES[:3]))
        self.live._seed(str(self.transcript))  # no session file: Claude isn't running, its jobs died with it
        self.assertEqual(self.live.background(), [])

    def test_a_missing_transcript_seeds_nothing(self):
        self.live._seed(str(self.home / "nope.jsonl"))
        self.live._seed(None)
        self.assertEqual(self.live.background(), [])

    def test_the_check_is_rate_limited_while_jobs_run(self):
        self.transcript.write_text(json.dumps(LINES[1]) + "\n")
        self.claude("shell", 0)
        with mock.patch.object(live_mod, "by_session_id", wraps=live_mod.by_session_id) as check:
            self.live._seed(str(self.transcript))
            for _ in range(5):
                self.live.background()
        self.assertEqual(check.call_count, 1)


if __name__ == "__main__":
    unittest.main()
