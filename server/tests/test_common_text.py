import unittest

from edith.common.text import chunk, take_directives, voice_summary


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


if __name__ == "__main__":
    unittest.main()
