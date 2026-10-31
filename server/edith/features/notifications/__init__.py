"""Pushes for the app while it is closed (Phase 5; contracts/push.md): replies and failures of app
turns, approvals (and their cancel once answered) and reminders, through the notifier ports; and app
updates (app.update_available), which go even while the app is connected.

Only while the app isn't connected (ports.presence, asked at push time); the app shows everything
itself while it is open. Update alerts are the exception: the app may not check for a while. Each tag is pushed once it is delivered. Publishing runs on one worker thread, so a slow or unreachable ntfy
never holds up the bus.

GET /v1/push/config hands the app what it subscribes with (the notifier's subscription(): ntfy's url,
topic and the phone's read-only token), so turning push on needs nothing pasted. The token is in the
answer only: never logged, never in the audit line, and not cached by the client (no-store).

    [features.notifications]
    via = ["ntfy"]         # notifier adapters to push through
    update_alerts = true   # push app.update_available (a new OTA or APK)
"""
import json
import queue
import re
import threading
from collections import OrderedDict

from edith.core import ApiError, Context, Event, Feature, Response

SEEN_MAX = 256    # tags pushed lately (oldest forgotten first)
WAITING_MAX = 50  # pushes waiting for the worker; past that they are dropped (and logged)
PREVIEW = 180
LIVE, APPROVALS, UPDATES = "edith://live", "edith://approvals", "edith://settings/updates"
ALWAYS = {"updates"}  # channels pushed even while the app is connected
FAILED = {  # the app's wording (app/src/features/notifications/model.ts)
    "not_ready": "Claude isn't ready yet. Try again in a moment.",
    "crashed": "Claude stopped unexpectedly.",
    "queue_full": "Too many messages are already waiting.",
}

_CODE_BLOCK = re.compile(r"```[\s\S]*?(```|$)")
_INLINE = re.compile(r"`([^`]*)`")
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MARKS = re.compile(r"(^|\s)[#>*_-]+\s")
_EMPH = re.compile(r"[*_]{2,}")


def preview(text: str, limit: int = PREVIEW) -> str:
    """One line of plain text, as the app's preview(): code and markdown marks out, whitespace folded."""
    plain = _CODE_BLOCK.sub(" [code] ", text or "")
    plain = _LINK.sub(r"\1", _INLINE.sub(r"\1", plain))
    plain = _EMPH.sub("", _MARKS.sub(r"\1", plain))
    plain = " ".join(plain.split())
    return plain[:limit - 1] + "…" if len(plain) > limit else plain


def message(ev: Event) -> dict | None:
    """The push for one event (contracts/push.md), or None when it isn't pushed."""
    d, t = ev.data, ev.type
    if t in ("turn.done", "turn.failed"):
        ref = d.get("ref")
        if not ref or ev.origin != "app":
            return None  # replies to Telegram or the terminal go there
        if t == "turn.failed":
            text = FAILED.get(d.get("reason")) or preview(str(d.get("detail") or d.get("stderr") or "")) \
                or "Something went wrong."
            return {"tag": f"turn:{ref}", "channel": "errors", "title": "EDITH couldn't finish", "text": text, "link": LIVE}
        error = d.get("is_error") is True
        title = "EDITH finished with an error" if error else \
            "EDITH · parallel task done" if d.get("lane") == "side" else "EDITH replied"
        return {"tag": f"turn:{ref}", "channel": "errors" if error else "replies", "title": title,
                "text": preview(str(d.get("display_text") or d.get("text") or "")) or "Done.", "link": LIVE}
    if t == "permission.request":
        pid = d.get("id")
        if not pid or ev.origin == "telegram":
            return None  # Telegram shows its own
        tool = d.get("tool") or ""
        return {"tag": f"perm:{pid}", "channel": "approvals",
                "title": f"Approve {tool or 'a tool'}?" + (" (parallel task)" if d.get("lane") == "side" else ""),
                "text": preview(str(d.get("detail") or ""), 300) or tool, "link": APPROVALS, "permission": pid}
    if t == "reminder.due":
        rid = d.get("id")
        if not rid:
            return None
        return {"tag": f"rem:{rid}:{d.get('due')}", "channel": "reminders",  # once per due time
                "title": "Reminder (late)" if d.get("late") else "Reminder",
                "text": preview(str(d.get("text") or ""), 300), "link": LIVE}
    if t == "app.update_available":
        kind, uid = d.get("kind"), d.get("id")
        if kind not in ("ota", "apk") or not uid:
            return None
        title = "EDITH update ready" if kind == "ota" else "New EDITH app version"
        fallback = "Restart EDITH to use it." if kind == "ota" else "Install it from Settings → Updates."
        return {"tag": f"update:{kind}:{uid}", "channel": "updates", "title": title,
                "text": preview(str(d.get("summary") or ""), 300) or fallback, "link": UPDATES}
    return None


