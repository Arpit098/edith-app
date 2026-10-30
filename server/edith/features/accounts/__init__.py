"""Claude accounts (contracts/accounts.md): the saved Claude logins, switching between them, adding
one with Claude's own login flow and removing one. A switch moves the coding agents and EDITH
herself (edith-claude) to the chosen account.

- profiles.py keeps the logins (~/.config/edith/claude-accounts, mode 700/600). The API only ever
  shows id, label, email, plan and which one is active: never a token.
- A switch only starts when everything is idle: no turn, queued message or approval, no agent busy
  or waiting for approval, no other Claude running. Otherwise it is refused, saying who is busy.
- The switch runs as a transient unit (`systemd-run --user`, runner.py), so it finishes on its own
  while it restarts EDITH's Claude, and even if the bridge goes down. Its steps come back as
  `accounts.switch` events (a datagram per step to <state_dir>/accounts.sock, listened to only
  while a switch runs) and stay in <state_dir>/accounts-switch.json for GET /v1/accounts.
- Add runs `claude auth login` headless in a private folder (login.py).

Config [features.accounts]: root, claude_dir, claude_json, claude, service, edith_socket,
edith_target, agents_socket, systemd_run, ready_timeout, login_ttl.
"""
import json
import logging
import os
import pathlib
import secrets
import select
import socket
import subprocess
import sys
import threading
import time

from edith.common.paths import resolve
from edith.core import ApiError, Context, Event, Feature

from .login import Login, LoginError
from .panes import Panes
from .profiles import ProfileError, Profiles, read_json, write_private

log = logging.getLogger("edith.feature.accounts")

