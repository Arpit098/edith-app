"""Files the app attaches to a message (contracts/attachments.md): saved in ~/edith/inbox like
Telegram's, with the type taken from the file's first bytes, never from the client.

The body is streamed to a temp file in the inbox while hashed, checked, then linked into place under
its final name (os.link never overwrites, so two uploads can't take the same name). Ids are kept in
<state_dir>/app-attachments.json (atomic writes) so they survive a restart.
"""
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.parse

MAX_BYTES = 25 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
KEEP_SECONDS = 7 * 86400
MAX_IDS = 500
MAX_PER_MESSAGE = 10
CHUNK = 64 * 1024
HEAD = 64  # bytes kept for sniffing
HEIC = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1"}
MP4 = {b"M4A ", b"M4B ", b"mp41", b"mp42", b"isom", b"iso2", b"3gp4", b"3gp5", b"dash"}
EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "audio/ogg": ".ogg",
       "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/aac": ".aac"}


class AttachmentError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def sniff(head: bytes):
    """The allowed type of a file from its first bytes, or None."""
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in HEIC:
            return "image/heic"
        if brand in MP4:
            return "audio/mp4"
        return None
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head.startswith(b"ID3"):
        return "audio/mpeg"
    if len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0:
        layer = (head[1] >> 1) & 0b11
        if layer == 0:  # ADTS (AAC) uses layer 00, which MPEG audio never does
            return "audio/aac" if head[1] & 0xF6 == 0xF0 else None
        return "audio/mpeg"
    return None


def safe_stem(raw, kind):
    name = urllib.parse.unquote(raw or "")
    stem = os.path.splitext(os.path.basename(name.replace("\\", "/")))[0]
    stem = re.sub(r"[^A-Za-z0-9._-]", "_", stem).strip("._")[:60]
    return stem or kind


class Attachments:
    def __init__(self, inbox, index_file):
        self.inbox, self.index_file = inbox, index_file
        self._lock = threading.Lock()
        self._ids = None  # loaded on first use

    def _load(self):
        if self._ids is None:
            try:
                with open(self.index_file) as f:
                    self._ids = json.load(f)
            except (OSError, ValueError):
                self._ids = {}
        return self._ids

    def _save(self):
        tmp = f"{self.index_file}.tmp-{os.getpid()}-{threading.get_ident()}"
        os.makedirs(os.path.dirname(self.index_file), exist_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(self._ids, f)
        os.replace(tmp, self.index_file)

    def add(self, body, length, filename=None, claimed_sha=None, now=None):
        """Save an upload streamed from body.read(n). -> {id, name, type, size, sha256}."""
        if length <= 0:
            raise AttachmentError(400, "the file is empty")
        now = now or time.time()
        os.makedirs(self.inbox, exist_ok=True)
        tmp = os.path.join(self.inbox, f".upload-{secrets.token_hex(8)}")
        try:
            h, size, head = hashlib.sha256(), 0, b""
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                while chunk := body.read(CHUNK):
                    if len(head) < HEAD:
                        head += chunk[:HEAD - len(head)]
                        if len(head) >= 12 and sniff(head) is None:
                            raise AttachmentError(415, "unsupported file type")  # stop before reading the rest
                    h.update(chunk)
                    f.write(chunk)
                    size += len(chunk)
                f.flush()
                os.fsync(f.fileno())
            kind = sniff(head)
            if kind is None:
                raise AttachmentError(415, "unsupported file type")
            if kind.startswith("image/") and size > MAX_IMAGE_BYTES:
                raise AttachmentError(413, "images are limited to 20 MB")
            sha = h.hexdigest()
            if claimed_sha and claimed_sha.strip().lower() != sha:
                raise AttachmentError(400, "sha256 mismatch")
            stem = f"{int(now)}_{safe_stem(filename, kind.split('/')[0])}"
            name = self._place(tmp, stem, EXT[kind])
            record = {"id": secrets.token_hex(8), "name": name, "type": kind, "size": size, "sha256": sha}
            with self._lock:
                ids = self._load()
                ids[record["id"]] = {**record, "path": os.path.join(self.inbox, name), "at": now}
                for old in [i for i, r in ids.items() if now - r["at"] > KEEP_SECONDS]:
                    del ids[old]
                while len(ids) > MAX_IDS:
                    del ids[min(ids, key=lambda i: ids[i]["at"])]
                self._save()
            return record
        finally:
            try:
                os.remove(tmp)
            except FileNotFoundError:
                pass

    def _place(self, tmp, stem, ext):
        """Link the temp file in under the first free name (never overwrites); -> that name."""
        for n in range(1, 1000):
            name = f"{stem}{'' if n == 1 else f'-{n}'}{ext}"
            try:
                os.link(tmp, os.path.join(self.inbox, name))
                return name
            except FileExistsError:
                continue
        raise AttachmentError(409, "too many files with this name")

    def paths(self, ids, now=None):
        """The saved paths for a message's attachment ids, or AttachmentError(400)."""
        if not isinstance(ids, list) or len(ids) > MAX_PER_MESSAGE:
            raise AttachmentError(400, f"attachments must be a list of at most {MAX_PER_MESSAGE} ids")
        now = now or time.time()
        with self._lock:
            known = self._load()
            out = []
            for i in ids:
                r = known.get(str(i))
                if r is None or now - r["at"] > KEEP_SECONDS or not os.path.exists(r["path"]):
                    raise AttachmentError(400, f"unknown attachment {i}")
                out.append(r["path"])
        return out
