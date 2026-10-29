"""deploy/install.sh: the read-only drift check between the repo's tracked files and the live ones."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = REPO / "deploy" / "install.sh"


def entries():
    text = SCRIPT.read_text()
    block = text[text.index("FILES=("):text.index("\n)\n")]
    return [line.strip().strip('"').split("|") for line in block.splitlines()[1:] if line.strip().startswith('"')]


class InstallCheckTest(unittest.TestCase):
    def setUp(self):
        self.home = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home)

    def run_check(self, *args):
        return subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True,
                              env={"LIVE_HOME": str(self.home), "PATH": os.environ["PATH"]})

    def install_all(self):
        for ours, theirs, _ in entries():
            (self.home / theirs).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(REPO / ours, self.home / theirs)

    def test_all_same(self):
        self.install_all()
        r = self.run_check()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(r.stdout.count("\nsame "), len(entries()))

    def test_differs_and_missing_and_writes_nothing(self):
        self.install_all()
        (self.home / "edith/CLAUDE.md").write_text("changed by hand\n")
        (self.home / "edith/bin/remind.py").unlink()
        before = sorted((p, p.stat().st_mtime_ns) for p in self.home.rglob("*") if p.is_file())
        r = self.run_check("--diff")
        self.assertEqual(r.returncode, 1)
        self.assertIn("DIFFERS  now            ~/edith/CLAUDE.md", r.stdout)
        self.assertIn("MISSING  after step 1   ~/edith/bin/remind.py", r.stdout)
        self.assertIn("-changed by hand", r.stdout)
        self.assertEqual(sorted((p, p.stat().st_mtime_ns) for p in self.home.rglob("*") if p.is_file()), before)

    def test_every_tracked_file_exists_in_the_repo(self):
        for ours, _, when in entries():
            self.assertTrue((REPO / ours).is_file(), ours)
            self.assertRegex(when, r"^(now|after step \d+)$")


if __name__ == "__main__":
    unittest.main()
