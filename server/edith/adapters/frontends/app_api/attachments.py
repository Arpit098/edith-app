"""Files the app attaches to a message (contracts/attachments.md): saved in ~/edith/inbox like
Telegram's, with the type taken from the file's first bytes, never from the client.

The body is streamed to a temp file in the inbox while hashed, checked, then linked into place under
its final name (os.link never overwrites, so two uploads can't take the same name). Ids are kept in
<state_dir>/app-attachments.json (atomic writes) so they survive a restart.

Documents: PDF by "%PDF-"; zip by "PK\\x03\\x04", then typed docx/xlsx/pptx (or a plain zip) by the
parts its central directory lists; Office 97-2003 files by the OLE signature, with the name's
extension choosing doc/xls/ppt; text (txt, csv, md, json) when the whole file is UTF-8 without
control bytes, with the name's extension choosing among those. The name only ever picks within a
class the bytes already proved.
"""
import codecs
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.parse
import zipfile

MAX_BYTES = 25 * 1024 * 1024  # any file, documents included (app: MAX_FILE_BYTES)
MAX_IMAGE_BYTES = 20 * 1024 * 1024
KEEP_SECONDS = 7 * 86400
MAX_IDS = 500
MAX_PER_MESSAGE = 10
CHUNK = 64 * 1024
HEAD = 64  # bytes kept for sniffing
HEIC = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1"}
MP4 = {b"M4A ", b"M4B ", b"mp41", b"mp42", b"isom", b"iso2", b"3gp4", b"3gp5", b"dash"}
EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "audio/ogg": ".ogg",
       "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/aac": ".aac",
       "application/pdf": ".pdf", "application/zip": ".zip",
       "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
       "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
       "application/msword": ".doc", "application/vnd.ms-excel": ".xls", "application/vnd.ms-powerpoint": ".ppt",
       "text/plain": ".txt", "text/csv": ".csv", "text/markdown": ".md", "application/json": ".json"}
OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
OLE_BY_EXT = {".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint"}
TEXT_BY_EXT = {".csv": "text/csv", ".md": "text/markdown", ".markdown": "text/markdown", ".json": "application/json"}
TEXT_TYPES = {"text/plain", *TEXT_BY_EXT.values()}
# The part every OOXML file of each kind has (ECMA-376 part 2); the first one found decides.
OOXML_PARTS = (("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
               ("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
               ("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation"))
# C0 control bytes text never has (tab, LF, VT, FF, CR and ESC are fine). In UTF-8 these bytes only
# ever stand for themselves, so a byte search per chunk is exact.
CONTROL = re.compile(rb"[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]")


class AttachmentError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def extension(filename):
    name = urllib.parse.unquote(filename or "").replace("\\", "/")
    return os.path.splitext(os.path.basename(name))[1].lower()


def looks_text(head: bytes) -> bool:
    """Whether a file's first bytes could be UTF-8 text (a character cut at the end is fine)."""
    try:
        codecs.getincrementaldecoder("utf-8")().decode(head, final=False)
    except UnicodeDecodeError:
        return False
    return CONTROL.search(head) is None


def sniff(head: bytes, filename=None):
    """The allowed type of a file from its first bytes, or None. A zip comes back as application/zip
    (zip_kind() then tells the Office types apart); text only says the start looks like text (the
    upload checks the rest)."""
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head.startswith(b"PK\x03\x04"):
        return "application/zip"
    if head.startswith(OLE):
        return OLE_BY_EXT.get(extension(filename))
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
    if looks_text(head):
        return TEXT_BY_EXT.get(extension(filename), "text/plain")
    return None


def zip_kind(path):
    """A saved zip's type: docx, xlsx or pptx by the part its directory lists, else a plain zip;
    None when it isn't a readable zip. Reads only the central directory, never extracts."""
    try:
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())
    except (zipfile.BadZipFile, OSError, ValueError):
        return None
    return next((kind for part, kind in OOXML_PARTS if part in names), "application/zip")


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
            text = codecs.getincrementaldecoder("utf-8")()  # None once the file can't be text
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                while chunk := body.read(CHUNK):
                    if len(head) < HEAD:
                        head += chunk[:HEAD - len(head)]
                        if len(head) >= 12 and sniff(head, filename) is None:
                            raise AttachmentError(415, "unsupported file type")  # stop before reading the rest
                    if text is not None:
                        try:
                            text.decode(chunk)
                            if CONTROL.search(chunk):
                                text = None
                        except UnicodeDecodeError:
                            text = None
                        if text is None and len(head) >= 12 and sniff(head, filename) in TEXT_TYPES:
                            raise AttachmentError(415, "unsupported file type")  # binary after a text-like start
                    h.update(chunk)
                    f.write(chunk)
                    size += len(chunk)
                f.flush()
                os.fsync(f.fileno())
            kind = sniff(head, filename)
            if kind in TEXT_TYPES:
                try:
                    if text is None:
                        kind = None
                    else:
                        text.decode(b"", final=True)
                except UnicodeDecodeError:  # ends inside a character
                    kind = None
            elif kind == "application/zip":
                kind = zip_kind(tmp)
            if kind is None:
                raise AttachmentError(415, "unsupported file type")
            if kind.startswith("image/") and size > MAX_IMAGE_BYTES:
                raise AttachmentError(413, "images are limited to 20 MB")
            sha = h.hexdigest()
            if claimed_sha and claimed_sha.strip().lower() != sha:
                raise AttachmentError(400, "sha256 mismatch")
            group = kind.split("/")[0]
            stem = f"{int(now)}_{safe_stem(filename, group if group in ('image', 'audio') else 'document')}"
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
