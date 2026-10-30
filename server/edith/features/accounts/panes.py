"""The Claude Code processes a switch must restart, read without touching them.

- Agents: every tmux pane on the default socket whose process is Claude. Claude writes
  <claude_dir>/sessions/<pid>.json with its sessionId and cwd, which is how each gets resumed.
- EDITH herself (edith-claude, `tmux -L edith`) is restarted through her service, not here.
- Any other running Claude (one with a sessions file that is neither) blocks a switch: it would
  keep the old login and write it back.

Read-only: `tmux list-panes` and `capture-pane`, never keys.
"""
import json
import os
import re
import subprocess

from edith.common.claude_screen import read_screen

SESSION_ID = re.compile(r"^[0-9a-f-]{36}$")


def children(pid: int) -> list[int]:
    out = []
    try:
        for tid in os.listdir(f"/proc/{pid}/task"):
            with open(f"/proc/{pid}/task/{tid}/children") as f:
                out += [int(c) for c in f.read().split()]
    except OSError:
        pass
    return out


class Panes:
    def __init__(self, claude_dir: str, tmux="tmux", socket=None, edith_socket="edith", run=subprocess.run,
                 children=children, alive=None, timeout=5.0):
        self.claude_dir, self.timeout, self._run, self._children = claude_dir, timeout, run, children
        self.cmd = [tmux] + (["-L", socket] if socket else [])
        self.edith_cmd = [tmux, "-L", edith_socket]
        self._alive = alive or (lambda pid: os.path.exists(f"/proc/{pid}"))

    def _tmux(self, cmd, *args) -> str | None:
        try:
            r = self._run(cmd + list(args), capture_output=True, text=True, timeout=self.timeout)
        except (OSError, subprocess.TimeoutExpired):
            return None
        return r.stdout if r.returncode == 0 else None

    def _session(self, pid: int) -> dict | None:
        try:
            with open(os.path.join(self.claude_dir, "sessions", f"{pid}.json")) as f:
                d = json.load(f)
        except (OSError, ValueError):
            return None
        return d if isinstance(d, dict) else None

    def _claude_in(self, pane_pid: int) -> tuple[int, dict] | None:
        """The Claude process of a pane: the pane's own process (`exec claude`) or one of its children."""
        for pid in [pane_pid] + self._children(pane_pid):
            s = self._session(pid)
            if s:
                return pid, s
        return None

    def _pane_pids(self, cmd) -> list[tuple[str, str, int, str]]:
        out = self._tmux(cmd, "list-panes", "-a", "-F", "#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}")
        rows = []
        for row in (out or "").splitlines():
            parts = row.split("\t")
            if len(parts) == 4 and parts[2].isdigit():
                rows.append((parts[0], parts[1], int(parts[2]), parts[3]))
        return rows

    def agents(self) -> list[dict]:
        """[{name, pane, pid, cwd, session_id, state, blocked}] for the panes running Claude, by name."""
        found = []
        for name, pane, pane_pid, path in self._pane_pids(self.cmd):
            hit = self._claude_in(pane_pid)
            if not hit:
                continue
            pid, s = hit
            sid = s.get("sessionId") if SESSION_ID.match(str(s.get("sessionId") or "")) else None
            screen = self._tmux(self.cmd, "capture-pane", "-p", "-t", pane)
            seen = read_screen(screen) if screen is not None else {"state": "idle", "blocked": None}
            found.append({"name": name, "pane": pane, "pid": pid, "cwd": s.get("cwd") or path, "session_id": sid,
                          "state": seen["state"], "blocked": seen["blocked"]})
        return sorted(found, key=lambda a: (a["name"], a["pane"]))

    def others(self, known: set[int]) -> list[dict]:
        """Running Claudes that are neither an agent pane nor EDITH's: [{pid, cwd}]."""
        for _, _, pane_pid, _ in self._pane_pids(self.edith_cmd):
            known = known | {pane_pid, *self._children(pane_pid)}
        out = []
        try:
            names = os.listdir(os.path.join(self.claude_dir, "sessions"))
        except OSError:
            return []
        for name in names:
            if not name.endswith(".json") or not name[:-5].isdigit():
                continue
            pid = int(name[:-5])
            if pid in known or not self._alive(pid):
                continue
            out.append({"pid": pid, "cwd": (self._session(pid) or {}).get("cwd")})
        return out
