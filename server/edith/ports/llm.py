"""Chat models the backup AI can use while Claude is down (contracts/backup.md). Every provider speaks
the OpenAI chat-completions shape, so one adapter covers them all; tests use a fake."""
from dataclasses import dataclass, field
from typing import Protocol


class ProviderError(Exception):
    """A provider call that didn't give an answer. `kind`:
    - `rate_limit` (HTTP 429): `retry_after` seconds if the provider said, `daily` when its daily quota is gone;
    - `auth` (401/403: the key was refused);
    - `down` (a timeout, a connection error, 5xx): worth one retry;
    - `bad_request` (any other 4xx, or an answer that can't be read).
    `detail` is short and never holds the key."""

    def __init__(self, kind: str, detail: str = "", status: int | None = None, retry_after: float | None = None,
                 daily: bool = False):
        super().__init__(f"{kind}: {detail}")
        self.kind, self.detail, self.status, self.retry_after, self.daily = kind, detail, status, retry_after, daily


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # JSON text, as the model wrote it


@dataclass
class ChatReply:
    text: str | None
    tool_calls: list[ToolCall] = field(default_factory=list)


class ChatProvider(Protocol):
    name: str    # "nemotron"
    label: str   # "Nemotron", shown in replies: "Backup (Nemotron): …"

    def available(self) -> bool:
        """Whether it can be used at all (its key file is there and private)."""

    def daily_reset(self, now: float) -> float:
        """When its daily quota comes back after `now` (unix seconds)."""

    def chat(self, messages: list[dict], tools: list[dict], timeout: float) -> ChatReply:
        """One chat-completions call (OpenAI shapes for messages and tools). Raises ProviderError."""


class ChatModels(Protocol):
    """The port: the configured providers, in the order they are tried."""
    providers: list[ChatProvider]
