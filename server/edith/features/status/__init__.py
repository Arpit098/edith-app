"""Status details: GET /v1/status/details for the app's status panel (contracts/status.md).

What EDITH's main lane is doing (thinking, a tool, waiting for approval, or waiting: her turn is
over but background work it started still runs) and since when, that background work, her
subagents (running, and finished in the last 30 minutes), the side
lanes, the queue, pending approvals, the conversation, the coding agents in tmux and the live tag.

The main lane's state comes from the bus (turn.*, tool.*, permission.*), so a request reads only
what is already known: nothing is polled. The background work and the conversation's numbers come
from the agent port (kept from the transcript as it grows), the coding agents from tmux and their
session files (cached for 5 s, agents.py) and the tag from `git describe` once (a deploy restarts
the bridge). Free text is redacted before it is sent.
"""
import collections
import os
import pathlib
import subprocess
import threading
import time

from edith.common.redact import redact
from edith.core import Context, Event, Feature

from .agents import Agents

MAX_SUMMARIES = 100  # refs -> first line of the message, for side-lane summaries
SUMMARY = 80         # characters


class Cached:
    """fn()'s value, computed by one caller at a time and kept for `ttl` seconds (None: for good)."""

    def __init__(self, fn, ttl=None, clock=time.monotonic):
        self.fn, self.ttl, self.clock = fn, ttl, clock
        self._lock, self._at, self._value = threading.Lock(), None, None

    def get(self):
        with self._lock:
            if self._at is None or self.ttl is not None and self.clock() - self._at >= self.ttl:
                self._value, self._at = self.fn(), self.clock()
            return self._value


def one_line(text, size=SUMMARY):
    line = next((ln.strip() for ln in (text or "").splitlines() if ln.strip()), "")
    return redact(line if len(line) <= size else line[:size - 1].rstrip() + "…")


def describe_live(path, run=subprocess.run):
    try:
        r = run(["git", "-C", str(path), "describe", "--tags", "--always", "--dirty"],
                capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def setup(ctx: Context) -> None:
    agent = ctx.ports.agent
    cfg = ctx.config
    started = time.time()
    lock = threading.Lock()
    main = {"state": "idle", "tool": None, "step": None, "since": None, "ref": None}
    approvals = {}        # pending permission id -> lane
    summaries: collections.OrderedDict[str, str] = collections.OrderedDict()
    ttl = float(cfg.get("agents_ttl", 5))
    agents = Agents(socket=cfg.get("agents_socket"), ttl=ttl, claude_dir=os.path.expanduser(cfg.get("claude_dir") or "~/.claude"))
    tmux_alive = Cached(agent.tmux_alive, ttl)  # `tmux has-session` at most once per ttl, like the agents
    live_dir = os.path.expanduser(cfg.get("live_dir") or str(pathlib.Path(__file__).resolve().parents[4]))
    tag = Cached(lambda: describe_live(live_dir))  # once: a deploy restarts the bridge

    def is_main(ev):
        return ev.data.get("lane", "main") == "main"

    def set_main(ev, state, **kw):
        if main["state"] != state or kw.get("step", main["step"]) != main["step"]:
            main["since"] = ev.ts
        main.update(state=state, **kw)

    def on_event(ev: Event):
        d, t = ev.data, ev.type
        with lock:
            if t == "message.user" and d.get("ref"):
                summaries[d["ref"]] = one_line(d.get("text"))
                summaries.move_to_end(d["ref"])
                while len(summaries) > MAX_SUMMARIES:
                    summaries.popitem(last=False)
            elif t == "permission.request":
                approvals[d.get("id")] = d.get("lane")
                if d.get("lane") in ("main", None) and main["state"] != "waiting_approval":
                    set_main(ev, "waiting_approval", tool=d.get("tool"), step=None)
            elif t == "permission.resolved":
                approvals.pop(d.get("id"), None)
                if main["state"] == "waiting_approval" and not any(v in ("main", None) for v in approvals.values()):
                    set_main(ev, "thinking", tool=None, step=None)
            elif not is_main(ev):
                return
            elif t == "turn.started":
                set_main(ev, "thinking", tool=None, step=None, ref=d.get("ref"))
            elif t in ("turn.done", "turn.stopped", "turn.failed"):
                if d.get("ref") in (main["ref"], None):
                    set_main(ev, "idle", tool=None, step=None, ref=None)
            elif main["state"] == "waiting_approval":
                return  # tool events while a prompt waits don't hide it
            elif t == "tool.call":  # from the main transcript (side lanes have none)
                set_main(ev, "tool", tool=d.get("name"), step=redact(d.get("summary")))
            elif t == "tool.result":
                set_main(ev, "thinking", tool=None, step=None)
            elif t == "turn.progress" and d.get("step") and main["state"] != "tool":
                set_main(ev, "tool", tool=None, step=redact(d.get("step")))

    for pattern in ("message.user", "permission.*", "turn.*", "tool.call", "tool.result"):
        ctx.subscribe(pattern, on_event)

    def edith_part(runs):
        """The main lane, checked against the agent's runs: the events say what it does, the runs
        whether it is really running (a missed end event, or a bridge restart mid-turn)."""
        run = next((r for r in runs if r.lane == "main"), None)
        with lock:
            m = dict(main)
            waiting = any(v in ("main", None) for v in approvals.values())
        if waiting:
            m["state"] = "waiting_approval"
        elif run is None:
            if m["state"] != "idle":
                m.update(state="idle", tool=None, step=None, ref=None)
        elif m["state"] == "idle" or m["ref"] != run.ref:  # running, but we missed its start
            m.update(state="tool" if run.step else "thinking", tool=None, step=redact(run.step), ref=run.ref,
                     since=run.started)
        m["turn_started"] = run.started if run else None
        m["tmux"] = "running" if tmux_alive.get() else "down"
        background = [{"id": j["id"], "kind": j["kind"], "label": redact(j["label"]), "started": j["started"]}
                      for j in agent.background()]
        subagents = [{**a, "description": redact(a["description"]), "last": redact(a.get("last"))}
                     for a in agent.subagents()]
        if m["state"] == "idle" and (background or any(a["state"] == "running" for a in subagents)):
            m["state"] = "waiting"  # the turn is over (`since` is when), but work it started goes on
        m["background"] = background
        m["subagents"] = subagents
        return m

    def api_details(req):
        now = time.time()
        runs, queued = agent.status()
        sid = agent.current_session()
        session = None
        if sid:
            stats = agent.session_stats(sid) or {}
            session = {"id": sid, "title": redact(agent.session_title(sid)), "started": stats.get("started"),
                       "messages": stats.get("messages"), "context_tokens": stats.get("context_tokens")}
        with lock:
            side = [{"ref": r.ref, "seconds": int(now - r.started), "step": redact(r.step),
                     "summary": summaries.get(r.ref)} for r in runs if r.lane == "side"]
            pending = len(approvals)
        return {"ts": now, "edith": edith_part(runs),
                "lanes": {"side": side, "max_side": agent.max_side_lanes, "queued": queued, "approvals": pending},
                "session": session,
                "agents": [{**a, "last": redact(a["last"])} for a in agents.get()] if cfg.get("agents", True) else [],
                "server": {"tag": tag.get(), "started": started, "uptime": int(now - started)}}

    ctx.add_route("GET", "/v1/status/details", api_details)


FEATURE = Feature(name="status", setup=setup, description="GET /v1/status/details for the app's status panel")
