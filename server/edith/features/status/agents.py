"""The coding agents: Claude Code sessions in tmux on the default socket (edith-dev, edith-app, …).

Read-only: `tmux list-panes` once and `tmux capture-pane` once per session, never send-keys, plus
the pane's Claude's session file (<claude_dir>/sessions/<pid>.json): a screen at its input box
while that file says Claude still works means its turn is over but background work it started (a
shell, a subagent) goes on: `waiting`. The result is cached for `ttl` seconds and computed by one
caller at a time, so the app can't make us hammer tmux. Each call has a timeout; a failure gives an
empty list and is logged, nothing more.
"""
import logging
import os
import subprocess
import threading
import time

from edith.common.claude_screen import read_screen
from edith.common.claude_sessions import children, in_pane, proc_stat

log = logging.getLogger("edith.feature.status")


def git_branch(path: str) -> str | None:
    """The branch checked out in `path` (or a short sha when detached), read from .git/HEAD
    without running git; worktrees (.git is a "gitdir:" file) included."""
    path = os.path.abspath(path or "/")
    while True:
        dot = os.path.join(path, ".git")
        try:
            if os.path.isfile(dot):
                with open(dot) as f:
                    gitdir = f.read().strip().removeprefix("gitdir:").strip()
                dot = os.path.join(path, gitdir)
            with open(os.path.join(dot, "HEAD")) as f:
                head = f.read().strip()
            return head.removeprefix("ref: refs/heads/") if head.startswith("ref:") else head[:7]
        except OSError:
            pass
        parent = os.path.dirname(path)
        if parent == path:
            return None
        path = parent


class Agents:
    def __init__(self, tmux="tmux", socket=None, ttl=5.0, timeout=3.0, run=subprocess.run, clock=time.monotonic,
                 claude_dir=os.path.expanduser("~/.claude"), children=children, stat=proc_stat):
        self.cmd = [tmux] + (["-L", socket] if socket else [])
        self.ttl, self.timeout, self._run, self._clock = ttl, timeout, run, clock
        self.claude_dir, self._children, self._stat = claude_dir, children, stat
        self._lock = threading.Lock()
        self._at, self._value = None, []

    def get(self) -> list[dict]:
        """[{name, dir, branch, state, blocked, last, background}] sorted by name; at most `ttl`
        seconds old. `background` is the session file's status while `state` is `waiting`."""
        with self._lock:
            if self._at is None or self._clock() - self._at >= self.ttl:
                self._value, self._at = self._read(), self._clock()
            return [dict(a) for a in self._value]

    def _tmux(self, *args):
        r = self._run(self.cmd + list(args), capture_output=True, text=True, timeout=self.timeout)
        return r.stdout if r.returncode == 0 else None

    def _read(self):
        try:
            out = self._tmux("list-panes", "-a", "-F", "#{window_active}#{pane_active}\t#{session_name}\t#{pane_id}"
                             "\t#{pane_current_path}\t#{pane_pid}")
        except (OSError, subprocess.TimeoutExpired) as e:
            log.warning("status: tmux list-panes failed: %s", e)
            return []
        panes = {}
        for row in (out or "").splitlines():  # None: no tmux server, so no agents
            parts = row.split("\t")
            if len(parts) == 5 and (parts[0] == "11" or parts[1] not in panes):  # the session's active pane
                panes[parts[1]] = (parts[2], parts[3], int(parts[4]) if parts[4].isdigit() else None)
        agents = []
        for name, (pane, cwd, pane_pid) in sorted(panes.items()):
            try:
                screen = self._tmux("capture-pane", "-p", "-t", pane)
            except (OSError, subprocess.TimeoutExpired) as e:
                log.warning("status: tmux capture-pane %s failed: %s", name, e)
                screen = None
            seen = read_screen(screen) if screen is not None else {"state": "idle", "blocked": None, "last": None}
            seen["background"] = None
            if seen["state"] == "idle" and pane_pid:
                hit = in_pane(self.claude_dir, pane_pid, self._children, self._stat)
                status = hit[1].get("status") if hit else None
                if status and status != "idle":
                    seen.update(state="waiting", background=str(status)[:20])
            agents.append({"name": name, "dir": os.path.basename(cwd.rstrip("/")) or cwd,
                           "branch": git_branch(cwd), **seen})
        return agents
