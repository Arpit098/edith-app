"""App updates (contracts/app-updates.md): collecting builds from GitHub (a fake gh) and serving them
over the App API. Nothing here calls GitHub."""
import hashlib
import http.client
import json
import os
import pathlib
import shutil
import tempfile
import unittest
from unittest import mock

from edith.adapters.frontends.app_api import AppApi
from edith.core import EventBus, Ports, Registry, load_features
from edith.features import app_updates
from edith.features.app_updates import store as store_mod
from edith.features.app_updates.github import GhError, MissingArtifact

TOKEN = "t" * 40
PIN = "2B:6C:D3:6E:EA:02:20:9B:55:D9:7D:7A:78:20:E1:F6:81:A6:B1:60:67:3A:4A:49:F2:2B:43:9F:3F:D8:02:AB"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def apk_artifact(run_id, code, signing="release", cert=PIN, runtime="rt1", body=None, lie=False, notes=None):
    body = body if body is not None else f"apk {code}".encode() * 1000
    meta = {"versionName": f"0.{code}", "versionCode": code, "sha": f"sha{code}", "run_id": run_id,
            "built_at": 1793280000 + code, "runtimeVersion": runtime, "size": len(body),
            "sha256": sha(b"other" if lie else body), "cert_sha256": cert, "signing": signing,
            **({"release_notes": notes} if notes is not None else {})}
    return {"edith.apk": body, "apk.json": json.dumps(meta).encode()}


def ota_artifact(run_id, update_id, runtime="rt1", created=1793280000, files=None, lie=False):
    files = files or {"dist/bundle.hbc": b"bundle " + update_id.encode(), "dist/assets/font": b"shared font"}
    entries = [{"path": p, "sha256": sha(b"x" if lie and i == 0 else d), "size": len(d),
                "contentType": "application/javascript" if p.endswith(".hbc") else "font/ttf",
                **({"launch": True} if p.endswith(".hbc") else {})} for i, (p, d) in enumerate(files.items())]
    update = {"id": update_id, "createdAt": created, "runtimeVersion": runtime, "channel": "main",
              "platform": "android", "sha": "abc", "run_id": run_id, "files": entries}
    manifest = b'{"id": "%s", "runtimeVersion": "%s", "createdAt": "2026-10-29T12:30:00.000Z", "launchAsset": {}}' % (
        update_id.encode(), runtime.encode())
    return {"update.json": json.dumps(update).encode(), "manifest.json": manifest,
            "manifest.sig": b'sig="c2ln", keyid="main", alg="rsa-v1_5-sha256"\n', **files}


class FakeGitHub:
    """Runs newest first, artifacts by (run, name); counts downloads."""

    def __init__(self):
        self.list, self.artifacts, self.downloads, self.fail = [], {}, [], set()

    def add_run(self, run_id, apk=None, ota=None):
        self.list.insert(0, {"id": run_id, "sha": f"sha{run_id}", "created": "x"})
        for name, files in (("edith-apk", apk), ("edith-ota", ota)):
            if files is not None:
                self.artifacts[run_id, name] = files

    def runs(self, limit=20):
        return self.list[:limit]

    def download(self, run_id, name, dest):
        self.downloads.append((run_id, name))
        if (run_id, name) in self.fail:
            raise GhError("network down")
        if (run_id, name) not in self.artifacts:
            raise MissingArtifact("no artifact matches")
        for rel, data in self.artifacts[run_id, name].items():
            path = pathlib.Path(dest, rel)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def subjects(self, base, head, limit=20):
        return [f"commit {head} since {base}"]


