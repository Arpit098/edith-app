"""bridge-state.json: small state shared by the parts of one process (Telegram offset, the
conversation per chat, session names, side-lane notes…), in the legacy bridge's format.

There is one StateFile per path per process (StateFile.at), so every user shares one lock. Reads
come from memory; each update is one atomic write (tmp + os.replace). Not fsynced, like legacy:
losing the last write in a power cut only means Telegram re-delivers an update.
"""
import copy
import json
import os
import threading

_files: dict[str, "StateFile"] = {}
_files_lock = threading.Lock()


class StateFile:
    @classmethod
    def at(cls, path: str) -> "StateFile":
        with _files_lock:
            if path not in _files:
                _files[path] = cls(path)
            return _files[path]

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.RLock()
        try:
            with open(path) as f:
                self._data = json.load(f)
        except (OSError, ValueError):
            self._data = {}

    def get(self, key, default=None):
        """A copy of one value, so callers can't change the state by accident."""
        with self._lock:
            return copy.deepcopy(self._data.get(key, default))

    def update(self, change):
        """Run change(state) under the lock (it may edit the dict in place), save, and return its result."""
        with self._lock:
            result = change(self._data)
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self._data, f)
            os.replace(tmp, self.path)
            return result
