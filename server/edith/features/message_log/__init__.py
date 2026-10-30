"""Message log (contracts/events.md, "Messages from Arpit"): what happened to each message Arpit sent,
so none vanishes from the app, plus the reactions Telegram shows, for app messages.

- Reactions: from the turn and permission events of app-origin messages, the same emojis the Telegram
  frontend sets (👀 🥱 👨‍💻 ⚡ 🙏, then REACT:/👍/😢/🫡/🕊/💔), published as message.reaction.
- Log: message.user (from frontends), message.delivered, message.reaction, the side-lane
  message.assistant and side-lane turn.started/turn.done, kept per conversation in
  <state_dir>/message-log/<session>.json (the newest 500, atomic writes; read once, then cached).
- GET /v1/sessions/{id}/history: the agent's transcript page merged with the log by time, without
  the transcript's own copy of a logged message.
"""
import collections
import json
import os
import re
import secrets
import threading

from edith.common.paths import resolve
from edith.core import ApiError, Context, Event, Feature

KEEP = 500
APP_REFS = 1000          # app messages followed for reactions
DEDUPE_SECONDS = 300     # a transcript message.user with the same text this close to a logged one is the same message
SESSION = re.compile(r"[A-Za-z0-9-]{1,64}")
LOGGED = {"message.user", "message.delivered", "message.reaction"}


def reaction_for(ev, lane):
    """The Telegram frontend's reaction for this moment of a turn, or None."""
    d, t = ev.data, ev.type
    if t == "turn.queued":
        return "🥱"
    if t == "turn.started":
        return "⚡" if d.get("lane") == "side" else "👨‍💻"
    if t == "permission.request":
        return "🙏"
    if t == "permission.resolved" and d.get("decision") in ("allow", "deny"):
        return "⚡" if lane == "side" else "👨‍💻"
    if t == "turn.done":
        return "😢" if d.get("is_error") else d.get("reaction") or "👍"
    if t == "turn.stopped":
        return "🕊" if d.get("lane") == "queued" else "🫡"
    if t == "turn.failed" and d.get("reason") not in ("bridge_error", "queue_full"):
        return "💔"
    return None


class Log:
    def __init__(self, folder):
        self.folder = folder
        self._lock = threading.Lock()
        self._cache: dict[str, list] = {}

    def _path(self, sid):
        return os.path.join(self.folder, f"{sid}.json")

    def events(self, sid):
        if not SESSION.fullmatch(sid or ""):
            return []
        with self._lock:
            if sid not in self._cache:
                try:
                    with open(self._path(sid)) as f:
                        self._cache[sid] = json.load(f)
                except (OSError, ValueError):
                    self._cache[sid] = []
            return list(self._cache[sid])

    def add(self, sid, event):
        if not SESSION.fullmatch(sid or ""):
            return
        self.events(sid)  # loaded
        with self._lock:
            items = self._cache[sid]
            items.append(event)
            del items[:-KEEP]
            os.makedirs(self.folder, mode=0o700, exist_ok=True)
            tmp = f"{self._path(sid)}.tmp-{os.getpid()}-{threading.get_ident()}"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(items, f, ensure_ascii=False)
            os.replace(tmp, self._path(sid))


def merge(page, logged, lower, upper):
    """The transcript page plus the logged events with lower < ts <= upper (None: open), by ts,
    without transcript message.user copies of logged messages."""
    picked = [e for e in logged if (lower is None or e["ts"] > lower) and (upper is None or e["ts"] <= upper)]
    rids = {e["data"].get("rid") for e in logged if e["type"] == "message.delivered"}
    users = [e for e in logged if e["type"] == "message.user"]

    def duplicate(e):
        if e["type"] != "message.user" or e.get("origin") == "terminal" and not e["data"].get("rid"):
            return False
        if e["data"].get("rid") in rids:
            return True
        return any(u["data"].get("text") == e["data"].get("text") and e["ts"] is not None
                   and abs(u["ts"] - e["ts"]) <= DEDUPE_SECONDS for u in users)
    events, last = [], None
    for e in page["events"]:
        if duplicate(e):
            continue
        last = e["ts"] if e["ts"] is not None else last
        events.append((last if last is not None else float("-inf"), 0, e))
    events += [(e["ts"], 1, e) for e in picked]
    events.sort(key=lambda x: (x[0], x[1]))
    return {**page, "events": [e for _, _, e in events]}


