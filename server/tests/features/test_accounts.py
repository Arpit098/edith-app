"""Claude accounts: profiles, the headless login, the switch runner and the routes. Everything runs on
a scratch HOME with fake tmux, systemctl and claude: nothing live is touched."""
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from types import SimpleNamespace
from unittest import mock

from edith.core import ApiError, Event, EventBus, Ports, Registry
from edith.core.registry import load_features
from edith.features import accounts
from edith.features.accounts.login import Login, LoginError, failure_line
from edith.features.accounts.panes import Panes
from edith.features.accounts.profiles import ProfileError, Profiles
from edith.features.accounts.runner import Switch
from edith.ports.agent import RunInfo

TOKENS = ("sk-ant-oat01-ACCESS", "sk-ant-ort01-REFRESH")  # must never appear in an answer


def creds(n, plan="max"):
    return json.dumps({"claudeAiOauth": {"accessToken": f"{TOKENS[0]}-{n}", "refreshToken": f"{TOKENS[1]}-{n}",
                                         "expiresAt": 1, "scopes": ["user:inference"], "subscriptionType": plan}})


def oauth(n):
    return {"accountUuid": f"uuid-{n}", "emailAddress": f"user{n}@example.com", "displayName": f"User {n}"}


class Home:
    """A scratch HOME with Claude logged in as account 1."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self.claude_dir = os.path.join(self.home, ".claude")
        self.claude_json = os.path.join(self.home, ".claude.json")
        self.root = os.path.join(self.home, ".config/edith/claude-accounts")
        os.makedirs(os.path.join(self.claude_dir, "sessions"))
        self.login_as(1)
        self.profiles = Profiles(self.root, self.claude_dir, self.claude_json)

    def login_as(self, n, plan="max"):
        with open(os.path.join(self.claude_dir, ".credentials.json"), "w") as f:
            f.write(creds(n, plan))
        with open(self.claude_json, "w") as f:
            json.dump({"numStartups": 7, "oauthAccount": oauth(n), "projects": {"/x": {}}}, f)

    def live(self):
        with open(os.path.join(self.claude_dir, ".credentials.json")) as f:
            c = json.load(f)
        with open(self.claude_json) as f:
            return c["claudeAiOauth"]["refreshToken"], json.load(f)

    def login_dir(self, n):
        d = tempfile.mkdtemp(dir=self.home)
        with open(os.path.join(d, ".credentials.json"), "w") as f:
            f.write(creds(n, "pro"))
        with open(os.path.join(d, ".claude.json"), "w") as f:
            json.dump({"oauthAccount": oauth(n)}, f)
        return d

    def cleanup(self):
        self.tmp.cleanup()


def mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


class ProfilesTest(unittest.TestCase):
    def setUp(self):
        self.h = Home()
        self.addCleanup(self.h.cleanup)
        self.p = self.h.profiles

    def test_the_login_in_use_is_saved_and_listed_without_tokens(self):
        accounts_ = self.p.list()
        self.assertEqual(len(accounts_), 1)
        a = accounts_[0]
        self.assertEqual({k: a[k] for k in ("label", "email", "plan", "active")},
                         {"label": "User 1", "email": "user1@example.com", "plan": "max", "active": True})
        self.assertEqual(set(a), {"id", "label", "email", "plan", "active"})
        self.assertNotIn("sk-ant", json.dumps(accounts_))
        folder = os.path.join(self.h.root, a["id"])
        self.assertEqual((mode(self.h.root), mode(folder)), (0o700, 0o700))
        for name in ("credentials.json", "account.json"):
            self.assertEqual(mode(os.path.join(folder, name)), 0o600)
        self.assertEqual(self.p.list(), accounts_)  # saved once

    def test_add_relogin_and_remove(self):
        first = self.p.list()[0]["id"]
        second = self.p.add(self.h.login_dir(2), label="Work")
        listed = self.p.list()
        self.assertEqual([(a["label"], a["active"]) for a in listed], [("User 1", True), ("Work", False)])
        self.assertEqual(self.p.add(self.h.login_dir(2)), second)  # the same account again: refreshed, not doubled
        self.assertEqual(self.p.get(second)["label"], "Work")
        with self.assertRaisesRegex(ProfileError, "in use"):
            self.p.remove(first)
        self.p.remove(second)
        self.assertEqual([a["id"] for a in self.p.list()], [first])
        with self.assertRaises(ProfileError):
            self.p.remove("../../etc")

    def test_add_needs_a_real_login(self):
        empty = tempfile.mkdtemp(dir=self.h.home)
        with self.assertRaisesRegex(ProfileError, "no credentials"):
            self.p.add(empty)
        with open(os.path.join(empty, ".credentials.json"), "w") as f:
            f.write('{"claudeAiOauth": {}}')
        with self.assertRaisesRegex(ProfileError, "no Claude login"):
            self.p.add(empty)

    def test_install_and_save_current(self):
        first = self.p.list()[0]["id"]
        second = self.p.add(self.h.login_dir(2))
        self.h.login_as(1)  # Claude refreshed account 1's token while it ran
        with open(os.path.join(self.h.claude_dir, ".credentials.json"), "w") as f:
            f.write(creds("1b"))
        self.assertEqual(self.p.save_current(), first)
        self.p.install(second)
        token, cfg = self.h.live()
        self.assertEqual(token, f"{TOKENS[1]}-2")
        self.assertEqual(cfg["oauthAccount"]["accountUuid"], "uuid-2")
        self.assertEqual((cfg["numStartups"], cfg["projects"]), (7, {"/x": {}}))  # the rest of ~/.claude.json kept
        self.assertEqual(mode(os.path.join(self.h.claude_dir, ".credentials.json")), 0o600)
        self.assertEqual(self.p.active(), second)
        self.p.install(first)
        self.assertEqual(self.h.live()[0], f"{TOKENS[1]}-1b")  # the refreshed token came back


FAKE_CLAUDE = textwrap.dedent("""\
    #!{python}
    import json, os, sys
    d = os.environ["CLAUDE_CONFIG_DIR"]
    if sys.argv[1:3] != ["auth", "login"]:
        sys.exit(2)
    print("Opening browser to sign in…")
    print("If the browser didn't open, visit: \\x1b]8;;https://claude.com/cai/oauth/authorize?code=true&state=abc\\x07"
          "https://claude.com/cai/oauth/authorize?code=true&state=abc\\x1b]8;;\\x07")
    print("Paste code here if prompted > ", end="", flush=True)
    code = sys.stdin.readline().strip()
    if code != "good-code#abc":
        print("Login failed: That code wasn't accepted. Sign in again to get a new code.")
        sys.exit(1)
    open(os.path.join(d, ".credentials.json"), "w").write({creds!r})
    json.dump({{"oauthAccount": {oauth!r}}}, open(os.path.join(d, ".claude.json"), "w"))
    print("Login successful.")
