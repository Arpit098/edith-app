import unittest

from edith.common.text import QUOTE_MAX, attachment_lines, chunk, clean_prompt, reply_line, reply_parts, take_directives, take_files, voice_summary


class TextTest(unittest.TestCase):
    def test_attachment_lines_note_office_files_and_round_trip(self):
        lines = attachment_lines(["/inbox/a.jpg", "/inbox/b.pdf", "/inbox/c.XLSX"])
        self.assertEqual(lines, "\n[Attached file saved at: /inbox/a.jpg]\n[Attached file saved at: /inbox/b.pdf]"
                                "\n[Attached file saved at: /inbox/c.XLSX]\n[Attached file note: c.XLSX is an Excel workbook"
                                " (a zip of XML: sheets in xl/worksheets/, their text in xl/sharedStrings.xml)]")
        parsed = clean_prompt("[App message from Arpit, 2026-11-03 10:43 IST]\nsum it" + lines)
        self.assertEqual((parsed["text"], parsed["attachments"]), ("sum it", ["/inbox/a.jpg", "/inbox/b.pdf", "/inbox/c.XLSX"]))
        self.assertEqual(attachment_lines([]), "")

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

    def test_directives_keep_the_old_shape_skip_code_and_take_paths_with_spaces(self):
        # Blank lines around a removed line go with it, as before (the old one-line regex did that).
        self.assertEqual(take_directives("a\n\nSEND_FILE: /x\n\nb", "SEND_FILE"), (["/x"], "a\nb"))
        self.assertEqual(take_directives("REACT: 👍 nice", "REACT"), ([], "REACT: 👍 nice"))  # one word only
        self.assertEqual(take_files("Here:\n  SEND_FILE:  /home/u/My Plan v2.pdf  \n"), (["/home/u/My Plan v2.pdf"], "Here:"))
        text = "Example:\n```\nSEND_FILE: /etc/passwd\nREACT: 🎉\n```\n~~~\nSEND_FILE: /a\n~~~\nSEND_FILE: /real.pdf"
        files, rest = take_files(text)
        self.assertEqual(files, ["/real.pdf"])
        self.assertIn("SEND_FILE: /etc/passwd", rest)
        self.assertEqual(take_directives(text, "REACT")[0], [])
        self.assertEqual(take_files("SEND_FILE:\nok"), ([], "SEND_FILE:\nok"))  # no path: not a directive
        # Quotes and backticks go; a REACT on the same line stays the reaction.
        self.assertEqual(take_files("SEND_FILE: `/tmp/a b.pdf`"), (["/tmp/a b.pdf"], ""))
        self.assertEqual(take_files('SEND_FILE: "/tmp/x.md"\nok'), (["/tmp/x.md"], "ok"))
        self.assertEqual(reply_parts("Done.\nSEND_FILE: '/tmp/r.pdf' REACT: 🎉"),
                         {"text": "Done.", "files": ["/tmp/r.pdf"], "reaction": "🎉"})
        # Telegram and the app read the same lines (both take_files).
        self.assertEqual(reply_parts("SEND_FILE: /tmp/a b.pdf")["text"], "📎 a b.pdf")
        self.assertEqual(reply_parts("Done.\nSEND_FILE: /tmp/a.pdf")["text"], "Done.")

    def test_voice_summary(self):
        self.assertEqual(voice_summary("Disk is 40% full.\n\nDetails:\n- /dev/sda1"), "Disk is 40% full.")

    def test_reply_line_round_trips_through_clean_prompt(self):
        line = reply_line({"text": "Disk is\n  40% full", "from": "edith"})
        self.assertEqual(line, "\n[Arpit is replying to EDITH's message: Disk is 40% full]")
        parsed = clean_prompt("[App message from Arpit, 2026-11-02 10:43 IST]\nand now?" + line)
        self.assertEqual((parsed["text"], parsed["replying_to"]), ("and now?", "Disk is 40% full"))
        self.assertIn("an earlier message", reply_line({"text": "mine", "from": "arpit"}))
        self.assertIn("an earlier message", reply_line({"text": "no from"}))

    def test_reply_line_brackets_in_the_quote_never_close_it(self):
        # A quote's own "]" (here at a line end, the case clean_prompt's pattern stops at) would end
        # the line early and leave the rest in the message text.
        line = reply_line({"text": "see [1]\nthen [2]", "from": "edith"})
        self.assertEqual(line, "\n[Arpit is replying to EDITH's message: see [1］ then [2］]")
        self.assertEqual(line.count("]"), 1)  # only the closing bracket
        parsed = clean_prompt("ok" + line + "\n[Attached file saved at: /inbox/a.jpg]")
        self.assertEqual((parsed["text"], parsed["replying_to"], parsed["attachments"]), ("ok", "see [1］ then [2］", ["/inbox/a.jpg"]))

    def test_reply_line_survives_bad_unicode(self):
        quote = clean_prompt("hi" + reply_line({"text": "ok \ud83d then"}))["replying_to"]
        self.assertEqual(quote, "ok ? then")  # a lone surrogate (bad JSON text): no crash, no broken prompt
        emoji = clean_prompt("hi" + reply_line({"text": "😀" * 400}))["replying_to"]
        self.assertEqual(emoji, "😀" * (QUOTE_MAX - 1) + "…")  # cut between characters, never inside one

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
