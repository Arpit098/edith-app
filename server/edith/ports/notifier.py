"""Push notifications to Arpit's devices: Telegram, and self-hosted ntfy for the app (contracts/push.md)."""
from typing import Protocol


class Notifier(Protocol):
    name: str

    def notify(self, title: str, body: str, priority: str = "default", data: dict | None = None) -> bool:
        """`data`: a structured message for a notifier that carries one (ntfy, contracts/push.md);
        others show title and body."""

    # Optional, for a notifier the app subscribes to itself (ntfy): subscription() -> {url, topic, token},
    # the phone's read-only access (GET /v1/push/config); raises ValueError when it can't be given.