def setup(ctx: Context) -> None:
    via = set(ctx.config.get("via", ["ntfy"]))
    update_alerts = ctx.config.get("update_alerts", True) is not False
    notifiers = [n for n in ctx.ports.notifiers if n.name in via]
    subscribable = [n for n in notifiers if callable(getattr(n, "subscription", None))]

    def push_config(req):
        if not subscribable:
            raise ApiError(404, "push isn't set up on edith (no ntfy notifier)")
        try:
            sub = subscribable[0].subscription()
        except ValueError as e:  # the message never holds the token
            ctx.log("push config refused: %s", e)
            raise ApiError(503, "edith's phone token for push isn't usable; see deploy/ntfy/README.md")
        body = {"url": sub["url"], "topic": sub["topic"], "token": sub["token"]}
        return Response(200, {"content-type": "application/json", "cache-control": "no-store"},
                        json.dumps(body).encode(), audit={"push": "config"})

    ctx.add_route("GET", "/v1/push/config", push_config)
    if not notifiers:
        ctx.log("no notifier among %s: nothing is pushed", sorted(via))
        return
    pushed: OrderedDict = OrderedDict()  # tag -> None, newest last
    lock = threading.Lock()       # the bus calls handlers from several threads

    pending: set = set()          # tags waiting for the worker: not pushed yet

    def send(msg: dict) -> None:
        tag, cancel = msg["tag"], msg.get("cancel")
        if not cancel:
            with lock:
                if tag not in pending:
                    return  # answered while it waited: nothing to show
        if not cancel and msg.get("channel") not in ALWAYS and ctx.ports.presence and ctx.ports.presence.app_clients():
            with lock:
                pending.discard(tag)  # the app is there and shows it itself
            return
        priority = "min" if cancel else "high" if msg.get("channel") == "approvals" else "default"
        data = {"v": 1, **msg}
        delivered = False
        for n in notifiers:
            delivered = n.notify(msg.get("title", ""), msg.get("text", ""), priority, data) is True or delivered
        if cancel:
            return
        with lock:
            answered = tag not in pending  # permission.resolved came in while it was being sent
            pending.discard(tag)
            if delivered and not answered:
                pushed[tag] = None  # marked only once a notifier took it
                while len(pushed) > SEEN_MAX:
                    pushed.popitem(last=False)
        if delivered and answered:
            enqueue({"tag": tag, "cancel": True})

    submit = ctx.add_worker("push", send, maxsize=WAITING_MAX)

    def enqueue(msg: dict) -> None:
        try:
            submit(msg)
        except queue.Full:
            ctx.log("push queue full: %s dropped", msg["tag"])
            if not msg.get("cancel"):
                with lock:
                    pending.discard(msg["tag"])  # may be pushed again by a later event

    def on_event(ev: Event) -> None:
        if ev.type == "permission.resolved":
            tag = f"perm:{ev.data.get('id')}"
            with lock:
                if tag in pending:
                    pending.discard(tag)  # not sent yet: the worker drops it (or cancels it if mid-send)
                    return
                if pushed.pop(tag, False) is False:
                    return
            enqueue({"tag": tag, "cancel": True})  # answered or timed out: take it off the phone
            return
        if ev.type == "app.update_available" and not update_alerts:
            return
        msg = message(ev)
        if msg is None:
            return
        with lock:
            if msg["tag"] in pushed or msg["tag"] in pending:
                return
            pending.add(msg["tag"])
        enqueue(msg)

    for t in ("turn.done", "turn.failed", "permission.request", "permission.resolved", "reminder.due",
              "app.update_available"):
        ctx.subscribe(t, on_event)


FEATURE = Feature(name="notifications", setup=setup, description="Pushes through ntfy while the app is closed")
