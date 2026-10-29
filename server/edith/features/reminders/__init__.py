"""Reminders: /reminders, the Snooze/Done/Cancel buttons, and firing reminders when they're due.

EDITH adds reminders with remind.py (cli.py). A due reminder goes out as `message.system` (Telegram
sends it to Arpit, with buttons) plus a `reminder.due` event. Texts and button actions are the
same as the legacy bridge's (golden tests in tests/features/test_reminders.py).
"""
import time

from edith.common.paths import resolve
from edith.core import ActionCall, ActionResult, Button, CommandCall, Context, Event, Feature, Reply

from .store import Store, fmt, tomorrow_at

# remind.py runs in another process and the stdlib has no file-change notification, so the firing
# job checks the file's stat() at most this far apart. It's one syscall; the file is only parsed
# when it changed. Reminders already in the file fire on time: the job sleeps until the next one.
CHECK_FILE_EVERY = 10.0
LATE_AFTER = 120  # seconds; a reminder fired later than this says when it was due


def reminder_buttons(r) -> list[list[Button]]:
    return [[Button("+15m", f"rem:snooze:15:{r['id']}"), Button("+1h", f"rem:snooze:60:{r['id']}"),
             Button("Tomorrow 9am", f"rem:snooze:tm:{r['id']}")],
            [Button("✅ Done", f"rem:done:{r['id']}")]]


def setup(ctx: Context) -> None:
    store = Store(resolve(ctx.config).reminders)

    def list_reminders(call: CommandCall):
        items = store.pending()
        if not items:
            return "No reminders set. Just tell me, e.g. \"remind me Friday 5pm to renew the domain\"."
        lines, rows = ["⏰ Upcoming reminders (IST):"], []
        for i, r in enumerate(items[:20], 1):
            lines.append(f"{i}. {fmt(r['due'])}{' 🔁 ' + r['every'] if r.get('every') else ''} - {r['text']}")
            rows.append([Button(f"❌ Cancel {i}", f"rem:cancel:{r['id']}")])
        return Reply("\n".join(lines), rows)

    def press(call: ActionCall):
        args = call.args  # ["cancel", id] | ["done", id] | ["snooze", "15"|"60"|"tm", id]
        if len(args) < 2:
            return ActionResult()
        action, rid = args[0], args[-1]
        if action == "cancel":
            r = store.cancel(rid)
            if r:
                call.reply(f"❌ Cancelled: {r['text']}")
            return ActionResult(toast="Cancelled." if r else "Already gone.")
        if action == "done":
            r = store.get(rid)
            if not (r and r.get("every") and not r.get("fired")):  # one-off: clear it; repeating: keep going
                store.cancel(rid)
            return ActionResult(toast="✅ Done", note="✅ Done")
        if action == "snooze" and len(args) == 3:
            when = tomorrow_at(9) if args[1] == "tm" else time.time() + int(args[1]) * 60
            r = store.snooze(rid, when)
            if not r:
                return ActionResult(toast="That reminder has expired.")
            label = f"💤 Snoozed to {fmt(r['due'])}"
            return ActionResult(toast=label, note=label)
        return ActionResult()

    def fire_due() -> float:
        for r in store.pop_due(time.time()):
            late = time.time() - r["due"] > LATE_AFTER
            text = f"⏰ {r['text']}"
            if r.get("every"):
                text += f"\n🔁 {r['every']}"
            if late:
                text += f"\n(late, was due {fmt(r['due'])} IST)"
            ctx.bus.publish(Event("reminder.due", {"id": r["id"], "text": r["text"], "every": r.get("every"),
                                                   "due": r["due"], "late": late}))
            ctx.bus.publish(Event("message.system", Reply(text, reminder_buttons(r)).as_data()))
        wait = store.next_wake()
        return CHECK_FILE_EVERY if wait is None else min(wait, CHECK_FILE_EVERY)

    ctx.add_command("reminders", "Upcoming reminders", list_reminders)
    ctx.add_action("rem", press)
    ctx.add_job("fire", fire_due)


FEATURE = Feature(name="reminders", setup=setup, description="Reminders: list, snooze, done, cancel, fire")
