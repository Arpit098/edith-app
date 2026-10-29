"""Voice turns (PLAN.md §4.7, Phase 3): the spoken summary of a reply, and voice.reply events for turns the
App API marked as voice."""
import unittest

from edith.core import Event, EventBus, Ports, Registry, load_features
from edith.features.voice import MAX_TRACKED
from edith.features.voice.speech import MAX_CHARS, speak_for, spoken_summary


class SpokenSummaryTest(unittest.TestCase):
    def test_first_paragraph_only(self):
        reply = "The disk is 62% full, with 31 GB free.\n\n```\n/dev/sda1  96G  58G  38G  62% /\n```\nDetails…"
        self.assertEqual(spoken_summary(reply), "The disk is 62% full, with 31 GB free.")

    def test_markdown_links_urls_and_emoji_are_not_read_out(self):
        reply = "✅ **Done.** Fixed `parse_date` in [the parser](https://github.com/x/y) — see https://x.y/z 🚀"
        self.assertEqual(spoken_summary(reply), "Done. Fixed parse_date in the parser — see a link.")

    def test_at_most_two_sentences(self):
        self.assertEqual(spoken_summary("One. Two! Three? Four."), "One. Two!")

    def test_hindi_danda_ends_a_sentence(self):
        self.assertEqual(spoken_summary("डिस्क 62% भरी है। 31 GB खाली है। बाकी ठीक है।"), "डिस्क 62% भरी है। 31 GB खाली है।")

    def test_long_sentence_is_cut_at_a_word(self):
        spoken = spoken_summary("word " * 200)
        self.assertLessEqual(len(spoken), MAX_CHARS + 1)
        self.assertTrue(spoken.endswith("word…"))

    def test_skips_code_and_directives_to_the_first_words(self):
        reply = "REACT: 👍\n```bash\nnpm test\n```\n\n## Tests\n- 42 passed\n- 0 failed\n\nSEND_FILE: /tmp/r.html"
        self.assertEqual(spoken_summary(reply), "Tests. 42 passed.")

    def test_table_rows_lose_their_pipes(self):
        self.assertEqual(spoken_summary("| host | load |\n|---|---|\n| edith | 0.4 |"), "host load. edith 0.4.")

    def test_nothing_speakable(self):
        self.assertEqual(spoken_summary("```\nls\n```"), "")
        self.assertEqual(spoken_summary(""), "")

    def test_speak_for_each_outcome(self):
        self.assertEqual(speak_for("turn.done", {"text": "All good.\n\nmore"}), ("done", "All good."))
        self.assertEqual(speak_for("turn.done", {"text": "```\nx\n```"}), ("done", "Done."))
        self.assertEqual(speak_for("turn.failed", {"reason": "not_ready"})[1], "Claude isn't ready yet. Try again in a moment.")
        self.assertEqual(speak_for("turn.failed", {"reason": "error"}), ("failed", "Something went wrong with that task."))
        self.assertEqual(speak_for("turn.stopped", {}), ("stopped", "Stopped."))
        self.assertEqual(speak_for("turn.queued", {"position": 2}), ("queued", "Queued. You're number 2."))
        self.assertIsNone(speak_for("turn.progress", {}))


class VoiceRepliesTest(unittest.TestCase):
    def setUp(self):
        self.bus = EventBus()
        report = load_features(["voice"], self.bus, Ports(), Registry(), {})
        self.assertEqual(report.loaded, ["voice"])
        self.replies = []
        self.bus.subscribe("voice.reply", lambda ev: self.replies.append((ev.data, ev.origin, ev.session_id)))

    def turn(self, type, origin="app", session_id="s1", **data):
        self.bus.publish(Event(type, data, origin=origin, session_id=session_id))

    def test_voice_turn_gets_queued_and_done_replies(self):
        self.turn("voice.turn", ref="app:1")
        for kind, data in [("turn.queued", {"position": 1}), ("turn.started", {"lane": "main"}),
                           ("turn.progress", {"step": "$ df -h"}), ("turn.done", {"text": "62% full.\n\nTable…"})]:
            self.turn(kind, ref="app:1", **data)
        self.assertEqual(self.replies, [
            ({"ref": "app:1", "outcome": "queued", "speak": "Queued. You're number 1."}, "app", "s1"),
            ({"ref": "app:1", "outcome": "done", "speak": "62% full."}, "app", "s1")])

    def test_only_voice_turns_and_only_once(self):
        self.turn("voice.turn", ref="app:v")
        self.turn("turn.done", ref="app:typed", text="Typed reply.")
        self.turn("turn.done", ref="tg:123", origin="telegram", text="Telegram reply.")
        self.turn("turn.failed", ref="app:v", reason="crashed")
        self.turn("turn.done", ref="app:v", text="late duplicate")  # the turn already ended
        self.assertEqual([r[0]["speak"] for r in self.replies], ["That task crashed."])

    def test_retried_turn_is_still_followed(self):
        self.turn("voice.turn", ref="app:r")
        self.turn("turn.retrying", ref="app:r", lane="side", reason="gone")
        self.turn("turn.stopped", ref="app:r", lane="side")
        self.assertEqual([r[0]["outcome"] for r in self.replies], ["stopped"])

    def test_tracking_is_bounded(self):
        for i in range(MAX_TRACKED + 1):
            self.turn("voice.turn", ref=f"app:{i}")
        self.turn("turn.done", ref="app:0", text="Dropped, oldest.")
        self.turn("turn.done", ref=f"app:{MAX_TRACKED}", text="Kept.")
        self.assertEqual([r[0]["speak"] for r in self.replies], ["Kept."])


if __name__ == "__main__":
    unittest.main()
