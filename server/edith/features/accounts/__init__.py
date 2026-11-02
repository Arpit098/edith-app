"""Claude accounts (contracts/accounts.md): the saved Claude logins, switching between them, adding
one with Claude's own login flow and removing one. A switch moves the coding agents and EDITH
herself (edith-claude) to the chosen account.

- profiles.py keeps the logins (~/.config/edith/claude-accounts, mode 700/600). The API only ever
  shows id, label, email, plan and which one is active: never a token.
- A switch only starts when everything is idle: no turn, queued message or approval, and every
  Claude's session file says `idle` (agents and EDITH's own, so background work counts), no agent
  waiting for approval, no other Claude running. Otherwise it is refused, saying who is busy.
- The switch runs as a transient unit (`systemd-run --user`, runner.py), so it finishes on its own
  while it restarts EDITH's Claude, and even if the bridge goes down. The agent port is held from
  the start until the switch reports its end: messages queue up, and the bridge doesn't start
  edith-claude on the old login. Its steps come back as `accounts.switch` events (a datagram per step
  to <state_dir>/accounts/switch-<run>.sock, listened to only while that switch runs) and stay in
  <state_dir>/accounts/switch.json for GET /v1/accounts. That folder is private (700).
- Add runs `claude auth login` headless in a private folder (login.py); folders of sign-ins older
  than login_ttl are swept at startup.

- At the limit (an `agent.limit` event), the account in use is marked limited until its reset
  (limits.py) and EDITH switches to a saved account that isn't, on her own, and tells Arpit. With
  none free, or the switch refused, she says so in an `accounts.limit` event: the backup feature
  takes over then (contracts/backup.md).

Config [features.accounts]: root, claude_dir, claude_json, claude, service, edith_socket,
edith_target, agents_socket, systemd_run, ready_timeout, login_ttl, auto_switch (default true).
"""
import json
import logging
import os
import pathlib
import secrets
import select
import shutil
import socket
import subprocess
import sys
import threading
import time

from edith.common import usertime
from edith.common.paths import resolve
from edith.common.timer import Timers
from edith.core import ApiError, Context, Event, Feature

from .limits import Limits
from .login import Login, LoginError
from .panes import Panes
from .profiles import ProfileError, Profiles, read_json, write_private

log = logging.getLogger("edith.feature.accounts")

SERVER_DIR = str(pathlib.Path(__file__).resolve().parents[3])  # where `python3 -m edith…` runs from
KEEP_RESULT = 3600     # a finished switch stays in GET /v1/accounts this long (seconds)
LISTEN_LIMIT = 1800    # the longest a switch is listened to (seconds)
QUIET_CHECK = 30       # seconds without a report before the status file is checked
RETRY_AFTER = (120, 240, 480, 960)  # seconds: an automatic switch refused (someone busy) is tried again
RECENT = 120           # seconds: another limit line from the same account this soon is the same limit


