"""Voice (PLAN.md §4.7): speech-to-text for the app, and what to say aloud when a voice turn ends.

POST /v1/stt: the body is the audio itself (any format ffmpeg reads; 16 kHz mono WAV is fastest), or a
multipart/form-data upload with a `file` part (`curl -F file=@clip.wav`). `?language=hi` skips detection.

Voice turns: the App API publishes `voice.turn {ref}` for a message sent with `voice: true` (its prompt
carries the [voice] tag, so EDITH answers with a spoken summary first). When that turn is queued or ends,
this publishes `voice.reply {ref, outcome, speak}` for the app to read out (speech.py).
"""
import email.parser
import email.policy
import threading
from collections import OrderedDict

from edith.core import ApiError, Context, Event, Feature
from edith.ports.stt import SttError

from .speech import speak_for

MAX_TRACKED = 64  # voice turns followed at once; the oldest is dropped (e.g. a send that failed)
ENDS = ("turn.done", "turn.failed", "turn.stopped")

STATUS = {"bad_audio": 400, "too_long": 413, "busy": 429, "unavailable": 503, "timeout": 504, "error": 502}


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

    voice_refs: OrderedDict[str, None] = OrderedDict()
    lock = threading.Lock()

    def on_voice_turn(ev: Event) -> None:
        with lock:
            voice_refs[ev.data["ref"]] = None
            if len(voice_refs) > MAX_TRACKED:
                voice_refs.popitem(last=False)

    def on_turn(ev: Event) -> None:
        ref = ev.data.get("ref")
        with lock:
            if ref not in voice_refs:
                return
            if ev.type in ENDS:
                del voice_refs[ref]
        said = speak_for(ev.type, ev.data)
        if said:
            ctx.bus.publish(Event("voice.reply", {"ref": ref, "outcome": said[0], "speak": said[1]},
                                  origin="app", session_id=ev.session_id))

    ctx.subscribe("voice.turn", on_voice_turn)
    ctx.subscribe("turn.*", on_turn)


FEATURE = Feature(name="voice", setup=setup, description="Speech-to-text for the app (voice mode: Phase 3)")
