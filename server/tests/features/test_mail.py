"""Mail (docs/PHASE1_PLAN.md, step 3): the repo's gmail.py must print exactly what
legacy/edith/google/gmail.py prints and send Gmail the same changes, with fewer round trips.
Everything runs against tests/fakes/google.py; nothing reads ~/.config/edith-google or calls Google."""
import contextlib
import io
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

from edith.adapters.google.auth import Session
from edith.adapters.google.gmail import GmailBox
from edith.features.mail import cli
from tests.fakes.google import FakeGmail, HttpError, mail
from tests.golden import assert_golden
from tests.legacy import legacy_home, load

SERVER = pathlib.Path(__file__).resolve().parents[2]
SHIMS = SERVER.parent / "deploy" / "shims" / "edith" / "google"


def messages():
    long_from = "A Very Long Sender Name From Somewhere <notifications@example-bank.example.com>"
    return [
        mail("m1", "t1", long_from, "Your statement for October is ready, with a subject line much longer than eighty characters",
             "Mon, 02 Nov 2026 09:15:00 +0530 (IST)", ["UNREAD", "INBOX"], snippet="s" * 200,
             plain="Hello Arpit,\n\nYour statement is ready.\n"),
        mail("m2", "t1", "Bank <bank@example.com>", "Re: statement", "Mon, 02 Nov 2026 10:00:00 +0530",
             ["INBOX"], snippet="html only",
             html="<html><style>p{}</style><script>x()</script><p>Line &amp; one</p><br/>Line two<div>three</div></html>"),
        mail("m3", "t3", "Mum <mum@example.com>", "Dinner?", "Sun, 01 Nov 2026 20:00:00 +0530",
             ["UNREAD", "INBOX", "IMPORTANT"], snippet="Are you coming",
             plain="Are you coming on Sunday?", html="<p>ignored when plain exists</p>",
             extra_headers=[{"name": "Message-ID", "value": "<abc@mail>"}, {"name": "References", "value": "<prev@mail>"}]),
        mail("m4", "t4", "Old <old@example.com>", "Archived but unread", "Sat, 31 Oct 2026 08:00:00 +0530",
             ["UNREAD"], snippet="not in the inbox", plain="old"),
    ]


SCRIPT = [
    [], ["bogus"], ["unread"], ["unread", "2"], ["search", "from:bank newer_than:7d", "5"],
    ["read", "m2"], ["read", "m3"], ["thread", "t1"], ["mark-read", "m1", "m3"], ["archive", "m2"],
    ["draft", "--to", "mum@example.com", "--subject", "Re: Dinner?", "--body", "Yes!", "--reply-to", "m3"],
    ["draft", "--to", "x@example.com", "--subject", "New", "--body", "Line 1\nLine 2"],
    ["send", "--to", "y@example.com", "--subject", "Hello", "--body", "Hi there", "--reply-to", "m1"],
]


class Creds:
    valid, scopes = True, []


def new_box(api):
    return GmailBox(Session("/nonexistent", load=lambda p: Creds(), build=lambda n, v, c: api))


def transcript(main):
    out = io.StringIO()
    for argv in SCRIPT:
        out.write(f"$ gmail.py {' '.join(argv)}\n")
        with mock.patch.object(sys, "argv", ["gmail.py", *argv]), contextlib.redirect_stdout(out):
            main(argv)
    return out.getvalue()


class MailParityTest(unittest.TestCase):
    def test_legacy_and_new_match_golden(self):
        old_api, new_api = FakeGmail(messages()), FakeGmail(messages())
        gauth = types.ModuleType("gauth")
        gauth.service = lambda name, version: old_api
        with legacy_home():
            legacy = load("google/gmail.py", modules={"gauth": gauth})
            old = transcript(lambda argv: legacy.main())
        new = transcript(lambda argv: cli.main(argv, box=new_box(new_api)))
        # Only legacy records golden files; the new code is held to legacy directly, so re-recording
        # (UPDATE_GOLDEN=1) can never hide a difference.
        assert_golden(self, "google/gmail.txt", old)
        assert_golden(self, "google/gmail_writes.json", old_api.writes())
        self.maxDiff = None
        self.assertEqual(new, old)
        self.assertEqual(new_api.writes(), old_api.writes())

    def test_listing_is_one_batch_not_one_call_per_message(self):
        many = [mail(f"u{i}", f"t{i}", "a@x", f"s{i}", "d", ["UNREAD", "INBOX"]) for i in range(30)]
        old_api, new_api = FakeGmail(many), FakeGmail(many)
        gauth = types.ModuleType("gauth")
        gauth.service = lambda name, version: old_api
        with legacy_home(), contextlib.redirect_stdout(io.StringIO()):
            legacy = load("google/gmail.py", modules={"gauth": gauth})
            legacy.list_q("is:unread in:inbox", 30)
            items = new_box(new_api).search("is:unread in:inbox", 30)
        self.assertEqual(len(items), 30)
        self.assertEqual((old_api.round_trips, new_api.round_trips), (31, 2))
        self.assertTrue(all(n == 3 for n in new_api.retries_asked))  # every plain request retries


class BatchRetryTest(unittest.TestCase):
    def test_retryable_errors_are_resent_with_backoff(self):
        api = FakeGmail(messages())
        api.fail["messages.get"] = [HttpError(503), HttpError(429)]
        with mock.patch("time.sleep") as sleep:
            items = new_box(api).search("is:unread in:inbox", 10)
        self.assertEqual([m.id for m in items], ["m1", "m3"])
        self.assertEqual(api.batch_sizes, [2, 2])  # both failed once (in order), then one batch of 2
        sleep.assert_called_once()

    def test_other_errors_are_raised(self):
        api = FakeGmail(messages())
        api.fail["messages.get"] = [HttpError(404)]
        with self.assertRaises(HttpError):
            new_box(api).search("is:unread in:inbox", 10)

    def test_gives_up_after_the_retries(self):
        api = FakeGmail(messages())
        api.fail["messages.get"] = [HttpError(503)] * 20
        with mock.patch("time.sleep"), self.assertRaises(HttpError):
            new_box(api).search("is:unread in:inbox", 1)


class WrapperTest(unittest.TestCase):
    def test_help_needs_no_token_or_network(self):
        with tempfile.TemporaryDirectory() as home:
            env = {"HOME": home, "EDITH_APP_SERVER": str(SERVER), "PATH": "/usr/bin:/bin"}
            r = subprocess.run([sys.executable, "-I", str(SHIMS / "gmail.py")], capture_output=True, text=True, env=env)
        self.assertEqual(r.stdout, cli.__doc__ + "\n")


if __name__ == "__main__":
    unittest.main()
