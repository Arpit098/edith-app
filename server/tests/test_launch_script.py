"""deploy/edith/bridge/edith-claude.sh must start Claude exactly like legacy's when no staging
variables are set, and follow EDITH_WORK_DIR / EDITH_STATE_DIR when they are. A fake `claude`
in ~/.local/bin prints what it was started with and where."""
import json
import pathlib
import re
import subprocess
import tempfile
import unittest

from tests.golden import assert_matches

SERVER = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = SERVER.parent / "deploy/edith/bridge/edith-claude.sh"


def home_with(sessions=(), session_file=None, state=None, work="edith", cache=".cache/edith"):
    home = pathlib.Path(tempfile.mkdtemp())
    (home / ".local/bin").mkdir(parents=True)
    fake = home / ".local/bin/claude"
    fake.write_text('#!/bin/sh\necho "cwd=$(pwd) tmux=$EDITH_TMUX args=$*"\n')
    fake.chmod(0o755)
    (home / work).mkdir(parents=True)
    # Legacy hardcodes ~/.claude/projects/-home-ubuntu-edith; the new script derives it from the work
    # dir. On edith (HOME=/home/ubuntu) both are the same folder; in a temp HOME, create both.
    for project in (home / ".claude/projects" / re.sub(r"[^A-Za-z0-9]", "-", str(home / work)),
                    home / ".claude/projects/-home-ubuntu-edith"):
        project.mkdir(parents=True, exist_ok=True)
        for sid in sessions:
            (project / f"{sid}.jsonl").write_text("")
    (home / cache).mkdir(parents=True)
    if session_file:
        (home / cache / "tmux-session.json").write_text(json.dumps(session_file))
    if state:
        (home / cache / "bridge-state.json").write_text(json.dumps(state))
    return home


def run(script, home, *args, env=None):
    r = subprocess.run(["bash", str(script), *args], capture_output=True, text=True,
                       env={"HOME": str(home), "PATH": "/usr/bin:/bin", **(env or {})})
    return r.stdout.replace(str(home), "~")


class LaunchScriptTest(unittest.TestCase):
    CASES = {
        "explicit session that exists": (dict(sessions=["s1"]), ["s1"]),
        "explicit session that's gone": (dict(sessions=[]), ["s1"]),
        "last tmux session": (dict(sessions=["s2"], session_file={"session_id": "s2"}), []),
        "bridge state fallback": (dict(sessions=["s3"], state={"sessions": {"111": "s3"}}), []),
        "nothing saved": (dict(), []),
    }

    def test_same_as_legacy_without_staging_variables(self):
        recorded = {}
        for name, (setup, args) in self.CASES.items():
            with self.subTest(name):
                out = run(SCRIPT, home_with(**setup), *args)
                self.assertTrue(out.startswith("cwd=~/edith tmux=1 args="), out)
                recorded[name] = out
        assert_matches(self, "launch/edith_claude.json", recorded)  # what legacy's script printed

    def test_staging_folders(self):
        home = home_with(sessions=["s9"], session_file={"session_id": "s9"}, work="edith-staging",
                         cache=".cache/edith-staging")
        out = run(SCRIPT, home, env={"EDITH_WORK_DIR": str(home / "edith-staging"),
                                             "EDITH_STATE_DIR": str(home / ".cache/edith-staging")})
        self.assertEqual(out, "cwd=~/edith-staging tmux=1 args=--resume s9\n")


if __name__ == "__main__":
    unittest.main()
