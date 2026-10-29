"""The hook and the permission relay (docs/PHASE1_PLAN.md, step 4). They run on every tool call of
the live tmux Claude, so the new code (through its wrappers) must behave byte for byte like the
legacy edith_hook.py and perm_mcp.py did (tests/golden/data/hook/), including when it fails.

They run as real subprocesses in a temporary HOME; a responder thread plays the bridge's part."""
import concurrent.futures
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from edith.adapters.agents.claude_tmux.watch import IN_CLOSE_WRITE, IN_MOVED_TO, Watch
from tests.golden import assert_matches

SERVER = pathlib.Path(__file__).resolve().parents[1]
SHIMS = SERVER.parent / "deploy" / "shims" / "edith" / "bridge"
HOOK = SHIMS / "hooks" / "edith_hook.py"
MCP = SHIMS / "perm_mcp.py"


def run(script, stdin, home, env=None, timeout=20):
    """Run a hook or MCP script like Claude Code does: python3 -I <script>, JSON on stdin."""
    base = {"HOME": str(home), "PATH": "/usr/bin:/bin", "EDITH_APP_SERVER": str(SERVER)}
    started = time.monotonic()
    r = subprocess.run([sys.executable, "-I", str(script)], input=stdin, capture_output=True, text=True,
                       env={**base, **(env or {})}, cwd=home, timeout=timeout)
    return r, time.monotonic() - started


class Responder:
    """Answers the first permission request like the bridge does: reads <id>.req.json and writes
    <id>.decision (in place, as the legacy bridge does, or atomically by rename). It reacts to the
    request file appearing (inotify), so it never misses one and never polls."""

    def __init__(self, home, decision, atomic=False):
        self.dir = pathlib.Path(home, ".cache/edith/perms")
        self.dir.mkdir(parents=True, exist_ok=True)  # both versions create it anyway
        self.decision, self.atomic, self.request = decision, atomic, None
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._watch = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self):
        self.thread.start()
        assert self._ready.wait(5)
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._watch.wake()
        self.thread.join(5)

    def _run(self):
        with Watch(self.dir, mask=IN_CLOSE_WRITE | IN_MOVED_TO) as self._watch:
            self._ready.set()
            while not self._stop.is_set():
                reqs = sorted(self.dir.glob("*.req.json"))
                if reqs:
                    self.request = json.loads(reqs[0].read_text())
                    if self.decision:
                        dec = self.dir / f"{self.request['id']}.decision"
                        if self.atomic:
                            tmp = self.dir / f".{self.request['id']}.tmp"
                            tmp.write_text(self.decision)
                            os.replace(tmp, dec)
                        else:
                            dec.write_text(self.decision)
                    return
                self._watch.wait(10)


def normalized(request):
    return request and {**request, "id": "ID", "ts": 0}


def state_files(home):
    """What the hook left in ~/.cache/edith, with times and ids normalized."""
    d = pathlib.Path(home, ".cache/edith")
    out = {}
    if (d / "tmux-session.json").exists():
        out["tmux-session.json"] = {**json.loads((d / "tmux-session.json").read_text()), "ts": 0}
    if (d / "tmux-events.jsonl").exists():
        out["tmux-events.jsonl"] = [{**json.loads(line), "ts": 0}
                                    for line in (d / "tmux-events.jsonl").read_text().splitlines()]
    perms = d / "perms"
    out["perms left"] = sorted(os.listdir(perms)) if perms.exists() else []
    return out


