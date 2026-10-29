"""Approvals: Allow/Deny for Claude's permission prompts, on every frontend.

Driven by the agent port's events, never by looking at files: permission.request shows the
question with its buttons (a message.system keyed "perm:<id>"), the perm:allow|deny:<id> buttons
answer through agent.resolve_permission, and permission.resolved (answered anywhere, or timed out)
clears that message's buttons.
"""
import re

from edith.core import ActionCall, ActionResult, Button, Context, Event, Feature, Reply

ACTION = re.compile(r"perm:(allow|deny):([0-9a-f]+)")


def setup(ctx: Context) -> None:
    agent = ctx.ports.agent
    answered = set()  # answered with our buttons: that edit already removed them

    def on_request(ev: Event):
        d = ev.data
        text = f"🔐 Permission needed{' (parallel lane)' if d.get('lane') == 'side' else ''}: {d['tool']}\n\n{d['detail']}"
        buttons = [[Button("✅ Allow", f"perm:allow:{d['id']}"), Button("❌ Deny", f"perm:deny:{d['id']}")]]
        ctx.bus.publish(Event("message.system", {**Reply(text, buttons).as_data(), "key": f"perm:{d['id']}",
                                                 "ref": d.get("ref")}, origin=ev.origin))

    def on_resolved(ev: Event):
        rid = ev.data["id"]
        if rid in answered:
            answered.discard(rid)
        else:  # answered elsewhere or timed out: take the buttons off the question
            ctx.bus.publish(Event("message.buttons_cleared", {"key": f"perm:{rid}"}, origin=ev.origin))

    def press(call: ActionCall):
        m = ACTION.fullmatch(call.action)
        if not m:
            return ActionResult()
        decision, rid = m.groups()
        if not agent.resolve_permission(rid, decision == "allow"):
            return ActionResult(toast="That request has expired.")
        answered.add(rid)
        label = "✅ Allowed" if decision == "allow" else "❌ Denied"
        return ActionResult(toast=label, note=label)

    ctx.subscribe("permission.request", on_request)
    ctx.subscribe("permission.resolved", on_resolved)
    ctx.add_action("perm", press)


FEATURE = Feature(name="approvals", setup=setup, description="Allow/Deny for permission prompts")
