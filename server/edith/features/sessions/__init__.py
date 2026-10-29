"""Sessions: /sessions, /resume, /name, /new and the tap-to-switch buttons (sess:<id>).

Conversations come from the agent port. Switching restarts the tmux Claude and can take a while,
so switches run one at a time on this feature's own background job, never on the caller's thread
(legacy started a thread per switch).
"""
import queue
import time

from edith.core import ActionCall, ActionResult, Button, CommandCall, Context, Feature, Reply

SWITCH_MESSAGES = {
    "busy": "⚠️ I'm in the middle of a task. /stop it first, then switch.",
    "missing": "❌ That conversation doesn't exist any more.",
    "already": "Already in that conversation.",
    "failed": "❌ The session didn't come back up. Check: systemctl --user status edith-claude",
    "ok": "▶️ Switched. Carry on where we left off.",
}
IDLE_WAKE = 2.0  # seconds; the switch job blocks on its queue and only wakes this often to notice shutdown


def ago(ts):
    s = int(time.time() - ts)
    return f"{s // 60}m ago" if s < 3600 else f"{s // 3600}h ago" if s < 86400 else f"{s // 86400}d ago"


def setup(ctx: Context) -> None:
    agent = ctx.ports.agent
    switches: queue.Queue = queue.Queue(maxsize=10)

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

    def switch(sid, reply):
        result = agent.resume(sid, before=lambda: reply(f"🔄 Switching to: {agent.session_title(sid) or sid[:8]}…"))
        reply(SWITCH_MESSAGES[result])

    idle_wake = float(ctx.config.get("idle_wake", IDLE_WAKE))

    def switch_job():
        try:
            sid, reply = switches.get(timeout=idle_wake)
        except queue.Empty:
            return 0
        switch(sid, reply)
        return 0

    def sessions(call: CommandCall):
        return listing()

    def resume(call: CommandCall):
        arg = call.args.strip()
        sid = agent.find_session(arg) if arg else None
        if not sid:
            return listing()
        switches.put((sid, call.reply))

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
        switches.put((call.action[len("sess:"):], call.reply))
        return ActionResult(toast="Switching…")

    ctx.add_command("new", "Start a fresh conversation", new, menu=True, order=50, help="start a fresh conversation")
    ctx.add_command("sessions", "Switch to an earlier conversation", sessions, menu=True, order=60,
                    help="switch back to an earlier conversation")
    ctx.add_command("resume", "Switch by number or name", resume, usage="<n|name>", order=65,
                    help="switch by number or name")
    ctx.add_command("name", "Name the current conversation", name, usage="<title>", menu=True, order=70,
                    help="name the current conversation")
    ctx.add_action("sess", press)
    ctx.add_job("switch", switch_job)


FEATURE = Feature(name="sessions", setup=setup, description="/sessions, /resume, /name, /new")