CASES = {
    # name: (stdin, env, decision for the responder or None, tmux-run file content or None)
    "session_start": ({"hook_event_name": "SessionStart", "session_id": "s1", "transcript_path": "/t/s1.jsonl",
                       "source": "resume"}, {"EDITH_TMUX": "1"}, None, None),
    "prompt_with_ref": ({"hook_event_name": "UserPromptSubmit", "session_id": "s1",
                         "prompt": "[Telegram message from Arpit]\nhi\n[tg-ref ab12cd]"}, {"EDITH_TMUX": "1"}, None, None),
    "prompt_without_ref": ({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "prompt": "typed in tmux"},
                           {"EDITH_TMUX": "1"}, None, None),
    "stop_text": ({"hook_event_name": "Stop", "session_id": "s1", "last_assistant_message": "Done ✅"},
                  {"EDITH_TMUX": "1"}, None, None),
    "stop_blocks": ({"hook_event_name": "Stop", "session_id": "s1",
                     "last_assistant_message": [{"type": "text", "text": "x"}]}, {"EDITH_TMUX": "1"}, None, None),
    "not_tmux": ({"hook_event_name": "SessionStart", "session_id": "s2"}, {}, None, None),
    "perm_allow": ({"hook_event_name": "PermissionRequest", "session_id": "s1", "tool_name": "Bash",
                    "tool_input": {"command": "sudo ls /root"}}, {"EDITH_TMUX": "1"}, "allow", "abc123"),
    "perm_deny": ({"hook_event_name": "PermissionRequest", "session_id": "s1", "tool_name": "Bash",
                   "tool_input": {"command": "rm -rf /tmp/x"}}, {"EDITH_TMUX": "1"}, "deny", "abc123"),
    "perm_timeout": ({"hook_event_name": "PermissionRequest", "session_id": "s1", "tool_name": "Bash",
                      "tool_input": {"command": "sudo reboot"}}, {"EDITH_TMUX": "1", "EDITH_PERM_TIMEOUT": "0.2"},
                     None, None),
    "perm_auto_allow_edit": ({"hook_event_name": "PermissionRequest", "session_id": "s1", "tool_name": "Edit",
                              "tool_input": {"file_path": "/home/x/project/a.py"}}, {"EDITH_TMUX": "1"}, None, None),
    "perm_protected_edit": ({"hook_event_name": "PermissionRequest", "session_id": "s1", "tool_name": "Write",
                             "tool_input": {"file_path": "~/.ssh/config"}}, {"EDITH_TMUX": "1"}, "allow", None),
    "perm_side_lane": ({"hook_event_name": "PermissionRequest", "session_id": "s3", "tool_name": "Bash",
                        "tool_input": {"command": "sudo whoami"}}, {"EDITH_RUN_ID": "run9"}, "allow", None),
    "perm_not_ours": ({"hook_event_name": "PermissionRequest", "session_id": "s4", "tool_name": "Bash",
                       "tool_input": {"command": "sudo whoami"}}, {}, None, None),
}


def run_case(name, atomic=False):
    stdin, env, decision, run_id = CASES[name]
    with tempfile.TemporaryDirectory() as home:
        if run_id:
            pathlib.Path(home, ".cache/edith").mkdir(parents=True)
            pathlib.Path(home, ".cache/edith/tmux-run").write_text(run_id)
        with Responder(home, decision, atomic) as responder:
            r, _ = run(HOOK, json.dumps(stdin), home, env)
        return {"exit": r.returncode, "stdout": r.stdout, "request": normalized(responder.request),
                "files": state_files(home)}


class HookParityTest(unittest.TestCase):
    maxDiff = None

    def test_every_event_matches_legacy(self):
        # Every case runs in its own temp HOME, so they all run side by side.
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            runs = {name: pool.submit(run_case, name) for name in CASES}
        for name in CASES:
            with self.subTest(name):
                assert_matches(self, f"hook/{name}.json", runs[name].result())  # what legacy did

    def test_atomic_decision_write_is_also_seen(self):
        assert_matches(self, "hook/perm_allow.json", run_case("perm_allow", atomic=True))

    def test_bad_input_fails_the_same_way(self):
        with tempfile.TemporaryDirectory() as home:
            r, _ = run(HOOK, "not json", home, {"EDITH_TMUX": "1"})
        self.assertEqual((r.returncode, r.stdout), (1, ""))  # as the legacy hook: exit 1, no decision

    def test_missing_repo_fails_like_legacy_and_never_hangs(self):
        """~/edith-app-live missing: exit 1, nothing on stdout (no decision), the same as the legacy
        hook crashing, for every event including PermissionRequest."""
        names = ("session_start", "prompt_with_ref", "stop_text", "perm_allow")
        with tempfile.TemporaryDirectory() as home, concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            runs = {name: pool.submit(run, HOOK, json.dumps(CASES[name][0]), home,
                                      {**CASES[name][1], "EDITH_APP_SERVER": ""}, 10) for name in names}
            for name in names:
                r, seconds = runs[name].result()
                with self.subTest(name):
                    self.assertEqual((r.returncode, r.stdout), (1, ""))
                    self.assertIn("ModuleNotFoundError: No module named 'edith'", r.stderr)
                    self.assertLess(seconds, 5)
            self.assertFalse(pathlib.Path(home, ".cache").exists())  # and it wrote nothing


