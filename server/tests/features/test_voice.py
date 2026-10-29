"""The voice feature's POST /v1/stt (docs/PHASE1_PLAN.md, step 9): the route on its own with a fake stt
port, then end to end through the App API and the whisper_cpp adapter to a fake whisper-server."""
import json
import pathlib
import shutil
import tempfile
import time
import unittest
import urllib.error
import urllib.request

from edith.adapters.frontends.app_api import AppApi
from edith.adapters.stt.whisper_cpp import WhisperCpp, multipart
from edith.core import ApiError, EventBus, Ports, Registry, load_features
from edith.ports.stt import SttError, Transcript
from tests.fakes.whisper import FakeWhisper, wav

TOKEN = "v" * 40


class FakeStt:
    def __init__(self, error=None):
        self.calls, self.error = [], error

    def transcribe(self, audio, mime="audio/wav", *, language=None, max_seconds=None):
        self.calls.append((audio, mime, language, max_seconds))
        if self.error:
            raise self.error
        return Transcript("check the disk", "en", 0.8, 2.5)


def load(stt, config=None):
    registry = Registry()
    report = load_features(["voice"], EventBus(), Ports(stt=stt), registry, {"voice": config or {}})
    assert report.loaded == ["voice"], report.failed
    return registry, registry.routes[("POST", "/v1/stt")]


def call(route, raw, ctype="audio/wav", query=None):
    return route.handler({"body": None, "raw": raw, "content_type": ctype, "params": {}, "query": query or {},
                          "origin": "app"})


class RouteTest(unittest.TestCase):
    def test_raw_body(self):
        stt = FakeStt()
        _, route = load(stt)
        self.assertEqual(call(route, b"RIFFaudio"),
                         {"text": "check the disk", "language": "en", "seconds": 0.8, "duration": 2.5})
        self.assertEqual(stt.calls, [(b"RIFFaudio", "audio/wav", None, 60.0)])

    def test_multipart_file_part_and_language(self):
        stt = FakeStt()
        _, route = load(stt, {"max_seconds": 30})
        body, ctype = multipart({"note": "x"}, b"RIFFclip")
        call(route, body, ctype, {"language": "HI"})
        self.assertEqual(stt.calls, [(b"RIFFclip", "audio/wav", "hi", 30.0)])

    def test_bad_requests(self):
        _, route = load(FakeStt())
        body, ctype = multipart({}, b"")
        no_file = body.replace(b'name="file"', b'name="other"')
        for raw, ctype_, query in [(b"", "audio/wav", {}), (no_file, ctype, {}), (b"x", "audio/wav", {"language": "e n"})]:
            with self.assertRaises(ApiError) as cm:
                call(route, raw, ctype_, query)
            self.assertEqual(cm.exception.status, 400)

    def test_stt_errors_map_to_statuses(self):
        for kind, status in [("bad_audio", 400), ("too_long", 413), ("busy", 429), ("unavailable", 503),
                             ("error", 502)]:
            _, route = load(FakeStt(SttError(kind, "why")))
            with self.assertRaises(ApiError) as cm:
                call(route, b"x")
            self.assertEqual((cm.exception.status, cm.exception.message), (status, "why"))

    def test_no_stt_port(self):
        _, route = load(None)
        with self.assertRaises(ApiError) as cm:
            call(route, b"x")
        self.assertEqual(cm.exception.status, 503)

    def test_size_limit_from_config(self):
        registry, route = load(FakeStt(), {"max_bytes": 1000})
        self.assertEqual(route.max_body, 1000)


class EndToEndTest(unittest.TestCase):
    """curl -F file=@clip.wav → App API → voice → whisper_cpp → (fake) whisper-server."""

    def setUp(self):
        self.whisper = FakeWhisper([(200, {"text": " namaste edith", "language": "hi"})])
        self.addCleanup(self.whisper.close)
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        token = pathlib.Path(d, "token")
        token.write_text(TOKEN)
        token.chmod(0o600)
        registry = Registry()
        load_features(["voice"], EventBus(), Ports(stt=WhisperCpp(self.whisper.url)), registry,
                      {"voice": {"max_bytes": 200_000}})
        self.api = AppApi({"bind": "tailscale", "port": 0, "token_file": str(token), "audit_log": f"{d}/audit"},
                          resolve_ip=lambda: "127.0.0.1", allow_loopback=True, retry_wait=0.05)
        self.api.start(EventBus(), registry, None)
        self.addCleanup(self.api.stop)
        deadline = time.monotonic() + 5
        while self.api.address is None and time.monotonic() < deadline:  # the bind runs on its own thread
            time.sleep(0.01)
        self.host, self.port = self.api.address

    def post(self, data, ctype):
        req = urllib.request.Request(f"http://{self.host}:{self.port}/v1/stt", data=data, method="POST",
                                     headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": ctype})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_multipart_upload(self):
        body, ctype = multipart({}, wav(2))
        status, out = self.post(body, ctype)
        self.assertEqual(status, 200)
        self.assertEqual((out["text"], out["language"], out["duration"]), ("namaste edith", "hi", 2.0))
        self.assertEqual(self.whisper.requests[0]["wav"]["seconds"], 2.0)

    def test_raw_upload_and_size_limit(self):
        self.assertEqual(self.post(wav(1), "audio/wav")[0], 200)
        status, out = self.post(wav(7), "audio/wav")  # 224 KB > max_bytes
        self.assertEqual((status, out), (413, {"error": "request too large"}))


if __name__ == "__main__":
    unittest.main()
