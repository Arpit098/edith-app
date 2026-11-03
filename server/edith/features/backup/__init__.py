"""The backup AI (contracts/backup.md): when Claude is at its usage limit (or its login is broken)
and no other Claude account is free, a free AI answers Arpit on Telegram and in the app, read-only,
until Claude is back.

- Takes over on `accounts.limit` (anything but `switching`), or on `agent.limit` when the accounts
  feature isn't enabled; or on `/backup on`. `/backup off` turns it off, `/backup auto` (the default)
  lets it take over and hand back on its own.
- While it answers, a diverter (core/divert.py) takes every message meant for Claude: a worker
  thread answers one at a time with our own tool loop (loop.py) over the providers (chain.py:
  Nemotron, Gemini, Mistral when its key exists) and read-only tools (tools.py). Replies start with
  "Backup (Nemotron):". `/queue` messages and anything that would change something go to Claude's
  queue; when Claude is back each one comes to Arpit with a "Send to Claude" button.
- Hands back at the reset time once a tiny test turn (agent.probe()) works; otherwise it checks
  again after 15, 30, then every 60 minutes. Arpit is told at both ends.
- Everything sent out goes through redact.scrub. Mail and calendar are never sent: no tool reads
  them, their log lines are dropped, and the history it sends is its own conversation only.

Config [features.backup]: mode (first start only; default "auto"), roots, blocked, bin_dir,
check_after (minutes, default [15, 30, 60]).
"""
import logging
import os
import queue
import secrets
import time

from edith.common import usertime
from edith.common.claude_limits import reset_time
from edith.common.paths import resolve
from edith.common.text import clean_prompt, take_directives, take_files
from edith.common.timer import Timers
from edith.core import ActionResult, ApiError, Button, Context, Event, Feature, Reply
from edith.ports.agent import TurnHandle

from . import loop
from .chain import Chain
from .store import MAX_QUEUE, Store
from .tools import PathPolicy, Tools

log = logging.getLogger("edith.feature.backup")

MODES = ("auto", "on", "off")
NOT_ANSWERING = "isn't answering"
AFTER_SWITCH = 60.0  # seconds after a done account switch before checking Claude (she restarts)
WHY = {"usage_limit": "hit its usage limit", "login": "has a login problem", "billing": "has a billing problem",
       "manual": "is set aside (/backup on)"}


