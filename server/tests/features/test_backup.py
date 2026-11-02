"""The backup AI (contracts/backup.md): the provider chain and its skip rules, the redaction filter
(adversarial), the read-only tools and their blocked paths, the tool loop, the OpenAI-compatible
adapter, and the feature end to end (take over, answer, queue, hand back). Fake providers only:
nothing leaves the machine."""
import io
import json
import os
import socket
import tempfile
import time
import unittest
import urllib.error
from types import SimpleNamespace
from unittest import mock

from edith.adapters.llm import openai_compat
from edith.core import DivertingAgent, Event, EventBus, Ports, Registry
from edith.core.registry import load_features
from edith.features import backup
from edith.features.backup import loop
from edith.features.backup.chain import AllUnavailable, Chain
from edith.features.backup.redact import scrub, scrub_messages
from edith.features.backup.tools import BIN_TOOLS, BinTool, PathPolicy, ToolError, Tools, bin_argv, public_host
from edith.ports.agent import RunInfo, TurnHandle
from edith.ports.llm import ChatReply, ProviderError, ToolCall
from tests.fakes import run_workers
from tests.fakes.llm import FakeModels, FakeProvider, say, use


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


def tmpdir(test):
    d = tempfile.TemporaryDirectory()
    test.addCleanup(d.cleanup)
    return d.name


# ---------------------------------------------------------------- the chain

class ChainTest(unittest.TestCase):
    def setUp(self):
        self.dir = tmpdir(self)
        self.clock = Clock()
        self.slept = []

    def chain(self, *providers):
        return Chain(providers, os.path.join(self.dir, "backup", "skips.json"), clock=self.clock, sleep=self.slept.append)

    def test_first_usable_answers(self):
        a, b = FakeProvider("a", "A", [say("hi")]), FakeProvider("b", "B")
        p, reply = self.chain(a, b).call([], [], 5)
        self.assertEqual((p.name, reply.text, len(b.calls)), ("a", "hi", 0))

    def test_429_with_retry_after_skips_until_then_and_survives_a_restart(self):
        a = FakeProvider("a", "A", [ProviderError("rate_limit", "slow down", 429, retry_after=120)])
        b = FakeProvider("b", "B", [say("from b")])
        p, reply = self.chain(a, b).call([], [], 5)
        self.assertEqual((p.name, reply.text), ("b", "from b"))
        chain = self.chain(a, b)  # a new process reads the skips back
        self.assertEqual(chain.skipped_until("a"), self.clock.t + 120)
        chain.call([], [], 5)
        self.assertEqual(len(a.calls), 1)  # not asked again while skipped
        self.assertEqual(os.stat(os.path.join(self.dir, "backup", "skips.json")).st_mode & 0o777, 0o600)
        self.clock.t += 121
        self.assertIsNone(chain.skipped_until("a"))
        self.assertEqual(chain.call([], [], 5)[0].name, "a")

    def test_429_daily_quota_waits_for_the_daily_reset(self):
        a = FakeProvider("a", "A", [ProviderError("rate_limit", "per day", 429, daily=True)], reset_in=5000)
        chain = self.chain(a, FakeProvider("b", "B"))
        chain.call([], [], 5)
        self.assertEqual(chain.skipped_until("a"), self.clock.t + 5000)

    def test_429_saying_nothing_skips_a_minute(self):
        a = FakeProvider("a", "A", [ProviderError("rate_limit", "", 429)])
        chain = self.chain(a, FakeProvider("b", "B"))
        chain.call([], [], 5)
        self.assertEqual(chain.skipped_until("a"), self.clock.t + 60)

    def test_down_is_retried_once_then_skipped_after_three_failures_in_a_row(self):
        down = ProviderError("down", "timeout")
        a = FakeProvider("a", "A", [down] * 6)
        b = FakeProvider("b", "B")
        chain = self.chain(a, b)
        for n in (1, 2):
            self.assertEqual(chain.call([], [], 5)[0].name, "b")
            self.assertEqual(len(a.calls), 2 * n)  # the call and its one retry
            self.assertIsNone(chain.skipped_until("a"))
        self.assertEqual(self.slept, [1.0, 1.0])
        chain.call([], [], 5)
        self.assertEqual(chain.skipped_until("a"), self.clock.t + 600)

    def test_a_success_clears_the_failures(self):
        down = ProviderError("down", "500", 500)
        a = FakeProvider("a", "A", [down, down, down, down, say("ok"), down, down])
        chain = self.chain(a, FakeProvider("b", "B"))
        chain.call([], [], 5)
        chain.call([], [], 5)
        self.assertEqual(chain.call([], [], 5)[0].name, "a")  # 3rd: ok, failures back to 0
        chain.call([], [], 5)
        self.assertIsNone(chain.skipped_until("a"))  # one failure only

    def test_a_refused_key_skips_an_hour_and_a_bad_request_moves_on(self):
        a = FakeProvider("a", "A", [ProviderError("auth", "invalid key", 401)])
        b = FakeProvider("b", "B", [ProviderError("bad_request", "no", 400)])
        c = FakeProvider("c", "C")
        chain = self.chain(a, b, c)
        self.assertEqual(chain.call([], [], 5)[0].name, "c")
        self.assertEqual(chain.skipped_until("a"), self.clock.t + 3600)
        self.assertEqual(len(b.calls), 1)  # not retried
        self.assertIsNone(chain.skipped_until("b"))

    def test_none_usable(self):
        a = FakeProvider("a", "A", available=False)
        b = FakeProvider("b", "B", [ProviderError("rate_limit", "", 429, retry_after=30)])
        with self.assertRaises(AllUnavailable) as e:
            self.chain(a, b).call([], [], 5)
        self.assertEqual(e.exception.reasons, [("A", "no key", None), ("B", "rate limited", self.clock.t + 30)])
        self.assertEqual(e.exception.next_at, self.clock.t + 30)
        self.assertEqual(a.calls, [])

    def test_the_answering_provider_stays_first(self):
        a, b = FakeProvider("a", "A"), FakeProvider("b", "B")
        chain = self.chain(a, b)
        self.assertEqual(chain.call([], [], 5, prefer=b)[0].name, "b")

    def test_status(self):
        a = FakeProvider("a", "A", [ProviderError("auth", "", 403)])
        chain = self.chain(a, FakeProvider("b", "B", available=False))
        with self.assertRaises(AllUnavailable):
            chain.call([], [], 5)
        self.assertEqual(chain.status(), [
            {"name": "a", "label": "A", "available": True, "skipped_until": self.clock.t + 3600, "why": "key refused"},
            {"name": "b", "label": "B", "available": False, "skipped_until": None, "why": None}])


