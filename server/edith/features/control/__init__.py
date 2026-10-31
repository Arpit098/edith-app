"""Control: /stop, /status, /queue, /btw, /compact, /restart and /help (also /start).

/btw <task> runs the task in a parallel lane while EDITH is busy (a message without it is read by
the running task before its answer); with no lane free it waits like any other message.

Texts are the legacy bridge's, word for word (golden tests in tests/features/test_bridge_commands.py).
/help and the command menu are built from the registry: every feature places its own commands.
"""
import os
import queue
import signal
import time

from edith.core import CommandCall, Context, Feature

COMPACT_REPLIES = {"busy": "⚠️ EDITH is busy; try /compact when the task ends.", "ok": "✅ Compacted.",
                   "failed": "❌ Compaction failed"}
HELP_HEADER = "I'm E.D.I.T.H. Just text me what you need.\n\n{busy}\n\n"
BUSY_HELP = {  # by the agent's busy_policy
    "queue": "If I'm busy, I read new messages before I answer. Start one with /btw to run it in a parallel "
             "lane straight away (up to {lanes}).",
    "side_lane": "If I'm busy, new messages run in a parallel lane straight away (up to {lanes}).",  # the legacy text
}


KINDS = {"shell": "Shell", "agent": "Agent"}


def background_lines(jobs, now=None) -> list[str]:
    """"Shell · Wait for PR 41 CI · 3 min" per background job."""
    now = time.time() if now is None else now
    out = []
    for j in jobs:
        mins = int((now - j["started"]) // 60) if j.get("started") else None
        out.append(" · ".join(filter(None, [KINDS.get(j["kind"], j["kind"].title()), j["label"],
                                            None if mins is None else f"{mins} min"])))
    return out


def setup(ctx: Context) -> None:
    agent = ctx.ports.agent

    def help_(call: CommandCall):
        lanes = agent.max_side_lanes if agent else 2
        busy = BUSY_HELP.get(getattr(agent, "busy_policy", "queue"), BUSY_HELP["queue"])
        return HELP_HEADER.format(busy=busy.format(lanes=lanes)) + "\n".join(ctx.registry.help_lines())

    def stop(call: CommandCall):
        r = agent.stop()
        if not (r.running or r.dropped):
            jobs = background_lines(agent.background())
            if jobs:  # /stop ends turns; work a finished turn left running isn't one
                return ("Nothing is running. Still in the background (/stop doesn't cancel it; ask me to):\n"
                        + "\n".join(f"• {j}" for j in jobs))
            return "Nothing is running."
        return f"🛑 Stopping {r.running} task(s)." + (f" Also dropped {len(r.dropped)} queued message(s)." if r.dropped else "")

    def status(call: CommandCall):
        runs, queued = agent.status()
        if runs:
            lines = [f"{'⚡ Parallel' if r.lane == 'side' else '⏳ Main'}: {int(time.time() - r.started)}s\n"
                     f"   🔧 {r.step or 'thinking'}" for r in runs]
            call.reply("\n".join(lines) + f"\nQueued: {queued}")
        else:
            call.reply("💤 Idle. " + ("Conversation in progress." if agent.has_conversation() else "No conversation yet."))
        jobs = background_lines(agent.background())
        if jobs:
            call.reply("⏳ In the background:\n" + "\n".join(f"• {j}" for j in jobs))
        sid = agent.current_session()
        call.reply(f"🖥 tmux session: {'running' if agent.tmux_alive() else 'down'}"
                   + (f" · {agent.session_title(sid) or sid[:8]}" if sid else "")
                   + "\nWatch live: ssh in, then edith-attach")

    def queue_(call: CommandCall):
        if call.prompt:  # an empty /queue does nothing, as before
            agent.send(call.prompt, call.origin, call.ref, force_queue=True)

    def btw(call: CommandCall):
        if not call.prompt:
            return "Usage: /btw <task>: runs it in parallel while I'm busy."
        agent.send(call.prompt, call.origin, call.ref, parallel=True)

    def restart(call: CommandCall):
        busy = len(agent.status()[0]) if agent else 0
        if busy and call.args.split()[:1] != ["now"]:
            return f"⚠️ {busy} task(s) running; a restart would kill them. Send /restart now to force."
        call.reply("🔄 Restarting the bridge, back in a few seconds.")
        os.kill(os.getpid(), signal.SIGTERM)  # main.py shuts down cleanly; systemd (Restart=always) restarts it

    def compact_job(item):
        instructions, reply = item
        result, detail = agent.compact(instructions)
        reply(COMPACT_REPLIES[result] + (f": {detail}" if detail else ""))

    submit_compact = ctx.add_worker("compact", compact_job, maxsize=1)  # one at a time; it takes minutes

    def compact(call: CommandCall):
        if agent.busy():
            return COMPACT_REPLIES["busy"]
        try:
            submit_compact((call.args.strip(), call.reply))
        except queue.Full:
            return "🗜 Already compacting; I'll tell you when it's done."
        return "🗜 Compacting the conversation…"

    # ---- App API ----

    def api_stop(req):
        r = agent.stop()
        # `background`: what still runs, which a stop doesn't cancel (the app says so).
        return {"running": r.running, "dropped": r.dropped, "ts": time.time(),
                "background": [{k: j[k] for k in ("id", "kind", "label", "started")} for j in agent.background()]}

    def api_status(req):
        runs, queued = agent.status()
        sid = agent.current_session()
        return {"main": "busy" if agent.busy() else "idle", "queued": queued, "ts": time.time(),
                "runs": [{"ref": r.ref, "lane": r.lane, "seconds": int(time.time() - r.started), "step": r.step}
                         for r in runs],
                "background": [{k: j[k] for k in ("id", "kind", "label", "started")} for j in agent.background()],
                "tmux": "running" if agent.tmux_alive() else "down", "conversation": agent.has_conversation(),
                "session": {"id": sid, "title": agent.session_title(sid)} if sid else None}

    ctx.add_route("POST", "/v1/stop", api_stop)
    ctx.add_route("GET", "/v1/status", api_status)
    ctx.add_command("queue", "Run after the current task", queue_, usage="<task>", menu=True, order=40,
                    help="wait for the current task instead of running in parallel", takes_prompt=True)
    ctx.add_command("btw", "Run in parallel", btw, usage="<task>", menu=True, order=35,
                    help="run in parallel while I'm busy", takes_prompt=True)
    ctx.add_command("compact", "Compact the conversation", compact, usage="[instructions]", order=75,
                    help="compact the conversation (optional: what to keep)")
    ctx.add_command("stop", "Stop all running tasks", stop, menu=True, order=80, help="stop all running tasks")
    ctx.add_command("status", "What E.D.I.T.H is doing", status, menu=True, order=90, help="what I'm doing right now")
    ctx.add_command("restart", "Restart the bridge", restart, menu=True, order=100,
                    help="restart the bridge (after updates)")
    ctx.add_command("help", "Help", help_, menu=True, order=110, help="this message")
    ctx.add_command("start", "Help", help_)  # Telegram sends /start first; same as /help


FEATURE = Feature(name="control", setup=setup, description="/stop, /status, /queue, /restart, /help")