""")


def fake_claude(folder):
    path = os.path.join(folder, "claude")
    with open(path, "w") as f:
        f.write(FAKE_CLAUDE.format(python=sys.executable, creds=creds(3), oauth=oauth(3)))
    os.chmod(path, 0o755)
    return path


class LoginTest(unittest.TestCase):
    def setUp(self):
        self.h = Home()
        self.addCleanup(self.h.cleanup)
        self.claude = fake_claude(self.h.home)
        self.env = {"HOME": self.h.home, "PATH": os.environ["PATH"]}

    def test_url_then_code(self):
        flow = Login(self.claude, self.h.root, self.env)
        self.assertEqual(flow.start(), "https://claude.com/cai/oauth/authorize?code=true&state=abc")
        self.assertEqual(mode(flow.dir), 0o700)
        with self.assertRaisesRegex(LoginError, "doesn't look like"):
            flow.finish("no spaces allowed")
        folder = flow.finish("good-code#abc")
        pid = self.h.profiles.add(folder)
        self.assertEqual(self.h.profiles.get(pid)["email"], "user3@example.com")
        flow.cancel()
        self.assertFalse(os.path.exists(flow.dir))

    def test_a_wrong_code(self):
        flow = Login(self.claude, self.h.root, self.env)
        flow.start()
        with self.assertRaisesRegex(LoginError, "That code wasn't accepted"):
            flow.finish("bad-code#abc")
        self.assertFalse(os.path.exists(flow.dir))

    def test_no_url(self):
        flow = Login("/bin/true", self.h.root, self.env, url_timeout=5)
        with self.assertRaisesRegex(LoginError, "sign-in link"):
            flow.start()

    def test_failure_line_hides_tokens(self):
        self.assertEqual(failure_line("x\nError: bad token sk-ant-ort01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"), "Error: bad token …")


IDLE_SCREEN = "● Done.\n\n──────\n❯ \n──────\n  ? for shortcuts\n"
BUSY_SCREEN = "● Running tests…\n\n✻ Thinking… (esc to interrupt)\n❯ \n"
APPROVAL_SCREEN = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n"


class FakeTmux:
    """tmux on the default socket: panes -> (session, pane_pid, cwd, screen)."""

    def __init__(self, panes, edith_pid=900):
        self.panes, self.edith_pid, self.calls = panes, edith_pid, []

    def __call__(self, cmd, **kw):
        self.calls.append(cmd)
        edith = "-L" in cmd and cmd[cmd.index("-L") + 1] == "edith"
        if "list-panes" in cmd:
            rows = ([f"edith\t%0\t{self.edith_pid}\t/home/x/edith"] if edith
                    else [f"{s}\t{p}\t{pid}\t{cwd}" for p, (s, pid, cwd, _) in self.panes.items()])
            return SimpleNamespace(returncode=0, stdout="\n".join(rows) + "\n")
        if "capture-pane" in cmd:
            return SimpleNamespace(returncode=0, stdout=self.panes[cmd[cmd.index("-t") + 1]][3])
        return SimpleNamespace(returncode=1, stdout="")


def session_file(claude_dir, pid, sid, cwd):
    with open(os.path.join(claude_dir, "sessions", f"{pid}.json"), "w") as f:
        json.dump({"pid": pid, "sessionId": sid, "cwd": cwd, "kind": "interactive"}, f)


SID = "7e35e50b-3c6c-4b2b-afaa-51c9e88303ef"


class PanesTest(unittest.TestCase):
    def setUp(self):
        self.h = Home()
        self.addCleanup(self.h.cleanup)

    def test_agents_their_sessions_and_others(self):
        tmux = FakeTmux({"%1": ("edith-dev", 101, "/w/dev", IDLE_SCREEN), "%2": ("edith-app", 200, "/w/app", BUSY_SCREEN),
                         "%3": ("shell", 300, "/w", "$ ")})
        session_file(self.h.claude_dir, 101, SID, "/w/dev")
        session_file(self.h.claude_dir, 201, "not-a-uuid", "/w/app")  # under the pane's shell
        session_file(self.h.claude_dir, 901, SID, "/home/x/edith")       # EDITH's, under -L edith
        session_file(self.h.claude_dir, 555, SID, "/elsewhere")          # some other Claude
        session_file(self.h.claude_dir, 556, SID, "/gone")               # ended (stale file)
        p = Panes(self.h.claude_dir, run=tmux, children=lambda pid: {200: [201], 900: [901]}.get(pid, []),
                  alive=lambda pid: pid != 556)
        agents_ = p.agents()
        self.assertEqual([(a["name"], a["pane"], a["pid"], a["cwd"], a["session_id"], a["state"]) for a in agents_],
                         [("edith-app", "%2", 201, "/w/app", None, "busy"), ("edith-dev", "%1", 101, "/w/dev", SID, "idle")])
        self.assertEqual(p.others({a["pid"] for a in agents_}), [{"pid": 555, "cwd": "/elsewhere"}])
        self.assertFalse(any("send-keys" in c for c in tmux.calls))


class FakeSystem:
    """The runner's machine: records every command; Claude processes stop on SIGTERM."""

    def __init__(self, home, auth_email, screens=None):
        self.home, self.auth_email, self.calls, self.t = home, auth_email, [], 0.0
        self.screens = screens or {}
        self.on_install = None

    def run(self, cmd, timeout=30.0, env=None):
        self.calls.append(("run", tuple(cmd)))
        if cmd[1:3] == ["auth", "status"]:
            return SimpleNamespace(returncode=0, stdout=json.dumps({"loggedIn": True, "email": self.auth_email()}))
        if "capture-pane" in cmd:
            screens = self.screens() if callable(self.screens) else self.screens
            return SimpleNamespace(returncode=0, stdout=screens.get(cmd[-1], IDLE_SCREEN))
        if "display-message" in cmd:
            return SimpleNamespace(returncode=0, stdout="0 4242\n")
        return SimpleNamespace(returncode=0, stdout="")

    def kill(self, pid, sig):
        self.calls.append(("kill", pid, int(sig)))

    def wait_exit(self, pid, timeout):
        return True

    def monotonic(self):
        return self.t

    def sleep(self, s):
        self.t += s

    def now(self):
        return 1000.0


