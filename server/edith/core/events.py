"""Event bus: the only way features talk to each other. Event types are listed in contracts/events.md."""
import fnmatch
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

log = logging.getLogger("edith.events")


@dataclass
class Event:
    type: str
    data: dict[str, Any] = field(default_factory=dict)
    origin: str = "system"  # telegram | app | terminal | system
    session_id: str | None = None
    ts: float = field(default_factory=time.time)


Handler = Callable[[Event], None]


class EventBus:
    """Synchronous publish/subscribe. A failing handler is logged and skipped; the others still run."""

    def __init__(self):
        self._subs: list[tuple[str, Handler, str]] = []
        self._lock = threading.Lock()

    def subscribe(self, pattern: str, handler: Handler, owner: str = "?") -> None:
        """pattern: an exact type ("turn.done") or a glob ("turn.*", "*")."""
        with self._lock:
            self._subs.append((pattern, handler, owner))

    def publish(self, event: Event) -> None:
        with self._lock:
            subs = list(self._subs)
        for pattern, handler, owner in subs:
            if fnmatch.fnmatchcase(event.type, pattern):
                try:
                    handler(event)
                except Exception:
                    log.exception("handler from %s failed on %s", owner, event.type)
