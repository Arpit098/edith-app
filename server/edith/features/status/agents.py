"""The coding agents: Claude Code sessions in tmux on the default socket (edith-dev, edith-app, …).

Read-only: `tmux list-panes` once and `tmux capture-pane` once per session, never send-keys. The
result is cached for `ttl` seconds and computed by one caller at a time, so the app can't make us
hammer tmux. Each call has a timeout; a failure gives an empty list and is logged, nothing more.
"""
import logging
import os
import re
import subprocess
import threading
import time

log = logging.getLogger("edith.feature.status")

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
BOX = re.compile(r"[─-▟]+")  # box drawing and block elements (borders, separators)
BOTTOM = 15  # lines at the end of the screen that hold Claude Code's prompt, footer and dialogs
PERMISSION = re.compile(r"Do you want to (?:proceed|make this edit|create|allow|run)|Would you like to proceed"
                        r"|❯\s*1\.\s*Yes", re.I)
USAGE_LIMIT = re.compile(r"usage limit reached|hit your limit|limit reached|limit will reset", re.I)
LAST_LINE = 100  # characters


def clean(line: str) -> str:
    return " ".join(BOX.sub(" ", ANSI.sub("", line)).split())


def read_screen(screen: str) -> dict:
    """What a Claude Code screen shows: {state: busy | idle | blocked, blocked: permission |
    usage_limit | None, last: the last "●" line or None}."""
    lines = [ln for ln in map(clean, screen.splitlines()) if ln]
    bottom = "\n".join(lines[-BOTTOM:])
    busy = "esc to interrupt" in bottom.lower()
    blocked = ("permission" if PERMISSION.search(bottom)
               else "usage_limit" if not busy and USAGE_LIMIT.search(bottom) else None)
    last = next((ln[1:].strip() for ln in reversed(lines) if ln.startswith("●")), None)
    if last and len(last) > LAST_LINE:
        last = last[:LAST_LINE - 1].rstrip() + "…"
    return {"state": "blocked" if blocked else "busy" if busy else "idle", "blocked": blocked, "last": last}


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
    def __init__(self, tmux="tmux", socket=None, ttl=5.0, timeout=3.0, run=subprocess.run, clock=time.monotonic):
        self.cmd = [tmux] + (["-L", socket] if socket else [])
        self.ttl, self.timeout, self._run, self._clock = ttl, timeout, run, clock
        self._lock = threading.Lock()
        self._at, self._value = None, []

    def get(self) -> list[dict]:
        """[{name, dir, branch, state, blocked, last}] sorted by name; at most `ttl` seconds old."""
        with self._lock:
            if self._at is None or self._clock() - self._at >= self.ttl:
                self._value, self._at = self._read(), self._clock()
            return [dict(a) for a in self._value]

    def _tmux(self, *args):
        r = self._run(self.cmd + list(args), capture_output=True, text=True, timeout=self.timeout)
        return r.stdout if r.returncode == 0 else None

    def _read(self):
        try:
            out = self._tmux("list-panes", "-a", "-F",
                             "#{window_active}#{pane_active}\t#{session_name}\t#{pane_id}\t#{pane_current_path}")
        except (OSError, subprocess.TimeoutExpired) as e:
            log.warning("status: tmux list-panes failed: %s", e)
            return []
        panes = {}
        for row in (out or "").splitlines():  # None: no tmux server, so no agents
            parts = row.split("\t")
            if len(parts) == 4 and (parts[0] == "11" or parts[1] not in panes):  # the session's active pane
                panes[parts[1]] = (parts[2], parts[3])
        agents = []
        for name, (pane, cwd) in sorted(panes.items()):
            try:
                screen = self._tmux("capture-pane", "-p", "-t", pane)
            except (OSError, subprocess.TimeoutExpired) as e:
                log.warning("status: tmux capture-pane %s failed: %s", name, e)
                screen = None
            seen = read_screen(screen) if screen is not None else {"state": "idle", "blocked": None, "last": None}
            agents.append({"name": name, "dir": os.path.basename(cwd.rstrip("/")) or cwd,
                           "branch": git_branch(cwd), **seen})
        return agents
