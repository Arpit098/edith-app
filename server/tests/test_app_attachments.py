"""App attachments (contracts/attachments.md): uploads saved in the inbox like Telegram's, typed by
their content, then named in the message prompt. Runs the real App API in a temp HOME."""
import hashlib
import http.client
import json
import os
import pathlib
import shutil
import stat
import struct
import tempfile
import threading
import unittest
from unittest import mock

from edith.adapters.frontends.app_api import AppApi, attachments
from edith.core import EventBus, Registry
from edith.ports.agent import TurnHandle

TOKEN = "a" * 40
HEADERS = {
    "image/jpeg": b"\xff\xd8\xff\xe0\x00\x10JFIF\x00",
    "image/png": b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR",
    "image/webp": b"RIFF\x24\x00\x00\x00WEBPVP8 ",
    "image/heic": b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00",
    "audio/ogg": b"OggS\x00\x02\x00\x00\x00\x00\x00\x00",
    "audio/mpeg": b"ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00",
    "audio/mp4": b"\x00\x00\x00\x20ftypM4A \x00\x00\x02\x00",
    "audio/wav": b"RIFF\x24\x00\x00\x00WAVEfmt ",
    "audio/aac": b"\xff\xf1\x50\x80\x02\x1f\xfc\x00\x00\x00\x00\x00",
}


class Agent:
    def __init__(self):
        self.sent = []

    def send(self, text, origin, ref, force_queue=False):
        self.sent.append(text)
        return TurnHandle(ref, "main")


class Server:
    def __init__(self, test):
        self.home = pathlib.Path(tempfile.mkdtemp())
        test.addCleanup(shutil.rmtree, self.home)
        token = self.home / "token"
        token.write_text(TOKEN)
        token.chmod(0o600)
        self.inbox = self.home / "edith" / "inbox"
        self.audit = self.home / "audit.jsonl"
        self.agent = Agent()
        self.api = AppApi({"bind": "tailscale", "port": 0, "token_file": str(token), "audit_log": str(self.audit),
                           "work_dir": str(self.home / "edith"), "state_dir": str(self.home / "state")},
                          resolve_ip=lambda: "127.0.0.1", allow_loopback=True)
        self.api.start(EventBus(), Registry(), self.agent)
        test.addCleanup(self.api.stop)
        assert self.api.listening.wait(5)

    def call(self, method, path, body=None, headers=None, token=TOKEN):
        c = http.client.HTTPConnection(*self.api.address, timeout=10)
        try:
            h = {"Authorization": f"Bearer {token}"} if token else {}
            if isinstance(body, dict):
                body, h["Content-Type"] = json.dumps(body).encode(), "application/json"
            c.request(method, path, body=body, headers={**h, **(headers or {})})
            r = c.getresponse()
            return r.status, json.loads(r.read() or b"{}")
        finally:
            c.close()

    def upload(self, data, **headers):
        return self.call("POST", "/v1/attachments", data, {"Content-Type": "application/octet-stream", **headers})


