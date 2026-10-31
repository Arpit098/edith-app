"""The Claude Code processes a switch must restart, read without touching them.

Claude writes <claude_dir>/sessions/<pid>.json for every running Claude: its sessionId, cwd,
procStart (the process's start time, field 22 of /proc/<pid>/stat) and status (`idle` when it has
nothing to do; `busy`, `shell`… while it works, background subagents and shells included).

- Agents: every tmux pane on the default socket whose process is Claude, resumed by its session id.
- EDITH (edith-claude, `tmux -L edith`): restarted through her service, but her status counts too.
- A Claude whose screen shows its usage limit doesn't block, whatever its status says (the turn the
  limit cut off): that is the moment a switch is for. A permission prompt or real work still does.
- Any other running Claude blocks a switch: it would keep the old login and write it back.

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


def proc_stat(pid: int) -> tuple[str, str] | None:
    """(comm, start time) of a process from /proc/<pid>/stat, or None if it's gone."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            stat = f.read()
    except OSError:
        return None
    comm = stat[stat.index("(") + 1:stat.rindex(")")]
    fields = stat[stat.rindex(")") + 2:].split()
    return comm, fields[19]  # field 22 overall: the 20th after "pid (comm)"


def same_process(pid: int, proc_start, stat=proc_stat) -> str | None:
    """The process name of `pid` if it is still the process that wrote its session file (its start
    time is the file's procStart, so the pid wasn't reused), else None. The name isn't required to be
    "claude": a Claude under another name must still count, or a switch would go ahead around it."""
    seen = stat(pid)
    if not seen or (proc_start not in (None, "") and seen[1] != str(proc_start)):
        return None
    return seen[0]


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
        try:
            with open(os.path.join(self.claude_dir, "sessions", f"{pid}.json")) as f:
                d = json.load(f)
        except (OSError, ValueError):
            return None
        if not isinstance(d, dict):
            return None
        comm = same_process(pid, d.get("procStart"), self._stat)
        return dict(d, comm=comm) if comm is not None else None

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
            seen = self._screen(self.cmd, pane)
            found.append({"name": name, "pane": pane, "pid": pid, "proc_start": str(s.get("procStart") or "") or None,
                          "cwd": s.get("cwd") or path, "session_id": sid, "status": s.get("status"), "comm": s["comm"],
                          "state": seen["state"], "blocked": seen["blocked"]})
        return sorted(found, key=lambda a: (a["name"], a["pane"]))

    def _screen(self, cmd, pane) -> dict:
        screen = self._tmux(cmd, "capture-pane", "-p", "-t", pane)
        return read_screen(screen) if screen is not None else {"state": "idle", "blocked": None}

    def edith(self) -> list[dict]:
        """EDITH's Claude (under `tmux -L edith`): [{pid, status, comm, state, blocked}] (empty while
        she's down). Her screen is only read (capture-pane), never typed into."""
        out = []
        for _, pane, pane_pid, _ in self._pane_pids(self.edith_cmd):
            hit = self._claude_in(pane_pid)
            if hit:
                seen = self._screen(self.edith_cmd, pane)
                out.append({"pid": hit[0], "status": hit[1].get("status"), "comm": hit[1]["comm"],
                            "state": seen["state"], "blocked": seen["blocked"]})
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

    @staticmethod
    def _why_busy(name, c) -> str | None:
        """Why the Claude `c` (an agent or EDITH's) can't be restarted now, or None if it can. A
        status other than `idle` (unknown ones included) counts as busy, unless its screen shows the
        usage limit: then the status is only the turn the limit interrupted, and a switch is what
        gets it going again."""
        if c["blocked"] == "permission":
            return f"{name} is waiting for approval"
        if c["blocked"] == "usage_limit":
            return None
        if c["state"] == "busy":
            return f"{name} is working (not at the limit)"
        if c["status"] != "idle":
            return f"{name} has background work running (not at the limit)"
        return None

    def blockers(self) -> tuple[list[dict], list[str], list[dict]]:
        """The agents; why the Claudes can't be restarted now (empty when they can); and the ones at
        their usage limit, [{name, interrupted}] ("EDITH" for her), `interrupted` when the limit
        stopped a turn (its session file isn't idle), which `--resume` doesn't re-send."""
        agents, why, at_limit = self.agents(), [], []
        found = [(a["name"], a) for a in agents] + [("EDITH", e) for e in self.edith()]
        for name, c in found:
            if c["comm"] != "claude":
                why.append(f"{name}'s process isn't named claude ({c['comm']}), so it can't be checked")
                continue
            reason = self._why_busy(name if name != "EDITH" else "EDITH's Claude", c)
            if reason:
                why.append(reason)
            elif c["blocked"] == "usage_limit":
                at_limit.append({"name": name, "interrupted": c["status"] != "idle"})
        for o in self.others({a["pid"] for a in agents}):
            why.append(f"another Claude is running (pid {o['pid']}{', in ' + o['cwd'] if o.get('cwd') else ''})")
        return agents, why, at_limit
