"""The collected builds on disk (contracts/app-updates.md), under <state_dir>/app-updates/:

    index.json             what was collected: runs seen, APKs, updates (written atomically)
    apks/<versionCode>.apk
    updates/<id>/          manifest.json, manifest.sig, update.json (served verbatim)
    assets/<sha256 hex>    every update's files, shared by content
    tmp/                   downloads in progress (emptied at start)

Every file is checked (size and SHA-256, read in chunks) before it is moved into place with
os.replace, so a reader never sees a partial or unverified file. Only the job thread writes; route
threads read `self.index`, which is replaced whole after every change (never edited in place).
"""
import copy
import hashlib
import json
import logging
import os
import shutil
import threading
import time

log = logging.getLogger("edith.feature.app_updates")

KEEP_APKS = 5
KEEP_RUNTIMES = 3
KEEP_PER_RUNTIME = 10   # updates kept per runtimeVersion (only the newest is served; a bound on disk use)
CHUNK = 1024 * 1024
HEX = set("0123456789abcdef")


class Rejected(Exception):
    """A downloaded artifact that is wrong (bad sha256, size or fields): never collected or retried."""


def sha256_file(path):
    h, size = hashlib.sha256(), 0
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def is_sha256(value):
    return isinstance(value, str) and len(value) == 64 and set(value) <= HEX


def write_json(path, data):
    tmp = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_json(path):
    with open(path) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise Rejected(f"{os.path.basename(path)} is not a JSON object")
    return data


def normalize_cert(value):
    return (value or "").replace(":", "").replace(" ", "").lower()


