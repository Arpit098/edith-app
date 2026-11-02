"""EDITH's subagents: the Agent tool calls of the main session, read from its transcript
(contracts/status.md, "Subagents"). Claude Code writes, in the transcript:
- the assistant's tool_use `Agent` (older: `Task`) with `description`, `subagent_type`, maybe `model`
  and `effort`, and a `prompt` (never kept: it may hold secrets);
- its tool_result: for a background agent (`run_in_background`, or async, the default now)
  `toolUseResult.status` "async_launched" with its `agentId` and `resolvedModel`; for a foreground
  one the answer itself (status "completed") once it is done; `is_error`: it failed (or was
  interrupted: stopped);
- for a background one, later, a `<task-notification>` with its task id (the agentId), usually its
  tool-use id, and `<status>` completed, failed, stopped or killed;
- a TaskStop naming its agentId, which stops it once its result is ok.

Each subagent's own transcript is <the session's transcript without .jsonl>/subagents/agent-<agentId>.jsonl,
next to agent-<agentId>.meta.json ({toolUseId, agentType, description…}); its last entries give the
"last activity" line (live.py reads it, only while it runs and only when the file changed).

Subagents.feed() takes entries in order and says whether the list changed. Finished ones are kept
RETAIN seconds after they ended, so the app can show ✓ or ✗ before they fade. Only parsing here.
"""
from .background import AGENTS, STOPPERS, entry_ts, is_async_launch, label_of, notifications
from .transcript import describe_tool, read_backward

RETAIN = 30 * 60  # seconds a finished subagent stays listed
MAX_AGENTS = 50
FIELD = 40        # characters of subagent_type, model and effort
LAST = 100        # characters of the last-activity line
LAST_BYTES = 256 * 1024  # of a subagent transcript's end, read for its last activity
ENDS = {"completed": "done", "failed": "failed", "stopped": "stopped", "killed": "stopped"}
KEYS = ("id", "description", "type", "model", "effort", "background", "state", "started", "ended")


def short(v, size=FIELD):
    return str(v)[:size] if isinstance(v, (str, int, float)) and str(v).strip() else None


class Subagents:
    def __init__(self):
        self._agents: dict[str, dict] = {}  # tool_use id -> {KEYS…, agent_id}
        self._stops: dict[str, str] = {}    # a TaskStop's tool_use id -> the agentId it stops

    def entries(self, now) -> list[dict]:
        """[{id, description, type, model, effort, background, state, started, ended}] oldest first:
        the running ones and those that ended less than RETAIN seconds before `now` (unix seconds;
        older ones are forgotten here)."""
        old = [k for k, a in self._agents.items() if a["ended"] is not None and now - a["ended"] > RETAIN]
        for k in old:
            del self._agents[k]
        return [{k: a[k] for k in KEYS} for a in sorted(self._agents.values(), key=lambda a: a["started"] or 0)]

    def running(self) -> list[tuple[str, str | None]]:
        """[(tool_use id, agentId or None)] of the running ones."""
        return [(a["id"], a["agent_id"]) for a in self._agents.values() if a["state"] == "running"]

    def any_running(self) -> bool:
        return any(a["state"] == "running" for a in self._agents.values())

    def stop_running(self, before: float, at: float) -> bool:
        """The running ones started before `before` are over (Claude said it was idle then, or no
        Claude runs the conversation): stopped, ended at `at`. True if any was."""
        changed = False
        for a in self._agents.values():
            if a["state"] == "running" and (a["started"] or 0) < before:
                a.update(state="stopped", ended=max(at, a["started"] or at))
                changed = True
        return changed

    def feed(self, e) -> bool:
        """Take one transcript entry; True if the list changed."""
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
            if name in AGENTS:
                bg = inp.get("run_in_background")
                self._agents[b["id"]] = {
                    "id": b["id"], "agent_id": None,
                    "description": label_of(name, {"description": inp.get("description")} if inp.get("description") else {}),
                    "type": short(inp.get("subagent_type")) or "general-purpose",
                    "model": short(inp.get("model")), "effort": short(inp.get("effort")),
                    "background": None if bg is None else bg is True or str(bg).strip().lower() == "true",
                    "state": "running", "started": entry_ts(e), "ended": None}
                while len(self._agents) > MAX_AGENTS:  # finished ones first, then the oldest
                    drop = min(self._agents.values(), key=lambda a: (a["state"] == "running", a["started"] or 0))
                    del self._agents[drop["id"]]
                changed = True
            elif name in STOPPERS and inp.get("task_id"):
                self._stops[b["id"]] = str(inp["task_id"])
                if len(self._stops) > MAX_AGENTS:
                    self._stops.pop(next(iter(self._stops)))
        return changed

    def _user(self, e, content):
        changed, at = False, entry_ts(e)
        if isinstance(content, list):
            for b in content:
                if not isinstance(b, dict) or b.get("type") != "tool_result":
                    continue
                tid = b.get("tool_use_id")
                a = self._agents.get(tid)
                if a is not None and a["state"] == "running":
                    r = e.get("toolUseResult") if isinstance(e.get("toolUseResult"), dict) else {}
                    if r.get("agentId"):
                        a["agent_id"] = str(r["agentId"])
                    if not a["model"]:
                        a["model"] = short(r.get("resolvedModel"))
                    if b.get("is_error"):
                        text = b.get("content") if isinstance(b.get("content"), str) else str(b.get("content"))
                        changed |= self._finish(a, "stopped" if "interrupted" in text.lower() else "failed", at)
                    elif is_async_launch(e):
                        a["background"] = True
                        changed = True  # it runs on, now with a model and an id
                    else:  # a foreground agent's answer
                        a["background"] = False
                        changed |= self._finish(a, "failed" if r.get("status") == "failed" else "done", at)
                elif tid in self._stops:
                    task = self._stops.pop(tid)
                    if not b.get("is_error"):
                        changed |= self._end([task], None, "stopped", at)
        for tasks, tool_use_id, status in notifications(content):
            changed |= self._end(tasks, tool_use_id, ENDS.get((status or "").lower(), "done"), at)
        return changed

    def _end(self, tasks, tool_use_id, state, at):
        changed = False
        for a in self._agents.values():
            if a["state"] == "running" and (a["id"] == tool_use_id or a["agent_id"] and a["agent_id"] in tasks):
                changed |= self._finish(a, state, at)
        return changed

    @staticmethod
    def _finish(a, state, at):
        if a["state"] != "running":
            return False
        a.update(state=state, ended=at if at is not None else a["started"])
        return True


def last_activity(path) -> str | None:
    """What a subagent did last, from its transcript's end: its latest tool call ("$ npm test",
    "Read: x.py") or else the first line of its latest text; None if there is none (or no file)."""
    try:
        for e, *_ in read_backward(path, None, LAST_BYTES):
            content = (e.get("message") or {}).get("content") if isinstance(e, dict) else None
            if e.get("type") != "assistant" or not isinstance(content, list):
                continue
            for b in reversed(content):
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use":
                    line = describe_tool(b.get("name", ""), b.get("input") if isinstance(b.get("input"), dict) else {})
                elif b.get("type") == "text" and isinstance(b.get("text"), str) and b["text"].strip():
                    line = next(ln.strip() for ln in b["text"].splitlines() if ln.strip())
                else:
                    continue
                return line if len(line) <= LAST else line[:LAST - 1].rstrip() + "…"
    except (OSError, ValueError):
        return None
    return None
