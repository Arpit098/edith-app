"""A few named, rescheduled-at-will timers on one thread (the accounts feature's switch retries, the
backup feature's hand-back checks). The thread sleeps on a Condition until the earliest one is due
or the set changes: no polling. It starts on the first schedule() and is a daemon, so it never
keeps the bridge up; stop() ends it at once."""
import heapq
import itertools
import logging
import threading
import time

log = logging.getLogger("edith.common.timer")


class Timers:
    def __init__(self, name: str, clock=time.time):
        self.name, self.clock = name, clock
        self._cond = threading.Condition()
        self._heap: list[tuple[float, int, str]] = []
        self._due: dict[str, tuple[float, int, object]] = {}  # key -> (at, seq, fn): the live entry
        self._seq = itertools.count()
        self._thread = None
        self._stopped = False

    def schedule(self, key: str, at: float, fn) -> None:
        """Run fn() at `at` (unix seconds), replacing any timer already under `key`."""
        with self._cond:
            seq = next(self._seq)
            self._due[key] = (at, seq, fn)
            heapq.heappush(self._heap, (at, seq, key))
            if self._thread is None and not self._stopped:
                self._thread = threading.Thread(target=self._run, name=f"timers:{self.name}", daemon=True)
                self._thread.start()
            self._cond.notify()

    def cancel(self, key: str) -> None:
        with self._cond:
            self._due.pop(key, None)  # its heap entry is skipped when it comes up
            self._cond.notify()

    def when(self, key: str) -> float | None:
        with self._cond:
            entry = self._due.get(key)
            return entry[0] if entry else None

    def stop(self) -> None:
        with self._cond:
            self._stopped = True
            self._cond.notify()

    def _run(self) -> None:
        while True:
            with self._cond:
                while True:
                    if self._stopped:
                        return
                    while self._heap and self._due.get(self._heap[0][2], (None, None))[1] != self._heap[0][1]:
                        heapq.heappop(self._heap)  # cancelled or rescheduled
                    if self._heap and self._heap[0][0] <= self.clock():
                        _, _, key = heapq.heappop(self._heap)
                        fn = self._due.pop(key)[2]
                        break
                    self._cond.wait(None if not self._heap else max(0.0, self._heap[0][0] - self.clock()))
            try:
                fn()
            except Exception:
                log.exception("timer %s:%s failed", self.name, key)