class UploadTest(unittest.TestCase):
    def setUp(self):
        self.s = Server(self)

    def test_every_allowed_type_is_detected_from_its_bytes(self):
        for kind, head in HEADERS.items():
            with self.subTest(kind):
                data = head + os.urandom(500)
                status, body = self.s.upload(data, **{"Content-Type": "text/plain", "x-filename": "x.exe"})
                self.assertEqual(status, 200, body)
                self.assertEqual((body["type"], body["size"], body["sha256"]), (kind, len(data), hashlib.sha256(data).hexdigest()))
                self.assertTrue(body["name"].endswith(attachments.EXT[kind]))  # the extension comes from the content
                saved = self.s.inbox / body["name"]
                self.assertEqual((saved.read_bytes(), stat.S_IMODE(saved.stat().st_mode)), (data, 0o600))
        self.assertEqual([n for n in os.listdir(self.s.inbox) if n.startswith(".")], [])  # no temp files left

    def test_saved_name_is_safe_and_never_overwrites(self):
        data = HEADERS["image/jpeg"] + b"x" * 10
        with mock.patch("time.time", return_value=1793600123):
            first = self.s.upload(data, **{"x-filename": "..%2F..%2Fetc%2FIMG%20%C3%A9t%C3%A9.HEIC"})[1]
            second = self.s.upload(data, **{"x-filename": "..%2F..%2Fetc%2FIMG%20%C3%A9t%C3%A9.HEIC"})[1]
            unnamed = self.s.upload(HEADERS["audio/ogg"] + b"x")[1]
        self.assertEqual(first["name"], "1793600123_IMG__t.jpg")  # no path parts; unsafe characters become _
        self.assertEqual(second["name"], "1793600123_IMG__t-2.jpg")
        self.assertEqual(unnamed["name"], "1793600123_audio.ogg")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(sorted(os.listdir(self.s.inbox)), sorted([first["name"], second["name"], unnamed["name"]]))

    def test_refused_uploads_keep_nothing(self):
        cases = [
            (b"%PDF-1.7\n" + b"x" * 100, {}, 415, "unsupported file type"),
            (b"\x00\x00\x00\x18ftypqt  " + b"x" * 100, {}, 415, "unsupported file type"),  # a QuickTime video
            (b"", {}, 400, "the file is empty"),
            (HEADERS["image/png"] + b"x", {"x-content-sha256": "0" * 64}, 400, "sha256 mismatch"),
        ]
        for data, headers, status, message in cases:
            with self.subTest(message):
                self.assertEqual(self.s.upload(data, **headers), (status, {"error": message}))
        with mock.patch.object(attachments, "MAX_IMAGE_BYTES", 100):
            self.assertEqual(self.s.upload(HEADERS["image/png"] + b"x" * 200)[0], 413)
        self.assertEqual(os.listdir(self.s.inbox), [])

    def test_too_big_is_refused_before_the_body_is_read(self):
        c = http.client.HTTPConnection(*self.s.api.address, timeout=10)
        self.addCleanup(c.close)
        c.putrequest("POST", "/v1/attachments")
        c.putheader("Authorization", f"Bearer {TOKEN}")
        c.putheader("Content-Length", str(attachments.MAX_BYTES + 1))
        c.endheaders()
        self.assertEqual(c.getresponse().status, 413)

    def test_unknown_type_stops_reading_early(self):
        reads = []
        real = attachments.Attachments.add

        def spy(self, body, *a, **k):
            read = body.read
            body.read = lambda n=65536: reads.append(n) or read(n)
            return real(self, body, *a, **k)
        with mock.patch.object(attachments.Attachments, "add", spy):
            c = http.client.HTTPConnection(*self.s.api.address, timeout=10)
            self.addCleanup(c.close)
            c.putrequest("POST", "/v1/attachments")
            c.putheader("Authorization", f"Bearer {TOKEN}")
            c.putheader("Content-Length", "5000000")
            c.endheaders(b"%PDF" + b"x" * 65532)  # only the first 64 kB of a 5 MB body is ever sent
            self.assertEqual(c.getresponse().status, 415)
        self.assertEqual(len(reads), 1)  # refused after the first chunk: the server never waits for the rest

    def test_needs_the_token(self):
        self.assertEqual(self.s.upload(HEADERS["image/png"], **{"Authorization": "Bearer -"})[0], 401)
        self.assertFalse(self.s.inbox.exists())

    def test_audited(self):
        body = self.s.upload(HEADERS["audio/wav"] + b"x")[1]
        with self.s.api.changed:
            # the file can exist before its line is written: wait for the line itself
            self.s.api.changed.wait_for(lambda: self.s.audit.exists() and '"attachment"' in self.s.audit.read_text(), 5)
        line = json.loads(self.s.audit.read_text().splitlines()[-1])
        self.assertEqual(line["attachment"], {k: body[k] for k in ("id", "type", "size", "sha256")})