class World:
    def __init__(self, test, pin=PIN):
        self.dir = tempfile.mkdtemp()
        test.addCleanup(shutil.rmtree, self.dir)
        self.gh = FakeGitHub()
        self.registry = Registry()
        with mock.patch.object(app_updates, "GitHub", lambda *a, **k: self.gh):
            report = load_features(["app_updates"], EventBus(), Ports(), self.registry,
                                   {"app_updates": {"state_dir": self.dir, "cert_sha256": pin}})
        assert report.loaded == ["app_updates"], report.failed
        self.root = pathlib.Path(self.dir, "app-updates")

    def collect(self):
        return self.registry.jobs["app_updates.collect"].run()

    def route(self, path, params=None, headers=None):
        return self.registry.routes["GET", path].handler({"params": params or {}, "headers": headers or {}, "query": {}})

    def restart(self, pin=PIN):
        """A new process: same files, fresh feature."""
        self.registry = Registry()
        with mock.patch.object(app_updates, "GitHub", lambda *a, **k: self.gh):
            load_features(["app_updates"], EventBus(), Ports(), self.registry,
                          {"app_updates": {"state_dir": self.dir, "cert_sha256": pin}})


class CollectTest(unittest.TestCase):
    def test_collects_verifies_and_never_downloads_twice(self):
        w = World(self)
        w.gh.add_run(101, apk=apk_artifact(101, 1101), ota=ota_artifact(101, "u1"))
        w.gh.add_run(102, apk=apk_artifact(102, 1102, signing="debug"))               # no OTA artifact
        w.gh.add_run(103, apk=apk_artifact(103, 1103, cert="AA:BB"), ota=ota_artifact(103, "u3", lie=True))
        w.gh.add_run(104, apk=apk_artifact(104, 1104, lie=True))
        self.assertEqual(w.collect(), 120)  # every 2 min
        runs = json.loads((w.root / "index.json").read_text())["runs"]
        self.assertEqual(runs["101"], {"apk": "collected", "ota": "collected"})
        self.assertEqual(runs["102"], {"apk": "skipped: debug-signed", "ota": "missing"})
        self.assertEqual(runs["103"]["apk"], "skipped: certificate is not the pinned one")
        self.assertTrue(runs["103"]["ota"].startswith("rejected: dist/bundle.hbc does not match"))
        self.assertTrue(runs["104"]["apk"].startswith("rejected: edith.apk does not match"))
        self.assertEqual(sorted(os.listdir(w.root / "apks")), ["1101.apk"])  # debug, unpinned, bad: not kept
        self.assertEqual(os.listdir(w.root / "tmp"), [])
        self.assertEqual(sorted(os.listdir(w.root / "assets")),
                         sorted(sha(d) for d in (b"bundle u1", b"shared font")))
        downloads = len(w.gh.downloads)
        w.collect()
        w.restart()
        w.collect()
        self.assertEqual(len(w.gh.downloads), downloads)  # every outcome is final: nothing downloaded again

    def test_an_unchanged_run_list_does_no_work(self):
        w = World(self)
        w.gh.add_run(101, apk=apk_artifact(101, 1101), ota=ota_artifact(101, "u1"))
        w.collect()
        index = w.root / "index.json"
        before, downloads = index.stat().st_mtime_ns, len(w.gh.downloads)
        writes = []
        real = app_updates.store.write_json
        with mock.patch.object(app_updates.store, "write_json", lambda *a: writes.append(a) or real(*a)):
            for _ in range(3):  # three 2-minute passes with nothing new on GitHub
                self.assertEqual(w.collect(), 120)
        self.assertEqual((writes, len(w.gh.downloads), index.stat().st_mtime_ns), ([], downloads, before))

    def test_a_failed_download_is_retried_next_pass(self):
        w = World(self)
        w.gh.add_run(101, apk=apk_artifact(101, 1101))
        w.gh.fail.add((101, "edith-apk"))
        with self.assertRaises(GhError):  # the job runner retries with backoff
            w.collect()
        self.assertNotIn("apk", json.loads((w.root / "index.json").read_text())["runs"].get("101", {}))
        w.gh.fail.clear()
        w.collect()
        self.assertEqual(w.route("/v1/app/latest")["versionCode"], 1101)

    def test_keeps_5_apks_and_3_runtime_versions(self):
        w = World(self)
        for i in range(7):
            run = 200 + i
            w.gh.add_run(run, apk=apk_artifact(run, 1200 + i),
                         ota=ota_artifact(run, f"u{i}", runtime=f"rt{i // 2}", created=1793280000 + i,
                                          files={"dist/b.hbc": f"bundle {i}".encode(), "dist/f": b"shared"}))
        w.collect()
        self.assertEqual(sorted(os.listdir(w.root / "apks")), [f"{1200 + i}.apk" for i in range(2, 7)])
        index = json.loads((w.root / "index.json").read_text())
        self.assertEqual(sorted(index["updates"]), ["u2", "u3", "u4", "u5", "u6"])  # rt1, rt2, rt3; rt0 dropped
        self.assertEqual(sorted(os.listdir(w.root / "updates")), ["u2", "u3", "u4", "u5", "u6"])
        self.assertEqual(sorted(os.listdir(w.root / "assets")),
                         sorted([sha(b"shared")] + [sha(f"bundle {i}".encode()) for i in range(2, 7)]))
        self.assertEqual(sorted(index["runs"]), [str(200 + i) for i in range(7)])
        w.gh.list = w.gh.list[:3]  # GitHub no longer lists the older runs: their records go
        w.collect()
        self.assertEqual(sorted(json.loads((w.root / "index.json").read_text())["runs"]), ["204", "205", "206"])

    def test_loading_touches_no_file(self):
        w = World(self)
        self.assertFalse(w.root.exists())  # created by the first job pass or request


