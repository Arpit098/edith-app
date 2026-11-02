"""The backup's own state, <state_dir>/backup/state.json (folder 700, file 600, atomic writes):
the mode, whether it is answering and why, the hand-back schedule, its last messages (its own only:
never Claude's, so mail and calendar replies can't reach a provider) and Claude's queue."""
import copy
import json
import os
import threading

from .chain import write_private

MAX_QUEUE = 20
MAX_HISTORY = 10
DEFAULT = {"mode": "auto", "active": False, "since": None, "reason": None, "kind": None, "resets": None,
           "provider": None, "next_check": None, "attempt": 0, "history": [], "queue": []}


class Store:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.RLock()
        try:
            with open(path) as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {}
        self._data = {**copy.deepcopy(DEFAULT), **(data if isinstance(data, dict) else {})}

    def get(self, key=None):
        with self._lock:
            return copy.deepcopy(self._data if key is None else self._data.get(key))

    def update(self, change):
        """change(state) under the lock (it edits in place); saved at once. -> its result."""
        with self._lock:
            result = change(self._data)
            self._data["history"] = self._data["history"][-MAX_HISTORY:]
            os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
            write_private(self.path, json.dumps(self._data).encode())
            return result

    def set(self, **values):
        self.update(lambda s: s.update(values))
