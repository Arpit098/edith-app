"""Reminder store: ~/.cache/edith/reminders.json, shared by remind.py (cli.py, which EDITH uses to
add, list and cancel reminders), this feature, and until step 6 the legacy bridge (through the
wrapper at ~/edith/bridge/reminders.py, which re-exports the module-level functions at the bottom).

The file format, times (IST) and rules are unchanged from legacy/edith/bridge/reminders.py:
one-off reminders stay in the file for 2 days after firing so Snooze/Done still work.

Changes from legacy:
- Reads take no lock and never write. Writes are atomic, so a read always sees a whole file. The
  parsed list is cached and re-parsed only when the file changes (inode, mtime, size).
- Writes hold the lock for the whole read-modify-write, and skip writing when nothing changed.
  (Legacy rewrote the file on every read and every 15 s tick.)
- A heap of (when, id) answers "is anything due?" without locking or scanning, so pop_due() is
  free when nothing is due and the firing job can sleep until the next due time.
- A corrupt file is moved aside (reminders.json.corrupt-<time>) instead of being overwritten.
"""
import calendar
import fcntl
import heapq
import json
import logging
import os
import secrets
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from edith.common.paths import resolve

log = logging.getLogger("edith.feature.reminders")

TZ = ZoneInfo("Asia/Kolkata")
REPEATS = ("daily", "weekdays", "weekly", "monthly")
KEEP_FIRED = 2 * 86400


def fmt(ts):
    return datetime.fromtimestamp(ts, TZ).strftime("%a %d %b, %H:%M")


def next_due(due, every, now=None):
    now = now or time.time()
    dt = datetime.fromtimestamp(due, TZ)
    while dt.timestamp() <= now:
        if every == "daily":
            dt += timedelta(days=1)
        elif every == "weekdays":
            dt += timedelta(days=1)
            while dt.weekday() >= 5:
                dt += timedelta(days=1)
        elif every == "weekly":
            dt += timedelta(days=7)
        elif every == "monthly":
            y, m = (dt.year + 1, 1) if dt.month == 12 else (dt.year, dt.month + 1)
            dt = dt.replace(year=y, month=m, day=min(dt.day, calendar.monthrange(y, m)[1]))
        else:
            raise ValueError(f"unknown repeat: {every}")
    return dt.timestamp()


def tomorrow_at(hour=9):
    dt = datetime.now(TZ) + timedelta(days=1)
    return dt.replace(hour=hour, minute=0, second=0, microsecond=0).timestamp()


def _wake_time(r):
    """When a reminder next needs attention: its due time, or for a fired one-off, when it expires."""
    return r["fired"] + KEEP_FIRED if r.get("fired") else r["due"]


