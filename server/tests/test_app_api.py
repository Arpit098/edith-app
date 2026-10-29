"""The App API (docs/PHASE1_PLAN.md, step 8): WebSocket framing (RFC 6455), the Tailscale-only bind,
the bearer token, routes from features, the live stream and the audit log. Servers bind 127.0.0.1
through a test-only constructor flag (config can't enable it); nothing leaves this machine."""
import base64
import json
import os
import pathlib
import shutil
import socket
import struct
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

from edith.adapters.frontends import app_api
from edith.adapters.frontends.app_api import AppApi, check_bind, read_token, ws
from edith.core import Event, EventBus, Ports, Registry, load_features
from edith.ports.agent import RunInfo, StopResult, TurnHandle

TOKEN = "t" * 40


class FakeAgent:
    max_side_lanes = 2

    def __init__(self):
        self.sent, self.resolved = [], []

    def send(self, text, origin, ref, force_queue=False):
        self.sent.append((text, origin, ref, force_queue))
        return TurnHandle(ref, "main")

    def stop(self):
        return StopResult(1, ["q1"])

    def status(self):
        return [RunInfo("r1", "main", time.time() - 5, "$ ls")], 1

    def busy(self):
        return True

    def tmux_alive(self):
        return True

    def has_conversation(self):
        return True

    def current_session(self):
        return "s1"

    def session_title(self, sid):
        return "First chat"

    def list_sessions(self, limit=8):
        return [{"session_id": "s1", "title": "First chat", "updated": 1.0},
                {"session_id": "s2", "title": "Other", "updated": 0.5}]

    def find_session(self, arg):
        return None

    def name_session(self, title, session_id=None):
        return session_id if session_id in ("s1", "s2") else None

    def new_session(self):
        return "ok"

    def resume(self, sid, before=None):
        return "missing"

    def resolve_permission(self, rid, allow):
        self.resolved.append((rid, allow))
        return rid == "ab12"


