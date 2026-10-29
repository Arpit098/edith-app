"""Voice: speech-to-text for the app (POST /v1/stt). The rest of voice comes in Phase 3 (PLAN.md §4.7).

The body is the audio itself (any format ffmpeg reads; 16 kHz mono WAV is fastest), or a
multipart/form-data upload with a `file` part (`curl -F file=@clip.wav`). `?language=hi` skips detection.
"""
import email.parser
import email.policy

from edith.core import ApiError, Context, Feature
from edith.ports.stt import SttError

STATUS = {"bad_audio": 400, "too_long": 413, "busy": 429, "unavailable": 503, "error": 502}


def audio_from(raw: bytes, content_type: str) -> tuple[bytes, str]:
    """-> (audio bytes, mime) from a raw or multipart/form-data body."""
    if not content_type.lower().startswith("multipart/form-data"):
        return raw, content_type or "application/octet-stream"
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + content_type.encode("latin-1") + b"\r\n\r\n" + raw)
    for part in msg.iter_parts() if msg.is_multipart() else ():
        if part.get_param("name", header="content-disposition") == "file":
            return part.get_payload(decode=True) or b"", part.get_content_type()
    raise ApiError(400, "multipart upload needs a 'file' part")


def setup(ctx: Context) -> None:
    max_bytes = int(ctx.config.get("max_bytes", 8 * 1024 * 1024))
    max_seconds = float(ctx.config.get("max_seconds", 60))

    def stt(req: dict) -> dict:
        if ctx.ports.stt is None:
            raise ApiError(503, "speech-to-text is not configured")
        audio, mime = audio_from(req["raw"], req["content_type"])
        if not audio:
            raise ApiError(400, "no audio")
        language = (req["query"].get("language") or "").strip().lower() or None
        if language and not (language.isalpha() and len(language) <= 8):
            raise ApiError(400, "language must be a code like en or hi")
        try:
            t = ctx.ports.stt.transcribe(audio, mime, language=language, max_seconds=max_seconds)
        except SttError as e:
            raise ApiError(STATUS.get(e.kind, 502), e.message)
        return {"text": t.text, "language": t.language, "seconds": t.seconds, "duration": t.duration}

    ctx.add_route("POST", "/v1/stt", stt, max_body=max_bytes)


FEATURE = Feature(name="voice", setup=setup, description="Speech-to-text for the app (voice mode: Phase 3)")
