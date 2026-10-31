"""Pushes while the app is closed (contracts/push.md): the notifications feature and the ntfy adapter."""
import http.server
import json
import logging
import os
import pathlib
import queue
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from edith.adapters.frontends.app_api import AppApi
from edith.adapters.notifiers.ntfy import NtfyNotifier
from edith.core import Event, EventBus, JobRunner, Ports, Registry, load_features
from edith.features.notifications import preview

TOKEN = "tk_" + "a" * 29


class FakeNotifier:
    def __init__(self, name="ntfy"):
        self.name = name
        self.sent = queue.Queue()

    def notify(self, title, body, priority="default", data=None):
        self.sent.put((title, body, priority, data))
        return True

    def next(self):
        return self.sent.get(timeout=5)


class FakePresence:
    def __init__(self):
        self.count = 0
        self.asked = queue.Queue()  # one item per push the worker checked

    def app_clients(self, wait=3.0):
        self.asked.put(self.count)
        return self.count


class FeatureTest(unittest.TestCase):
    def setUp(self):
        self.bus, registry = EventBus(), Registry()
        self.ntfy, self.telegram = FakeNotifier(), FakeNotifier("telegram")
        self.presence = FakePresence()
        ports = Ports(notifiers=[self.telegram, self.ntfy], presence=self.presence)
        report = load_features(["notifications"], self.bus, ports, registry, {})
        self.assertEqual(report.failed, {})
        self.jobs = JobRunner(list(registry.jobs.values()))
        self.jobs.start()
        self.addCleanup(self.jobs.stop)

    def publish(self, type_, origin="app", **data):
        self.bus.publish(Event(type_, data, origin=origin))

    def data(self):
        return self.ntfy.next()[3]

    def test_an_app_reply_is_pushed_once_and_others_are_not(self):
        self.publish("turn.done", origin="telegram", ref="t1", text="to Telegram")  # Telegram shows it
        self.publish("turn.done", ref="r1", text="**Done**: tests `pass`", lane="main")
        title, body, priority, data = self.ntfy.next()
        self.assertEqual((title, body, priority), ("EDITH replied", "Done: tests pass", "default"))
        self.assertEqual(data, {"v": 1, "tag": "turn:r1", "channel": "replies", "title": "EDITH replied",
                                "text": "Done: tests pass", "link": "edith://live"})
        self.publish("turn.done", ref="r1", text="again")  # the same tag: not again
        self.publish("turn.failed", ref="r2", reason="crashed")
        self.assertEqual(self.data(), {"v": 1, "tag": "turn:r2", "channel": "errors", "title": "EDITH couldn't finish",
                                       "text": "Claude stopped unexpectedly.", "link": "edith://live"})
        self.assertTrue(self.telegram.sent.empty())  # only the notifiers in `via` (default ntfy)

    def test_nothing_is_pushed_while_the_app_listens(self):
        self.presence.count = 1
        self.publish("turn.done", ref="r1", text="seen in the app")
        self.assertEqual(self.presence.asked.get(timeout=5), 1)  # asked at push time, and not pushed
        self.presence.count = 0
        self.publish("turn.done", ref="r2", text="app closed")
        self.assertEqual(self.data()["tag"], "turn:r2")  # FIFO: r1 would have come first
        self.publish("turn.done", ref="r1", text="seen in the app")  # not marked sent, so it can go later
        self.assertEqual(self.data()["tag"], "turn:r1")

    def test_an_approval_is_pushed_and_cancelled_once_answered(self):
        self.publish("permission.request", origin="telegram", id="p0", tool="Bash", detail="ls")
        self.publish("permission.resolved", id="p0", decision="allow")  # never pushed: no cancel either
        self.publish("permission.request", id="p1", tool="Bash", detail="npm test", lane="side")
        title, _, priority, data = self.ntfy.next()
        self.assertEqual((title, priority), ("Approve Bash? (parallel task)", "high"))
        self.assertEqual(data, {"v": 1, "tag": "perm:p1", "channel": "approvals", "title": "Approve Bash? (parallel task)",
                                "text": "npm test", "link": "edith://approvals", "permission": "p1"})
        self.presence.count = 1  # answered in the app, which opened meanwhile: the cancel still goes
        self.publish("permission.resolved", id="p1", decision="allow")
        _, _, priority, data = self.ntfy.next()
        self.assertEqual((priority, data), ("min", {"v": 1, "tag": "perm:p1", "cancel": True}))

    def test_a_push_that_failed_is_not_marked_sent(self):
        results = [False, True]
        notify = self.ntfy.notify
        self.ntfy.notify = lambda *a: (notify(*a), results.pop(0))[1]
        results.insert(1, True)
        self.publish("turn.done", ref="r1", text="first try fails")
        self.publish("turn.done", ref="r2", text="goes after it")
        self.assertEqual([self.data()["tag"], self.data()["tag"]], ["turn:r1", "turn:r2"])  # r1 done with, in order
        self.publish("turn.done", ref="r1", text="sent again")
        self.assertEqual(self.data()["tag"], "turn:r1")  # not deduped: the first never arrived

    def test_a_reminder_is_pushed_once_per_due_time(self):
        self.publish("reminder.due", origin="system", id="aa11", text="Pay rent", due=100, late=False, every="monthly")
        self.publish("reminder.due", origin="system", id="aa11", text="Pay rent", due=100, late=False, every="monthly")
        self.publish("reminder.due", origin="system", id="aa11", text="Pay rent", due=200, late=True, every="monthly")
        first, second = self.data(), self.data()
        self.assertEqual((first["tag"], first["title"]), ("rem:aa11:100", "Reminder"))
        self.assertEqual((second["tag"], second["title"]), ("rem:aa11:200", "Reminder (late)"))

    def test_preview_matches_the_app(self):
        self.assertEqual(preview("# Title\n```py\nx = 1\n```\nSee [docs](http://x) and `code`."),
                         "Title [code] See docs and code.")
        self.assertEqual(preview("x" * 200), "x" * 179 + "…")


