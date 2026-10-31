"""Messages never vanish (contracts/events.md, "Messages from Arpit"): accepted, delivered (main,
mid-turn, side lane), reacted to like Telegram, logged per conversation and merged into history.
Runs the real claude_tmux adapter (FakeTmux, the fake `claude -p`) with the message_log feature."""
import json
import os
import unittest
from unittest import mock

from edith.adapters.agents.claude_tmux.live import events_of
from edith.core import EventBus, Ports, Registry, load_features
from edith.features import message_log
from tests.test_claude_tmux import Harness

APP = "[App message from Arpit, 2026-10-29 18:17 UTC]\n"


class World:
    def __init__(self, test, **config):
        self.h = Harness(test, **config)
        assert self.h.agent._live.ready.wait(5)
        self.registry = Registry()
        report = load_features(["message_log"], self.h.bus, Ports(agent=self.h.agent), self.registry,
                               {"message_log": {"state_dir": str(self.h.state_dir)}})
        assert report.loaded == ["message_log"], report.failed

    def send(self, text, ref, origin="app"):
        return self.h.agent.send(APP + text if origin == "app" else f"[Telegram message from Arpit, x]\n{text}", origin, ref)

    def of(self, type, ref):
        return [e for e in self.h.events if e.type == type and e.data.get("ref") == ref]

    def reactions(self, ref, count=None):
        """The reactions so far; with `count`, after waiting for that many (each comes on the bus)."""
        if count:
            with self.h.cond:
                self.h.cond.wait_for(lambda: len(self.of("message.reaction", ref)) >= count, 5)
        return [e.data["emoji"] for e in self.of("message.reaction", ref)]

    def history(self, **query):
        return self.registry.routes["GET", "/v1/sessions/{id}/history"].handler(
            {"params": {"id": "current"}, "query": query, "headers": {}})

    def logged(self):
        return json.loads((self.h.state_dir / "message-log" / "s1.json").read_text())


class DeliveryTest(unittest.TestCase):
    def test_main_lane_message(self):
        w = World(self)
        w.h.reply = "Done.\nREACT: 🎉\nSEND_FILE: /tmp/x.txt"
        w.send("check the disk", "app:1")
        done = w.h.wait("turn.done", "app:1")
        user = w.of("message.user", "app:1")[0]
        self.assertEqual((user.origin, user.session_id), ("app", "s1"))
        self.assertEqual(user.data, {"ref": "app:1", "text": "check the disk", "voice": False, "attachments": [],
                                     "replying_to": None, "delivery": "main", "lane": "main"})
        self.assertEqual(w.of("message.delivered", "app:1")[0].data["delivery"], "main")
        self.assertEqual((done.data["display_text"], done.data["files"], done.data["reaction"]), ("Done.", ["/tmp/x.txt"], "🎉"))
        self.assertEqual(w.reactions("app:1", 3), ["👀", "👨‍💻", "🎉"])  # Telegram's: seen, working, EDITH's pick
        # The transcript's own copy is not sent again (the tag belongs to this message)
        self.assertFalse([e for e in w.h.events if e.type == "message.user" and e.origin != "app"])
        texts = [e["data"].get("text") for e in w.history()["events"] if e["type"] == "message.user"]
        self.assertEqual(texts, ["check the disk"])

    def test_mid_turn_message(self):
        w = World(self)
        w.h.mode = "mid_turn"
        w.send("Path works correctly.", "app:2")
        w.h.wait("turn.done", "app:2")
        self.assertEqual(w.of("message.delivered", "app:2")[0].data["delivery"], "mid_turn")
        users = [e for e in w.history()["events"] if e["type"] == "message.user"]
        self.assertEqual([(u["data"]["text"], u["data"]["ref"]) for u in users], [("Path works correctly.", "app:2")])

    def test_side_lane_message_and_answer(self):
        w = World(self, busy_policy="side_lane")  # every busy message to a side lane (/btw takes the same path)
        w.h.mode = "hang"
        w.send("a long task", "app:3")
        w.h.wait("turn.progress", "app:3")
        self.assertEqual(w.send("What's going on?", "app:4").lane, "side")
        w.h.wait("turn.done", "app:4")
        self.assertEqual(w.of("message.user", "app:4")[0].data["delivery"], "side_lane")
        self.assertEqual(w.of("message.delivered", "app:4")[0].data["delivery"], "side_lane")
        answer = w.of("message.assistant", "app:4")[0]
        self.assertEqual((answer.data["lane"], answer.data["text"]), ("side", "Side reply"))
        self.assertEqual(w.reactions("app:4", 3), ["👀", "⚡", "👍"])
        page = w.history()
        kinds = [(e["type"], e["data"].get("ref")) for e in page["events"] if e["data"].get("ref") == "app:4"]
        self.assertIn(("message.user", "app:4"), kinds)
        self.assertIn(("message.assistant", "app:4"), kinds)
        self.assertTrue(all(e["data"].get("log_id") for e in page["events"] if e["data"].get("ref") == "app:4"))

    def test_preamble_message_shows_clean(self):
        w = World(self)
        w.h.agent.state.update(lambda s: s.__setitem__("side_notes", [{"q": "What's going on?", "a": "All good.\n\nMore."}]))
        w.send("I think there is a small issue", "app:5")
        w.h.wait("turn.done", "app:5")
        submitted = w.h.fake.submitted[-1]
        self.assertTrue(submitted.startswith("[While you were busy, parallel lanes"))
        texts = [e["data"]["text"] for e in w.history()["events"] if e["type"] == "message.user"]
        self.assertEqual(texts, ["I think there is a small issue"])

    def test_telegram_messages_are_logged_without_app_reactions(self):
        w = World(self)
        w.send("hi from telegram", "tg:111:7", origin="telegram")
        w.h.wait("turn.done", "tg:111:7")
        self.assertEqual(w.reactions("tg:111:7"), [])
        self.assertEqual([e["type"] for e in w.logged()], ["message.user", "message.delivered"])

    def test_log_survives_a_restart_and_is_capped(self):
        w = World(self)
        w.send("remember me", "app:6")
        w.h.wait("turn.done", "app:6")
        again = message_log.Log(str(w.h.state_dir / "message-log"))
        self.assertIn("remember me", [e["data"].get("text") for e in again.events("s1")])
        self.assertEqual(os.stat(w.h.state_dir / "message-log" / "s1.json").st_mode & 0o777, 0o600)
        with mock.patch.object(message_log, "KEEP", 20):
            for i in range(25):
                again.add("s1", {"type": "message.reaction", "ts": i, "session_id": "s1", "origin": "app", "data": {}})
        self.assertEqual(len(message_log.Log(str(w.h.state_dir / "message-log")).events("s1")), 20)
        self.assertEqual(again.events("../x"), [])


