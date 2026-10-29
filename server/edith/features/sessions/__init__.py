"""Sessions: /sessions, /resume, /name, /new and the tap-to-switch buttons (sess:<id>).

Conversations come from the agent port. Switching restarts the tmux Claude and can take a while,
so switches run one at a time on this feature's own worker (ctx.add_worker), never on the caller's
thread (legacy started a thread per switch).
"""
import queue
import time

from edith.core import ActionCall, ActionResult, ApiError, Button, CommandCall, Context, Event, Feature, Reply

SWITCH_MESSAGES = {
    "busy": "⚠️ I'm in the middle of a task. /stop it first, then switch.",
    "missing": "❌ That conversation doesn't exist any more.",
    "already": "Already in that conversation.",
    "failed": "❌ The session didn't come back up. Check: systemctl --user status edith-claude",
    "ok": "▶️ Switched. Carry on where we left off.",
}


def ago(ts):
    s = int(time.time() - ts)
    return f"{s // 60}m ago" if s < 3600 else f"{s // 3600}h ago" if s < 86400 else f"{s // 86400}d ago"


def setup(ctx: Context) -> None:
    agent = ctx.ports.agent

    def listing():
        items = agent.list_sessions()
        if not items:
            return "No saved conversations yet."
        current = agent.current_session()
        lines, rows = ["🗂 Recent conversations (tap to switch):"], []
        for i, s in enumerate(items, 1):
            mark = " ◀ current" if s["session_id"] == current else ""
            lines.append(f"{i}. {s['title']} · {ago(s['updated'])}{mark}")
            rows.append([Button(f"{i}. {s['title'][:40]}", f"sess:{s['session_id']}")])
        return Reply("\n".join(lines) + "\n\n/name <title> names the current one.", rows)

    def switch(item):
        sid, reply = item
        result = agent.resume(sid, before=lambda: reply(f"🔄 Switching to: {agent.session_title(sid) or sid[:8]}…"))
        reply(SWITCH_MESSAGES[result])

    submit = ctx.add_worker("switch", switch)

    def queue_switch(sid, reply):
        try:
            submit((sid, reply))
            return True
        except queue.Full:  # ten switches already waiting
            reply(SWITCH_MESSAGES["busy"])
            return False

    def sessions(call: CommandCall):
        return listing()

    def resume(call: CommandCall):
        arg = call.args.strip()
        sid = agent.find_session(arg) if arg else None
        if not sid:
            return listing()
        queue_switch(sid, call.reply)

    def name(call: CommandCall):
        title = call.args.strip()
        if not title or not agent.name_session(title):
            return "Usage: /name <title>, e.g. /name youtube automation"
        return f"🏷 This conversation is now \"{title[:60]}\"."

    def new(call: CommandCall):
        if agent.new_session() == "busy":
            return "⚠️ I'm in the middle of a task. /stop it first, then /new."
        return "🆕 Fresh conversation started. The old one is still in /sessions."

    def press(call: ActionCall):
        queue_switch(call.action[len("sess:"):], call.reply)
        return ActionResult(toast="Switching…")

    ctx.add_command("new", "Start a fresh conversation", new, menu=True, order=50, help="start a fresh conversation")
    ctx.add_command("sessions", "Switch to an earlier conversation", sessions, menu=True, order=60,
                    help="switch back to an earlier conversation")
    ctx.add_command("resume", "Switch by number or name", resume, usage="<n|name>", order=65,
                    help="switch by number or name")
    ctx.add_command("name", "Name the current conversation", name, usage="<title>", menu=True, order=70,
                    help="name the current conversation")
    # ---- App API ----

    def api_list(req):
        current = agent.current_session()
        return {"sessions": [{**s, "current": s["session_id"] == current} for s in agent.list_sessions()]}

    def api_resume(req):
        """Switching takes a while: it runs on the switch job, and its messages arrive on the stream
        as command.reply events with this ref (plus session.changed when done)."""
        ref = f"app:switch:{req['params']['id'][:8]}:{int(time.time() * 1000)}"

        def reply(out):
            data = out.as_data() if isinstance(out, Reply) else {"text": out, "buttons": []}
            ctx.bus.publish(Event("command.reply", {"ref": ref, **data}, origin="app"))
        try:
            submit((req["params"]["id"], reply))
        except queue.Full:
            raise ApiError(429, "Too many switches waiting")
        return {"status": "switching", "ref": ref}

    def api_new(req):
        return {"result": agent.new_session()}

    def api_rename(req):
        title = ((req.get("body") or {}).get("title") or "").strip()
        if not title:
            raise ApiError(400, "title is required")
        if not agent.name_session(title, req["params"]["id"]):
            raise ApiError(404, "No such conversation")
        return {"session_id": req["params"]["id"], "title": title[:60]}

    ctx.add_action("sess", press)
    ctx.add_route("GET", "/v1/sessions", api_list)
    ctx.add_route("POST", "/v1/sessions/{id}/resume", api_resume)
    ctx.add_route("POST", "/v1/sessions/new", api_new)
    ctx.add_route("PATCH", "/v1/sessions/{id}", api_rename)


FEATURE = Feature(name="sessions", setup=setup, description="/sessions, /resume, /name, /new")
