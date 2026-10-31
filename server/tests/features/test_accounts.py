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
from edith.features.accounts.panes import Panes, proc_stat, same_process
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

    def write_live_creds(self, text):
        with open(os.path.join(self.claude_dir, ".credentials.json"), "w") as f:
            f.write(text)

    def live_token(self):
        with open(os.path.join(self.claude_dir, ".credentials.json")) as f:
            return json.load(f)["claudeAiOauth"]["refreshToken"]

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

    def test_rename_changes_the_label_only(self):
        pid = self.p.list()[0]["id"]
        folder = os.path.join(self.h.root, pid)
        creds_path = os.path.join(folder, "credentials.json")
        with open(creds_path, "rb") as f:
            creds_before = f.read()
        creds_stat = os.stat(creds_path)
        before = self.p.get(pid)
        self.p.rename(pid, "  Personal max  ")
        after = self.p.get(pid)
        self.assertEqual(after, dict(before, label="Personal max"))  # nothing else in account.json moved
        self.assertEqual(self.p.list()[0]["label"], "Personal max")
        with open(creds_path, "rb") as f:
            self.assertEqual(f.read(), creds_before)
        self.assertEqual(os.stat(creds_path).st_mtime_ns, creds_stat.st_mtime_ns)  # never rewritten
        self.assertEqual(mode(os.path.join(folder, "account.json")), 0o600)
        self.assertEqual(sorted(os.listdir(folder)), ["account.json", "credentials.json"])  # no tmp file left
        self.p.rename(pid, "x" * 40)
        for bad, why in (("", "empty"), ("   ", "empty"), ("x" * 41, "at most 40"), ("a\nb", "one line"), (None, "text")):
            with self.subTest(bad=bad), self.assertRaisesRegex(ProfileError, why):
                self.p.rename(pid, bad)
        self.assertEqual(self.p.get(pid)["label"], "x" * 40)
        for unknown in ("0000000a", "../../etc"):
            with self.assertRaisesRegex(ProfileError, "unknown"):
                self.p.rename(unknown, "Work")

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
# The usage limit mid-task (the session file stays `busy`: the turn it cut off), and Claude's menu for it.
LIMIT_SCREEN = "● Running the build…\n  ⎿  Usage limit reached · continuing shortly\n──────\n❯ \n──────\n"
LIMIT_MENU_SCREEN = ("● Running the build…\n You've hit your limit · resets 3pm (Asia/Kolkata)\n\n"
                     " What do you want to do?\n\n ❯ 1. Stop and wait for limit to reset\n   2. Upgrade your plan\n")


class ClaudeJsonTest(unittest.TestCase):
    """install() never wipes ~/.claude.json, and never leaves it out of step with the credentials."""

    def setUp(self):
        self.h = Home()
        self.addCleanup(self.h.cleanup)
        self.p = self.h.profiles
        self.p.list()
        self.second = self.p.add(self.h.login_dir(2))

    def test_a_broken_claude_json_is_left_alone(self):
        for broken in ("[]", "{not json", ""):
            with open(self.h.claude_json, "w") as f:
                f.write(broken)
            with self.assertRaisesRegex(ProfileError, "isn't a JSON object"):
                self.p.install(self.second)
            with open(self.h.claude_json) as f:
                self.assertEqual(f.read(), broken)
            self.assertEqual(self.h.live_token(), f"{TOKENS[1]}-1")  # the credentials weren't changed either

    def test_a_missing_claude_json_is_created(self):
        os.unlink(self.h.claude_json)
        self.p.install(self.second)
        self.assertEqual(self.h.live()[1], {"oauthAccount": oauth(2)})
        self.assertEqual(mode(self.h.claude_json), 0o600)


class FakeTmux:
    """tmux on the default socket: panes -> (session, pane_pid, cwd, screen); EDITH's (-L edith) is
    pane %0, showing `edith_screen`."""

    def __init__(self, panes, edith_pid=900):
        self.panes, self.edith_pid, self.calls, self.edith_screen = panes, edith_pid, [], IDLE_SCREEN

    def __call__(self, cmd, **kw):
        self.calls.append(cmd)
        edith = "-L" in cmd and cmd[cmd.index("-L") + 1] == "edith"
        if "list-panes" in cmd:
            rows = ([f"edith\t%0\t{self.edith_pid}\t/home/x/edith"] if edith
                    else [f"{s}\t{p}\t{pid}\t{cwd}" for p, (s, pid, cwd, _) in self.panes.items()])
            return SimpleNamespace(returncode=0, stdout="\n".join(rows) + "\n")
        if "capture-pane" in cmd:
            return SimpleNamespace(returncode=0, stdout=self.edith_screen if edith else self.panes[cmd[cmd.index("-t") + 1]][3])
        return SimpleNamespace(returncode=1, stdout="")


