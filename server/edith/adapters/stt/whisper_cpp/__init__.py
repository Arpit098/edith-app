"""Speech-to-text through a local whisper.cpp whisper-server (127.0.0.1 only, deploy/whisper/).

One upload is one request:
- Audio that is already 16 kHz mono 16-bit WAV goes to whisper-server as it is.
- Anything else goes through one ffmpeg process, stdin → stdout (raw PCM), with no temp file, except for
  MP4/M4A: its index can sit at the end of the file, which ffmpeg can't seek to on a pipe.
- whisper-server's own --convert is not used: it writes a temp file and shells out per request.

whisper-server handles one request at a time (a mutex around the model), so at most `max_pending` uploads
wait here; more get SttError("busy") instead of piling up threads.
"""
import io
import json
import logging
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave

from edith.ports.stt import SttError, Transcript

log = logging.getLogger("edith.adapter.stt.whisper_cpp")

RATE = 16000                 # whisper's sample rate
BYTES_PER_SECOND = RATE * 2  # mono, 16-bit
NON_SPEECH = {"[BLANK_AUDIO]", "[ Silence ]", "[silence]", "(silence)", "[MUSIC]", "[Music]"}


def ffmpeg_command(ffmpeg: str, source: str, max_seconds: float | None) -> list[str]:
    """Convert any audio `source` ("pipe:0" or a path) to raw 16 kHz mono s16le on stdout.
    `-t` stops decoding just past the limit, so an over-long upload costs at most that much work."""
    cmd = [ffmpeg, "-hide_banner", "-nostats", "-loglevel", "error", "-threads", "1", "-i", source]
    if max_seconds:
        cmd += ["-t", f"{max_seconds + 1:g}"]
    return cmd + ["-vn", "-ac", "1", "-ar", str(RATE), "-acodec", "pcm_s16le", "-f", "s16le", "pipe:1"]


def wav_bytes(pcm: bytes) -> bytes:
    """Wrap raw 16 kHz mono s16le PCM in a WAV header."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    return out.getvalue()


def ready_wav(audio: bytes) -> float | None:
    """The duration if `audio` is already a 16 kHz mono 16-bit PCM WAV (send it as is), else None."""
    if audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        return None
    try:
        with wave.open(io.BytesIO(audio)) as w:
            if (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getcomptype()) != (1, 2, RATE, "NONE"):
                return None
            return w.getnframes() / RATE
    except (wave.Error, EOFError):
        return None


def is_mp4(audio: bytes) -> bool:
    """ISO base media (MP4/M4A/3GP, Android's MediaRecorder default): an 'ftyp' box comes first."""
    return audio[4:8] == b"ftyp"


def multipart(fields: dict[str, str], file: bytes, filename: str = "audio.wav") -> tuple[bytes, str]:
    """A multipart/form-data body with the text `fields` and one `file` part. -> (body, content type)."""
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                 f"Content-Type: audio/wav\r\n\r\n".encode())
    parts += [file, f"\r\n--{boundary}--\r\n".encode()]
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


