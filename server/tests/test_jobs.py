import threading
import unittest

from edith.core import Job, JobRunner


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
