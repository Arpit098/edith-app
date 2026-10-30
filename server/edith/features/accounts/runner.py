"""The account switch itself (contracts/accounts.md, "Switch"), run by the feature as a transient
systemd unit (`systemd-run --user`), so it finishes on its own even though it stops EDITH's Claude
and survives the bridge going down:

    python3 -m edith.features.accounts.runner <plan.json>

1. stopping: every agent's Claude (SIGTERM, its pane kept with remain-on-exit), then edith-claude
   (`systemctl --user stop`). Nothing may run with the old login while the files change, or it
   could refresh its token and write the old account back.
2. saving: the live credentials (refreshed while Claude ran) back into the old account's profile.
3. installing: the new account's credentials and oauthAccount, atomically.
4. starting_agents: each pane respawned in its folder with `claude --resume <its session>`.
5. starting_edith: `systemctl --user restart edith-claude` (its launcher resumes her conversation).
6. checking: `claude auth status` shows the new account, and EDITH's and every agent's Claude
   reach their input box without a login error.

If 3-6 fail, everything is stopped again and the old account restored the same way (rolled_back).
Each step is reported to <status file> (atomic JSON, which GET /v1/accounts reads, e.g. after the
app reconnects) and as a datagram to the feature's socket (live `accounts.switch` events); a
bridge that is down misses only the datagram. Nothing here reads or prints a token.
"""
import json
import os
import re
import select
import shlex
import signal
import socket
import subprocess
import sys
import time

from .profiles import Profiles, ProfileError, write_private

READY = re.compile(r"^\s*❯", re.M)  # Claude's input box
LOGIN_ERROR = re.compile(r"Please run /login|Invalid API key|OAuth token (?:has )?expired|authentication_error"
                         r"|Not logged in", re.I)
BOTTOM = 15


class StepError(Exception):
    pass


class System:
    """What the runner does to the machine; tests replace it."""

    def run(self, cmd, timeout=30.0, env=None):
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)

    def kill(self, pid, sig):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass

    def wait_exit(self, pid, timeout) -> bool:
        """Wait for a process to end (a pidfd: woken by its exit, no polling)."""
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            return True
        try:
            return bool(select.select([fd], [], [], timeout)[0])
        finally:
            os.close(fd)

    monotonic = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)
    now = staticmethod(time.time)


