"""Background work of the tmux Claude, read from its transcript (contracts/status.md, "Background").

A turn can end (Stop hook, reply sent) while work it started goes on: a Bash command or an Agent
run with `run_in_background`. Claude Code writes, in the transcript:
- the assistant's tool_use, with `input.run_in_background` and a `description`: the job starts;
  an Agent call without it is async by default now, so it starts when its tool_result says
  `toolUseResult.status` "async_launched" (a foreground agent's result is its answer instead);
- its tool_result: `toolUseResult.backgroundTaskId` (a shell) or `agentId` (an agent), the job's
  task id; an error result means it never started;
- later a user entry (`origin.kind` "task-notification") holding
  `<task-notification><task-id>…</task-id><tool-use-id>…</tool-use-id><status>…</status>`: it ended
  (completed, failed, stopped or killed). A resumed conversation's notice of orphans may name
  several task ids and no tool-use id;
- a TaskStop / KillShell / KillBash tool_use naming the task id, which ends it once its result is ok.

Background.feed() takes entries in order and says whether the set of jobs changed. Only parsing
here; the live view feeds it and checks it against Claude's own session file (a missed
notification, or Claude restarting, can't leave a job "running" for good).
"""
import datetime as dt
import re

MAX_JOBS = 50
LABEL = 80  # characters
NOTIFICATION = re.compile(r"<task-notification>(.*?)</task-notification>", re.S)
FIELD = re.compile(r"<(task-id|tool-use-id|status)>\s*([^<]*?)\s*</\1>")
HEADER_END = re.compile(r"<(?:summary|result)>")  # free text starts here
AGENTS = ("Agent", "Task")
KINDS = {"Bash": "shell", "Agent": "agent", "Task": "agent"}
STOPPERS = ("TaskStop", "KillShell", "KillBash")


def truthy(v):
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")


def entry_ts(e):
    try:
        return dt.datetime.fromisoformat(e["timestamp"]).timestamp()
    except (KeyError, TypeError, ValueError):
        return None


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and isinstance(b.get("text"), str))
    return ""


def notifications(content):
    """[(task ids, tool-use id or None, status or None)] for each <task-notification> in a user entry.
    Only its header is read, before the first <summary> or <result>: those hold free text (a
    subagent's answer) that may quote the tags, which must not add ids or change the fields."""
    out = []
    for block in NOTIFICATION.findall(text_of(content)):
        header = HEADER_END.split(block, 1)[0]
        fields = [(k, v) for k, v in FIELD.findall(header) if v]
        tasks = list(dict.fromkeys(v for k, v in fields if k == "task-id"))
        one = {}
        for k, v in fields:
            one.setdefault(k, v)  # the first value of each field
        out.append((tasks, one.get("tool-use-id"), one.get("status")))
    return out


def is_async_launch(e):
    r = e.get("toolUseResult")
    return isinstance(r, dict) and (r.get("status") == "async_launched" or r.get("isAsync") is True)


def label_of(name, inp):
    text = inp.get("description") or (inp.get("command") if name == "Bash" else inp.get("prompt")) or name
    line = next((ln.strip() for ln in str(text).splitlines() if ln.strip()), name)
    return line if len(line) <= LABEL else line[:LABEL - 1].rstrip() + "…"


class Background:
    def __init__(self):
        self._jobs: dict[str, dict] = {}       # tool_use id -> {id, kind, label, started, task}
        self._stops: dict[str, str] = {}       # a stopper's tool_use id -> the task id it stops
        self._agents: dict[str, dict] = {}     # an Agent call without run_in_background, until its result

    def jobs(self) -> list[dict]:
        """[{id, kind: shell | agent, label, started}] oldest first (`started`: unix seconds or None)."""
        return [{k: j[k] for k in ("id", "kind", "label", "started")}
                for j in sorted(self._jobs.values(), key=lambda j: j["started"] or 0)]

    def drop_started_before(self, t: float) -> bool:
        """Forget the jobs started before `t` (Claude said it was idle at `t`, so they are over).
        True if any was dropped."""
        over = [k for k, j in self._jobs.items() if (j["started"] or 0) < t]
        for k in over:
            del self._jobs[k]
        return bool(over)

    def feed(self, e) -> bool:
        """Take one transcript entry; True if the jobs changed."""
        if not isinstance(e, dict) or e.get("isSidechain"):
            return False
        content = (e.get("message") or {}).get("content")
        if e.get("type") == "assistant" and isinstance(content, list):
            return self._assistant(e, content)
        if e.get("type") == "user":
            return self._user(e, content)
        return False

    def _assistant(self, e, content):
        changed = False
        for b in content:
            if not isinstance(b, dict) or b.get("type") != "tool_use" or not b.get("id"):
                continue
            name, inp = b.get("name", ""), b.get("input") if isinstance(b.get("input"), dict) else {}
            if truthy(inp.get("run_in_background")):
                self._jobs[b["id"]] = {"id": b["id"], "kind": KINDS.get(name, "shell" if "Bash" in name else "agent"),
                                       "label": label_of(name, inp), "started": entry_ts(e), "task": None}
                while len(self._jobs) > MAX_JOBS:  # a job whose end we never saw
                    self._jobs.pop(min(self._jobs, key=lambda k: self._jobs[k]["started"] or 0))
                changed = True
            elif name in AGENTS:  # async unless its result is its answer: known from the result
                self._agents[b["id"]] = {"id": b["id"], "kind": "agent", "label": label_of(name, inp),
                                         "started": entry_ts(e), "task": None}
                if len(self._agents) > MAX_JOBS:
                    self._agents.pop(next(iter(self._agents)))
            elif name in STOPPERS:
                task = inp.get("task_id") or inp.get("shell_id") or inp.get("bash_id")
                if task:
                    self._stops[b["id"]] = str(task)
                    if len(self._stops) > MAX_JOBS:
                        self._stops.pop(next(iter(self._stops)))
        return changed

    def _user(self, e, content):
        changed = False
        if isinstance(content, list):
            for b in content:
                if not isinstance(b, dict) or b.get("type") != "tool_result":
                    continue
                tid = b.get("tool_use_id")
                pending = self._agents.pop(tid, None)
                if pending and not b.get("is_error") and is_async_launch(e):
                    self._jobs[tid] = pending
                    changed = True
                if tid in self._jobs:
                    if b.get("is_error"):
                        changed |= self._jobs.pop(tid, None) is not None
                    else:
                        r = e.get("toolUseResult") if isinstance(e.get("toolUseResult"), dict) else {}
                        task = r.get("backgroundTaskId") or r.get("agentId")
                        if task:
                            self._jobs[tid]["task"] = str(task)
                elif tid in self._stops:
                    task = self._stops.pop(tid)
                    if not b.get("is_error"):
                        changed |= self._end(task, None)
        for tasks, tool_use_id, _ in notifications(content):
            changed |= self._end(tasks[0] if tasks else None, tool_use_id)
            for task in tasks[1:]:
                changed |= self._end(task, None)
        return changed

    def _end(self, task, tool_use_id):
        if tool_use_id and self._jobs.pop(tool_use_id, None) is not None:
            return True
        for k, j in list(self._jobs.items()):
            if task and j["task"] == task:
                del self._jobs[k]
                return True
        return False
