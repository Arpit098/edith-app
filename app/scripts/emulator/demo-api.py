#!/usr/bin/env python3
"""A demo App API for the CI screens job (.github/workflows/screens.yml): a believable session to
screenshot and record, so the theme is judged on real content. Standard library only.

HTTP: status (a task running), the current conversation's history, sessions, commands, approvals
(none), app/latest. WebSocket /v1/stream: answers the app's pings and sends the running turn's
events, so the working indicator shows. Auth: Bearer ci-token. The emulator reaches it at
10.0.2.2:<port>.

Usage: demo-api.py <port>
"""
import base64
import hashlib
import json
import socket
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
TOKEN = "Bearer ci-token"
SID = "8268e354-demo"
NOW = time.time()


def ev(kind, age, data, origin="system"):
    """An event `age` seconds ago, with a cursor in transcript order."""
    ev.n += 1
    return {"type": kind, "ts": NOW - age, "session_id": SID, "origin": origin, "data": {**data, "cursor": f"{SID}:{ev.n * 100}"}}


ev.n = 0

HISTORY = [
    ev("message.user", 900, {"text": "How much disk is left on edith? Clean up anything safe.", "voice": False, "ref": "app:1", "delivery": "main", "attachments": []}, "app"),
    ev("tool.call", 895, {"id": "t1", "name": "Bash", "summary": "df -h / /home"}),
    ev("tool.result", 893, {"id": "t1", "name": "Bash", "ok": True, "summary": "/dev/sda1  97G  81G  16G  84% /"}),
    ev("tool.call", 890, {"id": "t2", "name": "Bash", "summary": "du -sh ~/.cache/* | sort -h | tail -5"}),
    ev("tool.result", 885, {"id": "t2", "name": "Bash", "ok": True, "summary": "6.1G  /home/ubuntu/.cache/pip"}),
    ev("message.assistant", 880, {"text": "The root disk is at 84% (16 GB free). The biggest safe win is the pip cache: 6.1 GB. Old journald logs add another 1.2 GB. Shall I clear both?"}),
    ev("message.user", 860, {"text": "Yes, go ahead", "voice": True, "ref": "app:2", "delivery": "main", "attachments": []}, "app"),
    ev("tool.call", 855, {"id": "t3", "name": "Bash", "summary": "pip cache purge && sudo journalctl --vacuum-time=14d"}),
    ev("tool.result", 840, {"id": "t3", "name": "Bash", "ok": True, "summary": "Files removed: 4113 · Vacuuming done, freed 1.2G"}),
    ev("message.assistant", 835, {"text": "Done. The root disk is now at 76%, with 23 GB free."}),
    ev("message.user", 320, {"text": "Add a reminder to check it again next Monday", "voice": False, "ref": "app:3", "delivery": "main", "attachments": []}, "telegram"),
    ev("file.diff", 300, {"id": "d1", "path": "~/edith/reminders.json", "diff": "@@ -3,3 +3,8 @@\n   }\n+  {\n+    \"when\": \"2026-11-02T09:00:00+05:30\",\n+    \"text\": \"Check the disk on edith\"\n+  }\n ]"}),
    ev("message.assistant", 290, {"text": "Reminder set for Monday 2 November at 9:00."}),
    ev("message.user", 40, {"text": "Now run the server tests and tell me if anything fails", "voice": False, "ref": "app:4", "delivery": "main", "attachments": []}, "app"),
    ev("message.delivered", 39, {"ref": "app:4", "delivery": "main", "rid": "r4"}),
    ev("message.reaction", 38, {"ref": "app:4", "emoji": "👀"}),
    ev("turn.started", 38, {"ref": "app:4", "lane": "main"}),
    ev("tool.call", 30, {"id": "t4", "name": "Bash", "summary": "cd server && make test"}),
]