class NoNotifierTest(unittest.TestCase):
    def test_without_ntfy_it_stays_off(self):
        registry = Registry()
        report = load_features(["notifications"], EventBus(), Ports(notifiers=[FakeNotifier("telegram")]), registry, {})
        self.assertEqual((report.failed, registry.jobs), ({}, {}))


class Ntfy(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.seen.append((self.headers.get("Authorization"), body))
        status = self.server.answers.pop(0) if self.server.answers else 200
        self.send_response(status)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Ntfy)
        self.server.seen, self.server.answers = [], []
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        d = tempfile.mkdtemp()
        self.token = os.path.join(d, "token")
        with open(self.token, "w") as f:
            f.write(TOKEN + "\n")
        os.chmod(self.token, 0o600)
        self.addCleanup(lambda: (os.remove(self.token), os.rmdir(d)))
        url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.ntfy = NtfyNotifier({"url": url, "topic": "t", "token_file": self.token}, timeout=2, backoff=0.01)

    def test_publishes_the_message_as_json_with_the_token(self):
        self.assertTrue(self.ntfy.notify("Approve Bash?", "npm test", "high", {"v": 1, "tag": "perm:p1"}))
        auth, body = self.server.seen[0]
        self.assertEqual(auth, f"Bearer {TOKEN}")
        self.assertEqual(body, {"topic": "t", "title": "Approve Bash?", "priority": 4,
                                "message": '{"v":1,"tag":"perm:p1"}'})
        self.assertTrue(self.ntfy.notify("Hi", "plain"))
        self.assertEqual(self.server.seen[1][1]["message"], "plain")

    def test_retries_a_server_error_but_not_a_refusal(self):
        self.server.answers = [503, 200]
        self.assertTrue(self.ntfy.notify("a", "b"))
        self.assertEqual(len(self.server.seen), 2)
        self.server.answers = [403]
        self.assertFalse(self.ntfy.notify("a", "b"))
        self.assertEqual(len(self.server.seen), 3)
        self.server.answers = [500, 500, 500]
        self.assertFalse(self.ntfy.notify("a", "b"))  # 3 tries, then dropped
        self.assertEqual(len(self.server.seen), 6)

    def test_an_unreachable_server_or_open_token_fails_cleanly(self):
        dead = NtfyNotifier({"url": "http://127.0.0.1:1", "token_file": self.token}, timeout=1, retries=1, backoff=0.01)
        self.assertFalse(dead.notify("a", "b"))
        os.chmod(self.token, 0o644)
        open_token = NtfyNotifier({"url": "http://127.0.0.1:1", "token_file": self.token})
        self.assertFalse(open_token.notify("a", "b"))
        self.assertEqual(self.server.seen, [])


API_TOKEN = "t" * 40
PHONE = "tk_" + "p1" * 14 + "q"  # the phone's read-only token (29 after tk_)