# ---------------------------------------------------------------- redaction

SECRETS = [
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl" "bnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE" "pAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaRlGd\n(cut here",
    "nvapi-" "AbCdEf0123456789_GhIjKlMnOpQrStUvWxYz-0123",
    "AIza" "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
    "sk-ant-" "oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "ghp_" "16C7e42F292c6912E7710c838347Ae178B4a",
    "xoxb-" "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
    "eyJ" "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "123456789:AAH" "dqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
    "1//" "0gLx3bQ7RkY5mCgYIARAAGBASNwF-L9IrW8kVxj0aZ",
    "ya29." "a0AfH6SMBx7Kq3uLmN0pQrStUvWxYz123456",
    "AKIA" "IOSFODNN7EXAMPLE",
    "wJalr" "XUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "3f78" "6850e387550fdab836ed7e6dc881de23001b6a4f2d7c9e8b1a0f3c5d7e9a",
    "aZ3k" "P9qL2mX8vB7nC4wR6tY1uI5oE0sD",
    "tk_" "AbCdEfGhIjKlMnOpQrStUvWx",
    "GOCSPX-" "AbCdEfGhIjKlMnOp1234",
    "glpat-" "AbCdEfGhIjKlMnOpQr12",
    "hf_" "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
]
CONTEXTS = [
    "{}",
    "the key is {}",
    "OPENAI_API_KEY={}",
    "export GITHUB_TOKEN={}",
    "aws_secret_access_key = {}",
    '{{"access_token": "{}", "expires": 3600}}',
    "Authorization: Bearer {}",
    "https://api.example.com/v1/x?key={}&alt=json",
    "curl -H 'x-api-key: {}' https://x",
    "password: {}",
    "line one\nsecret={}\nline three",
]


class RedactTest(unittest.TestCase):
    def test_every_secret_in_every_context_is_removed(self):
        for secret in SECRETS:
            for ctx in CONTEXTS:
                text = ctx.format(secret)
                out = scrub(text)
                with self.subTest(secret=secret[:20], ctx=ctx[:20]):
                    self.assertNotIn(secret, out)
                    for line in secret.splitlines():  # no line of a key block survives either
                        if len(line) >= 16:
                            self.assertNotIn(line, out)

    def test_env_files_and_assignments(self):
        env = ("DB_PASSWORD=hunter2\nSESSION_SECRET: p@ss with spaces\nSTRIPE_KEY=rk_live_1\n"
               "export MY_APP_AUTH=xyz\nPORT=8080\nNODE_ENV=production\n")
        out = scrub(env)
        for s in ("hunter2", "p@ss with spaces", "rk_live_1", "xyz"):
            self.assertNotIn(s, out)
        self.assertIn("PORT=8080", out)
        self.assertIn("NODE_ENV=production", out)

    def test_url_credentials_and_signed_links(self):
        out = scrub("clone https://arpit:s3cretPass@github.com/x.git and https://s3.x/a?X-Sig=1&signature=abcdef123&code=zz9")
        for s in ("s3cretPass", "abcdef123", "zz9"):
            self.assertNotIn(s, out)
        self.assertIn("github.com/x.git", out)

    def test_secret_paths(self):
        for path in ("/home/ubuntu/.config/edith/nvidia-key", "~/.claude/.credentials.json", "$HOME/.ssh/id_ed25519",
                     "${HOME}/.aws/credentials", "/root/.gnupg/secring.gpg", "/home/arpit/.git-credentials"):
            out = scrub(f"cat {path} please")
            self.assertNotIn(path, out)
            self.assertIn("[blocked path]", out)

    def test_ordinary_text_is_kept(self):
        for text in ("The build passed in 12s on main.", "server/edith/features/backup/tools.py line 40",
                     "commit a1b2c3d fixed it", "Reminder at 2026-11-02 10:43 IST",
                     "use long_function_name_for_the_backup_feature here",
                     "https://github.com/Arpit098/edith-app/pull/63", "edith-bridge.service is active (running)",
                     "Disk 41.2 of 96.6 GiB used"):
            self.assertEqual(scrub(text), text, text)

    def test_messages_and_tool_calls(self):
        msgs = [{"role": "user", "content": "my key nvapi-" "AbCdEf0123456789_GhIjKlMnOpQrStUvWx"},
                {"role": "assistant", "content": "", "tool_calls": [{"id": "1", "type": "function", "function": {
                    "name": "read_file", "arguments": '{"path": "~/.config/edith/gemini-key"}'}}]},
                {"role": "tool", "tool_call_id": "1", "content": "AIza" "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"}]
        out = json.dumps(scrub_messages(msgs))
        for s in ("nvapi-AbCdEf", "gemini-key", "AIzaSyD"):
            self.assertNotIn(s, out)
        self.assertIn("nvapi", json.dumps(msgs))  # the originals are untouched
        self.assertIsNone(scrub(None))


# ---------------------------------------------------------------- tools

class Layout:
    """A scratch home with things the backup may and may not read."""

    def __init__(self, test):
        self.home = os.path.realpath(tmpdir(test))
        h = self.home
        files = {
            "edith/notes.txt": "deploy notes: all fine\nSECRETWORD in notes\n",
            "edith/inbox/photo.txt": "a caption",
            "edith/google/token.json": '{"refresh_token": "SECRETWORD-google"}',
            "edith/.claude/settings.json": "SECRETWORD-edith-claude",
            "Projects/app/src/main.py": "print('hello')\n# SECRETWORD mention in code\n",
            "Projects/app/README.md": "readme",
            "Projects/app/.env": "API_KEY=SECRETWORD-env",
            "Projects/app/.env.local": "SECRETWORD-env-local",
            "Projects/app/.git/config": "[remote] url = https://x:SECRETWORD@github.com",
            "Projects/app/config/secrets.yml": "SECRETWORD-secrets",
            "Projects/app/certs/server.pem": "SECRETWORD-pem",
            "Projects/app/API_KEYS.md": "SECRETWORD-keys",
            "Projects/app/.github/workflows/ci.yml": "on: push",
            ".config/edith/nvidia-key": "nvapi-" "SECRETWORD",
            ".claude/.credentials.json": "SECRETWORD-claude",
            ".ssh/id_rsa": "SECRETWORD-ssh",
            "state/messages.jsonl": "SECRETWORD-mail-log",
        }
        for rel, text in files.items():
            path = os.path.join(h, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(text)
        with open(os.path.join(h, "Projects/app/blob.bin"), "wb") as f:
            f.write(b"\x00\x01SECRETWORD")
        os.symlink(os.path.join(h, ".config/edith/nvidia-key"), os.path.join(h, "Projects/app/link-to-key"))
        os.symlink(os.path.join(h, ".claude/.credentials.json"), os.path.join(h, "Projects/app/innocent.txt"))
        os.symlink(os.path.join(h, ".config"), os.path.join(h, "Projects/app/cfg"))
        os.symlink("../../.ssh", os.path.join(h, "Projects/app/sshdir"))
        os.symlink(os.path.join(h, "Projects/app/README.md"), os.path.join(h, "edith/readme-link"))
        os.symlink("/etc/hostname", os.path.join(h, "Projects/app/host"))
        self.policy = PathPolicy(h, [os.path.join(h, "edith"), os.path.join(h, "Projects"), os.path.join(h, "edith/inbox")],
                                 [os.path.join(h, ".config"), os.path.join(h, ".claude"), os.path.join(h, "edith/google"),
                                  os.path.join(h, "state")], base=os.path.join(h, "edith"))


class ToolsTest(unittest.TestCase):
    def setUp(self):
        self.l = Layout(self)
        self.queued, self.ran = [], []
        self.tools = Tools(self.l.policy, os.path.join(self.l.home, "edith/bin"), self.queue, lambda: {"edith": {"state": "idle"}},
                           {"HOME": self.l.home}, resolver=self.resolve, run=self.fake_run)

    def queue(self, task):
        self.queued.append(task)
        return "abc123"

    def fake_run(self, argv, timeout, env):
        self.ran.append(argv)
        return "fake output"

    @staticmethod
    def resolve(host, port):
        table = {"example.com": "93.184.215.14", "localhost": "127.0.0.1", "metadata": "169.254.169.254",
                 "ts.internal": "100.101.1.2", "lan": "192.168.1.5", "v6": "::1"}
        if host not in table:
            raise socket.gaierror("unknown")
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (table[host], 0))]

    def call(self, tool_name, **args):
        return self.tools.call(tool_name, json.dumps(args))

    def test_allowed_reads(self):
        self.assertIn("1\tdeploy notes: all fine", self.call("read_file", path="~/edith/notes.txt"))
        self.assertIn("deploy notes", self.call("read_file", path="notes.txt"))  # relative: under ~/edith
        self.assertIn("print('hello')", self.call("read_file", path=f"{self.l.home}/Projects/app/src/main.py"))
        self.assertIn("readme", self.call("read_file", path="~/edith/readme-link"))  # a link to an allowed file
        self.assertIn("a caption", self.call("read_file", path="~/edith/inbox/photo.txt"))
        self.assertIn("on: push", self.call("read_file", path="~/Projects/app/.github/workflows/ci.yml"))

    def test_blocked_reads_in_every_disguise(self):
        h = self.l.home
        for path in ("~/.config/edith/nvidia-key", "~/.claude/.credentials.json", "~/.ssh/id_rsa",
                     "~/Projects/../.config/edith/nvidia-key", "~/edith/../.claude/.credentials.json",
                     "../.config/edith/nvidia-key", "$HOME/.config/edith/nvidia-key", "${HOME}/.ssh/id_rsa",
                     f"{h}/Projects/app/./../../.config/edith/nvidia-key", "~/Projects/app/link-to-key",
                     "~/Projects/app/innocent.txt", "~/Projects/app/cfg/edith/nvidia-key", "~/Projects/app/sshdir/id_rsa",
                     "~/Projects/app/.env", "~/Projects/app/.env.local", "~/Projects/app/.git/config",
                     "~/Projects/app/config/secrets.yml", "~/Projects/app/certs/server.pem", "~/Projects/app/API_KEYS.md",
                     "~/edith/google/token.json", "~/edith/.claude/settings.json", f"{h}/state/messages.jsonl",
                     "/etc/passwd", "/proc/self/environ", "~/Projects/app/host", "~", "/", "", "~/edith/notes.txt\x00"):
            out = self.call("read_file", path=path)
            with self.subTest(path=path):
                self.assertTrue(out.startswith("error:"), out)
                self.assertNotIn("SECRETWORD", out)

    def test_binary_and_folders(self):
        self.assertIn("binary", self.call("read_file", path="~/Projects/app/blob.bin"))
        self.assertIn("folder", self.call("read_file", path="~/Projects/app"))

    def test_listing_hides_what_is_blocked(self):
        out = self.call("list_dir", path="~/Projects/app").split("\n")
        names = {n.split(" ")[0] for n in out}
        self.assertEqual(names, {"README.md", "blob.bin", "src/", ".github/", "certs/", "config/"})
        self.assertNotIn("nvidia", self.call("list_dir", path="~/Projects/app/certs"))
        self.assertTrue(self.call("list_dir", path="~/.config").startswith("error:"))
        listed = self.call("list_dir", path="~/edith")
        self.assertNotIn("google", listed)
        self.assertNotIn(".claude", listed)

    def test_grep_never_reaches_blocked_files(self):
        for path in ("~/Projects", "~/edith", "~/Projects/app"):
            out = self.call("grep", text="secretword", path=path)
            with self.subTest(path=path):
                self.assertNotIn("SECRETWORD-", out)
                self.assertNotIn("nvapi", out)
        self.assertIn("main.py:2:", self.call("grep", text="SECRETWORD", path="~/Projects"))
        self.assertIn("notes.txt:2:", self.call("grep", text="SECRETWORD", path="~/edith/notes.txt"))
        self.assertTrue(self.call("grep", text="x", path="~/.claude").startswith("error:"))

    def test_bad_calls_come_back_as_text(self):
        self.assertIn("no tool", self.tools.call("write_file", "{}"))
        self.assertIn("JSON object", self.tools.call("read_file", "not json"))
        self.assertIn("unknown argument", self.call("read_file", path="x", mode="w"))
        self.assertIn("missing path", self.tools.call("read_file", "{}"))

    def test_only_read_only_tools_are_offered(self):
        names = {s["function"]["name"] for s in self.tools.specs()}
        self.assertEqual(names, {"read_file", "list_dir", "grep", "service_status", "service_logs", "system_info",
                                 "edith_status", "web_search", "fetch_url", "queue_for_claude", "reminders_list",
                                 "project_changes", "agents_status"})
        writer = BinTool("reminder_add", "add", ("remind.py", "add", "{when}", "{text}"),
                         {"when": ".*", "text": ".*"}, read_only=False)
        tools = Tools(self.l.policy, "/x", self.queue, lambda: None, {}, run=self.fake_run, bin_tools=BIN_TOOLS + (writer,))
        self.assertNotIn("reminder_add", {s["function"]["name"] for s in tools.specs()})
        with self.assertRaises(ToolError):
            bin_argv(writer, "/x", {"when": "+1h", "text": "x"})

    def test_bin_tools_argv_and_patterns(self):
        bin_dir = os.path.join(self.l.home, "edith/bin")
        os.makedirs(bin_dir)
        for script in ("remind.py", "changes.py", "agent.py"):
            open(os.path.join(bin_dir, script), "w").close()
        self.assertEqual(self.call("reminders_list"), "fake output")
        self.assertEqual(self.ran[-1], ["python3", "-I", f"{bin_dir}/remind.py", "list"])
        self.call("agents_status")
        self.assertEqual(self.ran[-1], ["python3", "-I", f"{bin_dir}/agent.py", "status"])
        self.call("project_changes", project="edith-app")
        self.assertEqual(self.ran[-1], ["python3", "-I", f"{bin_dir}/changes.py", "edith-app"])
        for bad in ("../etc", "--help", "a;rm -rf ~", "$(id)", "a b", "", "x" * 80, "-n"):
            with self.subTest(bad=bad):
                self.assertTrue(self.call("project_changes", project=bad).startswith("error:"))
        self.assertIn("unknown argument", self.call("agents_status", name="edith-app"))
        self.assertEqual(len(self.ran), 3)

    def test_services(self):
        self.call("service_status", unit="edith-bridge")
        self.assertEqual(self.ran[-1], ["systemctl", "--user", "status", "--no-pager", "--lines=0", "edith-bridge"])
        self.call("service_logs", unit="edith-claude.service", lines=999)
        self.assertEqual(self.ran[-1][:6], ["journalctl", "--user", "-u", "edith-claude.service", "-n", "200"])
        for bad in ("sshd", "edith;reboot", "../edith", "edith bridge", "-H root"):
            self.assertTrue(self.call("service_status", unit=bad).startswith("error:"), bad)

    def test_logs_drop_mail_and_calendar(self):
        tools = Tools(self.l.policy, "/x", self.queue, lambda: None, {}, run=lambda *a: (
            "10:00 edith.feature.mail INFO new mail from bank\n10:01 edith.main INFO running\n"
            "10:02 edith.adapter.google INFO token refreshed\n10:03 edith.feature.calendar INFO event at 5pm"))
        out = tools.call("service_logs", json.dumps({"unit": "edith-bridge"}))
        self.assertEqual(out, "10:01 edith.main INFO running")

    def test_web_is_public_only(self):
        for url in ("http://localhost/x", "http://metadata/computeMetadata", "http://ts.internal:8080/", "http://lan/",
                    "file:///etc/passwd", "ftp://example.com/", "http://user:pw@example.com/", "http://nowhere.invalid/",
                    "http://v6/"):
            with self.subTest(url=url):
                self.assertTrue(self.call("fetch_url", url=url).startswith("error:"))
        self.assertTrue(public_host("example.com", self.resolve))
        self.assertFalse(public_host("ts.internal", self.resolve))

    def test_fetch_and_search_with_a_fake_web(self):
        pages = {"https://example.com/a": (b"<html><head><title>t</title><script>x()</script></head><body><p>Hello "
                                           b"&amp; welcome</p></body></html>", "text/html")}

        class Resp:
            def __init__(self, body, ctype):
                self.body, self.headers = body, {"Content-Type": ctype}

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n):
                return self.body

        class Op:
            def open(self, req, timeout):
                body, ctype = pages.get(req.full_url, (b'<a class="result__a" href="//duckduckgo.com/l/?uddg='
                                                      b'https%3A%2F%2Fexample.com%2Fa">Example <b>A</b></a> <a class='
                                                      b'"result__snippet" href="x">An example page</a>', "text/html"))
                return Resp(body, ctype)

        resolver = lambda host, port: [(2, 1, 0, "", ("93.184.215.14", 0))]  # noqa: E731
        tools = Tools(self.l.policy, "/x", self.queue, lambda: None, {}, opener=Op(), resolver=resolver)
        self.assertEqual(tools.call("fetch_url", json.dumps({"url": "https://example.com/a"})), "Hello & welcome")
        self.assertEqual(tools.call("web_search", json.dumps({"query": "example"})),
                         "- Example A\n  https://example.com/a\n  An example page")

    def test_queue_and_status(self):
        self.assertIn("#abc123", self.call("queue_for_claude", task="restart the bridge"))
        self.assertEqual(self.queued, ["restart the bridge"])
        self.assertEqual(json.loads(self.call("edith_status")), {"edith": {"state": "idle"}})
        self.assertIn("disk /", self.call("system_info"))