CURSOR = HISTORY[-1]["data"]["cursor"]
ROUTES = {
    "/v1/status": {
        "main": "busy",
        "queued": 0,
        "runs": [{"ref": "app:4", "lane": "main", "seconds": 40, "step": "$ make test"}],
        "tmux": "running",
        "conversation": True,
        "session": {"id": SID, "title": "Disk space and tests"},
    },
    "/v1/sessions/current/history?limit=100": {"session_id": SID, "events": HISTORY, "start": f"{SID}:0", "cursor": CURSOR, "more": False, "reset": False},
    "/v1/sessions": {
        "sessions": [
            {"session_id": SID, "title": "Disk space and tests", "updated": NOW - 30, "current": True},
            {"session_id": "s-2", "title": "Morning briefing", "updated": NOW - 3 * 3600, "current": False},
            {"session_id": "s-3", "title": "Fix the Telegram bridge restart", "updated": NOW - 26 * 3600, "current": False},
            {"session_id": "s-4", "title": "Plan the wake word training", "updated": NOW - 3 * 86400, "current": False},
        ]
    },
    "/v1/permissions": {"pending": []},
    "/v1/commands": {
        "commands": [
            {"name": "today", "description": "Today's agenda and reminders", "usage": "", "help": ""},
            {"name": "disk", "description": "Disk space on edith", "usage": "", "help": ""},
            {"name": "queue", "description": "Queue a message for after the current task", "usage": "<text>", "help": ""},
            {"name": "compact", "description": "Compact the conversation", "usage": "", "help": ""},
        ]
    },
}

# The running turn, live: progress every few seconds while a client listens.
LIVE = [
    {"type": "turn.progress", "data": {"ref": "app:4", "lane": "main", "steps": 3, "step": "$ make test", "elapsed": 41}},
]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.headers.get("Authorization") != TOKEN:
            return self.answer(401, {"error": "bad token"})
        if self.path == "/v1/stream" and self.headers.get("Upgrade", "").lower() == "websocket":
            return self.stream()
        if self.path == "/v1/app/latest":
            return self.answer(404, {"error": "no release"})
        body = ROUTES.get(self.path)
        return self.answer(200, body) if body is not None else self.answer(404, {"error": f"not in the demo: {self.path}"})

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.answer(404, {"error": "the demo is read-only"})

    def answer(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # --- a minimal WebSocket (RFC 6455): text frames, server frames unmasked, client frames masked ---
    def stream(self):
        accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        sock = self.connection
        sock.settimeout(None)
        lock = threading.Lock()

        def send(obj):
            data = json.dumps(obj).encode()
            head = bytes([0x81]) + (bytes([len(data)]) if len(data) < 126 else bytes([126]) + struct.pack(">H", len(data)))
            with lock:
                sock.sendall(head + data)

        stop = threading.Event()

        def live():
            n = 0
            while not stop.wait(4.0):  # a demo heartbeat of progress, ended with the socket
                n += 1
                for e in LIVE:
                    d = {**e["data"], "elapsed": e["data"]["elapsed"] + 4 * n}
                    send({"type": e["type"], "ts": time.time(), "session_id": SID, "origin": "app", "data": d})

        threading.Thread(target=live, daemon=True).start()
        try:
            while True:
                b0, b1 = recv(sock, 2)
                op, length = b0 & 0x0F, b1 & 0x7F
                if length == 126:
                    (length,) = struct.unpack(">H", recv(sock, 2))
                elif length == 127:
                    (length,) = struct.unpack(">Q", recv(sock, 8))
                mask = recv(sock, 4) if b1 & 0x80 else b"\0\0\0\0"
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(recv(sock, length)))
                if op == 0x8:
                    break
                if op == 0x9:  # protocol ping
                    with lock:
                        sock.sendall(bytes([0x8A, len(payload)]) + payload)
                elif op == 0x1 and json.loads(payload or b"{}").get("type") == "ping":
                    send({"type": "pong"})
        except (ConnectionError, OSError, ValueError):
            pass
        finally:
            stop.set()
            self.close_connection = True


def recv(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
