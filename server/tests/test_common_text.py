import unittest

from edith.common.text import QUOTE_MAX, chunk, clean_prompt, reply_line, take_directives, voice_summary


class TextTest(unittest.TestCase):
    def test_chunk_respects_size_and_keeps_text(self):
        text = "\n".join(f"line {i}" for i in range(500))
        parts = chunk(text, 100)
        self.assertTrue(all(len(p) <= 100 for p in parts))
        self.assertEqual("".join(parts).replace("\n", ""), text.replace("\n", ""))
        self.assertEqual(chunk("", 10), [""])

    def test_take_directives(self):
        files, rest = take_directives("Done.\nSEND_FILE: /tmp/a.txt\nREACT: 🎉", "SEND_FILE")
        self.assertEqual(files, ["/tmp/a.txt"])
        self.assertEqual(rest, "Done.\nREACT: 🎉")

    def test_voice_summary(self):
        self.assertEqual(voice_summary("Disk is 40% full.\n\nDetails:\n- /dev/sda1"), "Disk is 40% full.")

    def test_reply_line_round_trips_through_clean_prompt(self):
        line = reply_line({"text": "Disk is\n  40% full [ok]", "from": "edith"})
        self.assertEqual(line, "\n[Arpit is replying to EDITH's message: Disk is 40% full [ok]]")
        parsed = clean_prompt("[App message from Arpit, 2026-11-02 10:43 IST]\nand now?" + line)
        self.assertEqual((parsed["text"], parsed["replying_to"]), ("and now?", "Disk is 40% full [ok]"))
        self.assertIn("an earlier message", reply_line({"text": "mine", "from": "arpit"}))
        self.assertIn("an earlier message", reply_line({"text": "no from"}))

    def test_reply_line_is_short_and_optional(self):
        long = reply_line({"text": "x " * 1000, "from": "edith"})
        quote = clean_prompt("hi" + long)["replying_to"]
        self.assertEqual(len(quote), QUOTE_MAX)
        self.assertTrue(quote.endswith("…"))
        self.assertEqual(reply_line(None), "")
        self.assertEqual(reply_line({"text": "  \n "}), "")
        for bad in ("text", {"from": "edith"}, {"text": 3}, []):
            with self.assertRaises(ValueError):
                reply_line(bad)


if __name__ == "__main__":
    unittest.main()
