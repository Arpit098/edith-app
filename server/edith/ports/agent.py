"""The coding agent that does the work (today: Claude Code in tmux, plus `claude -p` side lanes)."""
from dataclasses import dataclass
from typing import Protocol


@dataclass
class TurnHandle:
    ref: str
    lane: str  # "main" | "side"


class AgentBackend(Protocol):
    def send(self, text: str, origin: str, ref: str) -> TurnHandle:
        """Start a turn. Progress and the reply arrive as events on the bus (contracts/events.md)."""

    def stop(self) -> int:
        """Interrupt running turns; returns how many were stopped."""

    def current_session(self) -> str | None: ...

    def list_sessions(self, limit: int = 8) -> list[dict]:
        """[{session_id, title, updated}] newest first."""

    def resume(self, session_id: str) -> None: ...

    def new_session(self) -> None: ...

    def resolve_permission(self, request_id: str, allow: bool) -> bool: ...