def setup(ctx: Context) -> None:
    cfg = ctx.config
    paths = resolve(cfg)
    home = paths.home
    folder = os.path.join(paths.state_dir, "backup")
    state_file = os.path.join(folder, "state.json")
    fresh = not os.path.exists(state_file)
    store = Store(state_file)
    if fresh and cfg.get("mode") in MODES:
        store.set(mode=cfg["mode"])
    providers = list(getattr(ctx.ports.llm, "providers", None) or [])
    chain = Chain(providers, os.path.join(folder, "skips.json"))
    agent = ctx.ports.agent
    timers = Timers("backup")
    checks = [float(m) * 60 for m in cfg.get("check_after", [15, 30, 60])] or [900.0]
    current = {"prompt": None, "origin": None}  # the message the worker is answering (for queue_for_claude)
    active = [bool(store.get("active"))]  # read on every message: kept in memory too

    def at_home(p):
        return os.path.join(home, p[2:]) if p.startswith("~/") else p

    roots = [at_home(p) for p in cfg.get("roots", [paths.work_dir, "~/Projects", paths.inbox])]
    blocked = [at_home(p) for p in cfg.get("blocked", [])] + [
        os.path.join(home, ".config"), os.path.join(home, ".claude"), os.path.join(home, ".ssh"),
        os.path.join(paths.work_dir, "google"), os.path.join(paths.work_dir, ".claude"), paths.state_dir,
        paths.telegram_dir, paths.google_dir]
    env = {"HOME": home, "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "TZ": usertime.tz_name()}
    env.update({k: v for k, v in os.environ.items() if k in ("EDITH_WORK_DIR", "EDITH_STATE_DIR", "EDITH_APP_SERVER")})

    def edith_status():
        route = ctx.registry.routes.get(("GET", "/v1/status"))
        if not route:
            return None
        return route.handler({"body": None, "raw": b"", "params": {}, "query": {}, "headers": {}, "origin": "backup"})

    def queue_task(task, prompt=None, origin=None):
        qid = secrets.token_hex(3)

        def add(s):
            s["queue"].append({"id": qid, "task": task, "prompt": prompt if prompt is not None else current["prompt"],
                               "origin": origin or current["origin"] or "system", "ts": time.time()})
            del s["queue"][:-MAX_QUEUE]
        store.update(add)
        changed()
        return qid

    tools = Tools(PathPolicy(home, roots, blocked, base=paths.work_dir), at_home(cfg.get("bin_dir", "~/edith/bin")),
                  lambda task: queue_task(task), edith_status, env)

    # ---- telling ----

    def publish(type, data, origin="system"):
        ctx.bus.publish(Event(type, data, origin=origin or "system"))

    def tell(text, buttons=None):
        publish("message.system", Reply(text, buttons or []).as_data())

    def labels():
        names = [p["label"] for p in chain.status() if p["available"]]
        return " then ".join(names) if names else "no provider"

    def snapshot():
        s = store.get()
        return {"mode": s["mode"], "active": s["active"], "claude_limited": s["waiting"], "since": s["since"],
                "reason": s["kind"], "resets": s["resets"], "next_check": s["next_check"] if s["waiting"] else None,
                "provider": s["provider"], "queued": len(s["queue"]), "providers": chain.status()}

    def changed():
        publish("backup.changed", snapshot())

    # ---- taking over and handing back ----
    # Two flags: `waiting` (Claude is believed unavailable: hand-back checks run, the queue waits for
    # Claude) and `active` (the backup answers). /backup off ends `active` only; a passed check ends both.

    def schedule_check(at):
        store.set(next_check=at)
        timers.schedule("check", at, check)

    def start_answering(kind, resets):
        why = WHY.get(kind, NOT_ANSWERING)
        if not chain.any_available():
            tell(f"⚠️ Claude {why}, and no backup AI is set up yet (no key files in ~/.config/edith), so messages "
                 "wait for Claude.")
            return False
        store.set(active=True, since=time.time(), history=[], provider=None)
        active[0] = True
        back = f" (back {usertime.when(resets)})" if resets else ""
        tell(f"🛟 Claude {why}{back}. The backup AI ({labels()}) answers meanwhile: it can only read and look "
             "things up; anything else is queued for Claude. /backup off stops it.")
        return True

    def take_over(kind, resets):
        """Claude is unavailable (no other account free): wait for it, and answer unless the mode is off."""
        s = store.get()
        now = time.time()
        if s["waiting"]:
            if resets and (not s["resets"] or resets > s["resets"]):
                store.set(resets=resets)
                if s["mode"] != "on":
                    schedule_check(resets)
            return
        store.set(waiting=True, kind=kind, resets=resets, attempt=0)
        if s["mode"] != "on":
            schedule_check(resets if resets and resets > now else now + checks[0])
        if s["active"]:
            pass  # already answering (/backup on)
        elif s["mode"] == "off":
            tell(f"⚠️ Claude {WHY.get(kind, NOT_ANSWERING)}. The backup AI is off, so messages wait for Claude "
                 "(/backup auto turns it on).")
        else:
            start_answering(kind, resets)
        changed()

    def deliver_queue(queue):
        for item in queue:
            tell(f"📥 For Claude: {item['task'][:500]}",
                 [[Button("Send to Claude", f"bk:send:{item['id']}"), Button("Drop", f"bk:drop:{item['id']}")]])

    def claude_back(why):
        """A check passed (or the backup was only on by hand): Claude answers again."""
        s = store.get()
        store.set(active=False, waiting=False, next_check=None, attempt=0)
        active[0] = False
        timers.cancel("check")
        stuck = ""
        if agent and s["since"] and s["waiting"]:
            try:
                runs, _ = agent.status()
                if any(r.lane == "main" and r.started < s["since"] for r in runs):
                    stuck = " The task the limit cut off is still open: /stop it, then send it again."
            except Exception:
                pass
        n = len(s["queue"])
        what = "Claude is answering again and the backup AI has stopped" if s["active"] else "Claude is answering again"
        tell(f"✅ {why}: {what}.{stuck}" + (f" {n} task{'s' if n != 1 else ''} waited for Claude:" if n else ""))
        deliver_queue(s["queue"])
        changed()

    def stop_answering():
        """/backup off: the backup stops; if Claude is still limited, everything else waits for it."""
        s = store.get()
        if not s["active"]:
            return
        if not s["waiting"]:  # on by hand while Claude was fine
            claude_back("The backup AI is off")
            return
        store.set(active=False)
        active[0] = False
        until = f" until {usertime.when(s['resets'])}" if s["resets"] else ""
        n = len(s["queue"])
        tell(f"⏸ Backup off; Claude is still limited{until}. Messages wait for Claude"
             + (f", and the {n} queued task{'s' if n != 1 else ''} come{'s' if n == 1 else ''} once a test message "
                "to Claude works." if n else "."))

    def check():
        s = store.get()
        if not s["waiting"] or s["mode"] == "on":
            return
        r = agent.probe() if agent and hasattr(agent, "probe") else {"ok": False, "kind": "error", "detail": "no agent"}
        if r.get("ok"):
            claude_back("Claude passed a test message")
            return
        n = int(s["attempt"] or 0)
        store.set(attempt=n + 1)
        log.info("backup: Claude still unavailable (%s); checking again later", r.get("kind"))
        schedule_check(time.time() + checks[min(n, len(checks) - 1)])
        changed()
        if r.get("kind") in ("usage_limit", "login", "billing"):
            # The account in use is still limited: another one (say the first, freed by now) may not
            # be. The accounts feature switches to it, as for any limit.
            detail = r.get("detail") or ""
            ctx.bus.publish(Event("agent.limit", {"kind": r["kind"], "text": detail[:300], "resets": reset_time(detail),
                                                  "lane": "probe"}, origin="system"))

    s0 = store.get()
    if s0["waiting"] and s0["mode"] != "on":  # the bridge restarted while Claude was unavailable
        schedule_check(max(float(s0["next_check"] or 0), time.time() + 60))

    def accounts_enabled():
        return any(r.owner == "accounts" for r in ctx.registry.routes.values())

    def on_agent_limit(ev):
        if not accounts_enabled():  # else the accounts feature tries another account first
            take_over(ev.data.get("kind"), ev.data.get("resets"))

    def on_accounts_limit(ev):
        if ev.data.get("action") != "switching":
            take_over(ev.data.get("kind"), ev.data.get("next_free") or ev.data.get("resets"))

    def on_switch(ev):
        if ev.data.get("state") == "done" and store.get("waiting") and store.get("mode") != "on":
            schedule_check(time.time() + AFTER_SWITCH)  # another account: see whether Claude answers

    ctx.subscribe("agent.limit", on_agent_limit)
    ctx.subscribe("accounts.limit", on_accounts_limit)
    ctx.subscribe("accounts.switch", on_switch)

    # ---- answering ----

    def reply_done(ref, origin, text, started, steps=0, provider=None):
        publish("message.assistant", {"text": text, "files": [], "lane": "backup", "ref": ref}, origin)
        publish("turn.done", {"ref": ref, "lane": "backup", "text": text, "display_text": text, "steps": steps,
                              "elapsed": int(time.time() - started), "is_error": False, "subtype": "success",
                              "files": [], "reaction": None, "provider": provider}, origin)

    def question_of(text):
        c = clean_prompt(text)
        q = c["text"]
        if c.get("replying_to"):  # never the quoted text: it may be a mail or calendar reply
            q = f"(a reply to an earlier message)\n{q}"
        for a in c.get("attachments") or []:
            q += f"\n[Arpit attached a file: {a}]"
        return q

    def answer(item):
        """One message the backup took. Ones it took before it stopped (/backup off, or Claude back)
        are still answered here: they were promised an answer and are never left hanging."""
        text, origin, ref = item
        started = time.time()
        publish("turn.started", {"ref": ref, "lane": "backup"}, origin)
        question = question_of(text)
        current.update(prompt=text, origin=origin)
        try:
            ans = loop.answer(chain, tools, store.get("history"), question,
                              on_step=lambda step, n: publish("turn.progress", {
                                  "ref": ref, "lane": "backup", "steps": n, "step": step,
                                  "elapsed": int(time.time() - started)}, origin))
        finally:
            current.update(prompt=None, origin=None)
        if ans.unavailable is not None:
            why = "; ".join(f"{label}: {reason}" + (f" until {usertime.when(until)}" if until else "")
                            for label, reason, until in ans.unavailable.reasons)
            qid = queue_task(question[:500], text, origin)
            reply_done(ref, origin, f"Backup: no backup AI can answer right now ({why}). I've queued your message "
                                    f"for Claude (#{qid}).", started)
            return
        _, body = take_files(ans.text)  # the backup sends no files
        _, body = take_directives(body, "REACT")
        body = body.strip() or "(no answer)"
        label = ans.provider.label

        def remember(s):
            s["history"] += [{"role": "user", "content": question[:4000]}, {"role": "assistant", "content": body[:4000]}]
            s["provider"] = label
        store.update(remember)
        reply_done(ref, origin, f"Backup ({label}): {body}", started, ans.steps, ans.provider.name)
        changed()

    submit = ctx.add_worker("answer", answer, maxsize=10)

    def divert(text, origin, ref, force_queue, parallel):
        if not active[0]:
            return None
        c = clean_prompt(text)
        publish("message.user", {"ref": ref, **c, "delivery": "backup", "lane": "backup"}, origin)
        publish("message.delivered", {"ref": ref, "delivery": "backup", "rid": None}, origin)
        if force_queue:  # /queue: meant for Claude
            qid = queue_task(c["text"][:500] or "(a message)", text, origin)
            reply_done(ref, origin, f"📥 Queued for Claude (#{qid}). You'll get a 'Send to Claude' button when "
                                    "Claude is back.", time.time())
            return TurnHandle(ref, "backup")
        try:
            submit((text, origin, ref))
        except queue.Full:
            publish("turn.failed", {"ref": ref, "lane": "backup", "reason": "queue_full",
                                    "detail": "10 messages are already waiting for the backup AI"}, origin)
            return TurnHandle(ref, "refused")
        return TurnHandle(ref, "backup")

    ctx.add_diverter(divert)

    # ---- /backup, the queue's buttons, the API ----

    def set_mode(mode):
        old = store.get("mode")
        store.set(mode=mode)
        st = store.get()
        if mode == "off":
            stop_answering()
        elif mode == "on":
            if not st["active"]:
                start_answering(st["kind"] if st["waiting"] else "manual", st["resets"])
                if not st["waiting"]:
                    store.set(kind="manual")
            timers.cancel("check")
        elif st["waiting"]:  # auto while Claude is still unavailable: answer, and check on Claude
            if not st["active"]:
                start_answering(st["kind"], st["resets"])
            if old == "on" or not timers.when("check"):
                schedule_check(max(time.time(), float(st["resets"] or 0)) if old != "on" else time.time())
        elif st["active"]:  # on by hand while Claude was fine: auto hands back now
            claude_back("The backup AI is back on auto")
        changed()

    def describe():
        s = snapshot()
        mode = {"auto": "auto (answers when Claude is at its limit and no other account is free)",
                "on": "on (answers instead of Claude)", "off": "off"}[s["mode"]]
        lines = [f"Backup AI: {mode}."]
        if s["active"]:
            lines.append(f"Answering since {usertime.when(s['since'])}.")
        if s["claude_limited"]:
            lines.append("Claude is unavailable" + (f"; next check {usertime.when(s['next_check'])}" if s["next_check"]
                                                     else "") + ".")
        elif not s["active"]:
            lines.append("Claude is answering.")
        prov = []
        for p in s["providers"]:
            st = ("no key" if not p["available"] else f"skipped until {usertime.when(p['skipped_until'])} ({p['why']})"
                  if p["skipped_until"] else "ready")
            prov.append(f"{p['label']}: {st}")
        lines.append("Providers: " + ("; ".join(prov) if prov else "none configured") + ".")
        if s["queued"]:
            lines.append(f"Queued for Claude: {s['queued']}.")
        return "\n".join(lines)

    def cmd_backup(call):
        arg = call.args.strip().lower()
        if not arg:
            return describe()
        if arg not in MODES:
            return "Use /backup on, /backup off or /backup auto (/backup alone shows the state)."
        if arg == "on" and not chain.any_available():
            return "No backup AI is set up yet: add a key file in ~/.config/edith (nvidia-key or gemini-key)."
        set_mode(arg)
        return describe()

    ctx.add_command("backup", "Backup AI: on, off or auto", cmd_backup, help="the backup AI while Claude is at its "
                    "limit: on, off or auto", usage="[on|off|auto]", menu=True, order=60)

    def take(qid):
        found = {}

        def pop(s):
            for i, item in enumerate(s["queue"]):
                if item["id"] == qid:
                    found.update(s["queue"].pop(i))
                    return
        store.update(pop)
        return found or None

    def on_press(call):
        args = call.args
        if len(args) != 2 or args[0] not in ("send", "drop"):
            return ActionResult(toast="Unknown button")
        if args[0] == "send" and store.get("waiting"):
            return ActionResult(toast="Claude isn't back yet")
        item = take(args[1])
        if not item:
            return ActionResult(toast="Already handled")
        changed()
        if args[0] == "drop":
            return ActionResult(toast="Dropped", note="🗑 Dropped.")
        prompt = item.get("prompt") or item["task"]
        prompt = f"[Queued for Claude while the backup AI answered; it noted: {item['task'][:300]}]\n{prompt}"
        agent.send(prompt, call.origin, call.ref or f"bk:{item['id']}")
        return ActionResult(toast="Sent to Claude", note="📨 Sent to Claude.")

    ctx.add_action("bk", on_press)

    def api_get(req):
        return snapshot()

    def api_set(req):
        body = req.get("body")
        mode = body.get("mode") if isinstance(body, dict) else None
        if mode not in MODES:
            raise ApiError(400, "send {mode: auto | on | off}")
        if mode == "on" and not chain.any_available():
            raise ApiError(409, "no backup AI is set up (no key files)")
        set_mode(mode)
        return snapshot()

    ctx.add_route("GET", "/v1/backup", api_get)
    ctx.add_route("POST", "/v1/backup", api_set, max_body=1024)


FEATURE = Feature(name="backup", setup=setup, description="A free, read-only backup AI while Claude is at its limit")
