"""Wake word recordings on disk (contracts/wakeword.md §6):

    <root>/<session>/manifest.json     the session and its clips (written atomically)
    <root>/<session>/clips/<sha>.wav   one file per clip, named by its SHA-256
    <root>/.lock                       flock'd around every change

Files are 0600 and folders 0700. Manifests are read once and kept in memory (only this process
writes them), so listing sessions or checking disk use never re-reads or walks the folders.
"""
import array
import contextlib
import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import sys
import threading
import time
import wave
from datetime import datetime
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
KINDS = {"positive_near": (0.5, 5.0), "positive_far": (0.5, 5.0), "positive_whisper": (0.5, 5.0),
         "noise": (1.0, 120.0)}  # kind -> (min, max) seconds
RATE, CHANNELS, WIDTH = 16000, 1, 2
MAX_CLIP_BYTES = 4 * 1024 * 1024
MAX_CLIPS = 300
MAX_SESSIONS = 20
MAX_TOTAL_BYTES = 500 * 1024 * 1024
SESSION_ID = re.compile(r"[0-9]{8}-[0-9]{4}-[0-9a-f]{4}")
SHA256 = re.compile(r"[0-9a-f]{64}")
CHUNK = 64 * 1024
FLOOR_DB = -120.0


class StoreError(Exception):
    """A request the store refuses: `status` and a message for Arpit (contracts/wakeword.md)."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def write_private(path, data: bytes):
    """Atomically replace `path` with `data`, mode 0600."""
    tmp = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def db(value):
    return round(20 * math.log10(value / 32768), 1) if value > 0 else FLOOR_DB


def check_wav(path, kind):
    """The clip's (seconds, peak_dbfs, rms_dbfs), read from its header and frames with `wave`, or
    StoreError(400) saying what is wrong. The frames are read in chunks."""
    try:
        with wave.open(path, "rb") as w:
            channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            if w.getcomptype() != "NONE":
                raise StoreError(400, "expected PCM audio")
            if rate != RATE:
                raise StoreError(400, f"expected {RATE} Hz, got {rate}")
            if channels != CHANNELS:
                raise StoreError(400, f"expected mono, got {channels} channels")
            if width != WIDTH:
                raise StoreError(400, f"expected 16-bit samples, got {8 * width}-bit")
            seen, peak, squares = 0, 0, 0
            while chunk := w.readframes(CHUNK // WIDTH):
                samples = array.array("h", chunk)
                if sys.byteorder == "big":
                    samples.byteswap()  # WAV is little-endian
                seen += len(samples)
                if samples:
                    peak = max(peak, max(samples), -min(samples))
                    squares += sum(map(int.__mul__, samples, samples))
    except (wave.Error, EOFError) as e:
        raise StoreError(400, f"not a valid WAV file ({e})")
    if seen != frames:
        raise StoreError(400, f"the WAV data holds {seen} frames but its header says {frames}")
    seconds = frames / RATE
    low, high = KINDS[kind]
    if not low <= seconds <= high:
        raise StoreError(400, f"a {kind} clip must be {low:g}–{high:g} s long, this one is {seconds:.2f} s")
    return round(seconds, 3), db(peak), db(math.sqrt(squares / frames)) if frames else FLOOR_DB


def summary(manifest):
    kinds = {k: {"count": 0, "seconds": 0.0} for k in KINDS}
    for c in manifest["clips"]:
        kinds[c["kind"]]["count"] += 1
        kinds[c["kind"]]["seconds"] = round(kinds[c["kind"]]["seconds"] + c["seconds"], 3)
    return {"id": manifest["session"], "label": manifest["label"], "created_at": manifest["created_at"],
            "updated_at": manifest["updated_at"], "clips": len(manifest["clips"]),
            "bytes": sum(c["bytes"] for c in manifest["clips"]),
            "seconds": round(sum(c["seconds"] for c in manifest["clips"]), 3), "kinds": kinds}


class Recordings:
    def __init__(self, root, max_total_bytes=MAX_TOTAL_BYTES):
        self.root, self.max_total_bytes = root, max_total_bytes
        os.makedirs(root, mode=0o700, exist_ok=True)
        os.chmod(root, 0o700)
        self._lock = threading.Lock()
        self._lock_file = os.path.join(root, ".lock")
        self._manifests: dict[str, dict] = {}
        with self._locked():
            for name in os.listdir(root):
                path = os.path.join(root, name, "manifest.json")
                if SESSION_ID.fullmatch(name) and os.path.exists(path):
                    with open(path) as f:
                        self._manifests[name] = json.load(f)
                    self._sweep(name)
        self.used = sum(c["bytes"] for m in self._manifests.values() for c in m["clips"])

    @contextlib.contextmanager
    def _locked(self):
        """The threads of this process and any other process (flock) take turns changing the store."""
        with self._lock:
            fd = os.open(self._lock_file, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield
            finally:
                os.close(fd)  # releases the flock

    def _sweep(self, sid):
        """Remove uploads that never finished (a crash mid-upload) from a session's clips folder."""
        clips = os.path.join(self.root, sid, "clips")
        for name in os.listdir(clips) if os.path.isdir(clips) else []:
            if name.startswith(".upload-"):
                os.remove(os.path.join(clips, name))

    def _save(self, manifest):
        manifest["updated_at"] = int(time.time())
        write_private(os.path.join(self.root, manifest["session"], "manifest.json"),
                      json.dumps(manifest, indent=1).encode())
        self._manifests[manifest["session"]] = manifest

    def _manifest(self, sid):
        m = self._manifests.get(sid) if SESSION_ID.fullmatch(sid or "") else None
        if m is None:
            raise StoreError(404, "no such session")
        return m

    # ---- sessions ----

    def sessions(self):
        return sorted((summary(m) for m in list(self._manifests.values())), key=lambda s: s["created_at"], reverse=True)

    def session(self, sid):
        return summary(self._manifest(sid))

    def manifest(self, sid):
        return json.loads(json.dumps(self._manifest(sid)))  # a copy: callers can't change ours

    def create(self, label=""):
        with self._locked():
            if len(self._manifests) >= MAX_SESSIONS:
                raise StoreError(409, f"there are already {MAX_SESSIONS} sessions; delete one first")
            now = time.time()
            sid = f"{datetime.fromtimestamp(now, IST):%Y%m%d-%H%M}-{secrets.token_hex(2)}"
            for folder in (os.path.join(self.root, sid), os.path.join(self.root, sid, "clips")):
                os.mkdir(folder, 0o700)
                os.chmod(folder, 0o700)  # mkdir's mode is masked by the umask
            self._save({"version": 1, "session": sid, "label": str(label or "")[:60], "created_at": int(now),
                        "updated_at": int(now), "format": {"sample_rate": RATE, "channels": CHANNELS,
                                                           "sample_width": WIDTH}, "clips": []})
            return self.session(sid)

    def delete(self, sid):
        with self._locked():
            m = self._manifest(sid)
            shutil.rmtree(os.path.join(self.root, sid))
            del self._manifests[sid]
            self.used -= sum(c["bytes"] for c in m["clips"])

    # ---- clips ----

    def clip_path(self, sid, sha):
        if not SHA256.fullmatch(sha or "") or not any(c["sha256"] == sha for c in self._manifest(sid)["clips"]):
            raise StoreError(404, "no such clip")
        return os.path.join(self.root, sid, "clips", f"{sha}.wav")

    def add(self, sid, kind, body, length, claimed_sha=None):
        """Store an uploaded clip, streamed from body.read(n). -> (clip, created)."""
        if kind not in KINDS:
            raise StoreError(400, f"kind must be one of {', '.join(KINDS)}")
        self._manifest(sid)
        if length <= 0:
            raise StoreError(400, "the clip is empty")
        if self.used + length > self.max_total_bytes:
            raise StoreError(507, "recordings are using all their space; delete a session")
        clips = os.path.join(self.root, sid, "clips")
        tmp = os.path.join(clips, f".upload-{secrets.token_hex(8)}")
        try:
            h, size = hashlib.sha256(), 0
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                while chunk := body.read(CHUNK):
                    h.update(chunk)
                    f.write(chunk)
                    size += len(chunk)
                f.flush()
                os.fsync(f.fileno())
            sha = h.hexdigest()
            if claimed_sha and claimed_sha.strip().lower() != sha:
                raise StoreError(400, "sha256 mismatch")
            seconds, peak, rms = check_wav(tmp, kind)
            with self._locked():
                m = self._manifest(sid)  # it may have been deleted while this was uploading
                old = next((c for c in m["clips"] if c["sha256"] == sha), None)
                if old:
                    if old["kind"] != kind:
                        raise StoreError(409, f"this clip is already in the session as {old['kind']}")
                    return {k: v for k, v in old.items() if k != "file"}, False
                if len(m["clips"]) >= MAX_CLIPS:
                    raise StoreError(409, f"a session holds at most {MAX_CLIPS} clips")
                if self.used + size > self.max_total_bytes:
                    raise StoreError(507, "recordings are using all their space; delete a session")
                os.replace(tmp, os.path.join(clips, f"{sha}.wav"))
                clip = {"sha256": sha, "kind": kind, "file": f"clips/{sha}.wav", "seconds": seconds, "bytes": size,
                        "peak_dbfs": peak, "rms_dbfs": rms, "uploaded_at": int(time.time())}
                m = json.loads(json.dumps(m))
                m["clips"].append(clip)
                self._save(m)
                self.used += size
                return {k: v for k, v in clip.items() if k != "file"}, True
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.remove(tmp)

    def remove(self, sid, sha):
        with self._locked():
            path = self.clip_path(sid, sha)
            m = json.loads(json.dumps(self._manifest(sid)))
            clip = next(c for c in m["clips"] if c["sha256"] == sha)
            m["clips"].remove(clip)
            self._save(m)
            os.remove(path)
            self.used -= clip["bytes"]
