"""A way for Arpit to talk to EDITH (Telegram, the app's API). Frontends render the registry's commands."""
from typing import Protocol

from ..core.context import Registry
from ..core.events import EventBus


class Frontend(Protocol):
    name: str  # also the event "origin" for turns it starts

    def start(self, bus: EventBus, registry: Registry, agent) -> None:
        """Begin serving (in its own thread). Must not block."""

    def stop(self) -> None: ...
