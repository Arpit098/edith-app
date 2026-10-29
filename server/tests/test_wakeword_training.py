"""The stdlib parts of wakeword/training (they run on the Mac; tested here without any ML package):
fetch.py against the real wakeword routes, data.py's .npy slice, and lib's helpers."""
import hashlib
import http.server
import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock

from tests.features.test_wakeword import TOKEN, Server, wav

TRAINING = pathlib.Path(__file__).resolve().parents[2] / "wakeword" / "training"
sys.path.insert(0, str(TRAINING))
lib = importlib.import_module("lib")


def load(name):
    spec = importlib.util.spec_from_file_location(f"wakeword_{name}", TRAINING / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fetch, data = load("fetch"), load("data")


class Files(http.server.BaseHTTPRequestHandler):
    """Serves `files` {path: bytes} with Range support (like GitHub's and Hugging Face's CDNs)."""
    files: dict = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        body = self.files.get(self.path)
        if body is None:
            self.send_error(404)
            return
        rng = self.headers.get("Range")
        if rng:
            start, _, end = rng.removeprefix("bytes=").partition("-")
            start, end = int(start), int(end) if end else len(body) - 1
            part = body[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{start + len(part) - 1}/{len(body)}")
        else:
            part = body
            self.send_response(200)
        self.send_header("Content-Length", str(len(part)))
        self.end_headers()
        self.wfile.write(part)


def file_server(test, files):
    handler = type("H", (Files,), {"files": files})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 60}, daemon=True).start()

    def stop():
        threading.Thread(target=server.shutdown).start()
        try:  # wake serve_forever's select at once
            import socket
            socket.create_connection(server.server_address, timeout=1).close()
        except OSError:
            pass
        server.server_close()
    test.addCleanup(stop)
    return f"http://127.0.0.1:{server.server_address[1]}"


class FetchTest(unittest.TestCase):
    def setUp(self):
        self.s = Server(self)
        self.sid = self.s.session()
        self.clips = [wav(1.0), wav(1.2), wav(3.0)]
        for i, c in enumerate(self.clips):
            self.s.upload(self.sid, c, kind="noise" if i == 2 else "positive_near")
        self.work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.work)
        self.base = "http://%s:%d" % self.s.api.address

    def test_pulls_the_latest_session_and_checks_every_clip(self):
        logs = []
        folder = fetch.fetch(self.base, TOKEN, "latest", self.work, log=logs.append)
        for c in self.clips:
            self.assertEqual(pathlib.Path(folder, "clips", f"{hashlib.sha256(c).hexdigest()}.wav").read_bytes(), c)
        manifest = json.loads(pathlib.Path(folder, "manifest.json").read_text())
        self.assertEqual((manifest["session"], len(manifest["clips"])), (self.sid, 3))
        self.assertIn("3 downloaded", logs[-1])
        bad = pathlib.Path(folder, "clips", f"{hashlib.sha256(self.clips[0]).hexdigest()}.wav")
        bad.write_bytes(b"corrupt")
        fetch.fetch(self.base, TOKEN, self.sid, self.work, log=logs.append)
        self.assertIn("1 downloaded", logs[-1])  # only the damaged one again
        self.assertEqual(bad.read_bytes(), self.clips[0])
        self.assertNotIn(TOKEN, "".join(logs))

    def test_a_wrong_hash_is_never_kept(self):
        real = lib.download

        def tampered(url, dest, sha256=None, **kw):
            return real(url, dest, sha256="0" * 64, **kw)
        with mock.patch.object(fetch, "download", tampered), self.assertRaises(lib.FetchError):
            fetch.fetch(self.base, TOKEN, self.sid, self.work, log=lambda m: None)
        self.assertEqual(os.listdir(pathlib.Path(self.work, "recordings", self.sid, "clips")), [])

    def test_token_file_rules_and_errors(self):
        path = pathlib.Path(self.work, "token")
        path.write_text(TOKEN)
        path.chmod(0o644)
        with self.assertRaises(lib.FetchError):
            fetch.read_token(str(path))
        path.chmod(0o600)
        self.assertEqual(fetch.read_token(str(path)), TOKEN)
        with mock.patch("sys.stderr") as err:
            code = fetch.main(["--base-url", self.base, "--token-file", str(path), "--work", self.work,
                               "--session", "20990101-0000-ffff"])
        self.assertEqual(code, 1)
        self.assertNotIn(TOKEN, "".join(str(c) for c in err.mock_calls))


