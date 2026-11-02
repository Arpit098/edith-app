"""The backup providers in order, and when to skip one (contracts/backup.md, "Providers"):

- 429: skip it until Retry-After; with no Retry-After, until its daily reset when the quota for the
  day is gone, else for a minute.
- Down or slow (a timeout, a connection error, 5xx, an answer that can't be read): retry once at
  once, then move on to the next. After 3 such failures in a row, skip it for 10 minutes.
- Its key refused (401/403): skip it for an hour.
- Another 4xx (our request): move on (counted as a failure).
- A success clears its failures.

Skips and failure counts are kept in <state_dir>/backup/skips.json (600, atomic writes), so a
restart doesn't hammer a provider that said to wait. Nothing about keys is ever stored.
"""
import json
import logging
import os
import threading
import time

from edith.ports.llm import ProviderError

log = logging.getLogger("edith.feature.backup")

FAILURES_TO_SKIP = 3
SKIP_DOWN = 600.0     # seconds, after FAILURES_TO_SKIP failures in a row
SKIP_AUTH = 3600.0
SKIP_RATE = 60.0      # a 429 that says nothing about how long
MAX_SKIP = 2 * 86400  # never believe a Retry-After longer than this


class AllUnavailable(Exception):
    """No provider could answer. `reasons` is [(label, why, until or None)]; `next_at` the earliest
    skip end (or None)."""

    def __init__(self, reasons, next_at=None):
        super().__init__("; ".join(f"{label}: {why}" for label, why, _ in reasons) or "no backup AI is set up")
        self.reasons, self.next_at = reasons, next_at


def write_private(path, data: bytes):
    tmp = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


class Chain:
    def __init__(self, providers, path: str, clock=time.time, sleep=time.sleep):
        self.providers, self.path, self.clock, self.sleep = list(providers), path, clock, sleep
        self._lock = threading.Lock()
        try:
            with open(path) as f:
                data = json.load(f)
            self._state = {k: v for k, v in data.items() if isinstance(v, dict)} if isinstance(data, dict) else {}
        except (OSError, ValueError):
            self._state = {}

    # ---- state ----

    def _save(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        write_private(self.path, json.dumps(self._state).encode())

    def _entry(self, name):
        return self._state.setdefault(name, {"skip_until": 0.0, "failures": 0, "why": None})

    def skipped_until(self, name) -> float | None:
        with self._lock:
            until = float(self._state.get(name, {}).get("skip_until") or 0)
        return until if until > self.clock() else None

    def _skip(self, p, seconds, why):
        e = self._entry(p.name)
        e["skip_until"], e["why"], e["failures"] = self.clock() + min(max(seconds, 1.0), MAX_SKIP), why, 0
        log.warning("backup: skipping %s for %.0fs (%s)", p.name, seconds, why)

    def _record(self, p, err: ProviderError | None):
        """Apply the rules to one finished call (after its retry, for `down`)."""
        with self._lock:
            e = self._entry(p.name)
            if err is None:
                if e["failures"] or e["skip_until"]:
                    e.update(failures=0, skip_until=0.0, why=None)
                    self._save()
                return
            now = self.clock()
            if err.kind == "rate_limit":
                if err.retry_after is not None:
                    self._skip(p, err.retry_after, "rate limited")
                elif err.daily:
                    self._skip(p, p.daily_reset(now) - now, "daily quota used up")
                else:
                    self._skip(p, SKIP_RATE, "rate limited")
            elif err.kind == "auth":
                self._skip(p, SKIP_AUTH, "key refused")
            else:
                e["failures"] = int(e.get("failures") or 0) + 1
                e["why"] = "down" if err.kind == "down" else "error"
                if e["failures"] >= FAILURES_TO_SKIP:
                    self._skip(p, SKIP_DOWN, f"{FAILURES_TO_SKIP} failures in a row")
            self._save()

    # ---- use ----

    def status(self) -> list[dict]:
        """[{name, label, available, skipped_until, why}] in order (for /backup and GET /v1/backup)."""
        out = []
        for p in self.providers:
            until = self.skipped_until(p.name)
            with self._lock:
                why = self._state.get(p.name, {}).get("why") if until else None
            out.append({"name": p.name, "label": p.label, "available": p.available(), "skipped_until": until,
                        "why": why})
        return out

    def any_available(self) -> bool:
        return any(p.available() for p in self.providers)

    def call(self, messages, tools, timeout, prefer=None):
        """One chat call on the first usable provider (`prefer`, the one already answering this
        message, first), applying the rules. -> (provider, ChatReply). Raises AllUnavailable."""
        order = sorted(self.providers, key=lambda p: p is not prefer)
        reasons, next_at = [], []
        for p in order:
            if not p.available():
                reasons.append((p.label, "no key", None))
                continue
            until = self.skipped_until(p.name)
            if until:
                with self._lock:
                    why = self._state.get(p.name, {}).get("why") or "skipped"
                reasons.append((p.label, why, until))
                next_at.append(until)
                continue
            err = None
            for attempt in (1, 2):
                try:
                    reply = p.chat(messages, tools, timeout)
                except ProviderError as e:
                    err = e
                    if e.kind == "down" and attempt == 1:
                        log.info("backup: %s down (%s); retrying once", p.name, e.detail)
                        self.sleep(1.0)
                        continue
                    break
                self._record(p, None)
                return p, reply
            self._record(p, err)
            until = self.skipped_until(p.name)
            reasons.append((p.label, {"rate_limit": "rate limited", "auth": "key refused"}.get(err.kind, err.kind), until))
            if until:
                next_at.append(until)
        raise AllUnavailable(reasons, min(next_at) if next_at else None)
