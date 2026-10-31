"""Claude Code's own record of its running processes: <claude_dir>/sessions/<pid>.json, one per
running Claude, with its sessionId, cwd, procStart (field 22 of /proc/<pid>/stat) and status (`idle`
when it has nothing to do; `busy`, `shell`… while it works, background subagents and shells
included). Read-only; used by account switching (must every Claude be idle?) and the status panel
(is a Claude whose turn ended still running background work?).
"""
import json
import os


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


def read_session(claude_dir: str, pid: int, stat=proc_stat) -> dict | None:
    """A live Claude's session file, with `comm` added (None if there is none, or the pid is no
    longer that Claude)."""
    try:
        with open(os.path.join(claude_dir, "sessions", f"{pid}.json")) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(d, dict):
        return None
    comm = same_process(pid, d.get("procStart"), stat)
    return dict(d, comm=comm) if comm is not None else None


def in_pane(claude_dir: str, pane_pid: int, children=children, stat=proc_stat) -> tuple[int, dict] | None:
    """The Claude of a tmux pane: the pane's own process (`exec claude`) or one of its children."""
    for pid in [pane_pid] + children(pane_pid):
        s = read_session(claude_dir, pid, stat)
        if s:
            return pid, s
    return None


def by_session_id(claude_dir: str, session_id: str, stat=proc_stat) -> dict | None:
    """The live Claude running conversation `session_id` (its session file), or None."""
    try:
        names = os.listdir(os.path.join(claude_dir, "sessions"))
    except OSError:
        return None
    for name in names:
        if name.endswith(".json") and name[:-5].isdigit():
            s = read_session(claude_dir, int(name[:-5]), stat)
            if s and s.get("sessionId") == session_id:
                return s
    return None