MCP_INPUT = [
    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
     "params": {"name": "approve", "arguments": {"tool_name": "Edit", "input": {"file_path": "/home/x/a.py"}}}},
    {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
     "params": {"name": "approve", "arguments": {"tool_name": "Bash", "input": {"command": "sudo ls"}}}},
    {"jsonrpc": "2.0", "id": 5, "method": "ping"},
    {"jsonrpc": "2.0", "id": 6, "method": "resources/list"},
]


class McpParityTest(unittest.TestCase):
    def test_protocol_matches_legacy(self):
        with tempfile.TemporaryDirectory() as home, Responder(home, "deny") as responder:
            r, _ = run(MCP, "\n".join(json.dumps(m) for m in MCP_INPUT) + "\n", home, {"EDITH_RUN_ID": "run7"})
            out = {"exit": r.returncode, "stdout": r.stdout, "request": normalized(responder.request)}
        assert_matches(self, "hook/mcp.json", out)  # what legacy perm_mcp.py did

    def test_wrapper_still_importable_as_perm_mcp(self):
        code = ("import perm_mcp; print(perm_mcp.TIMEOUT, perm_mcp.PERM_DIR, "
                "perm_mcp.auto_allow('Edit', {'file_path': '/tmp/a'}), callable(perm_mcp.ask))")
        with tempfile.TemporaryDirectory() as home:
            r = subprocess.run([sys.executable, "-I", "-c", f"import sys; sys.path.insert(0, {str(SHIMS)!r}); {code}"],
                               capture_output=True, text=True,
                               env={"HOME": home, "PATH": "/usr/bin:/bin", "EDITH_APP_SERVER": str(SERVER)})
            self.assertEqual(r.stdout, f"600 {home}/.cache/edith/perms True True\n", r.stderr)


class WatchTest(unittest.TestCase):
    def test_wait_returns_on_change_wake_or_timeout(self):
        from edith.adapters.agents.claude_tmux.watch import Watch, wait_for
        with tempfile.TemporaryDirectory() as d, Watch(d) as w:
            self.assertFalse(w.polling)
            t = time.monotonic()
            self.assertEqual(w.wait(0.01), [])  # nothing happened: back after the timeout
            self.assertGreaterEqual(time.monotonic() - t, 0.009)
            threading.Thread(target=lambda: pathlib.Path(d, "a.txt").write_text("x")).start()
            self.assertEqual(wait_for(lambda: pathlib.Path(d, "a.txt").exists(), w, 5), True)
            threading.Thread(target=w.wake).start()
            t = time.monotonic()
            w.wait(5)
            self.assertLess(time.monotonic() - t, 2)  # woken, not timed out

    def test_polling_fallback(self):
        from edith.adapters.agents.claude_tmux.watch import Watch, wait_for
        with tempfile.TemporaryDirectory() as d, Watch(d, use_inotify=False) as w:
            self.assertTrue(w.polling)
            threading.Thread(target=lambda: pathlib.Path(d, "b").write_text("x")).start()
            self.assertTrue(wait_for(lambda: pathlib.Path(d, "b").exists(), w, 5))


if __name__ == "__main__":
    unittest.main()
