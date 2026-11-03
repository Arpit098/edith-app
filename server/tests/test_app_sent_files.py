"""Files EDITH sends to the app (contracts/attachments.md §4): SEND_FILE paths registered under opaque
ids, offered as `sent_files` on the stream and in history, downloaded from GET /v1/files/{id}. Only
registered ids are served; secret places and names, non-regular and oversized files are refused."""
import http.client
import json
import os
import pathlib
import shutil
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

from edith.adapters.frontends.app_api.sent_files import KEEP_SECONDS, SentFiles, mime_of, secret_name
from edith.core import Event
from tests.test_app_api import TOKEN, Api, read_frame


class Home:
    """A temp home with a work folder, secret folders and a few files."""

    def __init__(self, test):
        self.root = pathlib.Path(tempfile.mkdtemp())
        test.addCleanup(shutil.rmtree, self.root)
        self.home, self.work = self.root / "home", self.root / "home/edith"
        for d in ("edith/out", ".config/edith", ".claude", ".ssh", ".cache/edith"):
            (self.home / d).mkdir(parents=True)
        self.index = self.home / ".cache/edith/app-sent-files.json"

    def file(self, rel, data=b"hello"):
        p = self.home / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def files(self, **kw):
        kw.setdefault("roots", [str(self.work), "~/Projects"])
        return SentFiles(str(self.index), str(self.home), str(self.work), **kw)