class RoutesTest(unittest.TestCase):
    def setUp(self):
        self.w = World(self)
        self.w.gh.add_run(101, apk=apk_artifact(101, 1101), ota=ota_artifact(101, "u1", created=1793280000))
        self.w.gh.add_run(102, apk=apk_artifact(102, 1102), ota=ota_artifact(102, "u2", created=1793280100))
        self.w.gh.add_run(103, apk=apk_artifact(103, 1103, signing="debug"))
        self.w.collect()

    def test_latest_is_the_newest_offered_apk(self):
        latest = self.w.route("/v1/app/latest")
        self.assertEqual({k: latest[k] for k in ("versionCode", "versionName", "url", "notes", "cert_sha256")},
                         {"versionCode": 1102, "versionName": "0.1102", "url": "/v1/app/apk/1102",
                          "notes": "commit sha1102 since sha1101", "cert_sha256": PIN})
        self.assertIsNone(latest["release_notes"])  # a build from before release notes
        self.w.restart(pin="AA:BB")  # a different pinned certificate: nothing is offered
        with self.assertRaises(app_updates.ApiError) as cm:
            self.w.route("/v1/app/latest")
        self.assertEqual((cm.exception.status, cm.exception.message), (404, "no app build yet"))

    def test_release_notes_pass_through(self):
        notes = {"new": ["Attach photos and voice notes", 7], "fixes": ["Messages no longer vanish"],
                 "changes": [], "details": ["feat: attachments"], "extra": "ignored"}
        self.w.gh.add_run(104, apk=apk_artifact(104, 1104, notes=notes))
        asked = []
        self.w.gh.subjects = lambda base, head, limit=20: asked.append(head) or ["unused"]
        self.w.collect()
        latest = self.w.route("/v1/app/latest")
        self.assertEqual(latest["release_notes"], {"new": ["Attach photos and voice notes"],
                                                   "fixes": ["Messages no longer vanish"], "changes": [],
                                                   "details": ["feat: attachments"]})
        self.assertEqual(latest["notes"], "New: Attach photos and voice notes\nFix: Messages no longer vanish")
        self.assertEqual(asked, [])  # no commit subjects fetched for a build that has release notes

    def test_empty_release_notes_fall_back_to_commit_subjects(self):
        self.w.gh.add_run(104, apk=apk_artifact(104, 1104, notes={"new": [], "fixes": [], "changes": [], "details": []}))
        self.w.collect()
        latest = self.w.route("/v1/app/latest")
        self.assertEqual(latest["notes"], "commit sha1104 since sha1102")
        self.assertEqual(latest["release_notes"]["new"], [])

    def test_manifest_rules(self):
        def get(**headers):
            return self.w.route("/v1/updates/manifest", headers=headers)
        with self.assertRaises(app_updates.ApiError) as cm:
            get()
        self.assertEqual(cm.exception.status, 400)
        with self.assertRaises(app_updates.ApiError):
            get(**{"expo-runtime-version": "rt1", "expo-platform": "ios"})
        self.assertEqual(get(**{"expo-runtime-version": "rt9"}).status, 204)
        self.assertEqual(get(**{"expo-runtime-version": "rt1", "expo-channel-name": "beta"}).status, 204)
        current = get(**{"expo-runtime-version": "rt1", "expo-current-update-id": "u2"})
        self.assertEqual((current.status, current.body), (204, b""))
        r = get(**{"expo-runtime-version": "rt1", "expo-channel-name": "main", "expo-current-update-id": "u1",
                   "expo-fatal-error": "E" * 2000})
        self.assertEqual(r.status, 200)
        boundary = r.headers["content-type"].split("boundary=")[1]
        manifest = ota_artifact(102, "u2", created=1793280100)["manifest.json"]
        self.assertEqual(r.body, (f"--{boundary}\r\ncontent-type: application/json; charset=utf-8\r\n"
                                  f"content-disposition: form-data; name=\"manifest\"\r\n"
                                  f"expo-signature: sig=\"c2ln\", keyid=\"main\", alg=\"rsa-v1_5-sha256\"\r\n\r\n").encode()
                         + manifest + f"\r\n--{boundary}--\r\n".encode())
        self.assertEqual({k: r.headers[k] for k in ("expo-protocol-version", "expo-sfv-version", "cache-control")},
                         {"expo-protocol-version": "1", "expo-sfv-version": "0", "cache-control": "private, max-age=0"})
        self.assertEqual(r.audit, {"expo": {"current_update_id": "u1", "fatal_error": "E" * 1024}})

    def test_unknown_asset_and_apk(self):
        for path, params in (("/v1/updates/assets/{sha256}", {"sha256": "0" * 64}),
                             ("/v1/updates/assets/{sha256}", {"sha256": "../index.json"}),
                             ("/v1/app/apk/{versionCode}", {"versionCode": "1103"}),  # debug: never offered
                             ("/v1/app/apk/{versionCode}", {"versionCode": "9"})):
            with self.subTest(params), self.assertRaises(app_updates.ApiError) as cm:
                self.w.route(path, params)
            self.assertEqual(cm.exception.status, 404)