class SwitchTest(unittest.TestCase):
    def setUp(self):
        self.h = Home()
        self.addCleanup(self.h.cleanup)
        self.first = self.h.profiles.list()[0]["id"]
        self.second = self.h.profiles.add(self.h.login_dir(2))
        self.state = os.path.join(self.h.home, "state")
        os.makedirs(self.state)
        self.sock_path = os.path.join(self.state, "accounts.sock")
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        self.sock.bind(self.sock_path)
        self.sock.setblocking(False)
        self.addCleanup(self.sock.close)

    def plan(self, target):
        return {"run": "r1", "unit": "u1", "target": target, "root": self.h.root, "claude_dir": self.h.claude_dir,
                "claude_json": self.h.claude_json, "claude": "claude", "home": self.h.home, "path": "/bin",
                "agents": [{"name": "edith-dev", "pane": "%1", "pid": 101, "cwd": "/w/dev", "session_id": SID},
                           {"name": "edith-app", "pane": "%2", "pid": 201, "cwd": "/w/app", "session_id": None}],
                "status_file": os.path.join(self.state, "accounts-switch.json"), "socket": self.sock_path,
                "ready_timeout": 10}

    def email_now(self):
        return self.h.live()[1]["oauthAccount"]["emailAddress"]

    def events(self):
        out = []
        while True:
            try:
                out.append(json.loads(self.sock.recv(65536)))
            except BlockingIOError:
                return out

    def test_switch_order_and_progress(self):
        system = FakeSystem(self.h.home, self.email_now)
        self.assertEqual(Switch(self.plan(self.second), system).run(), "done")
        self.assertEqual(self.h.live()[1]["oauthAccount"]["accountUuid"], "uuid-2")
        calls = system.calls
        kills = [i for i, c in enumerate(calls) if c[0] == "kill"]
        stop = calls.index(("run", ("systemctl", "--user", "stop", "edith-claude")))
        restart = calls.index(("run", ("systemctl", "--user", "restart", "edith-claude")))
        respawns = [i for i, c in enumerate(calls) if c[0] == "run" and "respawn-pane" in c[1]]
        self.assertEqual([calls[i][1:] for i in kills], [(101, 15), (201, 15)])
        self.assertTrue(max(kills) < stop < min(respawns) and max(respawns) < restart)  # everyone stops first, EDITH starts last
        dev = calls[respawns[0]][1]
        self.assertEqual(dev[dev.index("-c") + 1], "/w/dev")
        self.assertTrue(dev[-1].endswith(f"exec claude --resume {SID}"))
        self.assertTrue(calls[respawns[1]][1][-1].endswith("exec claude --continue"))
        remain = [c[1] for c in calls if c[0] == "run" and "remain-on-exit" in c[1]]
        self.assertEqual(len(remain), 4)  # kept while stopped, unset once respawned
        steps = [(e["state"], e["step"]) for e in self.events()]
        self.assertEqual(steps, [("running", "stopping"), ("running", "saving"), ("running", "installing"),
                                 ("running", "starting_agents"), ("running", "starting_edith"), ("running", "checking"),
                                 ("done", "checking")])
        with open(self.plan(self.second)["status_file"]) as f:
            final = json.load(f)
        self.assertEqual((final["state"], final["previous"], final["agents"]), ("done", self.first, ["edith-dev", "edith-app"]))
        self.assertNotIn("sk-ant", json.dumps(final))

    def test_rolls_back_when_the_new_login_fails(self):
        def screens():  # the new account's login is broken: edith-dev says so
            return {"%1": "Invalid API key · Please run /login\n❯ \n"} if self.email_now() == "user2@example.com" else {}
        system = FakeSystem(self.h.home, self.email_now, screens=screens)
        self.assertEqual(Switch(self.plan(self.second), system).run(), "rolled_back")
        self.assertEqual(self.h.live()[1]["oauthAccount"]["accountUuid"], "uuid-1")
        events = self.events()
        self.assertIn(("running", "rolling_back"), [(e["state"], e["step"]) for e in events])
        self.assertEqual(events[-1]["state"], "rolled_back")
        self.assertIn("edith-dev", events[-1]["detail"])

    def test_wrong_account_after_restart(self):
        system = FakeSystem(self.h.home, lambda: "someone@else.com")
        self.assertEqual(Switch(self.plan(self.second), system).run(), "failed")  # and going back fails the same check
        self.assertIn("different account", self.events()[-1]["detail"])

    def test_a_stuck_start_times_out(self):
        system = FakeSystem(self.h.home, self.email_now, screens={"edith": "Starting…\n"})
        plan = self.plan(self.second)
        self.assertEqual(Switch(plan, system).run(), "failed")
        self.assertIn("EDITH's Claude didn't come back up", self.events()[-1]["detail"])

    def test_nothing_changes_when_stopping_fails(self):
        system = FakeSystem(self.h.home, self.email_now)
        real = system.run

        def run(cmd, timeout=30.0, env=None):
            if cmd[:3] == ["systemctl", "--user", "stop"]:
                system.calls.append(("run", tuple(cmd)))
                return SimpleNamespace(returncode=1, stdout="")
            return real(cmd, timeout, env)
        system.run = run
        self.assertEqual(Switch(self.plan(self.second), system).run(), "failed")
        self.assertEqual(self.h.live()[1]["oauthAccount"]["accountUuid"], "uuid-1")
        self.assertTrue(any(c[0] == "run" and "respawn-pane" in c[1] for c in system.calls))  # agents brought back


