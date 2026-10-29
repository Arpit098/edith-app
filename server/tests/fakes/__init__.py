"""Stand-ins for the outside world, shared by legacy golden recordings and tests of the new code."""
from .claude import FAKE_CLAUDE, write_plan
from .telegram import FakeTelegram, callback, message
from .tmux import FakeTmux

__all__ = ["FAKE_CLAUDE", "FakeTelegram", "FakeTmux", "callback", "message", "write_plan"]
