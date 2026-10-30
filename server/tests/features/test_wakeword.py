"""Wake word recordings (contracts/wakeword.md) through the real App API: sessions, streamed and
checked uploads, downloads for the trainer, caps and model status. Audio is generated here."""
import hashlib
import http.client
import io
import json
import math
import os
import pathlib
import shutil
import stat
import struct
import tempfile
import threading
import unittest
import wave
from unittest import mock

from edith.adapters.frontends.app_api import AppApi
from edith.core import EventBus, Ports, Registry, load_features
from edith.features.wakeword import store as store_mod

TOKEN = "w" * 40


def wav(seconds=1.0, rate=16000, channels=1, width=2, amplitude=8000):
    """A sine tone WAV (any format, to test what is refused)."""
    frames = int(seconds * rate)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        if width == 2:
            one = b"".join(struct.pack("<h", int(amplitude * math.sin(i / 8))) for i in range(min(frames, 1600)))
            data = (one * (frames // 1600 + 1))[:frames * 2]
            w.writeframes(data * channels if channels == 1 else b"".join(data[i:i + 2] * channels
                                                                         for i in range(0, len(data), 2)))
        else:
            w.writeframes(b"\x80" * frames * channels * width)
    return out.getvalue()


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Server:
    def __init__(self, test, **config):
        self.dir = tempfile.mkdtemp()
        test.addCleanup(shutil.rmtree, self.dir)
        self.models = pathlib.Path(self.dir, "models")
        self.models.mkdir()
        self.registry = Registry()
        report = load_features(["wakeword"], EventBus(), Ports(), self.registry,
                               {"wakeword": {"state_dir": self.dir, "models_dir": str(self.models), **config}})
        assert report.loaded == ["wakeword"], report.failed
        token = pathlib.Path(self.dir, "token")
        token.write_text(TOKEN)
        token.chmod(0o600)
        self.audit = pathlib.Path(self.dir, "audit.jsonl")
        self.api = AppApi({"bind": "tailscale", "port": 0, "token_file": str(token), "audit_log": str(self.audit)},
                          resolve_ip=lambda: "127.0.0.1", allow_loopback=True)
        self.api.start(EventBus(), self.registry, None)
        test.addCleanup(self.api.stop)
        assert self.api.listening.wait(5)
        self.root = pathlib.Path(self.dir, "wakeword", "recordings")

    def call(self, method, path, body=None, headers=None, token=TOKEN):
        c = http.client.HTTPConnection(*self.api.address, timeout=10)
        try:
            h = {"Authorization": f"Bearer {token}"} if token else {}
            if isinstance(body, dict):
                body, h["Content-Type"] = json.dumps(body).encode(), "application/json"
            c.request(method, path, body=body, headers={**h, **(headers or {})})
            r = c.getresponse()
            data = r.read()
            ctype = r.getheader("content-type") or ""
            return r.status, json.loads(data) if "json" in ctype else data, {k.lower(): v for k, v in r.getheaders()}
        finally:
            c.close()

    def session(self, label="Living room"):
        return self.call("POST", "/v1/wakeword/sessions", {"label": label})[1]["id"]

    def upload(self, sid, data, kind="positive_near", headers=None):
        return self.call("POST", f"/v1/wakeword/sessions/{sid}/clips?kind={kind}", data,
                         {"Content-Type": "audio/wav", **(headers or {})})

    def audited(self, n):
        with self.api.changed:
            self.api.changed.wait_for(lambda: self.audit.exists() and len(self.audit.read_text().splitlines()) >= n, 5)
        return [json.loads(line) for line in self.audit.read_text().splitlines()]


class SessionsTest(unittest.TestCase):
    def test_create_list_delete(self):
        s = Server(self)
        status, body, _ = s.call("POST", "/v1/wakeword/sessions", {"label": "x" * 80})
        self.assertEqual(status, 200)
        self.assertRegex(body["id"], r"^\d{8}-\d{4}-[0-9a-f]{4}$")
        self.assertEqual((body["label"], body["clips"], body["kinds"]["noise"]), ("x" * 60, 0, {"count": 0, "seconds": 0.0}))
        second = s.session("Bedroom")
        listing = s.call("GET", "/v1/wakeword/sessions")[1]
        self.assertEqual({x["id"] for x in listing["sessions"]}, {body["id"], second})
        self.assertEqual(listing["usage"], {"bytes": 0, "max_bytes": 500 * 1024 * 1024})
        self.assertEqual(s.call("DELETE", f"/v1/wakeword/sessions/{second}")[1], {"deleted": second})
        self.assertEqual(s.call("DELETE", f"/v1/wakeword/sessions/{second}")[0], 404)
        self.assertEqual(s.call("DELETE", "/v1/wakeword/sessions/..")[0], 404)
        self.assertEqual(sorted(os.listdir(s.root)), [".lock", ".tmp", body["id"]])
        for folder in (s.root, s.root / body["id"], s.root / body["id"] / "clips"):
            self.assertEqual(stat.S_IMODE(os.stat(folder).st_mode), 0o700)
        manifest = s.root / body["id"] / "manifest.json"
        self.assertEqual(stat.S_IMODE(os.stat(manifest).st_mode), 0o600)

    def test_session_cap(self):
        s = Server(self)
        with mock.patch.object(store_mod, "MAX_SESSIONS", 2):
            s.session()
            s.session()
            self.assertEqual(s.call("POST", "/v1/wakeword/sessions", {})[0], 409)

    def test_every_route_needs_the_token(self):
        s = Server(self)
        sid = s.session()
        for method, path in (("POST", "/v1/wakeword/sessions"), ("GET", "/v1/wakeword/sessions"),
                             ("GET", f"/v1/wakeword/sessions/{sid}/manifest"), ("GET", "/v1/wakeword/model"),
                             ("POST", f"/v1/wakeword/sessions/{sid}/clips?kind=noise"),
                             ("DELETE", f"/v1/wakeword/sessions/{sid}")):
            with self.subTest(path):
                self.assertEqual(s.call(method, path, token=None)[0], 401)
        self.assertEqual(len(os.listdir(s.root)), 3)  # .lock, .tmp and the session: nothing deleted


class UploadTest(unittest.TestCase):
    def setUp(self):
        self.s = Server(self)
        self.sid = self.s.session()

    def test_upload_download_and_manifest(self):
        data = wav(1.5)
        status, body, _ = self.s.upload(self.sid, data, headers={"x-clip-sha256": sha(data).upper()})
        self.assertEqual(status, 200)
        clip = body["clip"]
        self.assertEqual((body["created"], clip["sha256"], clip["kind"], clip["seconds"], clip["bytes"]),
                         (True, sha(data), "positive_near", 1.5, len(data)))
        self.assertAlmostEqual(clip["peak_dbfs"], 20 * math.log10(8000 / 32768), delta=0.2)
        self.assertLess(clip["rms_dbfs"], clip["peak_dbfs"])
        path = self.s.root / self.sid / "clips" / f"{sha(data)}.wav"
        self.assertEqual((path.read_bytes(), stat.S_IMODE(os.stat(path).st_mode)), (data, 0o600))
        status, got, headers = self.s.call("GET", f"/v1/wakeword/sessions/{self.sid}/clips/{sha(data)}")
        self.assertEqual((status, got, headers["content-type"], headers["etag"]), (200, data, "audio/wav", f"\"{sha(data)}\""))
        manifest = self.s.call("GET", f"/v1/wakeword/sessions/{self.sid}/manifest")[1]
        self.assertEqual(manifest["format"], {"sample_rate": 16000, "channels": 1, "sample_width": 2})
        self.assertEqual(manifest["clips"], [{**clip, "file": f"clips/{sha(data)}.wav"}])
        session = self.s.call("GET", "/v1/wakeword/sessions")[1]["sessions"][0]
        self.assertEqual((session["clips"], session["kinds"]["positive_near"]), (1, {"count": 1, "seconds": 1.5}))
        lines = self.s.audited(5)
        upload = next(line for line in lines if line["method"] == "POST" and "/clips" in line["path"])
        self.assertEqual(upload["wakeword"], {"session": self.sid, "kind": "positive_near", "sha256": sha(data),
                                              "seconds": 1.5, "created": True})

    def test_same_file_again_is_idempotent(self):
        data = wav(1.0)
        first = self.s.upload(self.sid, data)[1]
        again = self.s.upload(self.sid, data)[1]
        self.assertEqual((again["created"], again["clip"]), (False, first["clip"]))
        self.assertEqual(self.s.upload(self.sid, data, kind="positive_far")[0], 409)
        self.assertEqual(len(os.listdir(self.s.root / self.sid / "clips")), 1)  # no leftover temp files

    def test_bad_clips_are_refused_and_nothing_is_kept(self):
        cases = {
            "44.1 kHz": (wav(1.0, rate=44100), "expected 16000 Hz, got 44100"),
            "stereo": (wav(1.0, channels=2), "expected mono, got 2 channels"),
            "8-bit": (wav(1.0, width=1), "expected 16-bit samples, got 8-bit"),
            "not a wav": (b"RIFF\x00\x00\x00\x00JUNK" + b"x" * 100, "not a valid WAV file"),
            "truncated": (wav(1.0)[:-1000], "frames but its header says 16000"),
            "too short": (wav(0.2), "must be 0.5–5 s long"),
            "too long": (wav(6.0), "must be 0.5–5 s long"),
        }
        for name, (data, message) in cases.items():
            with self.subTest(name):
                status, body, _ = self.s.upload(self.sid, data)
                self.assertEqual(status, 400)
                self.assertIn(message, body["error"])
        self.assertIn("kind must be one of", self.s.upload(self.sid, wav(1.0), kind="music")[1]["error"])
        data = wav(1.0)
        self.assertEqual(self.s.upload(self.sid, data, headers={"x-clip-sha256": "0" * 64})[1], {"error": "sha256 mismatch"})
        self.assertEqual(self.s.upload("20990101-0000-ffff", data)[0], 404)
        self.assertEqual(os.listdir(self.s.root / self.sid / "clips"), [])
        self.assertEqual(self.s.call("GET", "/v1/wakeword/sessions")[1]["usage"]["bytes"], 0)

    def test_noise_may_be_longer(self):
        self.assertEqual(self.s.upload(self.sid, wav(10.0), kind="noise")[0], 200)

    def test_size_and_disk_caps(self):
        c = http.client.HTTPConnection(*self.s.api.address, timeout=10)  # refused before the body is read
        self.addCleanup(c.close)
        c.putrequest("POST", f"/v1/wakeword/sessions/{self.sid}/clips?kind=noise")
        c.putheader("Authorization", f"Bearer {TOKEN}")
        c.putheader("Content-Length", str(4 * 1024 * 1024 + 1))
        c.endheaders()
        self.assertEqual(c.getresponse().status, 413)
        small = Server(self, max_total_mb=0.05)  # 52 kB in all
        sid = small.session()
        self.assertEqual(small.upload(sid, wav(1.0))[0], 200)  # 32 kB
        status, body, _ = small.upload(sid, wav(1.2))
        self.assertEqual((status, body["error"]), (507, "recordings are using all their space; delete a session"))
        with mock.patch.object(store_mod, "MAX_CLIPS", 1):
            self.assertEqual(self.s.upload(self.sid, wav(1.0))[0], 200)
            self.assertEqual(self.s.upload(self.sid, wav(1.1))[0], 409)

    def test_chunked_upload_needs_a_length(self):
        c = http.client.HTTPConnection(*self.s.api.address, timeout=10)
        self.addCleanup(c.close)
        c.request("POST", f"/v1/wakeword/sessions/{self.sid}/clips?kind=noise", body=iter([wav(1.0)]),
                  headers={"Authorization": f"Bearer {TOKEN}", "Transfer-Encoding": "chunked"}, encode_chunked=True)
        self.assertEqual(c.getresponse().status, 411)

    def test_upload_is_streamed_not_buffered(self):
        reads = []
        real = store_mod.Recordings.add

        def spy(self, sid, kind, body, length, claimed=None):
            read = body.read
            body.read = lambda n=65536: reads.append(n) or read(n)
            return real(self, sid, kind, body, length, claimed)
        with mock.patch.object(store_mod.Recordings, "add", spy):
            self.assertEqual(self.s.upload(self.sid, wav(20.0), kind="noise")[0], 200)  # 640 kB
        self.assertGreater(len(reads), 8)
        self.assertTrue(all(n == store_mod.CHUNK for n in reads))

    def test_delete_clip(self):
        data = wav(1.0)
        self.s.upload(self.sid, data)
        path = f"/v1/wakeword/sessions/{self.sid}/clips/{sha(data)}"
        self.assertEqual(self.s.call("DELETE", path)[1], {"deleted": sha(data)})
        self.assertEqual(self.s.call("GET", path)[0], 404)
        self.assertEqual(self.s.call("DELETE", path)[0], 404)
        self.assertEqual(self.s.call("GET", "/v1/wakeword/sessions")[1]["usage"]["bytes"], 0)

    def test_parallel_uploads_keep_every_clip(self):
        clips = [wav(1.0 + i / 100) for i in range(8)]
        threads = [threading.Thread(target=self.s.upload, args=(self.sid, c)) for c in clips]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        manifest = self.s.call("GET", f"/v1/wakeword/sessions/{self.sid}/manifest")[1]
        self.assertEqual(sorted(c["sha256"] for c in manifest["clips"]), sorted(sha(c) for c in clips))

    def test_restart_reads_the_manifests_and_drops_half_uploads(self):
        data = wav(1.0)
        self.s.upload(self.sid, data)
        (self.s.root / ".tmp" / "upload-dead").write_bytes(b"partial")
        again = store_mod.Recordings(str(self.s.root))
        self.assertEqual((again.used, again.session(self.sid)["clips"]), (len(data), 1))
        self.assertEqual(os.listdir(self.s.root / self.sid / "clips"), [f"{sha(data)}.wav"])
        self.assertEqual(os.listdir(self.s.root / ".tmp"), [])

    def test_a_session_deleted_mid_upload(self):
        store = store_mod.Recordings(str(self.s.root))
        data = wav(1.0)

        class Body:  # the session is deleted while the clip is still arriving
            sent = False

            def read(self, n):
                if self.sent:
                    return b""
                self.sent = True
                store.delete(sid)
                return data
        sid = store.create("doomed")["id"]
        with self.assertRaises(store_mod.StoreError) as cm:
            store.add(sid, "positive_near", Body(), len(data))
        self.assertEqual(cm.exception.status, 404)
        self.assertFalse((self.s.root / sid).exists())
        self.assertEqual(os.listdir(self.s.root / ".tmp"), [])  # the temp file went too
        self.assertEqual(store.used, 0)

    def test_a_corrupt_manifest_skips_only_its_session(self):
        self.s.upload(self.sid, wav(1.0))
        bad = self.s.session("broken")
        (self.s.root / bad / "manifest.json").write_text("{not json")
        other = self.s.session("half")
        (self.s.root / other / "manifest.json").write_text(json.dumps({"session": other, "clips": [{}]}))
        with self.assertLogs("edith.feature.wakeword", "WARNING") as logs:
            again = store_mod.Recordings(str(self.s.root))
        self.assertEqual([s["id"] for s in again.sessions()], [self.sid])
        self.assertEqual(len(logs.records), 2)


class ModelStatusTest(unittest.TestCase):
    def test_bad_json_is_a_400_or_no_model(self):
        s = Server(self)
        status, body, _ = s.call("POST", "/v1/wakeword/sessions", b"[1, 2]", {"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        self.assertIn("JSON object", body["error"])
        for content in ("[1, 2]", "{broken", "\"text\""):
            (s.models / "hey_edith.json").write_text(content)
            self.assertEqual(s.call("GET", "/v1/wakeword/model")[1]["model"], None)

    def test_states(self):
        s = Server(self)
        self.assertEqual(s.call("GET", "/v1/wakeword/model")[1], {"state": "no_recordings", "model": None, "latest_session": None})
        sid = s.session()
        s.upload(sid, wav(1.0))
        status = s.call("GET", "/v1/wakeword/model")[1]
        self.assertEqual((status["state"], status["latest_session"]["id"], status["latest_session"]["clips"]),
                         ("waiting_for_training", sid, 1))
        info = {"version": "hey_edith-20261102-1130", "session": sid, "metrics": {"false_reject_rate": 0.03}}
        (s.models / "hey_edith.json").write_text(json.dumps(info))
        status = s.call("GET", "/v1/wakeword/model")[1]
        self.assertEqual((status["state"], status["model"]), ("trained", info))
        s.session()  # a newer session without clips doesn't count
        self.assertEqual(s.call("GET", "/v1/wakeword/model")[1]["state"], "trained")

    def test_loading_touches_no_file(self):
        with tempfile.TemporaryDirectory() as d:
            load_features(["wakeword"], EventBus(), Ports(), Registry(), {"wakeword": {"state_dir": d}})
            self.assertEqual(os.listdir(d), [])


if __name__ == "__main__":
    unittest.main()