class FakeAgent:
    max_side_lanes = 2

    def __init__(self):
        self.runs, self.queued = [], 0

    def status(self):
        return list(self.runs), self.queued


class RoutesTest(unittest.TestCase):
    def setUp(self):
        self.h = Home()
        self.addCleanup(self.h.cleanup)
        self.agent = FakeAgent()
        self.tmux = FakeTmux({"%1": ("edith-dev", 101, "/w/dev", IDLE_SCREEN)})
        session_file(self.h.claude_dir, 101, SID, "/w/dev")
        self.panes = Panes(self.h.claude_dir, run=self.tmux, children=lambda pid: [], alive=lambda pid: True)
        self.launched = []
        patches = [mock.patch.object(accounts, "Panes", lambda *a, **k: self.panes),
                   mock.patch.object(accounts, "launch", self.launch),
                   mock.patch.object(accounts, "unit_active", lambda unit: unit in self.active_units)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.active_units = set()
        self.bus, registry = EventBus(), Registry()
        self.events = []
        self.bus.subscribe("accounts.*", self.events.append, owner="test")
        cfg = {"root": self.h.root, "claude_dir": self.h.claude_dir, "claude_json": self.h.claude_json,
               "claude": fake_claude(self.h.home), "state_dir": os.path.join(self.h.home, "state")}
        with mock.patch.dict(os.environ, {"HOME": self.h.home}):
            report = load_features(["accounts"], self.bus, Ports(agent=self.agent), registry, {"accounts": cfg})
        self.assertEqual(report.loaded, ["accounts"], report.failed)
        self.routes = registry.routes
        self.state = cfg["state_dir"]

    def launch(self, cmd):
        self.launched.append(cmd)
        self.active_units.add(cmd[cmd.index("--unit") + 1])
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    def call(self, method, path, params=None, body=None):
        return self.routes[(method, path)].handler({"body": body, "params": params or {}, "query": {}, "headers": {},
                                                     "origin": "app"})

    def test_list_add_and_remove(self):
        listed = self.call("GET", "/v1/accounts")
        self.assertEqual([a["email"] for a in listed["accounts"]], ["user1@example.com"])
        self.assertEqual((listed["switch"], listed["login"]), (None, None))
        started = self.call("POST", "/v1/accounts/login")
        self.assertIn("/oauth/authorize?", started["url"])
        self.assertEqual(self.call("GET", "/v1/accounts")["login"], {"id": started["id"], "url": started["url"]})
        with self.assertRaises(ApiError) as e:
            self.call("POST", "/v1/accounts/login/{login}", {"login": started["id"]}, {"code": "not a code"})
        self.assertEqual(e.exception.status, 400)
        added = self.call("POST", "/v1/accounts/login/{login}", {"login": started["id"]}, {"code": "good-code#abc", "label": "Spare"})
        self.assertEqual({k: added["account"][k] for k in ("label", "email", "active")},
                         {"label": "Spare", "email": "user3@example.com", "active": False})
        listed = self.call("GET", "/v1/accounts")
        self.assertEqual(len(listed["accounts"]), 2)
        self.assertIsNone(listed["login"])
        self.assertNotIn("sk-ant", json.dumps(listed))
        with self.assertRaises(ApiError) as e:
            self.call("DELETE", "/v1/accounts/{id}", {"id": listed["accounts"][0]["id"]})
        self.assertEqual(e.exception.status, 409)
        self.call("DELETE", "/v1/accounts/{id}", {"id": added["account"]["id"]})
        self.assertEqual(len(self.call("GET", "/v1/accounts")["accounts"]), 1)

    def test_login_cancel_and_expiry(self):
        started = self.call("POST", "/v1/accounts/login")
        self.assertEqual(self.call("DELETE", "/v1/accounts/login/{login}", {"login": started["id"]}), {"cancelled": True})
        with self.assertRaises(ApiError) as e:
            self.call("POST", "/v1/accounts/login/{login}", {"login": started["id"]}, {"code": "good-code#abc"})
        self.assertEqual(e.exception.status, 404)
        self.assertEqual([n for n in os.listdir(self.h.root) if n.startswith(".login-")], [])

    def second(self):
        return self.h.profiles.add(self.h.login_dir(2))

    def refused(self, target):
        with self.assertRaises(ApiError) as e:
            self.call("POST", "/v1/accounts/{id}/switch", {"id": target})
        self.assertEqual(e.exception.status, 409)
        return e.exception.message

    def test_switch_refuses_unless_idle_and_says_why(self):
        target = self.second()
        self.tmux.panes["%1"] = ("edith-dev", 101, "/w/dev", BUSY_SCREEN)
        self.assertIn("edith-dev is busy", self.refused(target))
        self.tmux.panes["%1"] = ("edith-dev", 101, "/w/dev", APPROVAL_SCREEN)
        self.assertIn("edith-dev is waiting for approval", self.refused(target))
        self.tmux.panes["%1"] = ("edith-dev", 101, "/w/dev", IDLE_SCREEN)
        self.agent.runs, self.agent.queued = [RunInfo("r1", "main", 1.0, None)], 2
        self.assertEqual(self.refused(target), "Can't switch while EDITH is working on a task; 2 messages queued")
        self.agent.runs, self.agent.queued = [], 0
        self.bus.publish(Event("permission.request", {"id": "p1", "tool": "Bash"}))
        self.assertIn("an approval is waiting", self.refused(target))
        self.bus.publish(Event("permission.resolved", {"id": "p1", "decision": "allow"}))
        session_file(self.h.claude_dir, 777, SID, "/somewhere")
        self.assertIn("another Claude is running (pid 777, in /somewhere)", self.refused(target))
        os.unlink(os.path.join(self.h.claude_dir, "sessions", "777.json"))
        self.assertIn("already in use", self.refused(self.h.profiles.active()))
        self.assertEqual(self.launched, [])

    def test_switch_starts_a_transient_unit(self):
        target = self.second()
        answer = self.call("POST", "/v1/accounts/{id}/switch", {"id": target})
        self.assertEqual(answer["status"], "switching")
        cmd = self.launched[0]
        self.assertEqual(cmd[:3], ["systemd-run", "--user", "--unit"])
        self.assertEqual(cmd[-3:-1], ["-m", "edith.features.accounts.runner"])
        plan_file = cmd[-1]
        self.assertEqual(mode(plan_file), 0o600)
        with open(plan_file) as f:
            plan = json.load(f)
        self.assertNotIn("sk-ant", json.dumps(plan))
        self.assertEqual((plan["target"], [a["session_id"] for a in plan["agents"]]), (target, [SID]))
        self.assertEqual(self.events[-1].data["step"], "starting")
        self.assertIn("a switch is already running", self.refused(target))
        listed = self.call("GET", "/v1/accounts")
        self.assertEqual((listed["switch"]["state"], listed["switch"]["target"]), ("running", target))
        self.assertNotIn("unit", listed["switch"])

        # The runner's progress arrives as events, from its socket.
        sent = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        for state, step in (("running", "stopping"), ("done", "checking")):
            sent.sendto(json.dumps({"run": answer["run"], "unit": "u", "state": state, "step": step}).encode(),
                        plan["socket"])
        sent.close()
        deadline = time.monotonic() + 5  # the listener thread publishes them
        while self.events[-1].data.get("state") != "done" and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual([(e.data["state"], e.data["step"]) for e in self.events[-2:]], [("running", "stopping"), ("done", "checking")])
        self.assertNotIn("unit", self.events[-1].data)

    def test_an_interrupted_switch_is_reported_failed(self):
        os.makedirs(self.state, exist_ok=True)
        with open(os.path.join(self.state, "accounts-switch.json"), "w") as f:
            json.dump({"run": "r", "unit": "gone", "state": "running", "step": "checking", "ts": 1.0}, f)
        self.assertEqual(self.call("GET", "/v1/accounts")["switch"]["state"], "failed")

    def test_systemd_run_failing(self):
        target = self.second()
        self.launch = lambda cmd: SimpleNamespace(returncode=1, stdout="", stderr="no bus")
        with mock.patch.object(accounts, "launch", self.launch):
            with self.assertRaises(ApiError) as e:
                self.call("POST", "/v1/accounts/{id}/switch", {"id": target})
        self.assertEqual(e.exception.status, 503)
        self.assertEqual(self.call("GET", "/v1/accounts")["switch"]["state"], "failed")


class RunnerMainTest(unittest.TestCase):
    def test_runs_as_a_module(self):
        r = subprocess.run([sys.executable, "-m", "edith.features.accounts.runner", "/nonexistent-plan.json"],
                           capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
        self.assertIn("FileNotFoundError", r.stderr)  # importable standalone; fails only on the missing plan


if __name__ == "__main__":
    unittest.main()