class Captured(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append(self.format(record))


class PushConfigTest(unittest.TestCase):
    """GET /v1/push/config on a running App API, with the real ntfy adapter (it publishes nothing here)."""

    def setUp(self, notifiers=None):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.publish_file, self.phone_file = self.secret("publish", TOKEN), self.secret("phone", PHONE)
        api_token = self.secret("app-token", API_TOKEN)
        self.ntfy = NtfyNotifier({"url": "http://100.78.124.98:2586", "topic": "edith", "token_file": self.publish_file,
                                  "phone_token_file": self.phone_file})
        self.logs = Captured()
        root = logging.getLogger()
        level = root.level
        root.addHandler(self.logs)
        root.setLevel(logging.DEBUG)
        self.addCleanup(lambda: (root.removeHandler(self.logs), root.setLevel(level)))
        bus, registry = EventBus(), Registry()
        report = load_features(["notifications"], bus, Ports(notifiers=[self.ntfy] if notifiers is None else notifiers),
                               registry, {})
        self.assertEqual(report.failed, {})
        self.audit = os.path.join(self.dir, "audit.jsonl")
        self.api = AppApi({"bind": "tailscale", "port": 0, "token_file": api_token, "audit_log": self.audit},
                          resolve_ip=lambda: "127.0.0.1", allow_loopback=True)
        self.api.start(bus, registry, None)
        self.addCleanup(self.api.stop)
        self.assertTrue(self.api.listening.wait(5))

    def secret(self, name, value):
        path = os.path.join(self.dir, name)
        with open(path, "w") as f:
            f.write(value + "\n")
        os.chmod(path, 0o600)
        return path

    def get(self, token=API_TOKEN):
        host, port = self.api.address
        req = urllib.request.Request(f"http://{host}:{port}/v1/push/config")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, dict(r.headers), json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), json.loads(e.read())

    def assert_no_token_anywhere(self):
        self.api.stop()  # every audit line is written
        written = (pathlib.Path(self.audit).read_text() if os.path.exists(self.audit) else "") + "\n".join(self.logs.lines)
        for secret in (PHONE, TOKEN, API_TOKEN):
            self.assertNotIn(secret, written)

    def test_needs_the_bearer_token(self):
        for token in (None, "wrong", API_TOKEN + "x"):
            with self.subTest(token=token):
                status, _, body = self.get(token)
                self.assertEqual((status, body), (401, {"error": "unauthorized"}))
        self.assert_no_token_anywhere()

    def test_hands_over_the_phone_token_only(self):
        status, headers, body = self.get()
        self.assertEqual(status, 200)
        self.assertEqual(body, {"url": "http://100.78.124.98:2586", "topic": "edith", "token": PHONE})
        self.assertEqual(headers.get("cache-control") or headers.get("Cache-Control"), "no-store")
        self.assert_no_token_anywhere()
        lines = [json.loads(line) for line in pathlib.Path(self.audit).read_text().splitlines()]
        self.assertEqual([(a["path"], a["status"], a.get("push")) for a in lines], [("/v1/push/config", 200, "config")])

    def test_never_the_publish_token(self):
        self.secret("phone", TOKEN)  # the publish token copied into the phone's file
        status, _, body = self.get()
        self.assertEqual(status, 503)
        self.assertNotIn("token", body)
        self.ntfy.phone_token_file = self.publish_file  # or pointed at the publish file itself
        self.assertEqual(self.get()[0], 503)
        self.assertTrue(any("publish token" in line for line in self.logs.lines))
        self.assert_no_token_anywhere()

    def test_an_unusable_phone_token_file_is_refused(self):
        os.chmod(self.phone_file, 0o644)  # readable by others
        self.assertEqual(self.get()[0], 503)
        os.remove(self.phone_file)
        self.assertEqual(self.get()[0], 503)
        self.assert_no_token_anywhere()


class PushConfigWithoutNtfyTest(unittest.TestCase):
    get, secret, assert_no_token_anywhere = PushConfigTest.get, PushConfigTest.secret, PushConfigTest.assert_no_token_anywhere

    def test_says_push_isnt_set_up(self):
        PushConfigTest.setUp(self, notifiers=[FakeNotifier("telegram")])
        status, _, body = self.get()
        self.assertEqual((status, body), (404, {"error": "push isn't set up on edith (no ntfy notifier)"}))
        self.assert_no_token_anywhere()


if __name__ == "__main__":
    unittest.main()
