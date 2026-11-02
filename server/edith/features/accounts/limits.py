"""Which saved Claude accounts are at their limit, and until when: <state_dir>/accounts/limits.json
(in the private 700 folder, mode 600). Read once and cached; every change is one atomic write under
a lock. An account whose time has passed counts as free again (Claude's next error marks it again).

    {"<id>": {"kind": "usage_limit" | "login" | "billing", "until": 1793351234.5, "seen": 1793340000.0}}
"""
import json
import threading
import time

from .profiles import read_json, write_private

# How long an account counts as unavailable when Claude's text names no reset time.
DEFAULT_WAIT = {"usage_limit": 3600.0, "login": 6 * 3600.0, "billing": 6 * 3600.0}


class Limits:
    def __init__(self, path: str, ensure_dir=lambda: None, clock=time.time):
        self.path, self.clock, self._ensure_dir = path, clock, ensure_dir
        self._lock = threading.Lock()
        data = read_json(path)
        self._data = {k: v for k, v in data.items() if isinstance(v, dict)} if isinstance(data, dict) else {}

    def mark(self, account: str, kind: str, until: float | None) -> float:
        """Mark `account` unavailable until `until` (a default wait when None); -> that time."""
        now = self.clock()
        until = until if until and until > now else now + DEFAULT_WAIT.get(kind, 3600.0)
        with self._lock:
            self._data[account] = {"kind": kind, "until": until, "seen": now}
            self._save()
        return until

    def clear(self, account: str) -> None:
        with self._lock:
            if self._data.pop(account, None) is not None:
                self._save()

    def get(self, account: str) -> dict | None:
        """Its entry while it is still limited, else None."""
        with self._lock:
            entry = self._data.get(account)
        return dict(entry) if entry and float(entry.get("until") or 0) > self.clock() else None

    def free(self, accounts: list[str]) -> list[str]:
        return [a for a in accounts if self.get(a) is None]

    def next_free(self, accounts: list[str]) -> float | None:
        """The earliest time one of `accounts` stops being limited (None if one is free now)."""
        times = []
        for a in accounts:
            entry = self.get(a)
            if entry is None:
                return None
            times.append(float(entry["until"]))
        return min(times) if times else None

    def _save(self) -> None:
        now = self.clock()
        self._data = {k: v for k, v in self._data.items() if float(v.get("until") or 0) > now - 86400}
        self._ensure_dir()
        write_private(self.path, json.dumps(self._data).encode())
