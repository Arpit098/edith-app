"""Step 6 end to end: a Telegram conversation through the new stack (Telegram frontend + features
+ claude_tmux adapter) must make the same Telegram API calls and hand Claude the same prompts as
the legacy bridge did for it (tests/golden/data/e2e/conversation.json).

It runs in a temp HOME with FakeTelegram, a simulated tmux Claude (SimTmux plays its hooks and
transcript) and the fake `claude -p`. Compared: every Telegram call except "typing…" and the timed
"Working… Ns" edits (their count depends on the clock; checked separately), with elapsed seconds
and file timestamps normalized.
"""
import json
import os
import pathlib
import re
import time
import unittest
from unittest import mock

from edith.adapters.agents.claude_tmux.backend import ClaudeTmux
from edith.adapters.agents.claude_tmux.tmux import Tmux
from edith.adapters.frontends.telegram import TelegramFrontend
from edith.core import EventBus, Ports, Registry, load_features
from tests.fakes import FAKE_CLAUDE, FakeTelegram, FakeTmux, callback, message
from tests.fakes.claude import plan
from tests.golden import assert_matches, load as golden
from tests.home import temp_home

STAMP = "2026-11-02 10:43 IST"
REF = re.compile(r"\[tg-ref ([0-9a-f]+)\]")
FEATURES = ["sessions", "approvals", "control", "reminders", "quick_actions"]


class SimTmux(FakeTmux):
    """The tmux Claude: each submitted message gets the next scripted action ("reply", text) or
    keeps working ("hang") until finish(); Esc interrupts it."""

    def __init__(self, home, changed):
        super().__init__(on_submit=self._submit, on_key=self._key)
        self.home, self.script, self.changed, self.running = home, [], changed, False
        self.transcript = home / ".claude/projects" / re.sub(r"[^A-Za-z0-9]", "-", str(home / "edith")) / "s1.jsonl"

    def _event(self, **ev):
        with open(self.home / ".cache/edith/tmux-events.jsonl", "a") as f:
            f.write(json.dumps({"ts": time.time(), "session_id": "s1", **ev}) + "\n")

    def _line(self, entry):
        with open(self.transcript, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def _submit(self, text):
        m = REF.search(text)
        if not m:
            return
        if self.running:  # typed while it works: Claude Code folds it into the running turn
            self._line({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t0", "content": "ok"},
                {"type": "text", "text": f"The user sent a new message while you were working:\n{text}"}]}})
        else:
            self._event(event="prompt", ref=m[1])
            self._line({"type": "user", "message": {"content": text}})
            self._line({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "Bash", "input": {"command": "ls", "description": "List files"}}]}})
            action = self.script.pop(0) if self.script else ("hang",)
            if action[0] == "reply":
                self._event(event="stop", text=action[1])
            self.running = action[0] == "hang"
        with self.changed:  # the test can wait for a submission like for a Telegram call
            self.changed.notify_all()

    def finish(self, text):
        self._event(event="stop", text=text)
        self.running = False

    def _key(self, key):
        if key == "Escape":
            self.running = False
            self._line({"type": "user", "message": {"content": "[Request interrupted by user]"}})


def fixture(home):
    folder = home / ".claude/projects" / re.sub(r"[^A-Za-z0-9]", "-", str(home / "edith"))
    folder.mkdir(parents=True)
    (folder / "s1.jsonl").write_text(json.dumps({"type": "user", "message": {"content": "[x]\nFirst chat"}}) + "\n")
    state = home / ".cache/edith"
    state.mkdir(parents=True, exist_ok=True)
    (state / "tmux-session.json").write_text(json.dumps({"session_id": "s1", "transcript_path": str(folder / "s1.jsonl"),
                                                       "source": "resume", "ts": 1}))
    (state / "bridge-state.json").write_text(json.dumps({"sessions": {"111": "s1"}, "offset": 5}))
    (home / "report.txt").write_text("the report")
    plan_file = home / "plan.json"
    plan_file.write_text(json.dumps(plan(session_id="fork-1", reply="Side answer.")))
    return plan_file


