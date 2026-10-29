"""Changes (docs/PHASE1_PLAN.md, step 2): the repo's report must print and render exactly what
legacy/edith/bin/changes.py does, with a fixed number of git calls per repo."""
import contextlib
import io
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from edith.features.changes import report
from tests.golden import assert_golden
from tests.legacy import legacy_home, load

SERVER = pathlib.Path(__file__).resolve().parents[2]
SHIM = SERVER.parent / "deploy" / "shims" / "edith" / "bin" / "changes.py"
GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@x", "GIT_CONFIG_NOSYSTEM": "1"}


def sh(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, env={**os.environ, **GIT_ENV})


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    (path.write_bytes if isinstance(data, bytes) else path.write_text)(data)


def build_projects(projects: pathlib.Path):
    """A ~/Projects with every kind of change legacy handles."""
    a = projects / "alpha"
    write(a / "keep.txt", "same\n")
    write(a / "mod.py", "def f():\n    return 1\n")
    write(a / "gone.txt", "bye\n")
    write(a / "old.txt", "to be renamed\n" * 5)
    write(a / "big.txt", "".join(f"line {i}\n" for i in range(2000)))
    write(a / ".gitignore", "*.log\n")
    sh(projects, "init", "-q", "-b", "main", "alpha")
    sh(a, "add", "-A")
    sh(a, "commit", "-q", "-m", "init")
    write(a / "mod.py", "def f():\n    return 2  # <changed> & \"quoted\"\n")
    (a / "gone.txt").unlink()
    write(a / "big.txt", "".join(f"LINE {i}\n" for i in range(2000)))  # over MAX_LINES_PER_FILE
    write(a / "new.txt", "staged new file\n")
    sh(a, "add", "new.txt")
    sh(a, "mv", "old.txt", "renamed.txt")
    write(a / "notes.md", "# Notes\n\n- one\n- two\n")
    write(a / "nonl.txt", "no newline at end")
    write(a / "empty.txt", "")
    write(a / "img.bin", b"\x89PNG\x00\x01\x02binary")
    write(a / "dir" / "inner.txt", "+++ looks like a header\n++ two pluses\n")
    write(a / "my file.txt", "spaces in the name\n")
    write(a / "naïve.txt", "quoted by git\n")
    write(a / "debug.log", "ignored\n")
    write(a / "sub" / "x.txt", "nested repo\n")
    sh(a / "sub", "init", "-q", "-b", "main")

    b = projects / "group" / "beta"  # clean, detached
    write(b / "a.txt", "a\n")
    sh(projects / "group", "init", "-q", "-b", "main", "beta")
    sh(b, "add", "-A")
    sh(b, "commit", "-q", "-m", "init")
    sh(b, "checkout", "-q", "--detach")

    g = projects / "gamma"  # no commits yet
    sh(projects, "init", "-q", "-b", "main", "gamma")
    write(g / "first.txt", "first file\n")

    n = projects / "web" / "node_modules" / "dep"  # skipped
    write(n / "x.js", "x\n")
    sh(n.parent, "init", "-q", "dep")


