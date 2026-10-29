"""The whisper.cpp stt adapter (docs/PHASE1_PLAN.md, step 9) against a fake whisper-server and a fake
ffmpeg. No model, no network. Two tests use the real ffmpeg when it is installed."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

from edith.adapters.stt import whisper_cpp
from edith.adapters.stt.whisper_cpp import WhisperCpp, audio_ctx, ffmpeg_command, max_tokens, ready_wav
from edith.ports.stt import SttError
from tests.fakes.whisper import FakeWhisper, wav

FAKE_FFMPEG = str(pathlib.Path(__file__).resolve().parent / "fakes" / "fake_ffmpeg.py")
MP4_HEAD = b"\0\0\0\x20ftypM4A \0\0\0\0M4A isom" + b"\0" * 64


class Base(unittest.TestCase):
    def setUp(self):
        self.whisper = FakeWhisper()
        self.addCleanup(self.whisper.close)
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.log = os.path.join(self.dir, "ffmpeg.jsonl")
        env = mock.patch.dict(os.environ, {"FAKE_FFMPEG_LOG": self.log})
        env.start()
        self.addCleanup(env.stop)

    def stt(self, **kw):
        kw.setdefault("ffmpeg", FAKE_FFMPEG)
        kw.setdefault("backoff", 0.01)
        return WhisperCpp(self.whisper.url, **kw)

    def assertKind(self, kind, fn):
        with self.assertRaises(SttError) as cm:
            fn()
        self.assertEqual(cm.exception.kind, kind)
        return cm.exception

    def ffmpeg_calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [json.loads(line) for line in f]


class CommandTest(unittest.TestCase):
    def test_ffmpeg_command_pipes_raw_16k_mono_and_caps_length(self):
        self.assertEqual(ffmpeg_command("ffmpeg", "pipe:0", 60),
                         ["ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error", "-threads", "1",
                          "-i", "pipe:0", "-t", "61", "-vn", "-ac", "1", "-ar", "16000",
                          "-acodec", "pcm_s16le", "-f", "s16le", "pipe:1"])
        self.assertNotIn("-t", ffmpeg_command("ffmpeg", "/x.m4a", None))

    def test_ready_wav(self):
        self.assertEqual(ready_wav(wav(1.5)), 1.5)
        self.assertIsNone(ready_wav(wav(1, rate=44100)))
        self.assertIsNone(ready_wav(wav(1, channels=2)))
        self.assertIsNone(ready_wav(b"RIFF\0\0\0\0WAVEjunk"))
        self.assertIsNone(ready_wav(MP4_HEAD))

    def test_audio_ctx_fits_the_clip(self):
        self.assertEqual([audio_ctx(d) for d in (0.5, 5, 10, 28.7, 29, 60)], [89, 314, 564, 1499, 1500, 1500])

    def test_max_tokens_scales_with_duration(self):
        self.assertEqual([max_tokens(d) for d in (0.5, 5, 10, 60)], [42, 132, 232, 1232])

    def test_deadline_is_relative_to_duration(self):
        s = WhisperCpp()
        self.assertEqual([s.deadline(d) for d in (1, 3, 4, 10, 60)], [5.0, 5.0, 6.0, 15.0, 90.0])

    def test_create_reads_config(self):
        s = whisper_cpp.create({"url": "http://127.0.0.1:9/", "deadline_floor": 2, "deadline_factor": 3,
                                "language": "hi", "unknown": 1})
        self.assertEqual((s.url, s.deadline(1), s.deadline(2), s.language), ("http://127.0.0.1:9", 3, 6, "hi"))


class TranscribeTest(Base):
    def test_16k_mono_wav_skips_ffmpeg(self):
        t = self.stt().transcribe(wav(3))
        self.assertEqual((t.text, t.language, t.duration), ("hello edith", "en", 3.0))
        self.assertGreaterEqual(t.seconds, 0)
        self.assertEqual(self.ffmpeg_calls(), [])
        req, = self.whisper.requests
        self.assertEqual(req["path"], "/inference")
        self.assertEqual(req["fields"], {
            "response_format": "verbose_json", "no_language_probabilities": "true", "token_timestamps": "false",
            "no_timestamps": "true", "audio_ctx": "214",
            "max_tokens": "92",                                    # the token cap: 32 + 20/s × 3 s
            "entropy_thold": "2.4", "logprob_thold": "-1.0",       # whisper's loop checks, sent explicitly
            "temperature": "0.0", "temperature_inc": "0.2"})
        self.assertEqual(req["wav"], {"channels": 1, "rate": 16000, "width": 2, "seconds": 3.0})

    def test_other_audio_goes_through_one_ffmpeg_pipe(self):
        audio = b"OggS" + b"\1" * 5000
        with mock.patch.dict(os.environ, {"FAKE_FFMPEG_SECONDS": "4.5"}):
            t = self.stt().transcribe(audio, "audio/ogg", max_seconds=60)
        call, = self.ffmpeg_calls()
        self.assertEqual(call["argv"], ffmpeg_command(FAKE_FFMPEG, "pipe:0", 60)[1:])
        self.assertEqual(call["stdin_bytes"], len(audio))
        self.assertEqual(t.duration, 4.5)
        self.assertEqual(self.whisper.requests[0]["wav"]["seconds"], 4.5)

    def test_44k_stereo_wav_is_converted(self):
        self.stt().transcribe(wav(1, rate=44100, channels=2))
        self.assertEqual(len(self.ffmpeg_calls()), 1)

    def test_mp4_uses_a_seekable_temp_file_that_is_removed(self):
        audio = MP4_HEAD + b"\2" * 1000
        self.stt().transcribe(audio, "audio/mp4")
        call, = self.ffmpeg_calls()
        source = call["argv"][call["argv"].index("-i") + 1]
        self.assertTrue(source.endswith(".m4a"))
        self.assertEqual((call["stdin_bytes"], call["input_bytes"]), (0, len(audio)))
        self.assertFalse(os.path.exists(source))

    def test_full_window_when_fit_ctx_is_off(self):
        self.stt(fit_ctx=False).transcribe(wav(1))
        self.assertNotIn("audio_ctx", self.whisper.requests[0]["fields"])

    def test_language_from_call_or_config(self):
        self.stt(language="hi").transcribe(wav(1))
        self.stt(language="hi").transcribe(wav(1), language="en")
        self.assertEqual([r["fields"].get("language") for r in self.whisper.requests], ["hi", "en"])

    def test_text_is_tidied_and_blank_audio_is_empty(self):
        self.whisper.answers = [(200, {"text": "  Check   the\n disk ", "language": "en"}),
                                (200, {"text": " [BLANK_AUDIO]", "language": "en"})]
        stt = self.stt()
        self.assertEqual(stt.transcribe(wav(1)).text, "Check the disk")
        self.assertEqual(stt.transcribe(wav(1)).text, "")


class LimitTest(Base):
    def test_empty_and_undecodable_audio(self):
        self.assertKind("bad_audio", lambda: self.stt().transcribe(b""))
        self.assertKind("bad_audio", lambda: self.stt().transcribe(wav(0)))
        with mock.patch.dict(os.environ, {"FAKE_FFMPEG_EXIT": "1"}):
            e = self.assertKind("bad_audio", lambda: self.stt().transcribe(b"garbage"))
        self.assertIn("Invalid data", e.message)
        self.assertEqual(self.whisper.requests, [])

    def test_too_long(self):
        self.assertKind("too_long", lambda: self.stt().transcribe(wav(11), max_seconds=10))
        with mock.patch.dict(os.environ, {"FAKE_FFMPEG_SECONDS": "11"}):  # ffmpeg stops at max + 1
            self.assertKind("too_long", lambda: self.stt().transcribe(b"OggS..", max_seconds=10))
        self.assertEqual(self.whisper.requests, [])
        self.stt().transcribe(wav(10), max_seconds=10)

    def test_missing_ffmpeg(self):
        self.assertKind("error", lambda: self.stt(ffmpeg="/nonexistent/ffmpeg").transcribe(b"OggS"))

    def test_ffmpeg_timeout_kills_it(self):
        hang = os.path.join(self.dir, "hang")
        with open(hang, "w") as f:
            f.write("#!/bin/sh\nexec sleep 30\n")
        os.chmod(hang, 0o755)
        e = self.assertKind("error", lambda: self.stt(ffmpeg=hang, ffmpeg_timeout=0.3).transcribe(b"OggS"))
        self.assertIn("timed out", e.message)

    def test_busy_when_too_many_wait(self):
        self.whisper.release.clear()  # requests hang until released
        stt = self.stt(max_pending=1)
        first = threading.Thread(target=stt.transcribe, args=(wav(1),))
        first.start()
        try:
            self.assertTrue(self.whisper.arrived.wait(5))  # the first upload holds the only slot
            self.assertKind("busy", lambda: stt.transcribe(wav(1)))
        finally:
            self.whisper.release.set()
            first.join(5)
        stt.transcribe(wav(1))  # the slot is free again


class ServerErrorTest(Base):
    def test_503_while_loading_is_retried_then_succeeds(self):
        self.whisper.answers = [(503, {"status": "loading model"}), (503, {}), (200, {"text": "ok"})]
        self.assertEqual(self.stt(retries=3).transcribe(wav(1)).text, "ok")
        self.assertEqual(len(self.whisper.requests), 3)

    def test_503_forever_is_unavailable_after_retries(self):
        self.whisper.answers = [(503, {"status": "loading model"})]
        self.assertKind("unavailable", lambda: self.stt(retries=2).transcribe(wav(1)))
        self.assertEqual(len(self.whisper.requests), 3)

    def test_server_down_is_unavailable(self):
        url = self.whisper.url
        self.whisper.close()
        stt = WhisperCpp(url, retries=1, backoff=0.01)
        self.assertKind("unavailable", lambda: stt.transcribe(wav(1)))

    def test_400_is_bad_audio_and_500_is_error_without_retry(self):
        self.whisper.answers = [(400, {"error": "failed to read audio data"}), (500, {"error": "boom"})]
        stt = self.stt()
        self.assertKind("bad_audio", lambda: stt.transcribe(wav(1)))
        self.assertKind("error", lambda: stt.transcribe(wav(1)))
        self.assertEqual(len(self.whisper.requests), 2)

    def test_slow_server_times_out_at_the_deadline_without_retry(self):
        self.whisper.release.clear()  # a runaway decode: the server never answers
        stt = self.stt(deadline_floor=0.2, deadline_factor=0.1, retries=3)
        started = time.monotonic()
        try:
            e = self.assertKind("timeout", lambda: stt.transcribe(wav(4)))  # deadline max(0.2, 0.1 × 4) = 0.4 s
        finally:
            self.whisper.release.set()
        self.assertLess(time.monotonic() - started, 3)
        self.assertIn("0.4 s", e.message)
        self.assertEqual(len(self.whisper.requests), 1)
        self.assertEqual(self.whisper.requests[0]["fields"]["max_tokens"], "112")

    def test_waiting_behind_another_upload_does_not_use_up_the_deadline(self):
        self.whisper.release.clear()
        stt = self.stt(deadline_floor=1.0, deadline_factor=0)
        first = threading.Thread(target=lambda: self.assertKind("timeout", lambda: stt.transcribe(wav(1))))
        first.start()
        self.assertTrue(self.whisper.arrived.wait(5))
        second = []
        t = threading.Thread(target=lambda: second.append(stt.transcribe(wav(1))))
        t.start()
        first.join(5)               # the first times out after 1 s and frees the turn
        self.whisper.release.set()  # the second is answered at once; it waited ~1 s but has its own deadline
        t.join(5)
        self.assertEqual(second[0].text, "hello edith")


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is not installed")
class RealFfmpegTest(Base):
    """The real ffmpeg: the pipe path and the M4A temp-file path both give 16 kHz mono WAV."""

    def encode(self, args, suffix):
        out = os.path.join(self.dir, "in" + suffix)
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                        "sine=frequency=440:sample_rate=44100:duration=2", "-ac", "2", *args, out], check=True)
        with open(out, "rb") as f:
            return f.read()

    def test_stereo_44k_wav_and_m4a(self):
        stt = self.stt(ffmpeg="ffmpeg")
        for audio in (self.encode([], ".wav"), self.encode(["-c:a", "aac"], ".m4a")):
            t = stt.transcribe(audio, max_seconds=60)
            self.assertAlmostEqual(t.duration, 2.0, delta=0.1)
        for req in self.whisper.requests:
            self.assertEqual((req["wav"]["channels"], req["wav"]["rate"], req["wav"]["width"]), (1, 16000, 2))


if __name__ == "__main__":
    unittest.main()