class Store:
    def __init__(self, root):
        self.root = root
        self.apk_dir, self.update_dir = os.path.join(root, "apks"), os.path.join(root, "updates")
        self.asset_dir, self.tmp_dir = os.path.join(root, "assets"), os.path.join(root, "tmp")
        for d in (self.apk_dir, self.update_dir, self.asset_dir):
            os.makedirs(d, exist_ok=True)
        shutil.rmtree(self.tmp_dir, ignore_errors=True)  # partial downloads from a previous run
        os.makedirs(self.tmp_dir)
        self._index_file = os.path.join(root, "index.json")
        try:
            index = read_json(self._index_file)
        except FileNotFoundError:
            index = {}
        except (OSError, ValueError, Rejected):
            log.exception("app-updates index unreadable; starting empty (files are re-collected)")
            index = {}
        index.setdefault("runs", {})
        index.setdefault("apks", {})
        index.setdefault("updates", {})
        self.index = index
        self.assets = self._asset_map(index)

    # ---- reading (any thread) ----

    @staticmethod
    def _asset_map(index):
        """sha256 -> {contentType, size} for every file of every kept update."""
        out = {}
        for u in index["updates"].values():
            for f in u["files"]:
                out[f["sha256"]] = {"contentType": f.get("contentType") or "application/octet-stream", "size": f["size"]}
        return out

    def apk_path(self, version_code):
        return os.path.join(self.apk_dir, f"{int(version_code)}.apk")

    def asset_path(self, sha):
        return os.path.join(self.asset_dir, sha)

    def update_file(self, update_id, name):
        return os.path.join(self.update_dir, update_id, name)

    def newest_update(self, runtime_version, channel, platform="android"):
        best = None
        for u in self.index["updates"].values():
            if (u["runtimeVersion"], u["channel"], u["platform"]) == (runtime_version, channel, platform):
                if best is None or u["createdAt"] > best["createdAt"]:
                    best = u
        return best

    # ---- writing (the job thread only) ----

    def _commit(self, change):
        """Apply change(index copy) and publish the new index: on disk first, then in memory."""
        index = copy.deepcopy(self.index)
        change(index)
        write_json(self._index_file, index)
        self.index, self.assets = index, self._asset_map(index)

    def seen(self, run_id, kind):
        return kind in self.index["runs"].get(str(run_id), {})

    def mark(self, run_id, kind, outcome):
        self._commit(lambda ix: ix["runs"].setdefault(str(run_id), {}).__setitem__(kind, outcome))

    def forget_runs_before(self, oldest_listed):
        """Runs older than the oldest one GitHub still lists never come back: drop their records."""
        stale = [r for r in self.index["runs"] if int(r) < oldest_listed]
        if stale:
            self._commit(lambda ix: [ix["runs"].pop(r) for r in stale])

    def update_apk(self, version_code, **fields):
        self._commit(lambda ix: ix["apks"][str(version_code)].update(fields))

    def scratch(self, name):
        path = os.path.join(self.tmp_dir, name)
        shutil.rmtree(path, ignore_errors=True)
        os.makedirs(path)
        return path

    def add_apk(self, run_id, folder, cert_pin):
        """Check an extracted edith-apk artifact. -> its apk.json record if it is offerable (the APK is
        then in place), or a reason string ("skipped: …") if it is fine but not offered. Raises
        Rejected if it is broken."""
        meta = read_json(os.path.join(folder, "apk.json"))
        try:
            version_code, size, sha = int(meta["versionCode"]), int(meta["size"]), meta["sha256"]
            str(meta["versionName"]), str(meta["runtimeVersion"]), str(meta["sha"])
        except (KeyError, TypeError, ValueError) as e:
            raise Rejected(f"apk.json: bad or missing field ({e})")
        if int(meta.get("run_id", run_id)) != int(run_id):
            raise Rejected(f"apk.json is from run {meta.get('run_id')}, not {run_id}")
        if meta.get("signing") != "release":
            return f"skipped: {meta.get('signing') or 'unknown'}-signed"
        if cert_pin and normalize_cert(meta.get("cert_sha256")) != normalize_cert(cert_pin):
            return "skipped: certificate is not the pinned one"
        apk = os.path.join(folder, "edith.apk")
        if not os.path.isfile(apk):
            raise Rejected("edith.apk missing")
        got, got_size = sha256_file(apk)
        if (got, got_size) != (str(sha).lower(), size):
            raise Rejected(f"edith.apk does not match apk.json (sha256 {got[:12]}…, {got_size} bytes)")
        os.replace(apk, self.apk_path(version_code))
        record = {**meta, "versionCode": version_code, "size": size, "sha256": got, "run_id": int(run_id),
                  "collected_at": time.time()}
        self._commit(lambda ix: ix["apks"].__setitem__(str(version_code), record))
        return record

    def add_update(self, run_id, folder):
        """Check an extracted edith-ota artifact and put it in place; -> its record. Raises Rejected."""
        meta = read_json(os.path.join(folder, "update.json"))
        manifest_path, sig_path = os.path.join(folder, "manifest.json"), os.path.join(folder, "manifest.sig")
        manifest = read_json(manifest_path)
        try:
            update_id, files = str(meta["id"]), list(meta["files"])
            record = {"id": update_id, "createdAt": float(meta["createdAt"]), "runtimeVersion": str(meta["runtimeVersion"]),
                      "channel": str(meta["channel"]), "platform": str(meta["platform"]), "sha": meta.get("sha"),
                      "run_id": int(run_id), "files": []}
        except (KeyError, TypeError, ValueError) as e:
            raise Rejected(f"update.json: bad or missing field ({e})")
        if (manifest.get("id"), manifest.get("runtimeVersion")) != (update_id, record["runtimeVersion"]):
            raise Rejected("manifest.json does not match update.json (id or runtimeVersion)")
        if not update_id or "/" in update_id or update_id.startswith("."):
            raise Rejected("bad update id")
        with open(sig_path) as f:
            if not f.read().strip():
                raise Rejected("manifest.sig is empty")
        base = os.path.realpath(folder)
        checked = []
        for entry in files:
            try:
                rel, sha, size = str(entry["path"]), str(entry["sha256"]).lower(), int(entry["size"])
            except (KeyError, TypeError, ValueError) as e:
                raise Rejected(f"update.json files: bad entry ({e})")
            path = os.path.realpath(os.path.join(folder, rel))
            if not path.startswith(base + os.sep) or not is_sha256(sha):
                raise Rejected(f"update.json files: bad path or sha256 ({rel})")
            if not os.path.isfile(path):
                raise Rejected(f"{rel} missing")
            if sha256_file(path) != (sha, size):
                raise Rejected(f"{rel} does not match its sha256/size")
            checked.append((path, sha))
            record["files"].append({"path": rel, "sha256": sha, "size": size,
                                    "contentType": entry.get("contentType") or "application/octet-stream",
                                    "launch": bool(entry.get("launch"))})
        for path, sha in checked:  # all verified: now move them in (an existing copy is the same bytes)
            if not os.path.exists(self.asset_path(sha)):
                os.replace(path, self.asset_path(sha))
        target = os.path.join(self.update_dir, update_id)
        staged = self.scratch(f"update-{update_id}")
        for name, src in (("manifest.json", manifest_path), ("manifest.sig", sig_path),
                          ("update.json", os.path.join(folder, "update.json"))):
            os.replace(src, os.path.join(staged, name))
        shutil.rmtree(target, ignore_errors=True)
        os.replace(staged, target)
        self._commit(lambda ix: ix["updates"].__setitem__(update_id, record))
        return record

    def prune(self):
        """Keep the newest KEEP_APKS APKs and the updates of the newest KEEP_RUNTIMES runtimeVersions
        (at most KEEP_PER_RUNTIME each); delete the rest and the assets nothing uses any more."""
        apks = sorted(self.index["apks"], key=int, reverse=True)
        drop_apks = apks[KEEP_APKS:]
        by_runtime = {}
        for u in self.index["updates"].values():
            by_runtime.setdefault(u["runtimeVersion"], []).append(u)
        ranked = sorted(by_runtime.values(), key=lambda us: max(u["createdAt"] for u in us), reverse=True)
        keep = {u["id"] for us in ranked[:KEEP_RUNTIMES]
                for u in sorted(us, key=lambda u: u["createdAt"], reverse=True)[:KEEP_PER_RUNTIME]}
        drop_updates = [i for i in self.index["updates"] if i not in keep]
        if not drop_apks and not drop_updates:
            return
        self._commit(lambda ix: ([ix["apks"].pop(v) for v in drop_apks], [ix["updates"].pop(i) for i in drop_updates]))
        for v in drop_apks:
            try:
                os.remove(self.apk_path(v))
            except FileNotFoundError:
                pass
        for i in drop_updates:
            shutil.rmtree(os.path.join(self.update_dir, i), ignore_errors=True)
        with os.scandir(self.asset_dir) as it:
            unused = [e.path for e in it if e.name not in self.assets]
        for path in unused:
            os.remove(path)
        log.info("app updates pruned: %d APKs, %d updates, %d assets", len(drop_apks), len(drop_updates), len(unused))