class Switch:
    def __init__(self, plan: dict, system: System | None = None, profiles: Profiles | None = None):
        self.plan, self.sys = plan, system or System()
        self.profiles = profiles or Profiles(plan["root"], plan["claude_dir"], plan["claude_json"])
        self.agents = [dict(a) for a in plan.get("agents", [])]
        self.tmux = list(plan.get("tmux") or ["tmux"]) + (["-L", plan["agents_socket"]] if plan.get("agents_socket") else [])
        self.edith_tmux = list(plan.get("tmux") or ["tmux"]) + ["-L", plan.get("edith_socket", "edith")]
        self.status = {"run": plan["run"], "unit": plan.get("unit"), "target": plan["target"], "previous": None,
                       "state": "running", "step": None, "detail": None, "started": self.sys.now(),
                       "agents": [a["name"] for a in self.agents]}

    # ---- reporting ----

    def report(self, step=None, state="running", detail=None):
        self.status.update(step=step or self.status["step"], state=state, detail=detail, ts=self.sys.now())
        data = json.dumps(self.status).encode()
        try:
            write_private(self.plan["status_file"], data)
        except OSError as e:
            print(f"accounts: can't write the status file: {e}", file=sys.stderr)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            sock.sendto(data, self.plan["socket"])
        except OSError:
            pass  # the bridge is down or not listening: the status file has it
        finally:
            sock.close()
        print(f"accounts: {state} {self.status['step']}" + (f": {detail}" if detail else ""), flush=True)

    # ---- the steps ----

    def _tmux(self, *args, edith=False, timeout=10.0):
        return self.sys.run((self.edith_tmux if edith else self.tmux) + list(args), timeout)

    def _pane_pid(self, pane) -> int | None:
        r = self._tmux("display-message", "-p", "-t", pane, "#{pane_dead} #{pane_pid}")
        parts = (r.stdout or "").split() if r.returncode == 0 else []
        return int(parts[1]) if len(parts) == 2 and parts[0] == "0" and parts[1].isdigit() else None

    def stop_agents(self):
        for a in self.agents:
            self._tmux("set-option", "-p", "-t", a["pane"], "remain-on-exit", "on")
            pid = a["pid"]
            self.sys.kill(pid, signal.SIGTERM)
            if not self.sys.wait_exit(pid, self.plan.get("stop_grace", 20)):
                self.sys.kill(pid, signal.SIGKILL)
                if not self.sys.wait_exit(pid, 5):
                    raise StepError(f"{a['name']}'s Claude didn't stop")

    def stop_edith(self):
        r = self.sys.run(["systemctl", "--user", "stop", self.plan.get("service", "edith-claude")], 90)
        if r.returncode != 0:
            raise StepError(f"couldn't stop {self.plan.get('service', 'edith-claude')}")

    def start_agents(self):
        path = self.plan.get("path") or os.environ.get("PATH", "/usr/bin:/bin")
        claude = self.plan.get("claude", "claude")
        for a in self.agents:
            resume = ["--resume", a["session_id"]] if a.get("session_id") else ["--continue"]
            cmd = f"export PATH={shlex.quote(path)}; exec {shlex.join([claude, *resume])}"
            r = self._tmux("respawn-pane", "-k", "-t", a["pane"], "-c", a["cwd"], cmd)
            if r.returncode != 0:
                raise StepError(f"couldn't restart {a['name']}")
            self._tmux("set-option", "-p", "-u", "-t", a["pane"], "remain-on-exit")
            a["pid"] = self._pane_pid(a["pane"]) or a["pid"]  # `exec claude`: the pane's process is Claude

    def start_edith(self):
        r = self.sys.run(["systemctl", "--user", "restart", self.plan.get("service", "edith-claude")], 90)
        if r.returncode != 0:
            raise StepError(f"couldn't start {self.plan.get('service', 'edith-claude')}")

    def check(self, pid):
        email = self.profiles.get(pid).get("email")
        env = dict(os.environ, HOME=self.plan.get("home") or os.path.expanduser("~"))
        r = self.sys.run([self.plan.get("claude", "claude"), "auth", "status", "--json"], 30, env=env)
        try:
            status = json.loads(r.stdout or "")
        except ValueError:
            status = {}
        if not status.get("loggedIn"):
            raise StepError("Claude isn't logged in with the new account")
        if email and status.get("email") and status["email"].lower() != email.lower():
            raise StepError("Claude is logged in to a different account")
        screens = [("EDITH", ("capture-pane", "-p", "-t", self.plan.get("edith_target", "edith")), True)]
        screens += [(a["name"], ("capture-pane", "-p", "-t", a["pane"]), False) for a in self.agents]
        deadline = self.sys.monotonic() + self.plan.get("ready_timeout", 90)
        for name, args, edith in screens:
            # Polled with backoff: what tmux shows has no notification. Bounded by ready_timeout.
            delay = 0.25
            while True:
                r = self._tmux(*args, edith=edith)
                bottom = "\n".join((r.stdout or "").rstrip().splitlines()[-BOTTOM:]) if r.returncode == 0 else ""
                if LOGIN_ERROR.search(bottom):
                    raise StepError(f"{name}'s Claude says the login didn't work")
                if READY.search(bottom):
                    break
                if self.sys.monotonic() >= deadline:
                    raise StepError(f"{name}'s Claude didn't come back up")
                self.sys.sleep(delay)
                delay = min(2.0, delay * 2)

    def _up(self, pid):
        self.profiles.install(pid)
        self.report("starting_agents")
        self.start_agents()
        self.report("starting_edith")
        self.start_edith()
        self.report("checking")
        self.check(pid)

    def run(self) -> str:
        target = self.plan["target"]
        self.report("stopping")
        try:
            self.profiles.get(target)
            self.stop_agents()
            self.stop_edith()
            self.report("saving")
            previous = self.profiles.save_current()
            self.status["previous"] = previous
        except (StepError, ProfileError, OSError, subprocess.SubprocessError) as e:
            # Nothing changed yet: bring everyone back up on the login they had.
            try:
                self.start_agents()
                self.start_edith()
            except (StepError, OSError, subprocess.SubprocessError) as e2:
                return self.end("failed", f"{e}; restarting failed too: {e2}")
            return self.end("failed", str(e))
        try:
            self.report("installing")
            self._up(target)
            return self.end("done")
        except (StepError, ProfileError, OSError, subprocess.SubprocessError) as e:
            detail = str(e)
            if previous is None:
                return self.end("failed", f"{detail}; there is no previous account to go back to")
        self.report("rolling_back", detail=detail)
        try:
            self.stop_agents()
            self.stop_edith()
            self._up(previous)
            return self.end("rolled_back", detail)
        except (StepError, ProfileError, OSError, subprocess.SubprocessError) as e:
            return self.end("failed", f"{detail}; going back failed too: {e}")

    def end(self, state, detail=None):
        self.report(state=state, detail=detail)
        return state


def main(argv):
    with open(argv[1]) as f:
        plan = json.load(f)
    os.unlink(argv[1])
    state = Switch(plan).run()
    return 0 if state == "done" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