class WhisperCpp:
    def __init__(self, url: str = "http://127.0.0.1:8178", *, timeout: float = 60.0, ffmpeg: str = "ffmpeg",
                 ffmpeg_timeout: float = 20.0, language: str | None = None, retries: int = 3,
                 backoff: float = 0.5, max_pending: int = 2):
        self.url = url.rstrip("/")
        self.timeout, self.ffmpeg, self.ffmpeg_timeout = timeout, ffmpeg, ffmpeg_timeout
        self.language, self.retries, self.backoff = language, retries, backoff
        self._slots = threading.BoundedSemaphore(max_pending)

    # -- audio --------------------------------------------------------------------------------------

    def to_wav(self, audio: bytes, max_seconds: float | None) -> tuple[bytes, float]:
        """-> (16 kHz mono WAV, duration). Raises SttError bad_audio / too_long."""
        if not audio:
            raise SttError("bad_audio", "no audio")
        duration = ready_wav(audio)
        if duration is None:
            pcm = self._convert(audio, max_seconds)
            pcm = pcm[:len(pcm) - len(pcm) % 2]
            duration, audio = len(pcm) / BYTES_PER_SECOND, wav_bytes(pcm)
        if duration <= 0:
            raise SttError("bad_audio", "the audio is empty")
        if max_seconds and duration > max_seconds:
            raise SttError("too_long", f"audio is over {max_seconds:g} s")
        return audio, duration

    def _convert(self, audio: bytes, max_seconds: float | None) -> bytes:
        if is_mp4(audio):  # needs a seekable input (see the module docstring)
            with tempfile.NamedTemporaryFile(prefix="edith-stt-", suffix=".m4a") as f:
                f.write(audio)
                f.flush()
                return self._ffmpeg(ffmpeg_command(self.ffmpeg, f.name, max_seconds), b"")
        return self._ffmpeg(ffmpeg_command(self.ffmpeg, "pipe:0", max_seconds), audio)

    def _ffmpeg(self, cmd: list[str], stdin: bytes) -> bytes:
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as e:
            raise SttError("error", f"ffmpeg could not start: {e}")
        try:  # communicate() feeds stdin and drains both pipes together, so a full pipe never deadlocks
            out, err = proc.communicate(stdin, timeout=self.ffmpeg_timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise SttError("error", "ffmpeg timed out")
        if proc.returncode != 0:
            raise SttError("bad_audio", "could not decode the audio: " + err.decode(errors="replace").strip()[-300:])
        return out

    # -- whisper-server -----------------------------------------------------------------------------

    def _post(self, wav: bytes, language: str | None) -> dict:
        """POST /inference, retrying with backoff only while whisper-server is unreachable or loading its
        model (nothing was transcribed yet). A timeout is not retried: the server may still be working."""
        fields = {"response_format": "verbose_json", "temperature": "0.0"}
        if language:
            fields["language"] = language
        body, ctype = multipart(fields, wav)
        delay = self.backoff
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(f"{self.url}/inference", data=body, method="POST",
                                         headers={"Content-Type": ctype})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return json.loads(resp.read())
            except urllib.error.HTTPError as e:
                detail = e.read()[:300].decode(errors="replace")
                if e.code == 400:
                    raise SttError("bad_audio", f"whisper-server rejected the audio: {detail}")
                if e.code != 503:
                    raise SttError("error", f"whisper-server answered {e.code}: {detail}")
                reason = "loading its model"
            except (TimeoutError, urllib.error.URLError, ConnectionError) as e:
                if isinstance(e, TimeoutError) or isinstance(getattr(e, "reason", None), TimeoutError):
                    raise SttError("error", f"whisper-server took over {self.timeout:g} s")
                reason = f"unreachable ({getattr(e, 'reason', e)})"
            except ValueError:
                raise SttError("error", "whisper-server sent invalid JSON")
            if attempt < self.retries:
                log.warning("whisper-server %s; retry %d in %.1f s", reason, attempt + 1, delay)
                time.sleep(delay)  # backoff between reconnects, bounded by `retries`
                delay *= 2
        raise SttError("unavailable", f"whisper-server is {reason}")

    def transcribe(self, audio: bytes, mime: str = "audio/wav", *, language: str | None = None,
                   max_seconds: float | None = None) -> Transcript:
        # `mime` is not needed: the WAV check and ffmpeg's probe read the format from the bytes.
        if not self._slots.acquire(blocking=False):
            raise SttError("busy", "too many transcriptions waiting")
        try:
            wav, duration = self.to_wav(audio, max_seconds)
            started = time.monotonic()
            result = self._post(wav, language or self.language)
            text = " ".join(str(result.get("text", "")).split())
            return Transcript(text="" if text in NON_SPEECH else text, language=result.get("language"),
                              seconds=round(time.monotonic() - started, 3), duration=round(duration, 3))
        finally:
            self._slots.release()


def create(config: dict) -> WhisperCpp:
    """Config [adapter.whisper_cpp]: url, timeout, ffmpeg, ffmpeg_timeout, language, retries, max_pending.
    Nothing connects here; the first transcription does."""
    known = ("timeout", "ffmpeg", "ffmpeg_timeout", "language", "retries", "backoff", "max_pending")
    return WhisperCpp(config.get("url", "http://127.0.0.1:8178"), **{k: config[k] for k in known if k in config})