class Store:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()  # guards the cache; one Store may be shared by several threads
        self._key = None               # (inode, mtime_ns, size) of the file the cache came from
        self._items: list[dict] = []   # never mutated in place; replaced as a whole
        self._by_id: dict[str, dict] = {}
        self._heap: list[tuple[float, str]] = []
        self._corrupt = False          # the file exists but isn't valid JSON

    # ---- reading (no lock, no writes) ----

    def _read(self) -> list[dict]:
        """The current items, re-parsed only if the file changed since the last call."""
        try:
            st = os.stat(self.path)
            key = (st.st_ino, st.st_mtime_ns, st.st_size)
        except FileNotFoundError:
            key = None
        with self._lock:
            if key != self._key:
                key, items = self._parse()
                self._cache(key, items)
            return self._items

    def _parse(self):
        try:
            with open(self.path) as f:
                st = os.fstat(f.fileno())  # the key of the file actually read, even if it was just replaced
                key = (st.st_ino, st.st_mtime_ns, st.st_size)
                try:
                    return key, json.load(f)
                except ValueError:
                    return key, None  # corrupt: _modify() moves it aside before writing
        except FileNotFoundError:
            return None, []

    def _cache(self, key, items):
        self._key = key
        self._items = items if items is not None else []
        self._corrupt = items is None
        self._by_id = {r["id"]: r for r in self._items}
        self._heap = [(_wake_time(r), r["id"]) for r in self._items]
        heapq.heapify(self._heap)

    def pending(self):
        return sorted((dict(r) for r in self._read() if not r.get("fired")), key=lambda r: r["due"])

    def get(self, rid):
        self._read()
        r = self._by_id.get(rid)
        return dict(r) if r else None

    def next_wake(self, now=None):
        """Seconds until a reminder is due or a fired one expires (0 if overdue), None if there are none."""
        self._read()
        heap = self._heap
        return max(0.0, heap[0][0] - (now or time.time())) if heap else None

    # ---- writing (exclusive lock across processes) ----

    @contextmanager
    def _modify(self):
        """Yield a copy of the items under an exclusive lock; changes are saved on exit, atomically."""
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path + ".lock", "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            current = self._read()
            if self._corrupt:
                aside = f"{self.path}.corrupt-{int(time.time())}"
                os.replace(self.path, aside)
                log.error("reminders file was not valid JSON; moved it to %s", aside)
            items = [dict(r) for r in current]
            yield items
            if items != current or self._corrupt:
                tmp = self.path + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(items, f, indent=1)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, self.path)
                st = os.stat(self.path)
                with self._lock:
                    self._cache((st.st_ino, st.st_mtime_ns, st.st_size), items)

    def add(self, due, text, every=None, chat_id=None):
        if every and every not in REPEATS:
            raise ValueError(f"repeat must be one of {REPEATS}")
        item = {"id": secrets.token_hex(3), "due": float(due), "text": text, "every": every,
                "chat_id": chat_id, "created": time.time()}
        with self._modify() as items:
            items.append(item)
        return item

    def cancel(self, rid):
        with self._modify() as items:
            for i, r in enumerate(items):
                if r["id"] == rid:
                    return items.pop(i)
        return None

    def snooze(self, rid, until):
        """Push a reminder to `until`. Repeating ones keep their schedule; a one-off copy is made."""
        with self._modify() as items:
            for r in items:
                if r["id"] == rid:
                    if r.get("every"):
                        copy = dict(r, id=secrets.token_hex(3), every=None, due=float(until))
                        items.append(copy)
                        return copy
                    r["due"] = float(until)
                    r.pop("fired", None)
                    return r
        return None

    def pop_due(self, now=None):
        """Return reminders that are due (as they were before firing) and advance/mark them."""
        now = now or time.time()
        self._read()
        if not self._heap or self._heap[0][0] > now:
            return []  # nothing due or expiring: no lock, no write
        fired = []
        with self._modify() as items:
            for r in list(items):
                if r.get("fired"):
                    if now - r["fired"] > KEEP_FIRED:
                        items.remove(r)
                    continue
                if r["due"] <= now:
                    fired.append(dict(r))
                    if r.get("every"):
                        r["due"] = next_due(r["due"], r["every"], now)
                    else:
                        r["fired"] = now
        return fired


# ---- The legacy module API (reminders.FILE, reminders.pending(), …) for the wrapper ----
# The path follows the environment (HOME, EDITH_STATE_DIR) at call time, not import time, so a
# test (or a second copy) with its own HOME never touches the live file.

_default = None


def default_store():
    global _default
    path = resolve().reminders
    if _default is None or _default.path != path:
        _default = Store(path)
    return _default


def __getattr__(name):
    if name == "FILE":
        return resolve().reminders
    raise AttributeError(name)


def locked():
    return default_store()._modify()


def add(due, text, every=None, chat_id=None):
    return default_store().add(due, text, every, chat_id)


def pending():
    return default_store().pending()


def cancel(rid):
    return default_store().cancel(rid)


def snooze(rid, until):
    return default_store().snooze(rid, until)


def pop_due(now=None):
    return default_store().pop_due(now)


__all__ = ["FILE", "KEEP_FIRED", "REPEATS", "TZ", "Store", "add", "cancel", "default_store", "fmt", "locked",
           "next_due", "pending", "pop_due", "snooze", "tomorrow_at"]
