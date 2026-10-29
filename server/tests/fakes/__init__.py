"""Stand-ins for the outside world, used by the tests (and once to record the legacy golden files)."""
from .claude import FAKE_CLAUDE, write_plan
from .telegram import FakeTelegram, callback, message
from .tmux import FakeTmux


def run_workers(registry):
    """Run every queued item of the registry's workers (ctx.add_worker) right here, in order, as
    their threads would: deterministic, and no waiting."""
    for job in registry.jobs.values():
        while job.queue is not None and not job.queue.empty():
            job.run(job.queue.get_nowait())


__all__ = ["FAKE_CLAUDE", "FakeTelegram", "FakeTmux", "callback", "message", "run_workers", "write_plan"]