# ---------------------------------------------------------------- the loop

class FakeTools:
    def __init__(self, results=None):
        self.results, self.calls = results or {}, []

    def specs(self):
        return [{"type": "function", "function": {"name": "read_file"}}]

    def call(self, name, arguments):
        self.calls.append((name, arguments))
        return self.results.get(name, "result")


class LoopTest(unittest.TestCase):
    def chain(self, *providers):
        return Chain(providers, os.path.join(tmpdir(self), "skips.json"), sleep=lambda s: None)

    def test_tools_then_an_answer(self):
        p = FakeProvider("n", "N", [use("read_file", '{"path": "x"}'), say("The file says hi.")])
        tools = FakeTools({"read_file": "hi"})
        steps = []
        ans = loop.answer(self.chain(p), tools, [{"role": "user", "content": "earlier"}], "what's in x?",
                          on_step=lambda s, n: steps.append((s, n)))
        self.assertEqual((ans.text, ans.provider.name, ans.steps), ("The file says hi.", "n", 1))
        self.assertEqual(steps, [("read_file", 1)])
        sent = p.calls[1][0]
        self.assertEqual([m["role"] for m in sent], ["system", "user", "user", "assistant", "tool"])
        self.assertEqual(sent[-1], {"role": "tool", "tool_call_id": "call_read_file", "content": "hi"})

    def test_at_most_eight_tool_uses(self):
        p = FakeProvider("n", "N", [use("read_file", "{}", id=f"c{i}") for i in range(8)] + [say("done")])
        tools = FakeTools()
        ans = loop.answer(self.chain(p), tools, [], "loop forever")
        self.assertEqual((len(tools.calls), ans.steps, ans.text), (8, 8, "done"))
        self.assertEqual(p.calls[-1][1], [])  # the last call offers no tools
        many = ChatReply(None, [ToolCall(f"c{i}", "read_file", "{}") for i in range(10)])  # 10 in one go
        p = FakeProvider("n", "N", [many, say("done")])
        tools = FakeTools()
        ans = loop.answer(self.chain(p), tools, [], "all at once")
        self.assertEqual((len(tools.calls), ans.text), (8, "done"))
        refused = [m for m in p.calls[1][0] if m["role"] == "tool" and "tool limit" in m["content"]]
        self.assertEqual(len(refused), 2)

    def test_nothing_secret_leaves(self):
        p = FakeProvider("n", "N", [use("read_file"), say("ok")])
        tools = FakeTools({"read_file": "API_KEY=sk-ant-" "oat01-AbCdEfGhIjKlMnOpQrStUv0123 and ~/.claude/x"})
        loop.answer(self.chain(p), tools, [], "my token is ghp_" "16C7e42F292c6912E7710c838347Ae178B4a")
        sent = json.dumps([c[0] for c in p.calls])
        for s in ("sk-ant-oat01", "ghp_16C7", "~/.claude"):
            self.assertNotIn(s, sent)

    def test_falls_over_to_the_next_provider_mid_answer(self):
        a = FakeProvider("a", "A", [use("read_file"), ProviderError("rate_limit", "", 429, retry_after=60)])
        b = FakeProvider("b", "B", [say("from b")])
        ans = loop.answer(self.chain(a, b), FakeTools(), [], "q")
        self.assertEqual((ans.text, ans.provider.name), ("from b", "b"))
        self.assertEqual(b.calls[0][0][-1]["role"], "tool")  # b carries on the same conversation

    def test_none_can_answer(self):
        ans = loop.answer(self.chain(FakeProvider("a", "A", available=False)), FakeTools(), [], "q")
        self.assertIsNotNone(ans.unavailable)
        self.assertIsNone(ans.provider)