class OverHttpTest(unittest.TestCase):
    """Through the real App API: streamed files, Range, 204 without a body, audit, auth."""

    def setUp(self):
        self.w = World(self)
        self.body = os.urandom(300_000)
        self.w.gh.add_run(101, apk=apk_artifact(101, 1101, body=self.body), ota=ota_artifact(101, "u1"))
        self.w.collect()
        token = pathlib.Path(self.w.dir, "token")
        token.write_text(TOKEN)
        token.chmod(0o600)
        self.audit = pathlib.Path(self.w.dir, "audit.jsonl")
        self.api = AppApi({"bind": "tailscale", "port": 0, "token_file": str(token), "audit_log": str(self.audit)},
                          resolve_ip=lambda: "127.0.0.1", allow_loopback=True)
        self.api.start(EventBus(), self.w.registry, None)
        self.addCleanup(self.api.stop)
        self.assertTrue(self.api.listening.wait(5))

    def get(self, path, token=TOKEN, **headers):
        c = http.client.HTTPConnection(*self.api.address, timeout=10)
        self.addCleanup(c.close)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        c.request("GET", path, headers=headers)
        r = c.getresponse()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()

    def test_apk_whole_and_resumed(self):
        status, headers, data = self.get("/v1/app/apk/1101")
        self.assertEqual((status, data), (200, self.body))
        self.assertEqual((headers["content-length"], headers["etag"], headers["accept-ranges"], headers["content-type"]),
                         (str(len(self.body)), f"\"{sha(self.body)}\"", "bytes", "application/vnd.android.package-archive"))
        status, headers, data = self.get("/v1/app/apk/1101", Range="bytes=100000-")
        self.assertEqual((status, data, headers["content-range"]),
                         (206, self.body[100000:], f"bytes 100000-{len(self.body) - 1}/{len(self.body)}"))
        status, headers, _ = self.get("/v1/app/apk/1101", Range=f"bytes={len(self.body)}-")
        self.assertEqual((status, headers["content-range"]), (416, f"bytes */{len(self.body)}"))

    def test_asset_and_manifest(self):
        bundle = b"bundle u1"
        status, headers, data = self.get(f"/v1/updates/assets/{sha(bundle)}")
        self.assertEqual((status, data, headers["content-type"], headers["cache-control"]),
                         (200, bundle, "application/javascript", "public, max-age=31536000, immutable"))
        status, headers, data = self.get("/v1/updates/manifest", **{"expo-runtime-version": "rt1",
                                                                   "expo-current-update-id": "u1",
                                                                   "expo-embedded-update-id": "emb"})
        self.assertEqual((status, data), (204, b""))
        self.assertNotIn("content-type", headers)
        self.assertEqual(self.get("/v1/updates/manifest", **{"expo-runtime-version": "rt1"})[0], 200)
        self.assertTrue(self._audited(lambda lines: len(lines) == 3))
        line = json.loads(self.audit.read_text().splitlines()[1])
        self.assertEqual((line["status"], line["expo"]), (204, {"current_update_id": "u1", "embedded_update_id": "emb"}))

    def _audited(self, check):
        with self.api.changed:
            return self.api.changed.wait_for(lambda: self.audit.exists() and check(self.audit.read_text().splitlines()), 5)

    def test_every_route_needs_the_token(self):
        for path in ("/v1/updates/manifest", f"/v1/updates/assets/{sha(b'bundle u1')}", "/v1/app/latest", "/v1/app/apk/1101"):
            with self.subTest(path):
                self.assertEqual(self.get(path, token=None)[0], 401)
                self.assertEqual(self.get(path, token="Bearer -")[0], 401)  # expo-updates before the override

    def test_a_file_pruned_mid_request_is_a_404(self):
        os.remove(self.w.root / "apks" / "1101.apk")
        self.assertEqual(self.get("/v1/app/apk/1101")[0], 404)


