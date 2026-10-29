"""Quick actions: /menu and the one-tap prompts /brief, /mail, /today, /servers, /changes.

Each one sends EDITH a fixed prompt (word for word the legacy bridge's), as a normal turn.
"""
import time

from edith.core import ActionCall, ActionResult, Button, CommandCall, Context, Feature, Reply

GOOGLE = "cd ~/edith/google && ~/edith/venv/bin/python"
QUICK = {
    "/brief": ("☀️ Brief", "Give me a short brief for today: my calendar (" + GOOGLE + " gcal.py today), "
               "unread emails that actually matter (" + GOOGLE + " gmail.py unread; skip promotions and "
               "newsletters), and reminders due today (python3 -I ~/edith/bin/remind.py list)."),
    "/mail": ("📧 Mail", "Summarise my unread emails that matter (" + GOOGLE + " gmail.py unread). Skip "
              "promotions, newsletters and notifications. Flag anything that needs a reply. Read-only."),
    "/today": ("📅 Today", "What's on my calendar today, and the first thing tomorrow? (" + GOOGLE +
               " gcal.py today / tomorrow). Mention gaps where I'm free and any reminders due today "
               "(python3 -I ~/edith/bin/remind.py list)."),
    "/servers": ("🖥 Servers", "Read-only health check, no changes: this server (disk, memory, load, the "
                 "edith-bridge service) and Cracker GCP via --configuration=cracker (VM status, Cloud Run "
                 "services and their latest revision status, error logs from the last hour). Lead with "
                 "'all good' or what's wrong."),
    "/changes": ("📝 Changes", "show changes"),
}
MENU = {  # command menu descriptions, in menu order
    "/brief": "Today's brief: calendar, mail, reminders",
    "/mail": "Unread emails that matter",
    "/today": "Today's calendar",
    "/servers": "Server + Cracker health check",
    "/changes": "Recent file changes",
}


def quick_prompt(cmd):
    return f"[Quick action {cmd} from Arpit, {time.strftime('%Y-%m-%d %H:%M %Z')}]\n{QUICK[cmd][1]}"


def menu_keyboard():
    names = [c[1:] for c in QUICK]
    return [[Button(QUICK["/" + n][0], f"quick:{n}") for n in names[i:i + 3]] for i in range(0, len(names), 3)]


def setup(ctx: Context) -> None:
    agent = ctx.ports.agent

    def run(cmd):
        def handler(call: CommandCall):
            agent.send(quick_prompt(cmd), call.origin, call.ref)
        return handler

    def press(call: ActionCall):
        cmd = "/" + call.action[len("quick:"):]
        if cmd not in QUICK:
            return ActionResult()
        agent.send(quick_prompt(cmd), call.origin, call.ref)
        return ActionResult(toast="On it")

    ctx.add_command("menu", "Quick action buttons", lambda call: Reply("Quick actions:", menu_keyboard()),
                    menu=True, order=10, help="quick action buttons")
    for i, (cmd, description) in enumerate(MENU.items()):
        ctx.add_command(cmd[1:], description, run(cmd), menu=True, order=20 + i, group="quick", help="quick actions")
    ctx.add_action("quick", press)


FEATURE = Feature(name="quick_actions", setup=setup, description="/menu and quick action prompts")