SERVER_DIR = str(pathlib.Path(__file__).resolve().parents[3])  # where `python3 -m edith…` runs from
KEEP_RESULT = 3600     # a finished switch stays in GET /v1/accounts this long (seconds)
LISTEN_LIMIT = 1800    # the longest a switch is listened to (seconds)


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
    status_file = os.path.join(paths.state_dir, "accounts-switch.json")
    sock_path = os.path.join(paths.state_dir, "accounts.sock")
    login_ttl = float(cfg.get("login_ttl", 600))
    profiles = Profiles(root, claude_dir, claude_json)
    panes = Panes(claude_dir, socket=cfg.get("agents_socket"), edith_socket=cfg.get("edith_socket", "edith"))
    agent = ctx.ports.agent
    approvals: set[str] = set()
    lock = threading.Lock()  # one switch start / login change at a time
    logins: dict[str, Login] = {}
    listening = threading.Event()

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

    def listen(sock):
        """Turn the runner's datagrams into events until it reports its end (bounded by LISTEN_LIMIT)."""
        deadline = time.monotonic() + LISTEN_LIMIT
        try:
            while (left := deadline - time.monotonic()) > 0:
                if not select.select([sock], [], [], left)[0]:
                    break
                try:
                    data = json.loads(sock.recv(65536))
                except (OSError, ValueError):
                    continue
                if not isinstance(data, dict):
                    continue
                data.pop("unit", None)
                ctx.bus.publish(Event("accounts.switch", data, origin="system"))
                if data.get("state") != "running":
                    break
        finally:
            sock.close()
            try:
                os.unlink(sock_path)
            except OSError:
                pass
            listening.clear()

    def start_listening():
        if listening.is_set():
            return
        os.makedirs(paths.state_dir, exist_ok=True)
        try:
            os.unlink(sock_path)
        except FileNotFoundError:
            pass
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        old = os.umask(0o177)
        try:
            sock.bind(sock_path)  # mode 600: only this user can report
        finally:
            os.umask(old)
        listening.set()
        threading.Thread(target=listen, args=(sock,), name="accounts-switch", daemon=True).start()

    st = read_json(status_file)  # the bridge restarted during a switch: carry on listening to it
    if isinstance(st, dict) and st.get("state") == "running" and unit_active(st.get("unit")):
        start_listening()

    # ---- refusals ----

    def blockers(agents) -> list[str]:
        why = []
        if agent:
            runs, queued = agent.status()
            if any(r.lane == "main" for r in runs):
                why.append("EDITH is working on a task")
            side = sum(1 for r in runs if r.lane != "main")
            if side:
                why.append(f"{side} parallel task{'s' if side > 1 else ''} running")
            if queued:
                why.append(f"{queued} message{'s' if queued > 1 else ''} queued")
        if approvals:
            why.append("an approval is waiting")
        for a in agents:
            if a["blocked"] == "permission":
                why.append(f"{a['name']} is waiting for approval")
            elif a["state"] == "busy":
                why.append(f"{a['name']} is busy")
        for o in panes.others({a["pid"] for a in agents}):
            why.append(f"another Claude is running (pid {o['pid']}{', in ' + o['cwd'] if o.get('cwd') else ''})")
        return why

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
        target = req["params"]["id"]
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
            agents = panes.agents()
            why = blockers(agents)
            if why:
                raise ApiError(409, "Can't switch while " + "; ".join(why))
            run = secrets.token_hex(4)
            unit = f"edith-accounts-switch-{run}"
            plan = {"run": run, "unit": unit, "target": target, "root": root, "claude_dir": claude_dir,
                    "claude_json": claude_json, "claude": claude, "home": home, "path": os.environ.get("PATH", ""),
                    "agents": [{k: a[k] for k in ("name", "pane", "pid", "cwd", "session_id")} for a in agents],
                    "agents_socket": cfg.get("agents_socket"), "edith_socket": cfg.get("edith_socket", "edith"),
                    "edith_target": cfg.get("edith_target", "edith"), "service": cfg.get("service", "edith-claude"),
                    "ready_timeout": float(cfg.get("ready_timeout", 90)), "status_file": status_file,
                    "socket": sock_path}
            os.makedirs(paths.state_dir, exist_ok=True)
            plan_file = os.path.join(paths.state_dir, f"accounts-plan-{run}.json")
            write_private(plan_file, json.dumps(plan).encode())
            first = {"run": run, "unit": unit, "target": target, "previous": profiles.active(), "state": "running",
                     "step": "starting", "detail": None, "started": time.time(), "ts": time.time(),
                     "agents": [a["name"] for a in agents]}
            write_private(status_file, json.dumps(first).encode())
            start_listening()
            cmd = [cfg.get("systemd_run", "systemd-run"), "--user", "--unit", unit, "--collect", "--quiet",
                   "--working-directory", SERVER_DIR, f"--setenv=PATH={plan['path']}", f"--setenv=HOME={home}",
                   sys.executable, "-m", "edith.features.accounts.runner", plan_file]
            try:
                r = launch(cmd)
                ok = r.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                ok = False
            if not ok:
                log.warning("accounts: systemd-run failed for %s", unit)
                write_private(status_file, json.dumps(dict(first, state="failed", detail="couldn't start the switch")).encode())
                os.unlink(plan_file)
                raise ApiError(503, "couldn't start the switch")
            log.info("accounts: switching to %s (%s), restarting %d agent(s) and EDITH", target, unit, len(agents))
            first.pop("unit")
            ctx.bus.publish(Event("accounts.switch", first, origin="system"))
            return {"status": "switching", "run": run}

    def api_remove(req):
        try:
            profiles.remove(req["params"]["id"])
        except ProfileError as e:
            raise ApiError(409 if "in use" in str(e) else 404, str(e)) from None
        return {"removed": req["params"]["id"]}

    def api_login_start(req):
        with lock:
            for flow in logins.values():
                flow.cancel()
            logins.clear()
            flow = Login(claude, root, {"HOME": home, "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8"})
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

    ctx.add_route("GET", "/v1/accounts", api_list)
    ctx.add_route("POST", "/v1/accounts/login", api_login_start)
    ctx.add_route("POST", "/v1/accounts/login/{login}", api_login_finish)
    ctx.add_route("DELETE", "/v1/accounts/login/{login}", api_login_cancel)
    ctx.add_route("POST", "/v1/accounts/{id}/switch", api_switch)
    ctx.add_route("DELETE", "/v1/accounts/{id}", api_remove)


FEATURE = Feature(name="accounts", setup=setup, description="Claude accounts: list, switch, add and remove logins")
