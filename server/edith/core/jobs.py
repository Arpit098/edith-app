"""Runs features' background jobs: one thread per job, each sleeping on a shared stop Event until
its next run, so shutdown is immediate and no thread outlives stop()."""
import logging
import threading

from .context import Job

log = logging.getLogger("edith.jobs")

MAX_BACKOFF = 300.0  # seconds; a job that keeps failing is retried at most this far apart


class JobRunner:
    def __init__(self, jobs: list[Job], backoff: float = 2.0):
        self.jobs = list(jobs)
        self.backoff = backoff  # first retry after a failure; doubles up to MAX_BACKOFF
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        for job in self.jobs:
            t = threading.Thread(target=self._loop, args=(job,), name=f"job:{job.name}", daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout)

    def _loop(self, job: Job) -> None:
        failures = 0
        while not self._stop.is_set():
            try:
                wait = max(0.0, float(job.run()))
                failures = 0
            except Exception:
                failures += 1
                wait = min(MAX_BACKOFF, self.backoff * 2 ** (failures - 1))
                log.exception("job %s failed (%d in a row); retrying in %.0fs", job.name, failures, wait)
            self._stop.wait(wait)