class New:
    def __init__(self, home, busy_policy="side_lane"):  # the legacy recording ran every busy message in a side lane
        self.home = home
        self.tg = FakeTelegram()
        self.tmux = SimTmux(home, self.tg.changed)
        self.agent = ClaudeTmux({"chat_key": "111", "claude_bin": FAKE_CLAUDE, "busy_policy": busy_policy},
                                tmux=Tmux(runner=self.tmux, start_service=lambda: None, settle_step=0.005))
        self.bus, self.registry = EventBus(), Registry()
        report = load_features(FEATURES, self.bus, Ports(agent=self.agent), self.registry, {})
        assert report.loaded == FEATURES, report.failed
        self.frontend = TelegramFrontend({"poll": False}, api=self.tg)
        self.agent.start(self.bus)
        self.frontend.start(self.bus, self.registry, self.agent)
        assert self.frontend.startup_done.wait(5)  # the startup calls run on the poller thread
        self.startup = self.tg.record()
        self.tg.calls.clear()

    def message(self, m):
        self.frontend.handle_update({"update_id": 6, "message": m})

    def press(self, cb):
        self.frontend.handle_update({"update_id": 7, "callback_query": cb})

    def close(self):
        self.frontend.stop()
        self.agent.shutdown()



def conversation(w):
    """The scripted conversation. Each step waits until its effect is visible."""
    texts = lambda: w.tg.texts()  # noqa: E731
    edits = lambda: [p["text"] for m, p in w.tg.calls if m == "editMessageText"]  # noqa: E731
    wait = w.tg.wait  # wakes on every Telegram call and tmux submission: no polling

    w.message(message("/help", message_id=1))
    w.tmux.script.append(("reply", f"Here you go.\nREACT: 🎉\nSEND_FILE: {w.home}/report.txt\nSEND_FILE: {w.home}/missing.txt"))
    w.message(message("hello", message_id=2))
    wait(lambda: any("File not found" in t for t in texts()))

    w.message(message("a long task", message_id=3))
    wait(lambda: len(w.tmux.submitted) == 2)
    w.message(message("quick question", message_id=4))
    wait(lambda: "Side answer." in texts() and any(e.startswith("⚡ ✅ Done") for e in edits()))
    w.message(message("/queue after that", message_id=5))
    wait(lambda: any(t.startswith("📥 Queued (#1)") for t in texts()))
    w.tmux.script.append(("reply", "Queued one done."))
    w.tmux.finish("Long task done.")
    wait(lambda: "Queued one done." in texts())

    w.tmux.script.append(("reply", "A cat."))
    w.message(message("", message_id=6, caption="what is this", photo=[{"file_id": "small"}, {"file_id": "big"}],
                      reply_to_message={"text": "Earlier answer", "from": {"is_bot": True}}))
    wait(lambda: "A cat." in texts())

    w.tmux.script.append(("reply", "Mail summary."))
    w.press(callback("quick:mail", message_id=900, text="Quick actions:"))
    wait(lambda: "Mail summary." in texts())

    w.message(message("/stop", message_id=7))
    wait(lambda: "Nothing is running." in texts())
    w.message(message("stop me", message_id=8))
    wait(lambda: len(w.tmux.submitted) == 6)
    w.message(message("/stop", message_id=9))
    wait(lambda: any(e == "🛑 Stopped." for e in edits()))

    w.message(message("hi", chat_id=999, user_id=999, message_id=10))  # a stranger: ignored
    w.message(message("/status", message_id=11))
    wait(lambda: any(t.startswith("🖥 tmux session") for t in texts()))  # the last call of all


def normalize(w):
    home = str(w.home)
    out = []
    for call in w.tg.record():
        if call["method"] == "sendChatAction" or str(call.get("text", "")).lstrip("⚡ ").startswith("⏳ Working"):
            continue
        s = json.dumps(call, ensure_ascii=False).replace(home, "~")
        s = re.sub(r"Done in \d+s", "Done in Ns", s)
        s = re.sub(r"inbox/\d+_", "inbox/T_", s)
        out.append(json.loads(s))
    return out


def prompts(w):
    """What Claude was given: main-lane pastes and side-lane `claude -p` arguments."""
    main = [re.sub(r"\[tg-ref [0-9a-f]+\]", "[tg-ref R]", t).replace(str(w.home), "~").replace("\\", "")
            for t in w.tmux.submitted]
    main = [re.sub(r"inbox/\d+_", "inbox/T_", t) for t in main]
    side = [json.loads(line) for line in (w.home / "argv.jsonl").read_text().splitlines()]
    side = [[a.replace(str(w.home), "~") for a in argv] for argv in side]
    return {"main": main, "side": side}


def run():
    with temp_home(CLAUDE_BIN=FAKE_CLAUDE) as home, mock.patch("time.strftime", return_value=STAMP):
        plan_file = fixture(home)
        with mock.patch.dict(os.environ, {"FAKE_CLAUDE_PLAN": str(plan_file), "FAKE_CLAUDE_LOG": str(home / "argv.jsonl")}), \
                mock.patch("urllib.request.urlretrieve", side_effect=lambda url, dest: pathlib.Path(dest).write_bytes(b"x")):
            w = New(home)
            try:
                conversation(w)
                working = [p for m, p in w.tg.calls if m == "editMessageText" and "⏳ Working" in p["text"]]
                return {"calls": normalize(w), "prompts": prompts(w), "working_edits": bool(working)}
            finally:
                w.close()