class TranscriptTest(unittest.TestCase):
    def test_pasted_content_is_unwrapped_not_skipped(self):
        text = ("\n\n<pasted_content id=\"1e86\">\n[While you were busy, parallel lanes (forks of this conversation) "
                "handled these. You didn't see them, so here they are for context:]\n- Arpit: What's going on?\n"
                "  EDITH: All good.\n\nMore.\n\n" + APP + "I think there is a small issue\n[tg-ref d13fb6]\n</pasted_content>")
        out = events_of({"type": "user", "message": {"content": text}}, {})
        self.assertEqual([(t, o, d["text"], d["rid"]) for t, o, d in out],
                         [("message.user", "app", "I think there is a small issue", "d13fb6")])
        self.assertEqual(events_of({"type": "user", "message": {"content": text}}, {}, known=lambda rid: True), [])

    def test_history_drops_the_transcript_copy_by_rid_or_text(self):
        logged = [{"type": "message.user", "ts": 100.0, "origin": "app", "data": {"ref": "app:1", "text": "hello"}},
                  {"type": "message.delivered", "ts": 101.0, "origin": "app", "data": {"ref": "app:1", "rid": "ab"}}]
        page = {"events": [
            {"type": "message.user", "ts": 102.0, "origin": "app", "data": {"text": "hello", "rid": "ab"}},
            {"type": "message.user", "ts": 103.0, "origin": "app", "data": {"text": "hello", "rid": None}},
            {"type": "message.user", "ts": 900.0, "origin": "app", "data": {"text": "hello", "rid": None}},
            {"type": "message.assistant", "ts": 104.0, "origin": "system", "data": {"text": "hi"}}],
            "more": False}
        merged = message_log.merge(page, logged, None, None)["events"]
        self.assertEqual([(e["type"], e["ts"]) for e in merged],
                         [("message.user", 100.0), ("message.delivered", 101.0), ("message.assistant", 104.0),
                          ("message.user", 900.0)])  # 900 s later: a new message with the same words
        self.assertEqual(message_log.merge(page, logged, 100.5, None)["events"][0]["type"], "message.delivered")

    def test_a_typed_commands_delivery_drops_no_transcript_message(self):
        logged = [{"type": "message.delivered", "ts": 100.0, "origin": "app",
                   "data": {"ref": "app:1", "delivery": "command", "rid": None}}]  # a /command: no run id
        page = {"events": [{"type": "message.user", "ts": 101.0, "origin": "app", "data": {"text": "hi", "rid": None}}],
                "more": False}
        self.assertEqual([e["type"] for e in message_log.merge(page, logged, None, None)["events"]],
                         ["message.delivered", "message.user"])


if __name__ == "__main__":
    unittest.main()