def session_file(claude_dir, pid, sid, cwd, status="idle"):
    with open(os.path.join(claude_dir, "sessions", f"{pid}.json"), "w") as f:
        json.dump({"pid": pid, "sessionId": sid, "cwd": cwd, "kind": "interactive", "procStart": f"{pid}000",
                   "status": status}, f)


def fake_stat(dead=(), reused=(), names=None):
    """/proc/<pid>/stat as Claude's: start time "<pid>000"; `dead` pids are gone, `reused` belong to
    another process now; `names` gives some pids another process name."""
    def stat(pid):
        if pid in dead:
            return None
        return ("bash", "1") if pid in reused else ((names or {}).get(pid, "claude"), f"{pid}000")
    return stat


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
        session_file(self.h.claude_dir, 557, SID, "/reused")             # its pid is another process now
        p = Panes(self.h.claude_dir, run=tmux, children=lambda pid: {200: [201], 900: [901]}.get(pid, []),
                  stat=fake_stat(dead={556}, reused={557}))
        agents_ = p.agents()
        self.assertEqual([(a["name"], a["pane"], a["pid"], a["proc_start"], a["cwd"], a["session_id"], a["state"]) for a in agents_],
                         [("edith-app", "%2", 201, "201000", "/w/app", None, "busy"),
                          ("edith-dev", "%1", 101, "101000", "/w/dev", SID, "idle")])
        self.assertEqual(p.others({a["pid"] for a in agents_}), [{"pid": 555, "cwd": "/elsewhere"}])
        self.assertEqual(p.edith(), [{"pid": 901, "status": "idle", "comm": "claude", "state": "idle", "blocked": None}])
        self.assertFalse(any("send-keys" in c for c in tmux.calls))
        self.assertIn(["tmux", "-L", "edith", "capture-pane", "-p", "-t", "%0"], tmux.calls)  # her screen: read only

    def test_busy_is_anything_but_idle_in_the_session_file(self):
        tmux = FakeTmux({"%1": ("edith-dev", 101, "/w/dev", IDLE_SCREEN), "%2": ("edith-app", 201, "/w/app", IDLE_SCREEN)})
        session_file(self.h.claude_dir, 101, SID, "/w/dev", status="busy")      # a background subagent: idle screen
        session_file(self.h.claude_dir, 201, SID, "/w/app", status="thinking")  # a value we don't know
        session_file(self.h.claude_dir, 900, SID, "/home/x/edith", status="shell")
        p = Panes(self.h.claude_dir, run=tmux, children=lambda pid: [], stat=fake_stat())
        self.assertEqual(p.blockers()[1], ["edith-app has background work running (not at the limit)",
                                           "edith-dev has background work running (not at the limit)",
                                           "EDITH's Claude has background work running (not at the limit)"])
        for pid, cwd in ((101, "/w/dev"), (201, "/w/app"), (900, "/home/x/edith")):
            session_file(self.h.claude_dir, pid, SID, cwd)
        self.assertEqual(p.blockers()[1:], ([], []))

    def test_a_claude_at_its_usage_limit_doesnt_block(self):
        tmux = FakeTmux({"%1": ("edith-status", 101, "/w/status", LIMIT_SCREEN),
                         "%2": ("edith-app", 201, "/w/app", LIMIT_MENU_SCREEN)})
        session_file(self.h.claude_dir, 101, SID, "/w/status", status="busy")  # the turn the limit cut off
        session_file(self.h.claude_dir, 201, SID, "/w/app")                    # at the limit, but between turns
        session_file(self.h.claude_dir, 900, SID, "/home/x/edith", status="busy")
        tmux.edith_screen = LIMIT_MENU_SCREEN  # EDITH: the rate-limit menu
        p = Panes(self.h.claude_dir, run=tmux, children=lambda pid: [], stat=fake_stat())
        agents_, why, at_limit = p.blockers()
        self.assertEqual(why, [])
        self.assertEqual(at_limit, [{"name": "edith-app", "interrupted": False}, {"name": "edith-status", "interrupted": True},
                                    {"name": "EDITH", "interrupted": True}])
        self.assertEqual([a["name"] for a in agents_], ["edith-app", "edith-status"])  # both restarted by the switch

        # Real work or a permission prompt still blocks, and says it isn't the limit.
        tmux.panes["%1"] = ("edith-status", 101, "/w/status", BUSY_SCREEN)
        tmux.panes["%2"] = ("edith-app", 201, "/w/app", APPROVAL_SCREEN)
        tmux.edith_screen = BUSY_SCREEN
        agents_, why, at_limit = p.blockers()
        self.assertEqual(why, ["edith-app is waiting for approval", "edith-status is working (not at the limit)",
                               "EDITH's Claude is working (not at the limit)"])
        self.assertEqual(at_limit, [])
        tmux.edith_screen = IDLE_SCREEN  # EDITH not at the limit, her session file still busy
        self.assertEqual(p.blockers()[1][-1], "EDITH's Claude has background work running (not at the limit)")
        self.assertFalse(any("send-keys" in c for c in tmux.calls))

    def test_proc_stat_and_same_process(self):
        comm, start = proc_stat(os.getpid())
        self.assertTrue(start.isdigit())
        self.assertEqual(same_process(os.getpid(), start), comm)  # the start time decides, not the name
        self.assertIsNone(same_process(os.getpid(), str(int(start) + 1)))
        self.assertIsNone(proc_stat(2 ** 22 + 12345))     # no such pid
        self.assertEqual(same_process(7, "7000", stat=fake_stat()), "claude")
        self.assertIsNone(same_process(7, "6999", stat=fake_stat()))  # the pid was reused since

    def test_a_claude_under_another_name_still_counts_and_blocks(self):
        tmux = FakeTmux({"%1": ("edith-dev", 101, "/w/dev", IDLE_SCREEN)})
        session_file(self.h.claude_dir, 101, SID, "/w/dev")
        session_file(self.h.claude_dir, 900, SID, "/home/x/edith")
        session_file(self.h.claude_dir, 555, SID, "/elsewhere")
        p = Panes(self.h.claude_dir, run=tmux, children=lambda pid: [], stat=fake_stat(names={101: "node", 900: "node", 555: "node"}))
        agents_, why, _ = p.blockers()
        self.assertEqual([(a["name"], a["comm"]) for a in agents_], [("edith-dev", "node")])  # not skipped
        self.assertEqual(why, ["edith-dev's process isn't named claude (node), so it can't be checked",
                               "EDITH's process isn't named claude (node), so it can't be checked",
                               "another Claude is running (pid 555, in /elsewhere)"])