class MessageTest(unittest.TestCase):
    def setUp(self):
        self.s = Server(self)

    def test_prompt_has_telegrams_attachment_lines(self):
        photo = self.s.upload(HEADERS["image/heic"] + b"x", **{"x-filename": "IMG_2041.HEIC"})[1]
        voice = self.s.upload(HEADERS["audio/mp4"] + b"x", **{"x-filename": "note.m4a"})[1]
        with mock.patch("time.strftime", return_value="2026-11-02 10:43 IST"):
            status, body = self.s.call("POST", "/v1/messages", {"text": "what is this plant?",
                                                                "attachments": [photo["id"], voice["id"]]})
        self.assertEqual(status, 200)
        self.assertEqual(self.s.agent.sent[-1],
                         "[App message from Arpit, 2026-11-02 10:43 IST]\nwhat is this plant?"
                         f"\n[Attached file saved at: {self.s.inbox / photo['name']}]"
                         f"\n[Attached file saved at: {self.s.inbox / voice['name']}]")

    def test_attachments_without_text_and_errors(self):
        photo = self.s.upload(HEADERS["image/png"] + b"x")[1]
        self.assertEqual(self.s.call("POST", "/v1/messages", {"attachments": [photo["id"]]})[0], 200)
        self.assertEqual(self.s.call("POST", "/v1/messages", {"text": "x", "attachments": ["nope"]}),
                         (400, {"error": "unknown attachment nope"}))
        self.assertEqual(self.s.call("POST", "/v1/messages", {"text": "x", "attachments": ["a"] * 11})[0], 400)
        self.assertEqual(self.s.call("POST", "/v1/messages", {"text": ""})[0], 400)
        os.remove(self.s.inbox / photo["name"])  # deleted from the inbox: no longer attachable
        self.assertEqual(self.s.call("POST", "/v1/messages", {"attachments": [photo["id"]]})[0], 400)
        self.assertEqual(len(self.s.agent.sent), 1)

    def test_ids_survive_a_restart_and_expire(self):
        photo = self.s.upload(HEADERS["image/png"] + b"x")[1]
        again = attachments.Attachments(str(self.s.inbox), str(self.s.home / "state" / "app-attachments.json"))
        self.assertEqual(again.paths([photo["id"]]), [str(self.s.inbox / photo["name"])])
        with self.assertRaises(attachments.AttachmentError):
            again.paths([photo["id"]], now=photo_time(self.s) + attachments.KEEP_SECONDS + 1)


def photo_time(server):
    index = json.loads((server.home / "state" / "app-attachments.json").read_text())
    return next(iter(index.values()))["at"]


class SniffTest(unittest.TestCase):
    def test_mpeg_and_adts_frames(self):
        self.assertEqual(attachments.sniff(b"\xff\xfb\x90\x00" + bytes(8)), "audio/mpeg")  # MPEG-1 layer III
        self.assertEqual(attachments.sniff(b"\xff\xf9\x50\x80" + bytes(8)), "audio/aac")   # MPEG-2 ADTS
        self.assertIsNone(attachments.sniff(b"\xff\xf3"[:1] + bytes(11)))
        self.assertIsNone(attachments.sniff(b"GIF89a" + bytes(6)))

    def test_parallel_uploads_get_distinct_names(self):
        s = Server(self)
        data = HEADERS["image/jpeg"] + b"x"
        with mock.patch("time.time", return_value=1793600123):
            threads = [threading.Thread(target=s.upload, args=(data,), kwargs={"x-filename": "same.jpg"}) for _ in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(10)
        self.assertEqual(len(os.listdir(s.inbox)), 6)
        self.assertEqual(len(json.loads((s.home / "state" / "app-attachments.json").read_text())), 6)


if __name__ == "__main__":
    unittest.main()
