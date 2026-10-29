"""Push notifications to Arpit's devices (today: Telegram; Phase 5: self-hosted ntfy)."""
from typing import Protocol


class Notifier(Protocol):
    name: str

    def notify(self, title: str, body: str, priority: str = "default") -> bool: ...