def setup(ctx: Context) -> None:
    agent = ctx.ports.agent
    log = Log(os.path.join(resolve(ctx.config).state_dir, "message-log"))
    app_refs: collections.OrderedDict[str, dict] = collections.OrderedDict()  # ref -> {session, lane}
    sessions_of: collections.OrderedDict[str, str] = collections.OrderedDict()  # ref -> session (any origin)
    lock = threading.Lock()

    def session_for(ev):
        ref = ev.data.get("ref")
        with lock:
            sid = sessions_of.get(ref)
        return sid or ev.session_id or (agent.current_session() if agent else None)

    def keep(ev, sid):
        data = {**ev.data, "log_id": secrets.token_hex(6)}
        data.pop("cursor", None)
        log.add(sid, {"type": ev.type, "ts": ev.ts, "session_id": sid, "origin": ev.origin, "data": data})

    def on_user(ev):
        ref = ev.data.get("ref")
        if not ref or ev.origin not in ("app", "telegram"):
            return  # the transcript's own message.user (typed in tmux): not logged
        sid = ev.session_id or (agent.current_session() if agent else None)
        with lock:
            sessions_of[ref] = sid
            if len(sessions_of) > APP_REFS:
                sessions_of.popitem(last=False)
            if ev.origin == "app":
                app_refs[ref] = {"lane": ev.data.get("lane")}
                if len(app_refs) > APP_REFS:
                    app_refs.popitem(last=False)
        keep(ev, sid)
        if ev.origin == "app":
            react(ref, "👀", sid)

    def react(ref, emoji, sid):
        ctx.bus.publish(Event("message.reaction", {"ref": ref, "emoji": emoji}, origin="app", session_id=sid))

    def on_logged(ev):
        if ev.type == "message.user":
            return on_user(ev)
        keep(ev, session_for(ev))

    def on_side(ev):
        if ev.data.get("lane") == "side" and ev.data.get("ref"):
            keep(ev, session_for(ev))

    def on_progress(ev):
        ref = ev.data.get("ref")
        with lock:
            followed = app_refs.get(ref)
            if followed and ev.type == "turn.started":
                followed["lane"] = ev.data.get("lane")
        if followed:
            emoji = reaction_for(ev, followed.get("lane"))
            if emoji:
                react(ref, emoji, session_for(ev))

    for pattern in LOGGED:
        ctx.subscribe(pattern, on_logged)
    ctx.subscribe("message.assistant", on_side)
    ctx.subscribe("turn.*", on_side)
    ctx.subscribe("turn.*", on_progress)
    ctx.subscribe("permission.*", on_progress)

    # ---- history ----

    def first_ts(page):
        return next((e["ts"] for e in page["events"] if e["ts"] is not None), None)

    def last_ts(page):
        return next((e["ts"] for e in reversed(page["events"]) if e["ts"] is not None), None)

    def history(req):
        q = req.get("query") or {}
        sid = req["params"]["id"]
        try:
            limit = int(q.get("limit", 50))
        except ValueError:
            raise ApiError(400, "limit must be a number")
        after, before = q.get("after"), q.get("before")
        page = agent.history(None if sid == "current" else sid, after, before, limit)
        if page is None:
            raise ApiError(404, "No such conversation")
        sid = page["session_id"]
        older = page["more"] and after is None  # entries older than this page exist
        lower = first_ts(page) - 1e-6 if older and first_ts(page) is not None else None
        upper = None
        if after is not None and not page["reset"]:
            prior = agent.history(sid, None, after, 1)  # the entry just before the cursor
            lower = last_ts(prior) if prior and prior["events"] else lower
            upper = last_ts(page) if page["more"] else None
        elif before is not None and not page["reset"]:
            newer = agent.history(sid, before, None, 1)  # the entry the newer page starts with
            upper = first_ts(newer) - 1e-6 if newer and first_ts(newer) is not None else None
        return merge(page, log.events(sid), lower, upper)

    ctx.add_route("GET", "/v1/sessions/{id}/history", history)


FEATURE = Feature(name="message_log", setup=setup,
                  description="What happened to each message (accepted, delivered, reactions) and history with it")
