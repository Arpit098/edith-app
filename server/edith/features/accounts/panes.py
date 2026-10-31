"""The Claude Code processes a switch must restart, read without touching them.

Claude writes <claude_dir>/sessions/<pid>.json for every running Claude: its sessionId, cwd,
procStart (the process's start time, field 22 of /proc/<pid>/stat) and status (`idle` when it has
nothing to do; `busy`, `shell`… while it works, background subagents and shells included).

- Agents: every tmux pane on the default socket whose process is Claude, resumed by its session id.
- EDITH (edith-claude, `tmux -L edith`): restarted through her service, but her status counts too.
- Any other running Claude blocks a switch: it would keep the old login and write it back.

Read-only: `tmux list-panes` and `capture-pane`, never keys.
"""
import os
import re
import subprocess

from edith.common.claude_screen import read_screen
from edith.common.claude_sessions import children, proc_stat, read_session

SESSION_ID = re.compile(r"^[0-9a-f-]{36}$")


class Panes:
    def __init__(self, claude_dir: str, tmux="tmux", socket=None, edith_socket="edith", run=subprocess.run,
                 children=children, stat=proc_stat, timeout=5.0):
        self.claude_dir, self.timeout, self._run, self._children, self._stat = claude_dir, timeout, run, children, stat
        self.cmd = [tmux] + (["-L", socket] if socket else [])
        self.edith_cmd = [tmux, "-L", edith_socket]

    def _tmux(self, cmd, *args) -> str | None:
        try:
            r = self._run(cmd + list(args), capture_output=True, text=True, timeout=self.timeout)
        except (OSError, subprocess.TimeoutExpired):
            return None
        return r.stdout if r.returncode == 0 else None

    def session(self, pid: int) -> dict | None:
        """A live Claude's session file (None if there is none, or the pid is no longer that Claude)."""
        return read_session(self.claude_dir, pid, self._stat)

    def _claude_in(self, pane_pid: int) -> tuple[int, dict] | None:
        """The Claude process of a pane: the pane's own process (`exec claude`) or one of its children."""
        for pid in [pane_pid] + self._children(pane_pid):
            s = self.session(pid)
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
        """[{name, pane, pid, proc_start, cwd, session_id, status, state, blocked}] for the panes
        running Claude, by name. `status` is the session file's; `state`/`blocked` what the screen shows."""
        found = []
        for name, pane, pane_pid, path in self._pane_pids(self.cmd):
            hit = self._claude_in(pane_pid)
            if not hit:
                continue
            pid, s = hit
            sid = s.get("sessionId") if SESSION_ID.match(str(s.get("sessionId") or "")) else None
            screen = self._tmux(self.cmd, "capture-pane", "-p", "-t", pane)
            seen = read_screen(screen) if screen is not None else {"state": "idle", "blocked": None}
            found.append({"name": name, "pane": pane, "pid": pid, "proc_start": str(s.get("procStart") or "") or None,
                          "cwd": s.get("cwd") or path, "session_id": sid, "status": s.get("status"), "comm": s["comm"],
                          "state": seen["state"], "blocked": seen["blocked"]})
        return sorted(found, key=lambda a: (a["name"], a["pane"]))

    def edith(self) -> list[dict]:
        """EDITH's Claude (under `tmux -L edith`): [{pid, status}] (empty while she's down)."""
        out = []
        for _, _, pane_pid, _ in self._pane_pids(self.edith_cmd):
            hit = self._claude_in(pane_pid)
            if hit:
                out.append({"pid": hit[0], "status": hit[1].get("status"), "comm": hit[1]["comm"]})
        return out

    def others(self, known: set[int]) -> list[dict]:
        """Running Claudes that are neither in `known` nor EDITH's: [{pid, cwd}]."""
        for _, _, pane_pid, _ in self._pane_pids(self.edith_cmd):
            known = known | {pane_pid, *self._children(pane_pid)}
        out = []
        try:
            names = os.listdir(os.path.join(self.claude_dir, "sessions"))
        except OSError:
            return []
        for name in names:
            if not name.endswith(".json") or not name[:-5].isdigit() or int(name[:-5]) in known:
                continue
            s = self.session(int(name[:-5]))  # None: that Claude has ended (a stale file)
            if s is not None:
                out.append({"pid": int(name[:-5]), "cwd": s.get("cwd")})
        return sorted(out, key=lambda o: o["pid"])

    def blockers(self) -> tuple[list[dict], list[str]]:
        """The agents, and why the Claudes can't be restarted now (empty when all are idle). A status
        other than `idle` (unknown ones included) counts as busy."""
        agents, why = self.agents(), []
        for a in agents:
            if a["comm"] != "claude":
                why.append(f"{a['name']}'s process isn't named claude ({a['comm']}), so it can't be checked")
            elif a["blocked"] == "permission":
                why.append(f"{a['name']} is waiting for approval")
            elif a["state"] == "busy" or a["status"] != "idle":
                why.append(f"{a['name']} is busy")
        edith = self.edith()
        if any(e["comm"] != "claude" for e in edith):
            why.append("EDITH's process isn't named claude, so it can't be checked")
        elif any(e["status"] != "idle" for e in edith):
            why.append("EDITH's Claude is busy (background work)")
        for o in self.others({a["pid"] for a in agents}):
            why.append(f"another Claude is running (pid {o['pid']}{', in ' + o['cwd'] if o.get('cwd') else ''})")
        return agents, why