class Api:
    """A running App API on 127.0.0.1 with the step 5 features and a FakeAgent."""

    def __init__(self, test, **kw):
        self.dir = tempfile.mkdtemp()
        test.addCleanup(shutil.rmtree, self.dir)
        token = pathlib.Path(self.dir, "token")
        token.write_text(TOKEN)
        token.chmod(0o600)
        self.bus, self.registry, self.agent = EventBus(), Registry(), FakeAgent()
        load_features(["sessions", "control", "approvals", "quick_actions"], self.bus, Ports(agent=self.agent),
                      self.registry, {"sessions": {"idle_wake": 0.05}})
        self.audit = os.path.join(self.dir, "audit.jsonl")
        self.api = AppApi({"bind": "tailscale", "port": 0, "token_file": str(token), "audit_log": self.audit},
                          resolve_ip=kw.get("resolve_ip", lambda: "127.0.0.1"), allow_loopback=True,
                          retry_wait=kw.get("retry_wait", 0.05))
        self.api.start(self.bus, self.registry, self.agent)
        test.addCleanup(self.api.stop)
        deadline = time.monotonic() + 5
        while self.api.address is None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.host, self.port = self.api.address

    def call(self, method, path, body=None, token=TOKEN, raw=None, ctype="application/json"):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(f"http://{self.host}:{self.port}{path}", data=data, method=method)
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        if data is not None:
            req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def stream(self, token=TOKEN, key=None):
        s = socket.create_connection((self.host, self.port), timeout=5)
        key = key or base64.b64encode(os.urandom(16)).decode()
        s.sendall((f"GET /v1/stream HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
                   + (f"Authorization: Bearer {token}\r\n" if token else "") + "\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = s.recv(1)
            if not chunk:
                break
            head += chunk
        return s, head.decode(), key


def read_frame(sock):
    """A server frame (unmasked) -> (opcode, payload)."""
    def exactly(n):
        out = b""
        while len(out) < n:
            chunk = sock.recv(n - len(out))
            if not chunk:
                raise ConnectionError
            out += chunk
        return out
    b1, b2 = exactly(2)
    n = b2 & 0x7F
    if n == 126:
        n = struct.unpack("!H", exactly(2))[0]
    elif n == 127:
        n = struct.unpack("!Q", exactly(8))[0]
    return b1 & 0x0F, exactly(n)


class WebSocketFramingTest(unittest.TestCase):
    def test_accept_key_rfc_example(self):
        self.assertEqual(ws.accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")  # RFC 6455 §1.3
        self.assertTrue(ws.valid_key("dGhlIHNhbXBsZSBub25jZQ=="))
        self.assertFalse(ws.valid_key("short"))

    def test_encode_lengths(self):
        for n, header in ((0, 2), (125, 2), (126, 4), (65535, 4), (65536, 10)):
            frame = ws.encode(ws.OP_TEXT, b"x" * n)
            self.assertEqual((frame[0], len(frame) - n), (0x81, header))
            self.assertEqual(frame[1] & 0x80, 0)  # servers never mask

    def reader(self, data, **kw):
        buf = [data]

        def recv(n):
            out, buf[0] = buf[0][:n], buf[0][n:]
            return out
        return ws.Reader(recv, **kw)

    def test_reads_masked_text_fragments_and_interleaved_ping(self):
        data = (ws.client_frame(ws.OP_TEXT, b"hel", fin=False) + ws.client_frame(ws.OP_PING, b"p")
                + ws.client_frame(ws.OP_CONT, "lo ✓".encode()) + ws.client_frame(ws.OP_TEXT, b"x" * 70000))
        r = self.reader(data, max_message=100000)
        self.assertEqual(r.read(), (ws.OP_PING, b"p"))
        self.assertEqual(r.read(), (ws.OP_TEXT, "hello ✓".encode()))
        self.assertEqual(r.read(), (ws.OP_TEXT, b"x" * 70000))

    def test_protocol_errors(self):
        unmasked = bytes([0x81, 2]) + b"hi"
        cases = {
            "unmasked": (unmasked, ws.CLOSE_PROTOCOL),
            "too big": (ws.client_frame(ws.OP_TEXT, b"x" * 200), ws.CLOSE_TOO_BIG),
            "long control": (ws.client_frame(ws.OP_PING, b"x" * 126), ws.CLOSE_PROTOCOL),
            "fragmented control": (ws.client_frame(ws.OP_PING, b"x", fin=False), ws.CLOSE_PROTOCOL),
            "continuation first": (ws.client_frame(ws.OP_CONT, b"x"), ws.CLOSE_PROTOCOL),
            "reserved bits": (bytes([0xC1, 0x80]) + b"\0\0\0\0", ws.CLOSE_PROTOCOL),
            "unknown opcode": (ws.client_frame(0x3, b"x"), ws.CLOSE_PROTOCOL),
        }
        for name, (data, code) in cases.items():
            with self.subTest(name):
                with self.assertRaises(ws.ProtocolError) as e:
                    self.reader(data, max_message=100).read()
                self.assertEqual(e.exception.code, code)

    def test_close_frame(self):
        op, payload = read_frame(FakeSock(ws.close_frame(1008, "too slow")))
        self.assertEqual((op, struct.unpack("!H", payload[:2])[0], payload[2:]), (ws.OP_CLOSE, 1008, b"too slow"))


class FakeSock:
    def __init__(self, data):
        self.data = data

    def recv(self, n):
        out, self.data = self.data[:n], self.data[n:]
        return out


class BindTest(unittest.TestCase):
    def test_only_tailscale_addresses(self):
        self.assertEqual(check_bind("100.101.102.103"), "100.101.102.103")
        for bad in ("0.0.0.0", "::", "10.0.0.5", "192.168.1.2", "8.8.8.8", "100.100.100.100", "127.0.0.1", "", "edith"):
            with self.subTest(bad), self.assertRaises(ValueError):
                check_bind(bad)
        self.assertEqual(check_bind("127.0.0.1", allow_loopback=True), "127.0.0.1")

    def test_start_refuses_every_interface(self):
        for bind in ("0.0.0.0", "::"):
            with self.subTest(bind), self.assertRaises(ValueError):
                AppApi({"bind": bind}).start(EventBus(), Registry(), FakeAgent())

    def test_configured_non_tailscale_address_never_listens(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        token = pathlib.Path(d, "t")
        token.write_text(TOKEN)
        token.chmod(0o600)
        api = AppApi({"bind": "10.0.0.5", "port": 0, "token_file": str(token), "audit_log": f"{d}/a"})
        with self.assertLogs("edith.adapter.app_api", "ERROR"):
            api.start(EventBus(), Registry(), FakeAgent())
            api._thread.join(5)
        self.assertIsNone(api.server)

    def test_tailscale_ip_is_tailscale_or_none(self):
        ip = app_api.tailscale_ip()
        self.assertTrue(ip is None or ip.startswith("100."))

    def test_waits_for_the_address_then_listens(self):
        answers = iter([None, None, "127.0.0.1"])
        with self.assertLogs("edith.adapter.app_api", "WARNING") as logs:
            a = Api(self, resolve_ip=lambda: next(answers, "127.0.0.1"), retry_wait=0.02)
        self.assertEqual(a.call("GET", "/v1/status")[0], 200)
        self.assertEqual(sum("waiting for its address" in m for m in logs.output), 2)

    def test_token_file_must_be_private_and_long(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        p = pathlib.Path(d, "t")
        p.write_text(TOKEN)
        p.chmod(0o644)
        with self.assertRaises(PermissionError):
            read_token(p)
        p.chmod(0o600)
        p.write_text("short")
        with self.assertRaises(ValueError):
            read_token(p)


class RoutesTest(unittest.TestCase):
    def setUp(self):
        self.a = Api(self)

    def test_auth(self):
        for token in (None, "wrong", TOKEN + "x", "t" * 39):
            with self.subTest(token):
                self.assertEqual(self.a.call("GET", "/v1/status", token=token), (401, {"error": "unauthorized"}))

    def test_status_stop_and_sessions(self):
        status, body = self.a.call("GET", "/v1/status")
        self.assertEqual((status, body["main"], body["queued"], body["session"]), (200, "busy", 1, {"id": "s1", "title": "First chat"}))
        self.assertEqual(self.a.call("POST", "/v1/stop", {}), (200, {"running": 1, "dropped": ["q1"]}))
        self.assertEqual(self.a.call("GET", "/v1/sessions")[1]["sessions"][0]["current"], True)
        self.assertEqual(self.a.call("PATCH", "/v1/sessions/s2", {"title": " Renamed "}), (200, {"session_id": "s2", "title": "Renamed"}))
        self.assertEqual(self.a.call("PATCH", "/v1/sessions/zz", {"title": "x"})[0], 404)
        self.assertEqual(self.a.call("POST", "/v1/sessions/new", {}), (200, {"result": "ok"}))

    def test_resume_answers_on_the_stream(self):
        replies = []
        self.a.bus.subscribe("command.reply", lambda ev: replies.append(ev.data))
        status, body = self.a.call("POST", "/v1/sessions/gone/resume", {})
        self.assertEqual((status, body["status"]), (200, "switching"))
        deadline = time.monotonic() + 5
        while not replies and time.monotonic() < deadline:
            self.a.registry.jobs["sessions.switch"].run()
        self.assertEqual(replies, [{"ref": body["ref"], "text": "❌ That conversation doesn't exist any more.", "buttons": []}])

    def test_messages(self):
        with mock.patch("time.strftime", return_value="2026-11-02 10:43 IST"):
            status, body = self.a.call("POST", "/v1/messages", {"text": " check the disk ", "voice": True})
        self.assertEqual((status, body["lane"]), (200, "main"))
        self.assertEqual(self.a.agent.sent[-1], ("[App message from Arpit, 2026-11-02 10:43 IST] [voice]\ncheck the disk",
                                                 "app", body["ref"], False))
        self.assertEqual(self.a.call("POST", "/v1/messages", {"text": "  "}), (400, {"error": "text is required"}))
        self.assertEqual(self.a.call("POST", "/v1/messages", raw=b"{not json")[0], 400)

    def test_voice_message_announces_its_ref_before_the_send(self):
        seen = []
        self.a.bus.subscribe("voice.turn", lambda ev: seen.append((ev.data, ev.origin, len(self.a.agent.sent))))
        _, body = self.a.call("POST", "/v1/messages", {"text": "check the disk", "voice": True})
        self.a.call("POST", "/v1/messages", {"text": "typed"})
        self.assertEqual(seen, [({"ref": body["ref"]}, "app", 0)])  # 0: nothing was sent yet

    def test_actions_and_commands(self):
        status, body = self.a.call("POST", "/v1/actions", {"action": "quick:brief"})
        self.assertEqual((status, body["toast"]), (200, "On it"))
        self.assertTrue(self.a.agent.sent[-1][0].startswith("[Quick action /brief from Arpit"))
        self.assertEqual(self.a.call("POST", "/v1/actions", {"action": "nope:x"})[0], 404)
        self.assertEqual(self.a.call("POST", "/v1/permissions/ab12", {"allow": True}), (200, {"id": "ab12", "decision": "allow"}))
        self.assertEqual(self.a.call("POST", "/v1/permissions/cd34", {"allow": False})[0], 404)
        self.assertEqual(self.a.call("POST", "/v1/permissions/ab12", {"allow": "yes"})[0], 400)
        status, body = self.a.call("POST", "/v1/commands/menu", {})
        self.assertEqual(body["replies"][0]["buttons"][0][0], {"label": "☀️ Brief", "action": "quick:brief"})
        status, body = self.a.call("POST", "/v1/commands/queue", {"args": "after this"})
        self.assertEqual(self.a.agent.sent[-1][1:], ("app", body["ref"], True))
        names = [c["name"] for c in self.a.call("GET", "/v1/commands")[1]["commands"]]
        self.assertEqual(names[:3], ["menu", "brief", "mail"])
        self.assertEqual(self.a.call("POST", "/v1/commands/nope", {})[0], 404)

    def test_limits_and_errors(self):
        self.assertEqual(self.a.call("GET", "/v1/nope")[0], 404)
        self.assertEqual(self.a.call("DELETE", "/v1/status")[0], 405)
        self.assertEqual(self.a.call("POST", "/v1/messages", raw=b"x" * (17 * 1024))[0], 413)

    def test_audit_log(self):
        self.a.call("POST", "/v1/messages", {"text": "hello there"})
        self.a.call("GET", "/v1/status", token="wrong")
        deadline = time.monotonic() + 5  # each line is written just after its answer is sent
        while len(pathlib.Path(self.a.audit).read_text().splitlines()) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        lines = [json.loads(line) for line in pathlib.Path(self.a.audit).read_text().splitlines()]
        self.assertEqual([(e["method"], e["path"], e["status"], e["summary"]) for e in lines],
                         [("POST", "/v1/messages", 200, "hello there"), ("GET", "/v1/status", 401, "")])
        self.assertNotIn(TOKEN, pathlib.Path(self.a.audit).read_text())
        self.assertEqual(os.stat(self.a.audit).st_mode & 0o777, 0o600)


class StreamTest(unittest.TestCase):
    def setUp(self):
        self.a = Api(self)

    def test_handshake_events_ping_close(self):
        s, head, key = self.a.stream()
        self.addCleanup(s.close)
        self.assertTrue(head.startswith("HTTP/1.1 101"), head)
        self.assertIn(f"Sec-WebSocket-Accept: {ws.accept_key(key)}", head)
        deadline = time.monotonic() + 5
        while not self.a.api._clients and time.monotonic() < deadline:
            time.sleep(0.01)
        self.a.bus.publish(Event("turn.done", {"ref": "r1", "text": "ok"}, origin="telegram", session_id="s1"))
        op, payload = read_frame(s)
        event = json.loads(payload)
        self.assertEqual((op, event["type"], event["origin"], event["session_id"], event["data"]),
                         (ws.OP_TEXT, "turn.done", "telegram", "s1", {"ref": "r1", "text": "ok"}))
        s.sendall(ws.client_frame(ws.OP_PING, b"hi"))
        self.assertEqual(read_frame(s), (ws.OP_PONG, b"hi"))
        s.sendall(ws.client_frame(ws.OP_CLOSE, struct.pack("!H", 1000)))
        self.assertEqual(read_frame(s)[0], ws.OP_CLOSE)

    def test_unauthorized_and_bad_handshake(self):
        s, head, _ = self.a.stream(token=None)
        s.close()
        self.assertTrue(head.startswith("HTTP/1.1 401"), head)
        s, head, _ = self.a.stream(key="bad")
        s.close()
        self.assertTrue(head.startswith("HTTP/1.1 400"), head)

    def test_slow_client_is_dropped_and_clients_are_capped(self):
        with mock.patch.object(app_api, "CLIENT_BACKLOG", 3):
            s, head, _ = self.a.stream()
            self.addCleanup(s.close)
            deadline = time.monotonic() + 5
            while not self.a.api._clients and time.monotonic() < deadline:
                time.sleep(0.01)
            client = next(iter(self.a.api._clients))
            frame = ws.encode(ws.OP_TEXT, b'{"type": "tick"}')
            with client.lock:  # fill its backlog without waking its thread (no pipe write)…
                client.frames = [frame] * app_api.CLIENT_BACKLOG
            self.a.bus.publish(Event("tick", {}))  # …so this one overflows it, deterministically
            frames = []
            while True:
                op, payload = read_frame(s)
                frames.append(op)
                if op == ws.OP_CLOSE:
                    break
            self.assertEqual(struct.unpack("!H", payload[:2])[0], ws.CLOSE_POLICY)
        socks = [self.a.stream()[0] for _ in range(app_api.MAX_CLIENTS)]
        extra = self.a.stream()[0]
        self.assertEqual(read_frame(extra)[0], ws.OP_CLOSE)
        for sock in socks + [extra]:
            sock.close()


if __name__ == "__main__":
    unittest.main()
