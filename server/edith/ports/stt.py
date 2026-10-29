"""Speech-to-text (today: whisper.cpp on edith)."""
from dataclasses import dataclass
from typing import Protocol


@dataclass
class Transcript:
    text: str
    language: str | None = None
    seconds: float | None = None  # processing time


class SpeechToText(Protocol):
    def transcribe(self, audio: bytes, mime: str = "audio/wav") -> Transcript: ...
