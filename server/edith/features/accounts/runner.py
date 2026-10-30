"""The account switch itself (contracts/accounts.md, "Switch"), run by the feature as a transient
systemd unit (`systemd-run --user`), so it finishes on its own even though it stops EDITH's Claude
and survives the bridge going down. The bridge holds its agent while it runs (no turn starts and it
doesn't start edith-claude), until the last report.

    python3 -m edith.features.accounts.runner <plan.json>

0. Check again that every Claude is idle (their session files, EDITH's included) and that the agents
   are the ones in the plan; otherwise stop here, having changed nothing.
1. stopping: every agent's Claude (SIGTERM through a pidfd, after checking it is still that Claude;
   its pane kept with remain-on-exit), then edith-claude (`systemctl --user stop`). Nothing may run
   with the old login while the files change, or it could refresh and write the old one back.
2. saving: the live credentials (refreshed while Claude ran) back into the old account's profile.
3. installing: the new account's credentials and oauthAccount.
4. starting_edith: edith-claude alone (`systemctl --user restart`; her launcher resumes her
   conversation) until her input box shows. If her token needed refreshing, she did it alone (a
   refresh may rotate the refresh token, which would lock out others refreshing at the same time);
   the result is saved into the profile.
5. starting_agents: each pane respawned in its folder with `claude --resume <its session>`.
6. checking: the live credentials are still the profile's, `claude auth status` shows the new
   account, and every Claude reaches its input box without a login error.

If 3-6 fail, everything is stopped again, the new account's credentials saved back (they may have
rotated; not if they stopped matching its profile, as their origin is then unknown) and the old
account brought back the same way (rolled_back). Whatever happens, at the end
edith-claude is started and every stopped pane respawned.

Each step goes to <status file> (atomic JSON, which GET /v1/accounts reads, e.g. after the app
reconnects) and as a datagram to the feature's socket (live `accounts.switch` events). Nothing here
reads out or prints a token.
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

from .panes import Panes, is_claude, proc_stat
from .profiles import Profiles, write_private

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

    def open_claude(self, pid, proc_start):
        """A pidfd for `pid` if it is still the Claude that started at `proc_start`, else None (it
        ended, or the pid now belongs to another process). Holding the pidfd, the pid can't be reused
        under us."""
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            return None
        if not is_claude(pid, proc_start):
            os.close(fd)
            return None
        return fd

    def signal(self, fd, sig):
        try:
            signal.pidfd_send_signal(fd, sig)
        except ProcessLookupError:
            pass

    def wait(self, fd, timeout) -> bool:
        """Wait for the process to end (woken by its exit, no polling)."""
        return bool(select.select([fd], [], [], timeout)[0])

    def close(self, fd):
        os.close(fd)

    def proc_start(self, pid):
        seen = proc_stat(pid)
        return seen[1] if seen else None

    monotonic = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)
    now = staticmethod(time.time)


class Switch:
    def __init__(self, plan: dict, system: System | None = None, profiles: Profiles | None = None,
                 panes: Panes | None = None):
        self.plan, self.sys = plan, system or System()
        self.profiles = profiles or Profiles(plan["root"], plan["claude_dir"], plan["claude_json"])
        tmux = list(plan.get("tmux") or ["tmux"])
        self.panes = panes or Panes(plan["claude_dir"], tmux=tmux[0], socket=plan.get("agents_socket"),
                                    edith_socket=plan.get("edith_socket", "edith"))
        self.agents = [dict(a) for a in plan.get("agents", [])]
        self.tmux = tmux + (["-L", plan["agents_socket"]] if plan.get("agents_socket") else [])
        self.edith_tmux = tmux + ["-L", plan.get("edith_socket", "edith")]
        self.service = plan.get("service", "edith-claude")
        self.down: set[str] = set()  # panes stopped and not started again yet
        self.foreign = False  # the live credentials stopped matching the profile: their origin is unknown
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

    def recheck(self):
        """Right before stopping anything: still idle, and still the same agents."""
        agents, why = self.panes.blockers()
        if why:
            raise StepError("Can't switch now: " + "; ".join(why))
        if sorted((a["pane"], a["pid"]) for a in agents) != sorted((a["pane"], a["pid"]) for a in self.agents):
            raise StepError("the coding agents changed since the switch was asked for; try again")

    def stop_agents(self):
        for a in self.agents:
            if a["pane"] in self.down:
                continue
            self._tmux("set-option", "-p", "-t", a["pane"], "remain-on-exit", "on")
            self.down.add(a["pane"])
            fd = self.sys.open_claude(a["pid"], a.get("proc_start"))
            if fd is None:
                continue  # already gone (or the pid is someone else's now): nothing to stop
            try:
                self.sys.signal(fd, signal.SIGTERM)
                if not self.sys.wait(fd, self.plan.get("stop_grace", 20)):
                    self.sys.signal(fd, signal.SIGKILL)
                    if not self.sys.wait(fd, 5):
                        raise StepError(f"{a['name']}'s Claude didn't stop")
            finally:
                self.sys.close(fd)

    def stop_edith(self):
        r = self.sys.run(["systemctl", "--user", "stop", self.service], 90)
        if r.returncode != 0:
            raise StepError(f"couldn't stop {self.service}")

    def _respawn(self, a):
        path = self.plan.get("path") or os.environ.get("PATH", "/usr/bin:/bin")
        argv = [self.plan.get("claude", "claude")] + (["--resume", a["session_id"]] if a.get("session_id") else [])
        cmd = f"export PATH={shlex.quote(path)}; exec {shlex.join(argv)}"
        r = self._tmux("respawn-pane", "-k", "-t", a["pane"], "-c", a["cwd"], cmd)
        if r.returncode != 0:
            raise StepError(f"couldn't restart {a['name']}")
        self.down.discard(a["pane"])
        self._tmux("set-option", "-p", "-u", "-t", a["pane"], "remain-on-exit")
        pid = self._pane_pid(a["pane"])  # `exec claude`: the pane's process is Claude
        if pid:
            a["pid"], a["proc_start"] = pid, self.sys.proc_start(pid)

    def start_agents(self):
        for a in self.agents:
            self._respawn(a)

    def start_edith(self):
        r = self.sys.run(["systemctl", "--user", "restart", self.service], 90)
        if r.returncode != 0:
            raise StepError(f"couldn't start {self.service}")

    def wait_ready(self, name, args, edith, deadline):
        """Until a Claude shows its input box. Polled with backoff: what tmux shows has no
        notification. Bounded by `deadline`."""
        delay = 0.25
        while True:
            r = self._tmux(*args, edith=edith)
            bottom = "\n".join((r.stdout or "").rstrip().splitlines()[-BOTTOM:]) if r.returncode == 0 else ""
            if LOGIN_ERROR.search(bottom):
                raise StepError(f"{name}'s Claude says the login didn't work")
            if READY.search(bottom):
                return
            if self.sys.monotonic() >= deadline:
                raise StepError(f"{name}'s Claude didn't come back up")
            self.sys.sleep(delay)
            delay = min(2.0, delay * 2)

    def _edith_screen(self):
        return ("capture-pane", "-p", "-t", self.plan.get("edith_target", "edith"))

    def check(self, pid):
        if not self.profiles.matches_live(pid):
            self.foreign = True
            raise StepError("the login changed while the Claudes started (something wrote other credentials)")
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
        deadline = self.sys.monotonic() + self.plan.get("ready_timeout", 90)
        self.wait_ready("EDITH", self._edith_screen(), True, deadline)
        for a in self.agents:
            self.wait_ready(a["name"], ("capture-pane", "-p", "-t", a["pane"]), False, deadline)

    def _up(self, pid):
        self.profiles.install(pid)
        self.report("starting_edith")
        self.start_edith()
        self.wait_ready("EDITH", self._edith_screen(), True, self.sys.monotonic() + self.plan.get("ready_timeout", 90))
        self.profiles.save_current()  # her refresh, if she needed one, is the profile's token from now on
        self.report("starting_agents")
        self.start_agents()
        self.report("checking")
        self.check(pid)

    def _switch(self):
        target = self.plan["target"]
        try:
            self.profiles.get(target)
            self.recheck()
            self.stop_agents()
            self.stop_edith()
            self.report("saving")
            previous = self.profiles.save_current()
        except Exception as e:  # nothing changed: everyone comes back on the login they had (run's finally)
            return "failed", str(e)
        self.status["previous"] = previous
        try:
            self.report("installing")
            self._up(target)
            return "done", None
        except Exception as e:
            detail = str(e) or type(e).__name__
        if previous is None:
            return "failed", f"{detail}; there is no previous account to go back to"
        self.report("rolling_back", detail=detail)
        try:
            self.stop_agents()
            self.stop_edith()
            if not self.foreign:  # never save credentials of unknown origin into the new account's profile
                self.profiles.save_current()  # its token may have rotated: keep it
            self._up(previous)
            return "rolled_back", detail
        except Exception as e:
            return "failed", f"{detail}; going back failed too: {e}"

    def ensure_up(self) -> list[str]:
        """Start edith-claude and respawn every stopped pane, whatever happened. -> what failed."""
        problems = []
        for a in self.agents:
            if a["pane"] in self.down:
                try:
                    self._respawn(a)
                except Exception as e:
                    problems.append(str(e))
        try:
            r = self.sys.run(["systemctl", "--user", "start", self.service], 90)  # a no-op if she's running
            if r.returncode != 0:
                problems.append(f"couldn't start {self.service}")
        except Exception as e:
            problems.append(f"couldn't start {self.service}: {e}")
        return problems

    def run(self) -> str:
        self.report("stopping")
        state, detail = "failed", "the switch was interrupted"
        try:
            state, detail = self._switch()
        except Exception as e:
            state, detail = "failed", f"unexpected error: {e}"
        finally:
            problems = self.ensure_up()
            if problems:
                state = "failed"
                detail = "; ".join(filter(None, [detail, *problems]))
            self.end(state, detail)
        return state

    def end(self, state, detail=None):
        self.report(state=state, detail=detail)
        return state


def main(argv):
    with open(argv[1]) as f:
        plan = json.load(f)
    os.unlink(argv[1])
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))  # a stopped unit still runs run()'s finally
    state = Switch(plan).run()
    return 0 if state == "done" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