class FakePanes:
    def __init__(self, agents, why=(), others=(), at_limit=()):
        self.agents, self.why, self.running, self.at_limit = agents, list(why), list(others), list(at_limit)

    def blockers(self):
        return [dict(a) for a in self.agents], list(self.why), [dict(c) for c in self.at_limit]

    def others(self, known):
        return list(self.running)


class FakeSystem:
    """The runner's machine: records every command; Claude processes stop on SIGTERM. `on_run(cmd)`
    may act on the files (a Claude refreshing its token)."""

    def __init__(self, home, auth_email, screens=None, on_run=None, not_claude=()):
        self.home, self.auth_email, self.calls, self.t = home, auth_email, [], 0.0
        self.screens, self.on_run, self.not_claude = screens or {}, on_run, set(not_claude)

    def run(self, cmd, timeout=30.0, env=None):
        self.calls.append(("run", tuple(cmd)))
        if self.on_run:
            self.on_run(cmd)
        if cmd[1:3] == ["auth", "status"]:
            return SimpleNamespace(returncode=0, stdout=json.dumps({"loggedIn": True, "email": self.auth_email()}))
        if "capture-pane" in cmd:
            screens = self.screens() if callable(self.screens) else self.screens
            return SimpleNamespace(returncode=0, stdout=screens.get(cmd[-1], IDLE_SCREEN))
        if "display-message" in cmd:
            return SimpleNamespace(returncode=0, stdout="0 4242\n")
        return SimpleNamespace(returncode=0, stdout="")

    def open_claude(self, pid, proc_start):
        self.calls.append(("open", pid, proc_start))
        return None if pid in self.not_claude else pid

    def signal(self, fd, sig):
        self.calls.append(("kill", fd, int(sig)))

    def wait(self, fd, timeout):
        return True

    def close(self, fd):
        pass

    def proc_start(self, pid):
        return f"{pid}000"

    def monotonic(self):
        return self.t

    def sleep(self, s):
        self.t += s

    def now(self):
        return 1000.0


EDITH_RESTART = ("run", ("systemctl", "--user", "restart", "edith-claude"))
EDITH_START = ("run", ("systemctl", "--user", "start", "edith-claude"))


