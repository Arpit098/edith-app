"""Who is looking: whether the EDITH app is connected right now (the App API answers; contracts/push.md)."""
from typing import Protocol


class Presence(Protocol):
    def app_clients(self, wait: float = 3.0) -> int:
        """How many app /v1/stream clients answer now. May block up to `wait` s (a ping to quiet ones)."""
