import queue
import threading
import time
import unittest

from edith.core import Context, EventBus, Job, JobRunner, Ports, Registry


class JobRunnerTest(unittest.TestCase):
    def test_job_sets_its_own_wait_and_stop_is_prompt(self):
        ran = threading.Event()
        calls = []

        def run():
            calls.append(1)
            ran.set()
            return 3600  # nothing due for an hour: stop() must not wait for it

        runner = JobRunner([Job("t.slow", run, "t")])
        runner.start()
        self.assertTrue(ran.wait(2))
        runner.stop(timeout=2)
        self.assertFalse(any(t.is_alive() for t in runner._threads))
        self.assertEqual(calls, [1])

    def test_failures_back_off_and_do_not_kill_the_job(self):
        calls, done = [], threading.Event()

        def flaky():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("boom")  # retried after the backoff
            done.set()
            return 3600

        runner = JobRunner([Job("t.flaky", flaky, "t")], backoff=0.01)
        runner.start()
        self.assertTrue(done.wait(5))
        runner.stop(timeout=2)
        self.assertEqual(len(calls), 2)


class WorkerTest(unittest.TestCase):
    def worker(self, handle, maxsize=10):
        registry = Registry()
        submit = Context("f", EventBus(), Ports(), registry, {}).add_worker("w", handle, maxsize)
        return submit, JobRunner(list(registry.jobs.values()))

    def test_items_in_order_failures_isolated_and_limit(self):
        seen, done = [], threading.Event()

        def handle(item):
            if item == "bad":
                raise ValueError(item)
            seen.append(item)
            if item == "last":
                done.set()

        submit, runner = self.worker(handle, maxsize=4)
        for item in ("a", "bad", "b", "last"):
            submit(item)
        with self.assertRaises(queue.Full):  # nothing is consumed before start()
            submit("one too many")
        with self.assertLogs("edith.jobs", "ERROR"):
            runner.start()
            self.assertTrue(done.wait(5))
        runner.stop(timeout=2)
        self.assertEqual(seen, ["a", "b", "last"])

    def test_idle_worker_stops_at_once(self):
        submit, runner = self.worker(lambda item: None)
        runner.start()
        started = time.monotonic()
        runner.stop(timeout=2)
        self.assertLess(time.monotonic() - started, 0.2)  # woken by the sentinel, not a timeout
        self.assertFalse(any(t.is_alive() for t in runner._threads))
