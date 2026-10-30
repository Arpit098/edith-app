#!/usr/bin/env python3
"""A stand-in App API for the CI emulator job: answers POST /v1/permissions/{id} (an Allow/Deny
pressed on a notification) and logs each one, so the job can check the button reached the server.

Usage: mock-api.py <port> <log file>. The emulator reaches it at 10.0.2.2:<port>.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, LOG = int(sys.argv[1]), sys.argv[2]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if not self.path.startswith("/v1/permissions/") or self.headers.get("Authorization") != "Bearer ci-token":
            self.answer(404, {"error": "not found"})
            return
        allow = json.loads(body or b"{}").get("allow")
        pid = self.path.rsplit("/", 1)[1]
        with open(LOG, "a") as f:
            f.write(f"permission {pid} allow={str(allow).lower()}\n")
        self.answer(200, {"id": pid, "decision": "allow" if allow else "deny"})

    def answer(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
