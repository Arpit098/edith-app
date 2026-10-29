"""Where EDITH keeps its files, in one place.

The defaults are today's live locations, so the new code and the legacy bridge share the same
files. Every root can be moved, so a staging copy can run beside the live one
(docs/PHASE1_PLAN.md, step 6). A value in config.toml wins, then the environment, then the default:

| Root          | config key     | env var              | default                         |
|---------------|----------------|----------------------|---------------------------------|
| work_dir      | `work_dir`     | `EDITH_WORK_DIR`     | ~/edith                         |
| state_dir     | `state_dir`    | `EDITH_STATE_DIR`    | ~/.cache/edith                  |
| perm_dir      | `perm_dir`     | `EDITH_PERM_DIR`     | <state_dir>/perms               |
| telegram_dir  | `telegram_dir` | `TELEGRAM_STATE_DIR` | ~/.claude/channels/telegram     |
| google_dir    | `google_dir`   | `EDITH_GOOGLE_DIR`   | ~/.config/edith-google          |

EDITH_PERM_DIR and TELEGRAM_STATE_DIR are the names the legacy code already reads.
"""
import os
import re
from dataclasses import dataclass
from typing import Mapping

ROOTS = {  # name -> (env var, default; None means derived below)
    "work_dir": ("EDITH_WORK_DIR", "~/edith"),
    "state_dir": ("EDITH_STATE_DIR", "~/.cache/edith"),
    "perm_dir": ("EDITH_PERM_DIR", None),
    "telegram_dir": ("TELEGRAM_STATE_DIR", "~/.claude/channels/telegram"),
    "google_dir": ("EDITH_GOOGLE_DIR", "~/.config/edith-google"),
}


@dataclass(frozen=True)
class Paths:
    work_dir: str
    state_dir: str
    perm_dir: str
    telegram_dir: str
    google_dir: str
    home: str

    # Files shared with the legacy bridge and hooks; their formats must not change in Phase 1.
    @property
    def bridge_state(self) -> str:
        return os.path.join(self.state_dir, "bridge-state.json")

    @property
    def tmux_session(self) -> str:
        return os.path.join(self.state_dir, "tmux-session.json")

    @property
    def tmux_events(self) -> str:
        return os.path.join(self.state_dir, "tmux-events.jsonl")

    @property
    def tmux_run(self) -> str:
        return os.path.join(self.state_dir, "tmux-run")

    @property
    def reminders(self) -> str:
        return os.path.join(self.state_dir, "reminders.json")

    @property
    def changes_dir(self) -> str:
        return os.path.join(self.state_dir, "changes")

    @property
    def inbox(self) -> str:
        return os.path.join(self.work_dir, "inbox")

    @property
    def transcripts(self) -> str:
        """Claude Code's folder of session transcripts (<id>.jsonl) for work_dir."""
        return os.path.join(self.home, ".claude/projects", re.sub(r"[^A-Za-z0-9]", "-", self.work_dir))


def resolve(config: Mapping[str, str] | None = None, env: Mapping[str, str] | None = None) -> Paths:
    config = config or {}
    env = os.environ if env is None else env
    home = env.get("HOME") or os.path.expanduser("~")

    def expand(p: str) -> str:
        return os.path.abspath(home + p[1:] if p == "~" or p.startswith("~/") else p)

    found = {}
    for name, (var, default) in ROOTS.items():
        value = config.get(name) or env.get(var) or default
        found[name] = expand(value) if value else None
    found["perm_dir"] = found["perm_dir"] or os.path.join(found["state_dir"], "perms")
    return Paths(home=home, **found)