class SwitchTest(unittest.TestCase):
    def setUp(self):
        self.h = Home()
        self.addCleanup(self.h.cleanup)
        self.first = self.h.profiles.list()[0]["id"]
        self.second = self.h.profiles.add(self.h.login_dir(2))
        self.state = os.path.join(self.h.home, "state")
        os.makedirs(self.state)
        self.sock_path = os.path.join(self.state, "switch.sock")
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        self.sock.bind(self.sock_path)
        self.sock.setblocking(False)
        self.addCleanup(self.sock.close)
        out = mock.patch("builtins.print")  # the runner's journal lines
        out.start()
        self.addCleanup(out.stop)

    AGENTS = [{"name": "edith-dev", "pane": "%1", "pid": 101, "proc_start": "101000", "cwd": "/w/dev", "session_id": SID},
              {"name": "edith-app", "pane": "%2", "pid": 201, "proc_start": "201000", "cwd": "/w/app", "session_id": None}]

    def plan(self, target):
        return {"run": "r1", "unit": "u1", "target": target, "root": self.h.root, "claude_dir": self.h.claude_dir,
                "claude_json": self.h.claude_json, "claude": "claude", "home": self.h.home, "path": "/bin",
                "agents": [dict(a) for a in self.AGENTS],
                "status_file": os.path.join(self.state, "switch.json"), "socket": self.sock_path, "ready_timeout": 10}

    def switch(self, system, panes=None, target=None):
        return Switch(self.plan(target or self.second), system, panes=panes or FakePanes(self.AGENTS)).run()

    def email_now(self):
        return self.h.live()[1]["oauthAccount"]["emailAddress"]

    def saved_token(self, pid):
        with open(os.path.join(self.h.root, pid, "credentials.json")) as f:
            return json.load(f)["claudeAiOauth"]["refreshToken"]

    def events(self):
        out = []
        while True:
            try:
                out.append(json.loads(self.sock.recv(65536)))
            except BlockingIOError:
                return out

    def test_switch_order_and_progress(self):
        system = FakeSystem(self.h.home, self.email_now)
        self.assertEqual(self.switch(system), "done")
        self.assertEqual(self.h.live()[1]["oauthAccount"]["accountUuid"], "uuid-2")
        calls = system.calls
        kills = [i for i, c in enumerate(calls) if c[0] == "kill"]
        stop = calls.index(("run", ("systemctl", "--user", "stop", "edith-claude")))
        restart = calls.index(EDITH_RESTART)
        respawns = [i for i, c in enumerate(calls) if c[0] == "run" and "respawn-pane" in c[1]]
        self.assertEqual([calls[i][1:] for i in kills], [(101, 15), (201, 15)])
        self.assertEqual([c[1:] for c in calls if c[0] == "open"][:2], [(101, "101000"), (201, "201000")])
        self.assertTrue(max(kills) < stop < restart < min(respawns))  # everyone stops first; EDITH starts alone, first
        edith_ready = next(i for i, c in enumerate(calls) if i > restart and c[0] == "run" and "capture-pane" in c[1])
        self.assertLess(edith_ready, min(respawns))  # and is up before the agents start
        dev = calls[respawns[0]][1]
        self.assertEqual(dev[dev.index("-c") + 1], "/w/dev")
        self.assertTrue(dev[-1].endswith(f"exec claude --resume {SID}"))
        self.assertTrue(calls[respawns[1]][1][-1].endswith("exec claude"))  # no session id: no resume, no --continue
        remain = [c[1] for c in calls if c[0] == "run" and "remain-on-exit" in c[1]]
        self.assertEqual(len(remain), 4)  # kept while stopped, unset once respawned
        steps = [(e["state"], e["step"]) for e in self.events()]
        self.assertEqual(steps, [("running", "stopping"), ("running", "saving"), ("running", "installing"),
                                 ("running", "starting_edith"), ("running", "starting_agents"), ("running", "checking"),
                                 ("done", "checking")])
        with open(self.plan(self.second)["status_file"]) as f:
            final = json.load(f)
        self.assertEqual((final["state"], final["previous"], final["agents"]), ("done", self.first, ["edith-dev", "edith-app"]))
        self.assertNotIn("sk-ant", json.dumps(final))

    def test_rechecks_before_stopping_anything(self):
        for panes, why in ((FakePanes(self.AGENTS, ["edith-dev is busy"]), "Can't switch now: edith-dev is busy"),
                           (FakePanes(self.AGENTS[:1]), "the coding agents changed")):
            system = FakeSystem(self.h.home, self.email_now)
            self.assertEqual(self.switch(system, panes), "failed")
            self.assertIn(why, self.events()[-1]["detail"])
            self.assertFalse([c for c in system.calls if c[0] in ("open", "kill")])
            self.assertNotIn(("run", ("systemctl", "--user", "stop", "edith-claude")), system.calls)
            self.assertEqual(self.h.live()[1]["oauthAccount"]["accountUuid"], "uuid-1")

    def test_a_switch_at_the_limit_says_who_was_resumed(self):
        # The plan's list is from when the switch was asked for; the recheck right before stopping decides.
        panes = FakePanes(self.AGENTS, at_limit=[{"name": "edith-dev", "interrupted": True},
                                                 {"name": "EDITH", "interrupted": False}])
        system = FakeSystem(self.h.home, self.email_now)
        self.assertEqual(self.switch(system, panes), "done")
        self.assertEqual(self.events()[-1]["detail"],
                         "edith-dev was at the limit; it was resumed, but its interrupted task needs sending again; "
                         "EDITH was at the limit; it was resumed")
        self.assertFalse([c for c in system.calls if c[0] == "run" and "send-keys" in c[1]])  # nothing typed
        self.assertEqual(self.switch(FakeSystem(self.h.home, self.email_now), target=self.first), "done")
        self.assertIsNone(self.events()[-1]["detail"])  # nobody at the limit: no note

    def test_edith_refreshes_alone_and_the_refresh_is_saved(self):
        def on_run(cmd):  # EDITH's token had expired: she refreshes it (rotating the refresh token) as she starts
            if tuple(cmd) == EDITH_RESTART[1] and self.email_now() == "user2@example.com":
                self.h.write_live_creds(creds("2r"))
        self.assertEqual(self.switch(FakeSystem(self.h.home, self.email_now, on_run=on_run)), "done")
        self.assertEqual(self.saved_token(self.second), f"{TOKENS[1]}-2r")  # the agents started on it, and it's kept

    def test_rollback_keeps_the_new_accounts_rotated_token(self):
        def on_run(cmd):
            if tuple(cmd) == EDITH_RESTART[1] and self.email_now() == "user2@example.com":
                self.h.write_live_creds(creds("2r"))

        def screens():  # the new account's login is broken: edith-dev says so
            return {"%1": "Invalid API key · Please run /login\n❯ \n"} if self.email_now() == "user2@example.com" else {}
        system = FakeSystem(self.h.home, self.email_now, screens=screens, on_run=on_run)
        self.assertEqual(self.switch(system), "rolled_back")
        self.assertEqual(self.h.live()[1]["oauthAccount"]["accountUuid"], "uuid-1")
        self.assertEqual(self.saved_token(self.second), f"{TOKENS[1]}-2r")
        events = self.events()
        self.assertIn(("running", "rolling_back"), [(e["state"], e["step"]) for e in events])
        self.assertEqual(events[-1]["state"], "rolled_back")
        self.assertIn("edith-dev", events[-1]["detail"])

    def test_a_refresh_is_only_trusted_while_edith_runs_alone(self):
        def on_run(cmd):
            if tuple(cmd) == EDITH_RESTART[1] and self.email_now() == "user2@example.com":
                self.h.write_live_creds(creds("2r"))
        system = FakeSystem(self.h.home, self.email_now, on_run=on_run)
        panes = FakePanes(self.AGENTS, others=[{"pid": 555, "cwd": "/elsewhere"}])  # someone else was running
        self.assertEqual(self.switch(system, panes), "rolled_back")
        self.assertIn("another Claude was running while EDITH started", self.events()[-1]["detail"])
        self.assertEqual(self.saved_token(self.second), f"{TOKENS[1]}-2")  # the changed file isn't saved as account 2's
        self.assertFalse([c for c in system.calls if c[0] == "run" and "respawn-pane" in c[1] and c[1][-1].endswith(SID)][2:])

    def test_credentials_overwritten_while_starting_are_caught(self):
        def on_run(cmd):  # something on the old login writes its token over the new one as the agents start
            if "respawn-pane" in cmd and "%2" in cmd and self.email_now() == "user2@example.com":
                self.h.write_live_creds(creds("1x"))
        self.assertEqual(self.switch(FakeSystem(self.h.home, self.email_now, on_run=on_run)), "rolled_back")
        self.assertIn("the login changed", self.events()[-1]["detail"])
        self.assertEqual(self.saved_token(self.second), f"{TOKENS[1]}-2")  # the stray token isn't saved as account 2's
        self.assertEqual(self.h.live_token(), f"{TOKENS[1]}-1")

    def test_wrong_account_after_restart(self):
        system = FakeSystem(self.h.home, lambda: "someone@else.com")
        self.assertEqual(self.switch(system), "failed")  # and going back fails the same check
        self.assertIn("different account", self.events()[-1]["detail"])
        self.assertIn(EDITH_START, system.calls)

    def test_a_stuck_start_times_out(self):
        system = FakeSystem(self.h.home, self.email_now, screens={"edith": "Starting…\n"})
        self.assertEqual(self.switch(system), "failed")
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
        self.assertEqual(self.switch(system), "failed")
        self.assertEqual(self.h.live()[1]["oauthAccount"]["accountUuid"], "uuid-1")
        self.assertEqual(len([c for c in system.calls if c[0] == "run" and "respawn-pane" in c[1]]), 2)  # agents back
        self.assertIn(EDITH_START, system.calls)

    def test_everyone_comes_back_whatever_fails(self):
        # No previous account to go back to, and an unexpected error while starting EDITH.
        system = FakeSystem(self.h.home, self.email_now)
        real = system.run

        def run(cmd, timeout=30.0, env=None):
            if tuple(cmd) == EDITH_RESTART[1]:
                raise RuntimeError("dbus went away")
            return real(cmd, timeout, env)
        system.run = run
        with mock.patch.object(Profiles, "save_current", return_value=None):
            self.assertEqual(self.switch(system), "failed")
        self.assertIn("no previous account", self.events()[-1]["detail"])
        self.assertEqual(len([c for c in system.calls if c[0] == "run" and "respawn-pane" in c[1]]), 2)
        self.assertIn(EDITH_START, system.calls)

        # An error the steps don't expect at all.
        system = FakeSystem(self.h.home, self.email_now)
        with mock.patch.object(Switch, "_switch", side_effect=KeyError("boom")):
            self.assertEqual(self.switch(system), "failed")
        self.assertIn("unexpected error", self.events()[-1]["detail"])
        self.assertIn(EDITH_START, system.calls)

    def test_only_a_verified_claude_is_signalled(self):
        system = FakeSystem(self.h.home, self.email_now, not_claude={201})  # 201's pid now belongs to something else
        self.assertEqual(self.switch(system), "done")
        self.assertEqual([c[1:] for c in system.calls if c[0] == "kill"][:1], [(101, 15)])
        self.assertNotIn(("kill", 201, 15), system.calls)