# ---------------------------------------------------------------- the adapter

class Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


KEY = "nvapi-" "Kx7Qm2Lp9Rt4Vw8Yz1Ab3Cd5Ef6Gh0Jk"


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.dir = tmpdir(self)
        self.key_file = os.path.join(self.dir, "nvidia-key")

    def write_key(self, mode=0o600):
        fd = os.open(self.key_file, os.O_WRONLY | os.O_CREAT, mode)
        with os.fdopen(fd, "w") as f:
            f.write(KEY + "\n")
        os.chmod(self.key_file, mode)

    def provider(self, opener):
        return openai_compat.Provider("nemotron", openai_compat.DEFAULTS["nemotron"], self.dir, opener=opener)

    def opener(self, answer=None, error=None):
        calls = []

        def op(req, timeout):
            calls.append((req, timeout))
            if error:
                raise error
            return Resp(json.dumps(answer).encode())
        op.calls = calls
        return op

    def http_error(self, code, body, headers=None):
        return urllib.error.HTTPError("https://x", code, "err", headers or {}, io.BytesIO(body.encode()))

    def test_a_missing_or_open_key_file_switches_it_off(self):
        p = self.provider(self.opener())
        self.assertFalse(p.available())
        self.write_key(0o644)
        with self.assertLogs("edith.adapter.openai_compat", "WARNING") as logs:
            self.assertFalse(p.available())
        self.assertNotIn(KEY, "\n".join(logs.output))
        os.chmod(self.key_file, 0o600)
        self.assertTrue(p.available())
        with self.assertRaises(ProviderError) as e:
            openai_compat.Provider("gemini", openai_compat.DEFAULTS["gemini"], self.dir, opener=self.opener()).chat([], [], 5)
        self.assertEqual(e.exception.kind, "auth")

    def test_request_and_answer(self):
        self.write_key()
        op = self.opener({"choices": [{"message": {"content": "<think>hmm</think>Here it is.", "tool_calls": [
            {"id": "t1", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "x"}'}}]}}]})
        reply = self.provider(op).chat([{"role": "user", "content": "hi"}], [{"type": "function"}], 30)
        self.assertEqual(reply, ChatReply("Here it is.", [ToolCall("t1", "read_file", '{"path": "x"}')]))
        req, timeout = op.calls[0]
        self.assertEqual((req.full_url, timeout), ("https://integrate.api.nvidia.com/v1/chat/completions", 30))
        self.assertEqual(req.get_header("Authorization"), f"Bearer {KEY}")
        body = json.loads(req.data)
        self.assertEqual((body["model"], body["tool_choice"]), ("nvidia/nemotron-3-super-120b-a12b", "auto"))
        self.assertNotIn(KEY, req.data.decode())

    def test_errors(self):
        self.write_key()
        cases = (
            (self.http_error(429, '{"error": {"message": "slow"}}', {"Retry-After": "42"}), "rate_limit", 42.0, False),
            (self.http_error(429, '{"error": {"message": "Quota exceeded for GenerateRequestsPerDay", '
                                  '"details": [{"retryDelay": "17s"}]}}'), "rate_limit", 17.0, True),
            (self.http_error(401, f'{{"error": "bad key {KEY}"}}'), "auth", None, False),
            (self.http_error(503, "busy"), "down", None, False),
            (self.http_error(400, '{"error": {"message": "bad tools"}}'), "bad_request", None, False),
            (urllib.error.URLError(socket.timeout("timed out")), "down", None, False),
            (TimeoutError(), "down", None, False),
        )
        for error, kind, after, daily in cases:
            with self.subTest(kind=kind, after=after), self.assertRaises(ProviderError) as e:
                self.provider(self.opener(error=error)).chat([], [], 5)
            self.assertEqual((e.exception.kind, e.exception.retry_after, e.exception.daily), (kind, after, daily))
            self.assertNotIn(KEY, str(e.exception) + e.exception.detail)
        with self.assertRaises(ProviderError) as e:
            self.provider(self.opener({"nope": 1})).chat([], [], 5)
        self.assertEqual(e.exception.kind, "down")

    def test_retry_after_as_a_date(self):
        self.assertAlmostEqual(openai_compat.retry_after("Wed, 21 Oct 2026 07:28:00 GMT", "", 1792567650.0), 30.0)

    def test_create_and_daily_reset(self):
        models = openai_compat.create({"key_dir": self.dir, "providers": {"mistral": {"enabled": False}}})
        self.assertEqual([p.name for p in models.providers], ["nemotron", "gemini"])
        gemini = models.providers[1]
        self.assertEqual(gemini.base_url, "https://generativelanguage.googleapis.com/v1beta/openai")
        # midnight Pacific after 2026-11-02 10:00 UTC (03:00 PDT... PST from Nov 1): 2026-11-03 08:00 UTC
        self.assertEqual(gemini.daily_reset(1793613600.0), 1793692800.0)


# ---------------------------------------------------------------- the feature

class FakeAgent:
    max_side_lanes = 2

    def __init__(self):
        self.sent, self.runs, self.probes = [], [], []
        self.probe_answers = []

    def send(self, text, origin, ref, force_queue=False, parallel=False):
        self.sent.append((text, origin, ref))
        return TurnHandle(ref, "main")

    def status(self):
        return list(self.runs), 0

    def probe(self, timeout=90.0):
        self.probes.append(time.time())
        return self.probe_answers.pop(0) if self.probe_answers else {"ok": True, "kind": None, "detail": None}


class FakeTimers:
    def __init__(self, name, clock=None):
        self.due = {}

    def schedule(self, key, at, fn):
        self.due[key] = (at, fn)

    def cancel(self, key):
        self.due.pop(key, None)

    def when(self, key):
        return self.due.get(key, (None,))[0]

    def fire(self, key):
        _, fn = self.due.pop(key)
        fn()


class FeatureTest(unittest.TestCase):
    def setUp(self):
        self.home = tmpdir(self)
        self.state = os.path.join(self.home, "state")
        self.agent = FakeAgent()
        self.provider = FakeProvider("nemotron", "Nemotron")
        self.timers = []

        def make_timers(name, clock=None):
            t = FakeTimers(name)
            self.timers.append(t)
            return t
        p = mock.patch.object(backup, "Timers", make_timers)
        p.start()
        self.addCleanup(p.stop)
        self.load()

    def load(self, providers=None, accounts=False, mode=None):
        self.bus, self.registry = EventBus(), Registry()
        self.events = []
        self.bus.subscribe("*", self.events.append, owner="test")
        if accounts:
            self.registry.add_route(SimpleNamespace(method="GET", path="/v1/accounts", handler=None, owner="accounts"))
        models = FakeModels(*(providers if providers is not None else [self.provider]))
        self.front = DivertingAgent(self.agent, self.registry)  # what the frontends call
        cfg = {"state_dir": self.state, "work_dir": os.path.join(self.home, "edith"), "bin_dir": "/nonexistent"}
        if mode:
            cfg["mode"] = mode
        with mock.patch.dict(os.environ, {"HOME": self.home}):
            report = load_features(["backup"], self.bus, Ports(agent=self.front, llm=models), self.registry, {"backup": cfg})
        self.assertEqual(report.loaded, ["backup"], report.failed)
        self.cmd = self.registry.commands["backup"]

    @property
    def timer(self):
        return self.timers[-1]

    def of(self, type, ref=None):
        return [e.data for e in self.events if e.type == type and (ref is None or e.data.get("ref") == ref)]

    def system(self):
        return [d["text"] for d in self.of("message.system")]

    def backup_cmd(self, args=""):
        return self.cmd.handler(SimpleNamespace(args=args, origin="telegram", reply=lambda r: None))

    def limit(self, action="none_free", resets=None, kind="usage_limit"):
        self.bus.publish(Event("accounts.limit", {"account": "a1", "kind": kind, "resets": resets, "action": action,
                                                  "target": None, "next_free": resets, "detail": None}))

    def ask(self, text, ref="tg:1:5", **kw):
        handle = self.front.send(f"[Telegram message from Arpit, 2026-11-02 10:00 IST]\n{text}", "telegram", ref, **kw)
        run_workers(self.registry)
        return handle

    def test_claude_answers_while_not_taken_over(self):
        self.assertEqual(self.ask("hi").lane, "main")
        self.assertEqual(len(self.agent.sent), 1)
        self.assertEqual(self.provider.calls, [])

    def test_takes_over_answers_with_a_label_and_hands_back(self):
        resets = time.time() + 3600
        self.limit(resets=resets)
        self.assertIn("🛟 Claude hit its usage limit", self.system()[-1])
        self.assertIn("Nemotron", self.system()[-1])
        self.assertEqual(self.timer.when("check"), resets)
        self.provider.script = [say("Disk is 40% full.")]
        handle = self.ask("how full is the disk?")
        self.assertEqual(handle.lane, "backup")
        self.assertEqual(self.agent.sent, [])
        user = self.of("message.user", "tg:1:5")[0]
        self.assertEqual((user["text"], user["delivery"], user["lane"]), ("how full is the disk?", "backup", "backup"))
        done = self.of("turn.done", "tg:1:5")[0]
        self.assertEqual((done["text"], done["lane"], done["provider"]), ("Backup (Nemotron): Disk is 40% full.", "backup", "nemotron"))
        self.assertEqual(self.of("message.assistant", "tg:1:5")[0]["text"], "Backup (Nemotron): Disk is 40% full.")
        self.assertEqual([e.type for e in self.events if e.data.get("ref") == "tg:1:5"],
                         ["message.user", "message.delivered", "turn.started", "message.assistant", "turn.done"])
        # the reset time: a test message works -> hand back
        self.timer.fire("check")
        self.assertEqual(len(self.agent.probes), 1)
        self.assertIn("✅ Claude passed a test message", self.system()[-1])
        self.assertEqual(self.ask("and now?", ref="tg:1:6").lane, "main")
        self.assertFalse(self.registry.routes[("GET", "/v1/backup")].handler({})["active"])

    def test_hand_back_retries_after_15_30_then_60_minutes(self):
        self.limit()
        bad = {"ok": False, "kind": "usage_limit", "detail": "limit"}
        self.agent.probe_answers = [bad, bad, bad, bad]
        waits = []
        for _ in range(4):
            before = time.time()
            self.timer.fire("check")
            waits.append(round((self.timer.when("check") - before) / 60))
        self.assertEqual(waits, [15, 30, 60, 60])
        self.assertTrue(self.registry.routes[("GET", "/v1/backup")].handler({})["active"])

    def test_the_queue_and_send_to_claude(self):
        self.limit()
        self.provider.script = [use("queue_for_claude", '{"task": "restart edith-bridge"}'), say("I'll queue that for Claude.")]
        self.ask("restart the bridge please")
        self.assertEqual(self.of("turn.done")[-1]["text"], "Backup (Nemotron): I'll queue that for Claude.")
        self.ask("/queue fix the tests", ref="tg:1:7", force_queue=True)
        self.assertIn("Queued for Claude", self.of("turn.done", "tg:1:7")[0]["text"])
        self.assertEqual(self.registry.press("bk:send:zzz", "telegram", lambda r: None).toast, "Claude isn't back yet")
        self.timer.fire("check")
        msgs = self.of("message.system")
        self.assertIn("2 tasks waited for Claude", msgs[-3]["text"])
        first, second = msgs[-2], msgs[-1]
        self.assertEqual(first["text"], "📥 For Claude: restart edith-bridge")
        send = first["buttons"][0][0]
        self.assertEqual(send["label"], "Send to Claude")
        result = self.registry.press(send["action"], "telegram", lambda r: None, ref="tg:1:9")
        self.assertEqual(result.note, "📨 Sent to Claude.")
        text, origin, ref = self.agent.sent[-1]
        self.assertIn("restart the bridge please", text)
        self.assertIn("it noted: restart edith-bridge", text)
        self.assertEqual((origin, ref), ("telegram", "tg:1:9"))
        self.assertEqual(self.registry.press(send["action"], "telegram", lambda r: None).toast, "Already handled")
        drop = second["buttons"][0][1]
        self.assertEqual(self.registry.press(drop["action"], "telegram", lambda r: None).note, "🗑 Dropped.")
        self.assertEqual(len(self.agent.sent), 1)

    def test_no_provider_can_answer_queues_the_message(self):
        self.limit()
        self.provider.script = [ProviderError("rate_limit", "", 429, retry_after=600)]
        self.ask("what's up?")
        text = self.of("turn.done")[-1]["text"]
        self.assertIn("no backup AI can answer right now (Nemotron: rate limited until", text)
        self.assertIn("queued your message for Claude", text)
        self.assertEqual(self.registry.routes[("GET", "/v1/backup")].handler({})["queued"], 1)

    def test_switching_accounts_first(self):
        self.limit(action="switching")
        self.assertEqual(self.ask("hi").lane, "main")
        self.limit(action="refused")
        self.assertEqual(self.ask("hi", ref="tg:1:8").lane, "backup")

    def test_agent_limit_alone_only_without_the_accounts_feature(self):
        self.load(accounts=True)
        self.bus.publish(Event("agent.limit", {"kind": "login", "resets": None}))
        self.assertEqual(self.ask("hi").lane, "main")
        self.load(accounts=False)
        self.bus.publish(Event("agent.limit", {"kind": "login", "resets": None}))
        self.assertIn("login problem", self.system()[-1])
        self.assertEqual(self.ask("hi", ref="tg:1:8").lane, "backup")

    def test_off_and_no_keys(self):
        self.backup_cmd("off")
        self.limit()
        self.assertIn("backup AI is off", self.system()[-1])
        self.assertEqual(self.ask("hi").lane, "main")
        self.load(providers=[FakeProvider(available=False)])
        self.backup_cmd("auto")
        self.limit()
        self.assertIn("no backup AI is set up yet", self.system()[-1])
        self.assertEqual(self.ask("hi", ref="tg:1:6").lane, "main")
        self.assertIn("No backup AI is set up yet", self.backup_cmd("on"))

    def test_on_auto_and_status(self):
        out = self.backup_cmd("")
        self.assertIn("Backup AI: auto", out)
        self.assertIn("Nemotron: ready", out)
        self.backup_cmd("on")
        self.assertEqual(self.ask("hi").lane, "backup")
        self.assertNotIn("check", self.timer.due)  # forced on: no hand-back check
        self.backup_cmd("auto")
        self.timer.fire("check")  # auto again: Claude answers, so hand back at once
        self.assertEqual(self.ask("hi", ref="tg:1:6").lane, "main")
        self.assertIn("Use /backup on", self.backup_cmd("maybe"))
        changed = self.of("backup.changed")[-1]
        self.assertEqual((changed["mode"], changed["active"]), ("auto", False))

    def test_api(self):
        routes = self.registry.routes
        got = routes[("GET", "/v1/backup")].handler({})
        self.assertEqual({k: got[k] for k in ("mode", "active", "queued")}, {"mode": "auto", "active": False, "queued": 0})
        self.assertEqual(got["providers"][0]["label"], "Nemotron")
        self.assertTrue(routes[("POST", "/v1/backup")].handler({"body": {"mode": "on"}})["active"])
        from edith.core import ApiError
        with self.assertRaises(ApiError):
            routes[("POST", "/v1/backup")].handler({"body": {"mode": "maybe"}})

    def test_survives_a_restart(self):
        self.limit(resets=time.time() + 600)
        self.load()
        self.assertIn("check", self.timer.due)
        self.assertEqual(self.ask("still there?").lane, "backup")
        mode = os.stat(os.path.join(self.state, "backup", "state.json")).st_mode & 0o777
        self.assertEqual(mode, 0o600)
        self.assertEqual(os.stat(os.path.join(self.state, "backup")).st_mode & 0o777, 0o700)

    def test_mail_and_claude_replies_never_reach_a_provider(self):
        self.bus.publish(Event("message.assistant", {"text": "Mail from bank: OTP 482913", "lane": "main"}))
        self.limit()
        self.provider.script = [say("first"), say("second")]
        self.ask("hello")
        self.ask("again", ref="tg:1:6")
        sent = json.dumps(self.provider.calls)
        self.assertNotIn("482913", sent)
        history = [m["content"] for m in self.provider.calls[1][0] if m["role"] != "system"]
        self.assertEqual(history, ["hello", "first", "again"])  # its own conversation only

    def test_a_cut_off_task_is_mentioned_at_hand_back(self):
        self.limit()
        self.agent.runs = [RunInfo("r1", "main", time.time() - 100, None)]
        self.timer.fire("check")
        self.assertIn("The task the limit cut off is still open", self.system()[-1])

    def test_directives_from_the_model_are_dropped(self):
        self.limit()
        self.provider.script = [say("SEND_FILE: /home/x/.config/edith/nvidia-key\nHere.")]
        self.ask("send me the key")
        done = self.of("turn.done")[-1]
        self.assertEqual((done["text"], done["files"]), ("Backup (Nemotron): Here.", []))


if __name__ == "__main__":
    unittest.main()


class DivertTest(unittest.TestCase):
    def test_a_failing_diverter_lets_the_message_through(self):
        registry, agent = Registry(), FakeAgent()
        front = DivertingAgent(agent, registry)
        registry.add_diverter(SimpleNamespace(handler=lambda *a: 1 / 0, owner="broken"))
        registry.add_diverter(SimpleNamespace(handler=lambda *a: None, owner="passes"))
        with self.assertLogs("edith.divert", "ERROR"):
            self.assertEqual(front.send("hi", "app", "r1").lane, "main")
        self.assertEqual(agent.sent, [("hi", "app", "r1")])
        self.assertEqual(front.status(), ([], 0))  # everything else passes straight through