def normalize(text):
    text = text.replace(os.environ["HOME"], "~")
    text = re.sub(r"changes-\d{8}-\d{6}\.html", "changes-STAMP.html", text)
    text = re.sub(r"<title>Changes \d{8}-\d{6}</title>", "<title>Changes STAMP</title>", text)
    return re.sub(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC", "DATE UTC", text)


@contextlib.contextmanager
def projects_home():
    with legacy_home(EDITH_CHANGES_ROOTS="", **GIT_ENV) as home:
        projects = home / "Projects"
        build_projects(projects)
        os.environ["EDITH_CHANGES_ROOTS"] = str(projects)
        yield home


def run(main, argv):
    """Run a main(); return (normalized stdout, normalized HTML or None)."""
    out = io.StringIO()
    with mock.patch.object(sys, "argv", ["changes.py", *argv]), contextlib.redirect_stdout(out):
        main()
    text = out.getvalue()
    m = re.search(r"^HTML: (.+)$", text, re.M)
    return normalize(text), normalize(pathlib.Path(m[1]).read_text()) if m else None


class ChangesTest(unittest.TestCase):
    def test_legacy_and_new_match_golden(self):
        with projects_home() as home:
            index = (home / "Projects/alpha/.git/index").read_bytes()
            legacy = load("bin/changes.py")
            old_text, old_page = run(legacy.main, [])
            # Only legacy records golden files; the new code is held to legacy directly, so
            # re-recording (UPDATE_GOLDEN=1) can never hide a difference.
            assert_golden(self, "changes/all.txt", old_text)
            assert_golden(self, "changes/all.html", old_page)
            self.maxDiff = None
            self.assertEqual(run(report.main, []), (old_text, old_page))
            for main in (legacy.main, report.main):
                self.assertEqual(run(main, ["BET"]), (normalize("beta ((detached)): clean\nNo uncommitted changes.\n"), None))
                self.assertEqual(run(main, ["zzz"])[0], "No git repos found under ~/Projects matching 'zzz'.\n")
            # Read-only: the repo's own index is untouched.
            self.assertEqual((home / "Projects/alpha/.git/index").read_bytes(), index)

    def test_git_calls_do_not_grow_with_files(self):
        with projects_home() as home:
            many = home / "Projects" / "many"
            for i in range(40):
                write(many / f"t{i}.txt", "a\n")
            sh(home / "Projects", "init", "-q", "-b", "main", "many")
            sh(many, "add", "-A")
            sh(many, "commit", "-q", "-m", "init")
            for i in range(40):
                write(many / f"t{i}.txt", "b\n")
                write(many / f"u{i}.txt", "new\n")
            real = subprocess.run
            calls = []
            with mock.patch("subprocess.run", side_effect=lambda *a, **k: calls.append(a[0]) or real(*a, **k)):
                branch, files = report.repo_changes(str(many))
            self.assertEqual(len(files), 80)
            self.assertEqual(len(calls), 6)  # branch, numstat, diff, ls-files, add -N, diff (legacy: 123)

    def test_report_is_private_and_old_ones_are_pruned(self):
        with projects_home() as home:
            out_dir = home / ".cache/edith/changes"
            out_dir.mkdir(parents=True)
            for i in range(25):
                (out_dir / f"changes-20260101-0000{i:02d}.html").write_text("old")
            text, _ = run(report.main, ["alpha"])
            names = sorted(os.listdir(out_dir))
            self.assertEqual(len(names), 20)
            self.assertFalse([n for n in names if not n.startswith("changes-")])  # no temp files left
            newest = out_dir / names[-1]
            self.assertEqual(newest.stat().st_mode & 0o777, 0o600)

    def test_hung_git_is_reported_and_others_continue(self):
        with projects_home():
            real = report.git

            def slow(repo, *args, **kw):
                if repo.endswith("gamma"):
                    raise report.GitTimeout("git branch timed out after 30s")
                return real(repo, *args, **kw)

            with mock.patch.object(report, "git", side_effect=slow):
                text, _ = run(report.main, [])
            self.assertIn("gamma: skipped, git branch timed out after 30s", text)
            self.assertIn("alpha (main):", text)

    def test_wrapper(self):
        with projects_home() as home:
            env = {**os.environ, "EDITH_APP_SERVER": str(SERVER)}
            r = subprocess.run([sys.executable, "-I", str(SHIM), "beta"], capture_output=True, text=True, env=env)
            self.assertEqual(r.stdout, "beta ((detached)): clean\nNo uncommitted changes.\n")
            r = subprocess.run([sys.executable, "-I", str(SHIM)], capture_output=True, text=True, env=env)
            self.assertRegex(r.stdout, r"HTML: .*/\.cache/edith/changes/changes-\d{8}-\d{6}\.html\n$")
            self.assertTrue(r.stdout.splitlines()[-1].split(": ", 1)[1].startswith(str(home)))


if __name__ == "__main__":
    unittest.main()