class FakeAgent:
    max_side_lanes = 2

    def __init__(self):
        self.runs, self.queued, self.holds, self.order = [], 0, [], []

    def status(self):
        self.order.append("status")
        return list(self.runs), self.queued

    def hold(self):
        self.holds.append("hold")
        self.order.append("hold")

    def release(self):
        self.holds.append("release")
        self.order.append("release")


class RoutesTest(unittest.TestCase):
    def setUp(self):
        self.h = Home()
        self.addCleanup(self.h.cleanup)
        self.agent = FakeAgent()
        self.tmux = FakeTmux({"%1": ("edith-dev", 101, "/w/dev", IDLE_SCREEN)})
        session_file(self.h.claude_dir, 101, SID, "/w/dev")
        self.panes = Panes(self.h.claude_dir, run=self.tmux, children=lambda pid: [], stat=fake_stat())
        self.launched = []
        self.active_units = set()
        patches = [mock.patch.object(accounts, "Panes", lambda *a, **k: self.panes),
                   mock.patch.object(accounts, "launch", lambda cmd: self.launch(cmd)),
                   mock.patch.object(accounts, "unit_active", lambda unit: unit in self.active_units)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.state = os.path.join(self.h.home, "state")
        self.load()

    def load(self):
        self.bus, registry = EventBus(), Registry()
        self.events = []
        self.bus.subscribe("accounts.*", self.events.append, owner="test")
        cfg = {"root": self.h.root, "claude_dir": self.h.claude_dir, "claude_json": self.h.claude_json,
               "claude": fake_claude(self.h.home), "state_dir": self.state}
        with mock.patch.dict(os.environ, {"HOME": self.h.home}):
            report = load_features(["accounts"], self.bus, Ports(agent=self.agent), registry, {"accounts": cfg})
        self.assertEqual(report.loaded, ["accounts"], report.failed)
        self.routes = registry.routes

    def launch(self, cmd):
        self.launched.append(cmd)
        self.active_units.add(cmd[cmd.index("--unit") + 1])
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    def call(self, method, path, params=None, body=None):
        return self.routes[(method, path)].handler({"body": body, "params": params or {}, "query": {}, "headers": {},
                                                     "origin": "app"})

    def wait_for(self, check, timeout=5):
        deadline = time.monotonic() + timeout  # the listener thread publishes and releases
        while not check() and time.monotonic() < deadline:
            time.sleep(0.02)
        return check()

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

    def test_rename(self):
        pid = self.call("GET", "/v1/accounts")["accounts"][0]["id"]
        renamed = self.call("PATCH", "/v1/accounts/{id}", {"id": pid}, {"label": " Work "})
        self.assertEqual(renamed["account"], {"id": pid, "label": "Work", "email": "user1@example.com", "plan": "max",
                                              "active": True})
        self.assertEqual(self.call("GET", "/v1/accounts")["accounts"][0]["label"], "Work")
        for params, body, status in (({"id": pid}, {"label": "y" * 41}, 400), ({"id": pid}, {"label": " "}, 400),
                                     ({"id": pid}, {}, 400), ({"id": pid}, None, 400), ({"id": pid}, {"label": 5}, 400),
                                     ({"id": "0000000a"}, {"label": "Work"}, 404)):
            with self.subTest(params=params, body=body), self.assertRaises(ApiError) as e:
                self.call("PATCH", "/v1/accounts/{id}", params, body)
            self.assertEqual(e.exception.status, status)
        self.assertEqual(self.call("GET", "/v1/accounts")["accounts"][0]["label"], "Work")

    def test_login_cancel_and_expiry(self):
        started = self.call("POST", "/v1/accounts/login")
        self.assertEqual(self.call("DELETE", "/v1/accounts/login/{login}", {"login": started["id"]}), {"cancelled": True})
        with self.assertRaises(ApiError) as e:
            self.call("POST", "/v1/accounts/login/{login}", {"login": started["id"]}, {"code": "good-code#abc"})
        self.assertEqual(e.exception.status, 404)
        self.assertEqual([n for n in os.listdir(self.h.root) if n.startswith(".login-")], [])

    def test_stale_sign_in_folders_are_swept_at_startup(self):
        os.makedirs(self.h.root, exist_ok=True)
        old, new = os.path.join(self.h.root, ".login-old"), os.path.join(self.h.root, ".login-new")
        for folder in (old, new):
            os.makedirs(os.path.join(folder, "x"))
        os.utime(old, (time.time() - 3600, time.time() - 3600))
        self.load()
        self.assertEqual((os.path.exists(old), os.path.exists(new)), (False, True))  # a live sign-in's folder stays

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
        self.assertIn("edith-dev is working (not at the limit)", self.refused(target))
        self.tmux.panes["%1"] = ("edith-dev", 101, "/w/dev", APPROVAL_SCREEN)
        self.assertIn("edith-dev is waiting for approval", self.refused(target))
        self.tmux.panes["%1"] = ("edith-dev", 101, "/w/dev", IDLE_SCREEN)
        session_file(self.h.claude_dir, 101, SID, "/w/dev", status="busy")  # a background subagent; the screen looks idle
        self.assertIn("edith-dev has background work running (not at the limit)", self.refused(target))
        session_file(self.h.claude_dir, 101, SID, "/w/dev")
        session_file(self.h.claude_dir, 900, SID, "/home/x/edith", status="shell")  # EDITH's own Claude
        self.assertIn("EDITH's Claude has background work running (not at the limit)", self.refused(target))
        session_file(self.h.claude_dir, 900, SID, "/home/x/edith")
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
        self.assertEqual(self.agent.holds, ["hold", "release"] * 7)  # held before each check, released on refusal
        self.assertEqual(self.agent.order[:3], ["hold", "status", "release"])

    def test_an_agent_and_edith_at_the_limit_dont_block_a_switch(self):
        target = self.second()
        self.tmux.panes["%1"] = ("edith-dev", 101, "/w/dev", LIMIT_SCREEN)
        session_file(self.h.claude_dir, 101, SID, "/w/dev", status="busy")  # the turn the limit cut off
        self.tmux.edith_screen = LIMIT_MENU_SCREEN
        session_file(self.h.claude_dir, 900, SID, "/home/x/edith", status="busy")
        answer = self.call("POST", "/v1/accounts/{id}/switch", {"id": target})
        self.assertEqual(answer["status"], "switching")
        with open(self.launched[0][-1]) as f:
            plan = json.load(f)
        self.assertEqual(plan["at_limit"], [{"name": "edith-dev", "interrupted": True}, {"name": "EDITH", "interrupted": True}])
        self.assertEqual([a["name"] for a in plan["agents"]], ["edith-dev"])  # still restarted (and resumed)

    def test_switch_holds_the_agent_and_starts_a_transient_unit(self):
        target = self.second()
        answer = self.call("POST", "/v1/accounts/{id}/switch", {"id": target})
        self.assertEqual(answer["status"], "switching")
        self.assertEqual(self.agent.holds, ["hold"])
        cmd = self.launched[0]
        self.assertEqual(cmd[:3], ["systemd-run", "--user", "--unit"])
        self.assertEqual(cmd[cmd.index("-p") + 1], "TimeoutStopSec=300")  # time for the runner's finally
        self.assertEqual(cmd[-3:-1], ["-m", "edith.features.accounts.runner"])
        plan_file = cmd[-1]
        self.assertEqual((mode(os.path.dirname(plan_file)), mode(plan_file)), (0o700, 0o600))
        with open(plan_file) as f:
            plan = json.load(f)
        self.assertNotIn("sk-ant", json.dumps(plan))
        self.assertEqual(os.path.dirname(plan["socket"]), os.path.dirname(plan_file))  # the private folder
        self.assertEqual((plan["target"], [(a["session_id"], a["proc_start"]) for a in plan["agents"]]), (target, [(SID, "101000")]))
        self.assertEqual(plan["at_limit"], [])
        self.assertEqual(self.events[-1].data["step"], "starting")
        self.assertIn("a switch is already running", self.refused(target))
        with self.assertRaises(ApiError) as e:  # nor can an account be removed meanwhile
            self.call("DELETE", "/v1/accounts/{id}", {"id": target})
        self.assertEqual((e.exception.status, e.exception.message), (409, "a switch is running; try again when it's done"))
        listed = self.call("GET", "/v1/accounts")
        self.assertEqual((listed["switch"]["state"], listed["switch"]["target"]), ("running", target))
        self.assertNotIn("unit", listed["switch"])

        # The runner's progress arrives as events, from its socket; its end ends the hold.
        sent = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        for state, step in (("running", "stopping"), ("done", "checking")):
            sent.sendto(json.dumps({"run": answer["run"], "unit": "u", "state": state, "step": step}).encode(),
                        plan["socket"])
        sent.close()
        self.assertTrue(self.wait_for(lambda: self.agent.holds == ["hold", "release"]))
        self.assertEqual([(e.data["state"], e.data["step"]) for e in self.events[-2:]], [("running", "stopping"), ("done", "checking")])
        self.assertNotIn("unit", self.events[-1].data)

    def test_a_missed_end_still_ends_the_hold(self):
        target = self.second()
        with mock.patch.object(accounts, "QUIET_CHECK", 0.05):
            answer = self.call("POST", "/v1/accounts/{id}/switch", {"id": target})
            self.active_units.clear()  # the unit ended while the bridge wasn't listening
            with open(os.path.join(self.state, "accounts", "switch.json"), "w") as f:
                json.dump({"run": answer["run"], "unit": "u", "state": "done", "step": "checking", "ts": time.time()}, f)
            self.assertTrue(self.wait_for(lambda: self.agent.holds == ["hold", "release"]))
        self.assertEqual(self.events[-1].data["state"], "done")

    def test_a_restarted_bridge_holds_again_during_a_switch(self):
        os.makedirs(os.path.join(self.state, "accounts"), mode=0o700)
        with open(os.path.join(self.state, "accounts", "switch.json"), "w") as f:
            json.dump({"run": "r", "unit": "u-live", "state": "running", "step": "starting_edith", "ts": time.time()}, f)
        self.active_units.add("u-live")
        self.agent.holds.clear()
        self.load()
        self.assertEqual(self.agent.holds, ["hold"])
        sent = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sent.sendto(json.dumps({"run": "r", "state": "done", "step": "checking"}).encode(),
                    os.path.join(self.state, "accounts", "switch-r.sock"))
        sent.close()
        self.assertTrue(self.wait_for(lambda: self.agent.holds == ["hold", "release"]))

    def test_an_interrupted_switch_is_reported_failed(self):
        os.makedirs(os.path.join(self.state, "accounts"), exist_ok=True)
        with open(os.path.join(self.state, "accounts", "switch.json"), "w") as f:
            json.dump({"run": "r", "unit": "gone", "state": "running", "step": "checking", "ts": 1.0}, f)
        self.assertEqual(self.call("GET", "/v1/accounts")["switch"]["state"], "failed")

    def test_any_failure_after_holding_releases(self):
        target = self.second()
        real = accounts.write_private

        def broken(path, data, mode=0o600):
            if os.path.basename(path).startswith("plan-"):
                raise OSError("disk full")
            return real(path, data, mode)
        with mock.patch.object(accounts, "write_private", broken):
            with self.assertRaises(OSError):
                self.call("POST", "/v1/accounts/{id}/switch", {"id": target})
        self.assertEqual(self.agent.holds, ["hold", "release"])
        def launch(cmd):  # after the listener started: an error nobody expected
            raise RuntimeError("no systemd-run")
        self.launch = launch
        with self.assertRaises(RuntimeError):
            self.call("POST", "/v1/accounts/{id}/switch", {"id": target})
        self.assertTrue(self.wait_for(lambda: self.agent.holds == ["hold", "release"] * 2))
        self.assertEqual(self.call("GET", "/v1/accounts")["switch"]["state"], "failed")

    def test_an_old_listener_cant_end_a_newer_switchs_hold(self):
        target = self.second()
        first = self.call("POST", "/v1/accounts/{id}/switch", {"id": target})["run"]
        self.active_units.clear()  # its unit died: the switch counts as failed, a new one may start
        second = self.call("POST", "/v1/accounts/{id}/switch", {"id": target})["run"]
        self.assertNotEqual(first, second)
        sent = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sent.sendto(json.dumps({"run": first, "state": "failed", "step": "stopping"}).encode(),
                    os.path.join(self.state, "accounts", f"switch-{first}.sock"))
        self.assertTrue(self.wait_for(lambda: not os.path.exists(os.path.join(self.state, "accounts", f"switch-{first}.sock"))))
        self.assertEqual(self.agent.holds, ["hold", "hold"])  # the old listener ended without releasing
        sent.sendto(json.dumps({"run": first, "state": "done", "step": "checking"}).encode(),  # another run's report
                    os.path.join(self.state, "accounts", f"switch-{second}.sock"))
        sent.sendto(json.dumps({"run": second, "state": "done", "step": "checking"}).encode(),
                    os.path.join(self.state, "accounts", f"switch-{second}.sock"))
        sent.close()
        self.assertTrue(self.wait_for(lambda: self.agent.holds == ["hold", "hold", "release"]))
        self.assertEqual([e.data["run"] for e in self.events if e.data.get("state") == "done"], [second])

    def test_systemd_run_failing(self):
        target = self.second()
        self.launch = lambda cmd: SimpleNamespace(returncode=1, stdout="", stderr="no bus")
        with self.assertRaises(ApiError) as e:
            self.call("POST", "/v1/accounts/{id}/switch", {"id": target})
        self.assertEqual(e.exception.status, 503)
        self.assertEqual(self.call("GET", "/v1/accounts")["switch"]["state"], "failed")
        self.assertTrue(self.wait_for(lambda: self.agent.holds == ["hold", "release"]))
        self.assertEqual(self.events[-1].data["state"], "failed")


class RunnerMainTest(unittest.TestCase):
    def test_runs_as_a_module(self):
        r = subprocess.run([sys.executable, "-m", "edith.features.accounts.runner", "/nonexistent-plan.json"],
                           capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
        self.assertIn("FileNotFoundError", r.stderr)  # importable standalone; fails only on the missing plan


if __name__ == "__main__":
    unittest.main()