class TelegramEndToEndTest(unittest.TestCase):
    maxDiff = None

    def test_same_telegram_calls_and_prompts_as_legacy(self):
        new = run()
        assert_matches(self, "e2e/conversation.json", {"calls": new["calls"], "prompts": new["prompts"]})
        self.assertTrue(new["working_edits"])

    def test_startup_calls_match_legacy(self):
        """deleteWebhook, then setMyCommands with legacy's list, in legacy's order."""
        with temp_home() as home:
            fixture(home)
            w = New(home)
            try:
                self.assertEqual([c["method"] for c in w.startup], ["deleteWebhook", "setMyCommands"])
                self.assertEqual(w.startup[1]["commands"], golden("commands/set_my_commands.json"))
            finally:
                w.close()

    def test_busy_messages_are_read_mid_task_and_btw_runs_in_parallel(self):
        with temp_home() as home, mock.patch.dict(os.environ, {"FAKE_CLAUDE_PLAN": str(fixture(home)),
                                                               "FAKE_CLAUDE_LOG": str(home / "argv.jsonl")}):
            w = New(home, busy_policy="queue")
            try:
                reactions = lambda mid: [p["reaction"][0]["emoji"] for m, p in w.tg.calls  # noqa: E731
                                         if m == "setMessageReaction" and p["message_id"] == mid]
                w.message(message("a long task", message_id=3))
                w.tg.wait(lambda: len(w.tmux.submitted) == 1)
                w.message(message("also check the logs", message_id=4))
                w.tg.wait(lambda: "✍" in reactions(4))  # read by the running task
                self.assertFalse(any(t.startswith("📥 Queued") for t in w.tg.texts()))
                self.assertIn("also check the logs", w.tmux.submitted[1])
                w.message(message("/btw what time is it", message_id=5))
                w.tg.wait(lambda: "Side answer." in w.tg.texts())  # a parallel lane answered
                self.assertTrue(any(t.startswith("⚡ ⏳ On it (parallel lane)") for t in w.tg.texts()))
                self.assertEqual(len(w.tmux.submitted), 2)  # /btw never went into the main turn
                w.tmux.finish("Both done.")
                w.tg.wait(lambda: "Both done." in w.tg.texts())
                w.tg.wait(lambda: "👍" in reactions(4))  # answered by that reply, in its own chat
                self.assertEqual(w.tg.texts().count("Both done."), 1)  # one reply for both messages
            finally:
                w.close()

    def test_a_folded_telegram_message_gets_the_answer_when_the_turn_came_from_the_app(self):
        with temp_home() as home, mock.patch.dict(os.environ, {"FAKE_CLAUDE_PLAN": str(fixture(home)),
                                                               "FAKE_CLAUDE_LOG": str(home / "argv.jsonl")}):
            w = New(home, busy_policy="queue")
            try:
                w.agent.send("[App message from Arpit, x]\na long task", "app", "app:1")  # from the phone app
                w.tg.wait(lambda: len(w.tmux.submitted) == 1)
                w.message(message("and the logs?", message_id=4))
                w.tg.wait(lambda: any(m == "setMessageReaction" and p["message_id"] == 4 and p["reaction"][0]["emoji"] == "✍"
                                      for m, p in w.tg.calls))
                w.tmux.finish("Logs are clean.")
                w.tg.wait(lambda: "Logs are clean." in w.tg.texts())
                sent = next(p for m, p in w.tg.calls if m == "sendMessage" and p["text"] == "Logs are clean.")
                self.assertEqual((sent["chat_id"], sent["reply_parameters"]["message_id"]), (111, 4))  # quoting it
            finally:
                w.close()

    def test_crash_notice_and_clean_exit(self):
        with temp_home() as home:
            fixture(home)
            state = home / ".cache/edith/bridge-state.json"
            state.write_text(json.dumps({"clean_exit": False}))
            w = New(home)
            self.assertIn({"method": "sendMessage", "chat_id": "111",
                           "text": "⚠️ E.D.I.T.H restarted after a crash and is back online."}, w.startup)
            self.assertFalse(json.loads(state.read_text())["clean_exit"])
            w.close()
            self.assertTrue(json.loads(state.read_text())["clean_exit"])


if __name__ == "__main__":
    unittest.main()
