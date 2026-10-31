"""OTA bundles built on edith (app_updates/local_build.py): the key-file and native-change refusals,
and the store importing them from its inbox next to CI's. No npm, git or GitHub here."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from edith.features import app_updates
from edith.features.app_updates import local_build
from edith.features.app_updates.github import GhError
from edith.features.app_updates.local_build import Refused, check_key, plan
from tests.features.test_app_updates import PIN, World, apk_artifact, ota_artifact


def write_artifact(folder, files):
    for rel, data in files.items():
        path = pathlib.Path(folder, rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


class KeyFileTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.key = os.path.join(self.dir, "key.pem")

    def test_missing_wrong_mode_or_not_a_file_is_refused(self):
        with self.assertRaisesRegex(Refused, "no OTA signing key"):
            check_key(self.key)
        pathlib.Path(self.key).write_text("secret")
        os.chmod(self.key, 0o644)
        with self.assertRaisesRegex(Refused, "mode 600 \\(it is 644\\)"):
            check_key(self.key)
        os.chmod(self.key, 0o600)
        check_key(self.key)
        link = os.path.join(self.dir, "link.pem")
        os.symlink(self.key, link)
        with self.assertRaisesRegex(Refused, "not a regular file"):
            check_key(link)

    def test_the_key_is_never_opened(self):
        pathlib.Path(self.key).write_text("secret")
        os.chmod(self.key, 0o600)
        real_open = open

        def spy(path, *a, **k):
            self.assertNotEqual(os.path.abspath(path), self.key)
            return real_open(path, *a, **k)
        with mock.patch("builtins.open", spy):
            check_key(self.key)


def apk(code, runtime, signing="release", cert=PIN):
    return {"versionCode": code, "runtimeVersion": runtime, "signing": signing, "cert_sha256": cert, "sha": f"sha{code}"}


def history(*commits):
    """is_ancestor over one line of history, oldest first."""
    return lambda a, b: a in commits and b in commits and commits.index(a) <= commits.index(b)


class PlanTest(unittest.TestCase):
    def test_a_native_change_needs_an_apk(self):
        index = {"apks": {"1": apk(1, "rtA"), "2": apk(2, "rtB", signing="debug"), "3": apk(3, "rtB", cert="AA")}}
        with self.assertRaisesRegex(Refused, "matches no APK edith offers .*rtA \\(APK 1\\).*needs a real APK build"):
            plan(index, PIN, "rtB", "head", history("sha1", "head"))  # debug-signed and unpinned APKs don't count

    def test_the_bundle_is_for_the_newest_matching_apk_and_notes_start_at_the_newest_build(self):
        index = {"apks": {"1": apk(1, "rtA"), "2": apk(2, "rtA"), "3": apk(3, "rtB")}, "updates": {}}
        line = history("sha1", "sha2", "old", "newer", "head")
        self.assertEqual(plan(index, PIN, "rtA", "head", line), (index["apks"]["2"], "sha2"))
        index["updates"] = {"u1": {"id": "u1", "runtimeVersion": "rtA", "createdAt": 10, "sha": "old"},
                            "u2": {"id": "u2", "runtimeVersion": "rtA", "createdAt": 20, "sha": "newer"},
                            "u3": {"id": "u3", "runtimeVersion": "rtB", "createdAt": 30, "sha": "other"}}
        self.assertEqual(plan(index, PIN, "rtA", "head", line)[1], "newer")
        with self.assertRaisesRegex(Refused, "already the newest bundle"):
            plan(index, PIN, "rtA", "newer", line)

    def test_an_older_ref_would_roll_the_app_back(self):
        index = {"apks": {"2": apk(2, "rtA")},
                 "updates": {"u2": {"id": "u2", "runtimeVersion": "rtA", "createdAt": 20, "sha": "ci-head"}}}
        line = history("sha2", "older", "ci-head", "head")
        with self.assertRaisesRegex(Refused, "older.*doesn't contain ci-head.*bundle u2.*roll the app back"):
            plan(index, PIN, "rtA", "older", line)
        with self.assertRaisesRegex(Refused, "side.*doesn't contain ci-head"):
            plan(index, PIN, "rtA", "side", line)  # not in that history at all (another branch)
        self.assertEqual(plan(index, PIN, "rtA", "head", line)[1], "ci-head")
        del index["updates"]["u2"]  # no bundle yet: checked against the APK's commit
        with self.assertRaisesRegex(Refused, "doesn't contain sha2.*APK 2"):
            plan(index, PIN, "rtA", "unrelated", line)

    def test_a_ci_bundle_imported_during_the_build_is_not_rolled_back(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        artifact = os.path.join(root, "built")
        write_artifact(artifact, ota_artifact(0, "local1"))
        index = {"apks": {"2": apk(2, "rtA")}, "updates": {}}
        (pathlib.Path(root) / "index.json").write_text(json.dumps(index))
        line = history("sha2", "head", "ci-newer")
        plan(index, PIN, "rtA", "head", line)  # fine when the build starts
        index["updates"]["ci"] = {"id": "ci", "runtimeVersion": "rtA", "createdAt": 30, "sha": "ci-newer"}
        (pathlib.Path(root) / "index.json").write_text(json.dumps(index))  # CI's bundle arrives meanwhile
        with self.assertRaisesRegex(Refused, "head doesn't contain ci-newer"):
            local_build.deliver(artifact, "local1", root, PIN, "rtA", "head", line)
        self.assertFalse(os.path.exists(os.path.join(root, "inbox")))
        self.assertIn("inbox", local_build.deliver(artifact, "local2", root, PIN, "rtA", "ci-newer2",
                                                   history("sha2", "ci-newer", "ci-newer2")))
        self.assertEqual(os.listdir(os.path.join(root, "inbox")), ["local2"])

    def test_ancestry_is_gits(self):
        repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, repo)
        git = ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
        subprocess.run(git[:3] + ["init", "-q"], check=True)
        shas = []
        for i in range(2):
            subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", str(i)], check=True)
            shas.append(subprocess.run(git[:3] + ["rev-parse", "HEAD"], capture_output=True, text=True,
                                       check=True).stdout.strip())
        is_ancestor = local_build.ancestry(repo)
        self.assertTrue(is_ancestor(shas[0], shas[1]))
        self.assertFalse(is_ancestor(shas[1], shas[0]))
        self.assertFalse(is_ancestor("0" * 40, shas[1]))  # unknown commit

    def test_cert_is_only_for_a_dry_run(self):
        with self.assertRaises(SystemExit):
            local_build.main(["--cert", "/tmp/test-cert.pem"])


class InboxTest(unittest.TestCase):
    def setUp(self):
        self.w = World(self)
        self.inbox = self.w.root / "inbox"

    def drop(self, update_id, created, ready=True, **kw):
        name = update_id if ready else f".{update_id}"
        write_artifact(self.inbox / name, ota_artifact(0, update_id, created=created, **kw))

    def served(self):
        r = self.w.route("/v1/updates/manifest", headers={"expo-runtime-version": "rt1"})
        return json.loads(r.body.split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n--", 1)[0])["id"] if r.status == 200 else None

    def test_a_local_build_is_imported_like_a_ci_artifact(self):
        self.w.gh.add_run(101, apk=apk_artifact(101, 1101), ota=ota_artifact(101, "ci1", created=1793280000))
        self.drop("local1", 1793280100)
        self.drop("partial", 1793280200, ready=False)   # still being copied in: left alone
        self.drop("bad", 1793280300, lie=True)           # a file that doesn't match its sha256
        self.drop("garbled", 1793280400)
        (self.inbox / "garbled" / "manifest.json").write_text("{not json")
        (self.inbox / "empty").mkdir()                   # no update.json
        self.drop("unsigned", 1793280500)
        (self.inbox / "unsigned" / "manifest.sig").unlink()
        self.w.collect()
        index = json.loads((self.w.root / "index.json").read_text())
        self.assertEqual(sorted(index["updates"]), ["ci1", "local1"])  # a bad local build doesn't stop CI's
        self.assertEqual((index["updates"]["local1"]["source"], index["updates"]["local1"]["run_id"]), ("local", 0))
        rejected = [".rejected-bad", ".rejected-empty", ".rejected-garbled", ".rejected-unsigned"]
        self.assertEqual(sorted(os.listdir(self.inbox)), [".partial", *rejected])  # set aside, not retried

        # A week later they are gone; one set aside more recently stays.
        week_ago = os.stat(self.inbox / ".rejected-bad").st_mtime - app_updates.REJECTED_KEEP - 1
        for name in rejected[:3]:
            os.utime(self.inbox / name, (week_ago, week_ago))
        self.w.collect()
        self.assertEqual(sorted(os.listdir(self.inbox)), [".partial", ".rejected-unsigned"])
        self.assertEqual(self.served(), "local1")

    def test_the_newest_is_served_whether_ci_or_local(self):
        self.w.gh.add_run(101, apk=apk_artifact(101, 1101), ota=ota_artifact(101, "ci1", created=1793280100))
        self.w.collect()
        self.drop("local1", 1793280200)
        self.w.collect()
        self.assertEqual(self.served(), "local1")
        self.w.gh.add_run(102, ota=ota_artifact(102, "ci2", created=1793280300))
        self.w.collect()
        self.assertEqual(self.served(), "ci2")
        index = json.loads((self.w.root / "index.json").read_text())
        self.assertEqual({i: u["source"] for i, u in index["updates"].items()},
                         {"ci1": "ci", "local1": "local", "ci2": "ci"})

    def test_github_down_doesnt_hold_up_a_local_build(self):
        self.drop("local1", 1793280100)

        def down(limit=20):
            raise GhError("gh run list failed")
        self.w.gh.runs = down
        with self.assertRaises(GhError):
            self.w.collect()  # the job runner retries the GitHub part with backoff
        self.assertEqual(self.served(), "local1")


if __name__ == "__main__":
    unittest.main()