def unit_active(unit: str | None) -> bool:
    if not unit:
        return False
    try:
        return subprocess.run(["systemctl", "--user", "is-active", "--quiet", unit], timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def launch(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=30)


def setup(ctx: Context) -> None:
    cfg = ctx.config
    paths = resolve(cfg)
    home = paths.home

    def at_home(p):
        return os.path.abspath(os.path.join(home, p[2:]) if p.startswith("~/") else p)

    root = at_home(cfg.get("root", "~/.config/edith/claude-accounts"))
    claude_dir = at_home(cfg.get("claude_dir", "~/.claude"))
    claude_json = at_home(cfg.get("claude_json", "~/.claude.json"))
    claude = cfg.get("claude") or os.path.join(home, ".local/bin/claude")
    private = os.path.join(paths.state_dir, "accounts")  # 700: the socket, the status and plan files
    status_file = os.path.join(private, "switch.json")
    login_ttl = float(cfg.get("login_ttl", 600))
    profiles = Profiles(root, claude_dir, claude_json)
    panes = Panes(claude_dir, socket=cfg.get("agents_socket"), edith_socket=cfg.get("edith_socket", "edith"))
    agent = ctx.ports.agent
    approvals: set[str] = set()
    lock = threading.Lock()  # one switch start / login change at a time
    logins: dict[str, Login] = {}
    hold_lock = threading.Lock()
    hold_owner: list[str | None] = [None]  # the run whose switch holds the agent

    def private_dir():
        os.makedirs(private, mode=0o700, exist_ok=True)
        os.chmod(private, 0o700)
        return private

    def sock_path(run: str) -> str:
        return os.path.join(private, f"switch-{run}.sock")  # one per switch: its listener's own

    def hold(run: str):
        with hold_lock:
            hold_owner[0] = run
            if agent:
                agent.hold()

    def release(run: str):
        """End the hold only if `run`'s switch still owns it (an old listener mustn't end a newer one's)."""
        with hold_lock:
            if hold_owner[0] != run:
                return
            hold_owner[0] = None
            if agent:
                agent.release()

    def sweep_logins():
        """Remove the folders of sign-ins left by an earlier run (only ones older than a sign-in can live)."""
        try:
            names = os.listdir(root)
        except OSError:
            return
        for name in names:
            folder = os.path.join(root, name)
            try:
                if name.startswith(".login-") and time.time() - os.stat(folder).st_mtime > login_ttl:
                    shutil.rmtree(folder, ignore_errors=True)
            except OSError:
                pass

    sweep_logins()

    def on_permission(ev: Event) -> None:
        pid = str(ev.data.get("id") or "")
        if ev.type == "permission.request":
            approvals.add(pid)
        else:
            approvals.discard(pid)

    ctx.subscribe("permission.request", on_permission)
    ctx.subscribe("permission.resolved", on_permission)

    # ---- the switch's progress ----

    def current_switch():
        st = read_json(status_file)
        if not isinstance(st, dict):
            return None
        if st.get("state") == "running" and not unit_active(st.get("unit")):
            st = dict(st, state="failed", detail="the switch stopped before it finished")
        elif st.get("state") != "running" and time.time() - float(st.get("ts") or 0) > KEEP_RESULT:
            return None
        st.pop("unit", None)
        return st

    def listen(run, sock):
        """Turn run's datagrams into events until it reports its end (bounded by LISTEN_LIMIT), then end
        its hold."""
        deadline = time.monotonic() + LISTEN_LIMIT
        try:
            while (left := deadline - time.monotonic()) > 0:
                if not select.select([sock], [], [], min(left, QUIET_CHECK))[0]:
                    # Quiet for a while: a datagram may have been missed (sent while the bridge
                    # restarted), so the status file and the unit say whether the switch is still on.
                    st = current_switch()
                    if st and st.get("run") == run and st.get("state") == "running":
                        continue
                    if st and st.get("run") == run:
                        ctx.bus.publish(Event("accounts.switch", st, origin="system"))
                    break
                try:
                    data = json.loads(sock.recv(65536))
                except (OSError, ValueError):
                    continue
                if not isinstance(data, dict) or data.get("run") != run:
                    continue
                data.pop("unit", None)
                ctx.bus.publish(Event("accounts.switch", data, origin="system"))
                if data.get("state") != "running":
                    break
        finally:
            sock.close()
            try:
                os.unlink(sock_path(run))
            except OSError:
                pass
            release(run)

    def start_listening(run):
        private_dir()
        try:
            os.unlink(sock_path(run))
        except FileNotFoundError:
            pass
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.bind(sock_path(run))  # in the 700 folder: only this user can report
        threading.Thread(target=listen, args=(run, sock), name=f"accounts-switch-{run}", daemon=True).start()

    def tell_listener(run, data: bytes):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            sock.sendto(data, sock_path(run))
        except OSError:
            release(run)
        finally:
            sock.close()

    st = read_json(status_file)  # the bridge restarted during a switch: carry on listening to it
    if isinstance(st, dict) and st.get("state") == "running" and st.get("run") and unit_active(st.get("unit")):
        hold(st["run"])
        start_listening(st["run"])

    # ---- refusals ----

    def blockers() -> tuple[list[dict], list[str], list[dict]]:
        """The agents, why a switch can't start now (empty when it can), and the Claudes at their
        usage limit (which don't block: a switch is what gets them going again)."""
        why = []
        agents, busy, at_limit = panes.blockers()
        if agent:
            runs, queued = agent.status()
            # EDITH's screen at the limit: her open bridge turn is the one the limit cut off (no Stop
            # hook comes, so it stays open) and a switch is what gets her going again.
            edith_at_limit = any(c["name"] == "EDITH" for c in at_limit)
            if any(r.lane == "main" for r in runs) and not edith_at_limit:
                why.append("EDITH is working on a task")
            side = sum(1 for r in runs if r.lane != "main")
            if side:
                why.append(f"{side} parallel task{'s' if side > 1 else ''} running")
            if queued:
                why.append(f"{queued} message{'s' if queued > 1 else ''} queued")
        if approvals:
            why.append("an approval is waiting")
        return agents, why + busy, at_limit

    # ---- routes ----

    def api_list(req):
        with lock:
            stale = [k for k, flow in logins.items() if flow.expired(login_ttl)]
            for k in stale:
                logins.pop(k).cancel()
            flow = next(iter(logins.values()), None)
        return {"accounts": profiles.list(), "switch": current_switch(),
                "login": {"id": flow.id, "url": flow.url} if flow else None}

    def api_switch(req):
        return start_switch(req["params"]["id"])

    def start_switch(target, auto=False):
        """Start a switch to `target` (see api_switch's route), or raise ApiError saying why not."""
        with lock:
            try:
                info = profiles.get(target)
            except ProfileError as e:
                raise ApiError(404, str(e)) from None
            running = current_switch()
            if running and running.get("state") == "running":
                raise ApiError(409, "a switch is already running")
            if profiles.active() == target:
                raise ApiError(409, f"{info.get('label') or info.get('email')} is already in use")
            run = secrets.token_hex(4)
            unit = f"edith-accounts-switch-{run}"
            hold(run)  # before the checks, so nothing can start between checking and the switch
            first, listening = None, False
            try:
                agents, why, at_limit = blockers()
                if why:
                    raise ApiError(409, "Can't switch while " + "; ".join(why))
                plan = {"run": run, "unit": unit, "target": target, "root": root, "claude_dir": claude_dir,
                        "claude_json": claude_json, "claude": claude, "home": home, "path": os.environ.get("PATH", ""),
                        "tz": usertime.tz_name(),  # the respawned Claudes print limit times in the user's zone
                        "agents": [{k: a[k] for k in ("name", "pane", "pid", "proc_start", "cwd", "session_id")} for a in agents],
                        "agents_socket": cfg.get("agents_socket"), "edith_socket": cfg.get("edith_socket", "edith"),
                        "edith_target": cfg.get("edith_target", "edith"), "service": cfg.get("service", "edith-claude"),
                        "ready_timeout": float(cfg.get("ready_timeout", 90)), "status_file": status_file,
                        "socket": sock_path(run), "at_limit": at_limit}
                plan_file = os.path.join(private_dir(), f"plan-{run}.json")
                write_private(plan_file, json.dumps(plan).encode())
                first = {"run": run, "unit": unit, "target": target, "previous": profiles.active(), "state": "running",
                         "step": "starting", "detail": None, "started": time.time(), "ts": time.time(),
                         "agents": [a["name"] for a in agents]}
                write_private(status_file, json.dumps(first).encode())
                start_listening(run)
                listening = True
                # TimeoutStopSec: a stopped unit gets time for the runner's finally (EDITH and the agents
                # started again) before systemd kills it.
                cmd = [cfg.get("systemd_run", "systemd-run"), "--user", "--unit", unit, "--collect", "--quiet",
                       "-p", "TimeoutStopSec=300", "--working-directory", SERVER_DIR, f"--setenv=PATH={plan['path']}",
                       f"--setenv=HOME={home}", sys.executable, "-m", "edith.features.accounts.runner", plan_file]
                try:
                    r = launch(cmd)
                    ok = r.returncode == 0
                except (OSError, subprocess.TimeoutExpired):
                    ok = False
                if not ok:
                    log.warning("accounts: systemd-run failed for %s", unit)
                    os.unlink(plan_file)
                    raise ApiError(503, "couldn't start the switch")
            except BaseException as e:
                # Refused or failed before the runner took over: end the hold (through the listener,
                # which also publishes the failure, once it runs).
                failed = None
                if first is not None:
                    detail = e.message if isinstance(e, ApiError) else f"couldn't start the switch: {e}"
                    failed = json.dumps(dict(first, state="failed", detail=detail)).encode()
                    try:
                        write_private(status_file, failed)
                    except OSError:
                        pass
                if listening and failed:
                    tell_listener(run, failed)
                else:
                    release(run)
                raise
            # The runner has the switch now (and the hold, until it reports its end): nothing here may undo that.
            log.info("accounts: switching to %s (%s), restarting %d agent(s) and EDITH", target, unit, len(agents))
            first.pop("unit")
            if auto:
                auto_runs[run] = target
            try:
                ctx.bus.publish(Event("accounts.switch", first, origin="system"))
            except Exception:
                log.exception("accounts: publishing the switch's start failed")
            return {"status": "switching", "run": run}

    def api_remove(req):
        with lock:
            running = current_switch()
            if running and running.get("state") == "running":
                raise ApiError(409, "a switch is running; try again when it's done")
            try:
                profiles.remove(req["params"]["id"])
            except ProfileError as e:
                raise ApiError(409 if "in use" in str(e) else 404, str(e)) from None
        return {"removed": req["params"]["id"]}

    def api_rename(req):
        pid, body = req["params"]["id"], req.get("body")
        if not isinstance(body, dict) or "label" not in body:
            raise ApiError(400, "send {label}")
        try:
            profiles.get(pid)
        except ProfileError as e:
            raise ApiError(404, str(e)) from None
        try:
            profiles.rename(pid, body["label"])  # metadata only: works during a switch too
        except ProfileError as e:
            raise ApiError(404 if "unknown" in str(e) else 400, str(e)) from None
        log.info("accounts: %s renamed", pid)
        return {"account": next((a for a in profiles.list() if a["id"] == pid), None)}

    def api_login_start(req):
        with lock:
            for flow in logins.values():
                flow.cancel()
            logins.clear()
            flow = Login(claude, root, usertime.env({"HOME": home, "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                                                     "LANG": "C.UTF-8"}))
            logins[flow.id] = flow
        try:
            url = flow.start()
        except (LoginError, OSError) as e:
            with lock:
                logins.pop(flow.id, None)
            raise ApiError(502, str(e)) from None
        log.info("accounts: login %s started", flow.id)
        return {"id": flow.id, "url": url}

    def take_login(lid):
        with lock:
            flow = logins.pop(lid, None)
        if not flow or flow.expired(login_ttl):
            if flow:
                flow.cancel()
            raise ApiError(404, "that sign-in has expired; start again")
        return flow

    def api_login_finish(req):
        body = req.get("body") or {}
        flow = take_login(req["params"]["login"])
        try:
            folder = flow.finish(str(body.get("code") or ""))
            pid = profiles.add(folder, str(body.get("label") or "") or None)
        except LoginError as e:
            if "doesn't look like" in str(e):  # a typo: keep the sign-in open for another try
                with lock:
                    logins[flow.id] = flow
                raise ApiError(400, str(e)) from None
            raise ApiError(400, str(e)) from None
        except ProfileError as e:
            raise ApiError(400, str(e)) from None
        finally:
            if flow.id not in logins:
                flow.cancel()  # removes its folder (the profile has its own copy)
        log.info("accounts: login %s saved as %s", flow.id, pid)
        account = next((a for a in profiles.list() if a["id"] == pid), None)
        return {"account": account}

    def api_login_cancel(req):
        with lock:
            flow = logins.pop(req["params"]["login"], None)
        if flow:
            flow.cancel()
        return {"cancelled": bool(flow)}

    # ---- automatic switch at the limit (contracts/backup.md, "Account switch first") ----

    auto_runs: dict[str, str] = {}  # run -> target, for the switches started here
    retries = {"n": 0}

    def name_of(pid):
        try:
            info = profiles.get(pid)
        except ProfileError:
            return pid
        return info.get("label") or info.get("email") or pid

    def tell(text):
        ctx.bus.publish(Event("message.system", {"text": text}, origin="system"))

    def limit_event(**data):
        ctx.bus.publish(Event("accounts.limit", data, origin="system"))

    def try_auto_switch(active, kind, until, first_try=True):
        """Switch to an account that isn't limited; tell Arpit and the backup feature what happened."""
        ids = [a["id"] for a in profiles.list()]
        others = [a for a in ids if a != active]
        free = limits.free(others)
        what = {"usage_limit": "hit its usage limit", "login": "has a login problem",
                "billing": "has a billing problem"}.get(kind, "stopped answering")
        if not free:
            nxt = limits.next_free(ids)
            limit_event(account=active, kind=kind, resets=until, action="none_free", target=None, next_free=nxt,
                        detail="no other Claude account is free")
            if first_try:
                tell(f"⚠️ Claude ({name_of(active)}) {what} (back {usertime.when(until)}). "
                     + ("No other Claude account is saved." if not others else "No other Claude account is free."))
            return
        target = free[0]
        try:
            start_switch(target, auto=True)
        except ApiError as e:
            n = retries["n"]
            retries["n"] += 1
            retry = n < len(RETRY_AFTER)
            limit_event(account=active, kind=kind, resets=until, action="refused", target=target,
                        next_free=None, detail=e.message)
            if retry:
                timers.schedule("retry", time.time() + RETRY_AFTER[n], lambda: retry_switch(active, kind, until))
            if first_try or not retry:
                tell(f"⚠️ Claude ({name_of(active)}) {what}. I couldn't switch to {name_of(target)}: {e.message}."
                     + (" I'll try again in a few minutes." if retry else " Switch by hand in Settings → Claude accounts."))
            return
        retries["n"] = 0
        limit_event(account=active, kind=kind, resets=until, action="switching", target=target, next_free=None,
                    detail=None)
        tell(f"🔁 Claude ({name_of(active)}) {what} (back {usertime.when(until)}). Switching to {name_of(target)} "
             "automatically; the chat pauses for about 30 s.")

    def retry_switch(account, kind, until):
        if profiles.active() == account and limits.get(account):
            try_auto_switch(account, kind, until, first_try=False)

    def on_limit(item):
        kind, resets = item.get("kind"), item.get("resets")
        active = profiles.active()
        if active is None:
            limit_event(account=None, kind=kind, resets=resets, action="none_free", target=None, next_free=None,
                        detail="no Claude account is saved")
            return
        running = current_switch()
        if running and running.get("state") == "running":
            return  # a switch is already moving everyone
        seen = limits.get(active)
        if seen and time.time() - float(seen.get("seen") or 0) < RECENT:
            return  # the same limit, reported again
        until = limits.mark(active, kind, resets)
        timers.cancel("retry")
        retries["n"] = 0
        try_auto_switch(active, kind, until)

    timers = Timers("accounts")
    limits = Limits(os.path.join(private, "limits.json"), ensure_dir=private_dir)
    if cfg.get("auto_switch", True):
        submit_limit = ctx.add_worker("auto_switch", on_limit, maxsize=5)

        def on_agent_limit(ev):
            try:
                submit_limit(dict(ev.data))
            except Exception:
                log.warning("accounts: too many limit reports waiting; one dropped")

        ctx.subscribe("agent.limit", on_agent_limit)

    def on_switch(ev):
        run, state = ev.data.get("run"), ev.data.get("state")
        if run not in auto_runs or state == "running":
            return
        target = auto_runs.pop(run)
        if state == "done":
            limits.clear(target)
            tell(f"✅ Switched to Claude ({name_of(target)})." + (f" {ev.data['detail']}." if ev.data.get("detail") else ""))
            return
        limits.mark(target, "login", None)  # it didn't come up: don't pick it again for a while
        limit_event(account=ev.data.get("previous"), kind="usage_limit", resets=None, action="switch_failed",
                    target=target, next_free=None, detail=ev.data.get("detail"))
        tell(f"⚠️ The automatic switch to {name_of(target)} didn't work: {ev.data.get('detail') or state}.")

    ctx.subscribe("accounts.switch", on_switch)

    ctx.add_route("GET", "/v1/accounts", api_list)
    ctx.add_route("POST", "/v1/accounts/login", api_login_start)
    ctx.add_route("POST", "/v1/accounts/login/{login}", api_login_finish)
    ctx.add_route("DELETE", "/v1/accounts/login/{login}", api_login_cancel)
    ctx.add_route("POST", "/v1/accounts/{id}/switch", api_switch)
    ctx.add_route("DELETE", "/v1/accounts/{id}", api_remove)
    ctx.add_route("PATCH", "/v1/accounts/{id}", api_rename, max_body=4096)


FEATURE = Feature(name="accounts", setup=setup, description="Claude accounts: list, switch, add and remove logins")