class RegisterTest(unittest.TestCase):
    def setUp(self):
        self.h = Home(self)
        self.s = self.h.files(max_bytes=1000)

    def test_registers_once_per_file_and_survives_a_restart(self):
        p = self.h.file("edith/out/Report final.pdf", b"%PDF-1.7 data")
        first = self.s.register(str(p))
        self.assertRegex(first["id"], r"^[0-9a-f]{32}$")
        self.assertEqual({k: first[k] for k in ("name", "size", "mime")},
                         {"name": "Report final.pdf", "size": 13, "mime": "application/pdf"})
        self.assertEqual(self.s.register(str(p)), first)                    # the same file keeps its id
        self.assertEqual(self.s.register("out/Report final.pdf"), first)    # relative: from the work folder
        self.assertEqual(self.s.register("~/edith/out/Report final.pdf"), first)
        self.assertEqual(oct(self.h.index.stat().st_mode & 0o777), "0o600")
        again = self.h.files(max_bytes=1000)
        self.assertEqual(again.register(str(p)), first)                     # persisted
        f, r = again.open(first["id"])
        with f:
            self.assertEqual(f.read(), b"%PDF-1.7 data")
        self.assertNotIn(str(p), json.dumps(first))                         # the app never gets the path

    def test_a_changed_file_is_a_new_id_and_the_old_one_stops_serving(self):
        p = self.h.file("edith/out/a.txt", b"one")
        old = self.s.register(str(p))
        os.utime(p, ns=(1, 1))  # same size, other mtime
        self.assertIsNone(self.s.open(old["id"]))
        new = self.s.register(str(p))
        self.assertNotEqual(new["id"], old["id"])
        tmp = self.h.file("edith/out/b.txt", b"two")
        os.replace(tmp, p)  # replaced by another file (another inode)
        self.assertIsNone(self.s.open(new["id"]))
        p.unlink()
        self.assertIsNone(self.s.open(new["id"]))

    def test_expires_after_seven_days(self):
        p = self.h.file("edith/out/a.txt")
        rec = self.s.register(str(p), now=time.time() - KEEP_SECONDS - 5)
        self.assertIsNone(self.s.open(rec["id"]))
        fresh = self.s.register(str(p))
        self.assertNotEqual(fresh["id"], rec["id"])
        self.assertNotIn(rec["id"], json.loads(self.h.index.read_text()))  # pruned

    def test_refusals(self):
        self.h.file(".config/edith/app-token", b"secret")
        self.h.file(".claude/settings.json", b"{}")
        self.h.file(".ssh/id_ed25519", b"key")
        link = self.h.home / "edith/out/innocent.txt"
        link.symlink_to(self.h.home / ".claude/settings.json")
        dirlink = self.h.home / "edith/cfg"
        dirlink.symlink_to(self.h.home / ".config")
        os.mkfifo(self.h.home / "edith/out/pipe")
        cases = {
            str(self.h.home / ".config/edith/app-token"): "in a private folder",
            "~/.claude/settings.json": "in a private folder",
            str(self.h.home / ".ssh/id_ed25519"): "in a private folder",
            str(link): "in a private folder",                       # a symlink into one
            "cfg/edith/app-token": "in a private folder",            # through a linked folder
            str(self.h.file("edith/out/.env")): "a key, token or credential file",
            str(self.h.file("edith/out/cracker-dev-key.json")): "a key, token or credential file",
            str(self.h.file("edith/out/server.pem")): "a key, token or credential file",
            str(self.h.file("edith/out/big.bin", b"x" * 1001)): "over 0 MB",
            str(self.h.home / "edith/out"): "not a regular file",
            str(self.h.home / "edith/out/pipe"): "not a regular file",
            str(self.h.home / "edith/out/missing.pdf"): "not found",
            "/proc/self/environ": "in a system folder",
            str(self.h.file("edith/.claude/settings.json")): "in a private folder",   # wherever it is
            str(self.h.file("Projects/app/.git/config")): "in a private folder",
            str(self.h.file(".cache/edith/accounts/a1/creds.json")): "in a private folder",
            str(self.h.file(".cache/edith/authorized_keys.bak-1")): "a key, token or credential file",
            # Outside the allowed roots (~/edith and ~/Projects here).
            str(self.h.file(".claude.json")): "outside the folders EDITH may send from",
            str(self.h.file(".bash_history")): "outside the folders EDITH may send from",
            str(self.h.file("edith-backups/bridge.tar")): "outside the folders EDITH may send from",
            str(self.h.file(".local/share/pki/x.db")): "outside the folders EDITH may send from",
            str(self.h.file(".cache/edith/bridge-state.json")): "outside the folders EDITH may send from",
            # A dot-folder inside a root.
            str(self.h.file("edith/.venv/lib/x.py")): "in a hidden folder",
            str(self.h.file("Projects/app/.github/ci.yml")): "in a hidden folder",
            "Projects/app/.env.local": "a key, token or credential file",
            "/dev/null": "in a system folder",
            "": "not a path",
        }
        with self.assertLogs("edith.adapter.app_api.files", "WARNING") as logs:
            for path, why in cases.items():
                with self.subTest(path):
                    out = self.s.register(path)
                    self.assertNotIn("id", out)
                    self.assertEqual(out["error"], why)
        self.assertNotIn("secret", "\n".join(logs.output))  # never the file's contents
        self.assertFalse(self.h.index.exists())               # nothing was registered

    def test_hard_links_are_refused_at_register_and_at_serve(self):
        secret = self.h.file(".claude/settings.json", b"secret")
        linked = self.h.home / "edith/out/settings.txt"
        os.link(secret, linked)
        with self.assertLogs("edith.adapter.app_api.files", "WARNING"):
            self.assertEqual(self.s.register(str(linked)), {"name": "settings.txt", "error": "has other hard links"})
        p = self.h.file("edith/out/plain.txt")
        rec = self.s.register(str(p))
        os.link(p, self.h.home / "edith/out/plain-2.txt")
        self.assertIsNone(self.s.open(rec["id"]))

    def test_lookup_only_never_registers_and_refusals_log_once(self):
        p = self.h.file("edith/out/a.txt")
        self.assertEqual(self.s.register(str(p), create=False), {"name": "a.txt", "error": "no longer available"})
        self.assertFalse(self.h.index.exists())
        rec = self.s.register(str(p))
        self.assertEqual(self.s.register(str(p), create=False), rec)
        old = self.s.register(str(self.h.file("edith/out/b.txt")), now=time.time() - KEEP_SECONDS - 5)
        self.assertEqual(self.s.register(str(self.h.home / "edith/out/b.txt"), create=False)["error"], "no longer available")
        self.assertIsNone(self.s.open(old["id"]))  # not renewed
        with self.assertLogs("edith.adapter.app_api.files", "WARNING") as logs:
            for _ in range(3):
                self.s.register("~/.ssh/id_rsa")
                self.s.register("~/.ssh/id_rsa", create=False)
            self.s.register("/proc/self/environ")
        self.assertEqual(len(logs.output), 2)

    def test_default_roots(self):
        s = SentFiles(str(self.h.index), str(self.h.home), str(self.h.work))
        self.assertEqual(s.roots, [os.path.realpath(p) for p in (self.h.work, self.h.home / "Projects", "/tmp")])
        (self.h.home / "Downloads").mkdir()
        self.assertEqual(SentFiles(str(self.h.index), str(self.h.home), str(self.h.work)).roots[-1],
                         os.path.realpath(self.h.home / "Downloads"))

    def test_secret_names(self):
        for name in (".env", ".env.local", "app-token", "api_key.txt", "credentials.json", "id_rsa.pub",
                     "client_secret_1.apps.json", "keystore.jks", "secrets.yaml"):
            self.assertTrue(secret_name(name), name)
        for name in ("report.pdf", "token-analysis.pdf", "keyboard.md", "monkey.png", "notes.txt"):
            self.assertFalse(secret_name(name), name)

    def test_open_takes_only_ids(self):
        for bad in ("../../etc/passwd", "/etc/passwd", "0" * 32, "ABC", None):
            self.assertIsNone(self.s.open(bad))

    def test_mime(self):
        self.assertEqual([mime_of(n) for n in ("a.md", "a.png", "a.docx", "a.unknownext", "noext")],
                         ["text/markdown", "image/png",
                          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                          "application/octet-stream", "application/octet-stream"])


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.a = Api(self)
        self.h = Home(self)
        self.a.api.sent_files = self.h.files()
        self.pdf = self.h.file("edith/out/Plan v2.pdf", b"%PDF-1.7\n" + b"x" * 200_000)

    def get(self, path, token=TOKEN):
        req = urllib.request.Request(f"http://{self.a.host}:{self.a.port}{path}")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
        except urllib.error.HTTPError as e:
            return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()

    def test_download(self):
        rec = self.a.api.sent_files.register(str(self.pdf))
        status, headers, body = self.get(f"/v1/files/{rec['id']}")
        self.assertEqual((status, body), (200, self.pdf.read_bytes()))
        self.assertEqual((headers["content-type"], headers["content-length"], headers["x-content-type-options"]),
                         ("application/pdf", str(len(body)), "nosniff"))
        self.assertEqual(headers["content-disposition"], "attachment; filename*=UTF-8''Plan%20v2.pdf")
        self.assertEqual(self.get(f"/v1/files/{rec['id']}", token=None)[0], 401)
        self.assertEqual(self.get(f"/v1/files/{'0' * 32}")[0], 404)
        self.assertEqual(self.get("/v1/files/..%2F..%2Fetc%2Fpasswd")[0], 404)
        self.assertEqual(self.get("/v1/files/%2Fetc%2Fpasswd")[0], 404)
        self.assertTrue(self.a.wait(lambda: '"file": {"id"' in self.a.audit_text()))
        self.assertNotIn(str(self.pdf), self.a.audit_text())

    def test_stream_events_carry_sent_files(self):
        s, head, _ = self.a.stream()
        self.addCleanup(s.close)
        self.assertTrue(self.a.wait(lambda: self.a.api._clients))
        data = {"text": "Here it is", "files": [str(self.pdf), str(self.h.home / ".ssh/id_rsa")], "lane": "main"}
        with self.assertLogs("edith.adapter.app_api.files", "WARNING"):
            self.a.bus.publish(Event("message.assistant", data, origin="system", session_id="s1"))
            event = json.loads(read_frame(s)[1])
        ok, refused = event["data"]["sent_files"]
        self.assertEqual(event["data"]["files"], data["files"])  # the paths stay, for older apps
        self.assertEqual((ok["name"], ok["size"], ok["mime"]), ("Plan v2.pdf", self.pdf.stat().st_size, "application/pdf"))
        self.assertEqual(refused, {"name": "id_rsa", "error": "in a private folder"})
        self.assertNotIn("sent_files", data)  # the bus event itself is untouched (Telegram uses the paths)
        self.a.bus.publish(Event("turn.done", {"ref": "r1", "text": "ok", "files": []}, origin="system"))
        self.assertNotIn("sent_files", json.loads(read_frame(s)[1])["data"])
        status, _, body = self.get(f"/v1/files/{ok['id']}")
        self.assertEqual((status, body), (200, self.pdf.read_bytes()))

    def test_history_carries_sent_files(self):
        page = {"session_id": "s1", "start": "s1:0", "cursor": "s1:9", "more": False, "reset": False, "events": [
            {"type": "message.assistant", "ts": 100.0, "session_id": "s1", "origin": "system",
             "data": {"text": "", "files": [str(self.pdf)], "lane": "main", "cursor": "s1:9"}}]}
        self.a.agent.history = lambda sid, after, before, limit: page
        # Never sent live: history doesn't register it.
        (sent,) = self.a.call("GET", "/v1/sessions/current/history")[1]["events"][0]["data"]["sent_files"]
        self.assertEqual(sent, {"name": "Plan v2.pdf", "error": "no longer available"})
        # Sent live (no app connected): history finds its id.
        self.a.bus.publish(Event("turn.done", {"ref": "r", "text": "x", "files": [str(self.pdf)]}, origin="system"))
        status, body = self.a.call("GET", "/v1/sessions/current/history")
        self.assertEqual(status, 200)
        (sent,) = body["events"][0]["data"]["sent_files"]
        self.assertEqual(sent, self.a.api.sent_files.register(str(self.pdf), create=False))
        self.assertIn("id", sent)

    def test_a_short_sendfile_ends_the_connection(self):
        rec = self.a.api.sent_files.register(str(self.pdf))
        with mock.patch("socket.socket.sendfile", return_value=0):
            req = urllib.request.Request(f"http://{self.a.host}:{self.a.port}/v1/files/{rec['id']}",
                                         headers={"Authorization": f"Bearer {TOKEN}"})
            with urllib.request.urlopen(req, timeout=10) as r:
                with self.assertRaises(http.client.IncompleteRead):
                    r.read()


if __name__ == "__main__":
    unittest.main()
