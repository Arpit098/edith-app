"""Speech-to-text (today: whisper.cpp on edith)."""
from dataclasses import dataclass
from typing import Protocol


@dataclass
class Transcript:
    text: str
    language: str | None = None
    seconds: float | None = None   # processing time
    duration: float | None = None  # length of the audio, in seconds


class SttError(Exception):
    """A transcription that failed. `kind` says why, so callers can answer without knowing the engine:
    bad_audio (unreadable or empty), too_long (over max_seconds), busy (too many waiting),
    unavailable (the engine is down or still loading) or error (anything else)."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind, self.message = kind, message


class SpeechToText(Protocol):
    def transcribe(self, audio: bytes, mime: str = "audio/wav", *, language: str | None = None,
                   max_seconds: float | None = None) -> Transcript:
        """Raises SttError. `language` is a code like "en" or "hi" (None: detect it)."""
        ...