class GitHubCliTest(unittest.TestCase):
    """The gh calls themselves, with a fake subprocess.run."""

    def run_with(self, returncode=0, stdout="", stderr=""):
        calls = []

        def fake(args, **kw):
            calls.append((args, kw["timeout"]))
            return mock.Mock(returncode=returncode, stdout=stdout, stderr=stderr)
        return app_updates.github.GitHub("o/r", run=fake), calls

    def test_runs_download_and_errors(self):
        gh, calls = self.run_with(stdout=json.dumps([{"databaseId": 5, "headSha": "s", "createdAt": "c"}]))
        self.assertEqual(gh.runs(), [{"id": 5, "sha": "s", "created": "c"}])
        self.assertEqual(calls[0][0][:9], ["gh", "run", "list", "--repo", "o/r", "--workflow", "build-apk.yml",
                                           "--branch", "main"])
        gh, _ = self.run_with(returncode=1, stderr="no artifact matches any of the names or patterns provided")
        with self.assertRaises(MissingArtifact):
            gh.download(5, "edith-ota", "/tmp/x")
        gh, _ = self.run_with(returncode=1, stderr="HTTP 502")
        with self.assertRaises(GhError):
            gh.download(5, "edith-apk", "/tmp/x")

    def test_timeout(self):
        def slow(args, **kw):
            raise app_updates.github.subprocess.TimeoutExpired(args, kw["timeout"])
        with self.assertRaises(GhError):
            app_updates.github.GitHub("o/r", run=slow).runs()


class StoreTest(unittest.TestCase):
    def test_sha256_is_read_in_chunks(self):
        with tempfile.NamedTemporaryFile() as f:
            f.write(b"x" * (store_mod.CHUNK * 2 + 5))
            f.flush()
            reads = []
            real = open

            class Spy:
                def __init__(self, *a):
                    self.f = real(*a)

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    self.f.close()

                def read(self, n=-1):
                    reads.append(n)
                    return self.f.read(n)
            with mock.patch("builtins.open", Spy):
                digest, size = store_mod.sha256_file(f.name)
        self.assertEqual((digest, size), (sha(b"x" * (store_mod.CHUNK * 2 + 5)), store_mod.CHUNK * 2 + 5))
        self.assertTrue(all(n == store_mod.CHUNK for n in reads))


if __name__ == "__main__":
    unittest.main()