class LibTest(unittest.TestCase):
    def test_split_is_stable_and_holds_out_every_nth(self):
        clips = [{"sha256": f"{i:064x}"} for i in range(20)]
        train, held = lib.split(list(reversed(clips)), 5)
        self.assertEqual((len(train), len(held)), (16, 4))
        self.assertEqual(held, lib.split(clips, 5)[1])
        self.assertFalse({c["sha256"] for c in train} & {c["sha256"] for c in held})

    def test_activations_count_bursts_once(self):
        scores = [0, 0.9, 0.95, 0.9] + [0] * 30 + [0.6] + [0] * 5 + [0.7]
        self.assertEqual(lib.activations(scores, 0.5), 2)  # the last one falls in the 2 s after the second
        self.assertEqual(lib.activations(iter([0.1] * 100), 0.5), 0)

    def test_pick_device(self):
        def torch(mps, cuda):
            return types.SimpleNamespace(backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: mps)),
                                         cuda=types.SimpleNamespace(is_available=lambda: cuda))
        self.assertEqual(lib.pick_device(torch(True, True)), "mps")
        self.assertEqual(lib.pick_device(torch(False, True)), "cuda")
        self.assertEqual(lib.pick_device(torch(False, False)), "cpu")
        self.assertEqual(lib.pick_device(torch(True, False), "cpu"), "cpu")

    def test_npy_headers_match_numpys(self):
        # The real file's header, as Hugging Face serves it (128 bytes)
        real = lib.npy_header_bytes("<f2", (5625000, 16, 96))
        self.assertEqual(len(real), 128)
        self.assertEqual(lib.npy_header(real + b"\0" * 64), (128, "<f2", (5625000, 16, 96)))
        self.assertEqual(len(lib.npy_header_bytes("<f2", (1406250, 16, 96))), 128)

    def test_model_info_and_metrics(self):
        onnx = pathlib.Path(tempfile.mkdtemp(), "hey_edith.onnx")
        self.addCleanup(shutil.rmtree, onnx.parent)
        onnx.write_bytes(b"model")
        metrics = {"false_reject_rate": 0.031, "held_out_positives": 32, "false_accepts_per_hour": 0.4,
                   "negative_hours": 10.7, "noise_false_accepts_per_hour": 0.0, "noise_hours": 0.2}
        info = lib.model_info(str(onnx), "20261102-1043-a1b2", 0.5, metrics, "mps", "0.6.0", {}, now=1793603400)
        self.assertEqual((info["version"], info["file"], info["sha256"], info["size"]),
                         ("hey_edith-20261102-1240", "hey_edith.onnx", hashlib.sha256(b"model").hexdigest(), 5))
        md = lib.metrics_md(info)
        self.assertIn("02 Nov 2026, 12:40 IST", md)
        self.assertIn("| 3.1% | ✅ < 5% |", md)


class DataTest(unittest.TestCase):
    def test_negative_slice_downloads_only_its_rows(self):
        rows = b"".join(bytes([i]) * 12 for i in range(100))  # shape (100, 2, 3) of 2-byte values
        full = lib.npy_header_bytes("<f2", (100, 2, 3)) + rows
        served = []
        base = file_server(self, {"/f.npy": full})
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work)
        real = lib.request
        with mock.patch.object(data, "HF", base + "/"), \
                mock.patch.object(data, "ACAV", ("f.npy", hashlib.sha256(full).hexdigest(), 100)), \
                mock.patch.object(data, "request", lambda url, headers=None, **kw: served.append(headers) or real(url, headers, **kw)):
            path = data.negatives(work, 10)
        got = pathlib.Path(path).read_bytes()
        self.assertEqual(lib.npy_header(got)[1:], ("<f2", (10, 2, 3)))
        self.assertEqual(got[128:], rows[:120])  # the first 10 rows, nothing more
        self.assertEqual(served, [{"Range": "bytes=0-1023"}])

    def test_download_resumes_and_checks_the_hash(self):
        body = os.urandom(5000)
        base = file_server(self, {"/x.bin": body})
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work)
        dest = os.path.join(work, "x.bin")
        pathlib.Path(dest + ".part").write_bytes(body[:1234])  # an interrupted earlier run
        lib.download(base + "/x.bin", dest, hashlib.sha256(body).hexdigest())
        self.assertEqual(pathlib.Path(dest).read_bytes(), body)
        os.remove(dest)
        with self.assertRaises(lib.FetchError):
            lib.download(base + "/x.bin", dest, "0" * 64)
        self.assertFalse(os.path.exists(dest) or os.path.exists(dest + ".part"))

    def test_failures_retry_with_backoff_then_give_up(self):
        sleeps = []
        with self.assertRaises(lib.FetchError):
            lib.request("http://127.0.0.1:9/none", timeout=1, sleep=sleeps.append)
        self.assertEqual(sleeps, [1, 2, 4, 8])


if __name__ == "__main__":
    unittest.main()
