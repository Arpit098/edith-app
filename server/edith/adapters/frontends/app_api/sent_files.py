"""Files EDITH sends to the app (its `SEND_FILE: /path` reply lines; contracts/attachments.md §4).

Telegram attaches those paths itself. The app can't read the server's disk, so each path is registered
here under an opaque random id, and the app downloads it with GET /v1/files/<id>. The request never
names a path: only a registered id is served, and only while the file is still the one registered.

Claude writes the SEND_FILE lines, so registration is the gate:
- the path is resolved (symlinks too) and must be a regular, readable file of at most MAX_BYTES with
  one link (a hard link to a private file would otherwise pass as an ordinary one);
- it must be inside one of the allowed roots (config `send_file_roots`; by default ~/edith, ~/Projects,
  /tmp/edith-out and ~/Downloads) or a Claude session's scratchpad
  (/tmp/claude-<uid>/<project>/<session>/scratchpad/…; nothing else under /tmp, which holds browser
  profiles, task outputs and prompts), and not inside a dot-folder below that root (.git, .venv, …);
- nothing in a secret folder (.config, .claude, .ssh, …, anywhere) or /proc, /sys, /dev, checked on
  the given path and on the resolved one;
- no key, token, .env or credential file by its name.
A refusal is logged once per path and reason, with the path (never the file's contents), and the app
gets the name with `error` instead of an id.

Only the live events register files (the bus, whether or not the app is connected); history pages only
look up ids already there, so reading old history never registers (or keeps alive) anything.

Registration is idempotent: the same file (resolved path, device, inode, size and mtime) keeps its id,
so the live event, turn.done and every history page that name it agree. Ids live KEEP_SECONDS (7 days)
in <state_dir>/app-sent-files.json (atomic writes, at most MAX_IDS), so they survive a restart.
"""
import json
import logging
import mimetypes
import os
import re
import secrets
import stat
import threading
import time

log = logging.getLogger("edith.adapter.app_api.files")

MAX_BYTES = 50 * 1024 * 1024
KEEP_SECONDS = 7 * 86400
MAX_IDS = 1000
ID = re.compile(r"[0-9a-f]{32}")
# Folders that hold keys, tokens and logins: refused wherever they are (~/edith/.claude too), and a
# repository's .git (its config can carry a token in a remote URL).
SECRET_PARTS = {".config", ".claude", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store",
                ".mozilla", ".pki", ".git"}
# Under the home: more of them (EDITH's saved Claude logins among them).
SECRET_DIRS = (".local/share/keyrings", ".cache/edith/accounts")
SYSTEM_DIRS = ("/proc", "/sys", "/dev")
# By name: .env files, private keys and keystores, and files named for a key, token, secret, password or
# credentials (by the stem's last word, so "token-analysis.pdf" is fine and "cracker-dev-key.json" isn't).
SECRET_FILE = re.compile(r"^(\.env(\..*)?|\.netrc|\.git-credentials|authorized_keys.*|known_hosts.*|\.npmrc|\.pypirc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519).*"
                         r"|client_secret.*|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc))$", re.I)
SECRET_STEM = re.compile(r"(^|[._-])(api[._-]?keys?|keys?|tokens?|secrets?|credentials?|passwords?|passwd)$", re.I)
MIME = {".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".txt": "text/plain",
        ".log": "text/plain", ".html": "text/html", ".pdf": "application/pdf", ".webp": "image/webp",
        ".heic": "image/heic", ".apk": "application/vnd.android.package-archive"}


class Refused(Exception):
    """A SEND_FILE path that isn't served; the message is the reason (no path, no contents)."""


def mime_of(name):
    ext = os.path.splitext(name)[1].lower()
    return MIME.get(ext) or mimetypes.guess_type(name, strict=False)[0] or "application/octet-stream"


def secret_name(name):
    return bool(SECRET_FILE.match(name) or SECRET_STEM.search(os.path.splitext(name)[0]))


def _under(path, folder):
    return path == folder or path.startswith(folder.rstrip("/") + "/")


def default_roots(home, work_dir, tmp="/tmp"):
    """Where EDITH may send files from unless config says otherwise (scratchpads are always allowed)."""
    roots = [work_dir, os.path.join(home, "Projects"), os.path.join(tmp, "edith-out")]
    downloads = os.path.join(home, "Downloads")
    return roots + ([downloads] if os.path.isdir(downloads) else [])


class SentFiles:
    def __init__(self, index_file, home, work_dir, max_bytes=MAX_BYTES, roots=None, tmp="/tmp"):
        self.index_file, self.max_bytes = index_file, max_bytes
        self.home, self.work_dir = os.path.realpath(home), work_dir
        self._raw_home = os.path.abspath(home)
        expand = lambda p: self._raw_home + p[1:] if p == "~" or p.startswith("~/") else p  # noqa: E731
        self.roots = [os.path.realpath(expand(r)) for r in (roots if roots is not None else default_roots(home, work_dir, tmp))]
        # A Claude Code session's scratchpad (this user's only): /tmp/claude-<uid>/<project>/<session>/scratchpad/
        self.scratchpad = re.compile(rf"^{re.escape(os.path.realpath(tmp))}/claude-{os.getuid()}/[^/]+/[^/]+/scratchpad(?=/)")
        self._logged = set()  # (path, reason) refusals already logged
        self._lock = threading.Lock()
        self._ids = None   # id -> record, loaded on first use
        self._keys = {}    # (path, dev, ino, size, mtime_ns) -> id

    # ---- the index ----

    def _load(self):
        if self._ids is None:
            try:
                with open(self.index_file) as f:
                    loaded = json.load(f)
                self._ids = {i: r for i, r in loaded.items() if ID.fullmatch(i) and isinstance(r, dict)}
            except (OSError, ValueError, AttributeError):
                self._ids = {}
            self._keys = {self._key(r): i for i, r in self._ids.items()}
        return self._ids

    @staticmethod
    def _key(r):
        return (r.get("path"), r.get("dev"), r.get("ino"), r.get("size"), r.get("mtime_ns"))

    def _save(self):
        tmp = f"{self.index_file}.tmp-{os.getpid()}-{threading.get_ident()}"
        os.makedirs(os.path.dirname(self.index_file), exist_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(self._ids, f)
        os.replace(tmp, self.index_file)

    def _prune(self, now):
        ids = self._ids
        for old in [i for i, r in ids.items() if now - r.get("at", 0) > KEEP_SECONDS]:
            self._keys.pop(self._key(ids.pop(old)), None)
        if len(ids) > MAX_IDS:
            for old in sorted(ids, key=lambda i: ids[i].get("at", 0))[:len(ids) - MAX_IDS]:
                self._keys.pop(self._key(ids.pop(old)), None)

    # ---- the gate ----

    def _secret_place(self, path):
        for d in SYSTEM_DIRS:
            if _under(path, d):
                return "a system folder"
        if SECRET_PARTS.intersection(path.split("/")[:-1]):
            return "a private folder"
        for home in {self.home, self._raw_home}:
            for d in SECRET_DIRS:
                if _under(path, os.path.join(home, d)):
                    return "a private folder"
        return None

    def check(self, raw):
        """A SEND_FILE value -> (resolved path, os.stat_result, name), or Refused(reason)."""
        if not isinstance(raw, str) or not raw.strip() or "\x00" in raw:
            raise Refused("not a path")
        given = raw.strip()
        if given == "~" or given.startswith("~/"):
            given = self._raw_home + given[1:]
        given = os.path.normpath(os.path.join(self.work_dir, given))  # relative: Claude's working folder
        name = os.path.basename(given)
        real = os.path.realpath(given)
        for p in (given, real):
            where = self._secret_place(p)
            if where:
                raise Refused(f"in {where}")
        if secret_name(name) or secret_name(os.path.basename(real)):
            raise Refused("a key, token or credential file")
        root = next((r for r in self.roots if _under(real, r)), None)
        if root is None and (pad := self.scratchpad.match(real)):
            root = pad.group(0)
        if root is None:
            raise Refused("outside the folders EDITH may send from")
        if any(part.startswith(".") for part in os.path.relpath(real, root).split("/")[:-1]):
            raise Refused("in a hidden folder")
        try:
            st = os.stat(real)
        except OSError:
            raise Refused("not found")
        if not stat.S_ISREG(st.st_mode):
            raise Refused("not a regular file")
        if st.st_nlink > 1:
            raise Refused("has other hard links")
        if st.st_size > self.max_bytes:
            raise Refused(f"over {self.max_bytes // (1024 * 1024)} MB")
        if not os.access(real, os.R_OK):
            raise Refused("not readable")
        return real, st, name

    # ---- registering and serving ----

    def _checked(self, raw):
        """check(), with a refusal logged once per path and reason. -> (real, st, name) or {name, error}."""
        try:
            return self.check(raw)
        except Refused as e:
            shown = raw if isinstance(raw, str) else type(raw).__name__
            with self._lock:
                first = (shown, str(e)) not in self._logged
                if first:
                    if len(self._logged) >= MAX_IDS:
                        self._logged.clear()
                    self._logged.add((shown, str(e)))
            if first:
                log.warning("SEND_FILE not offered to the app (%s): %r", e, shown)
            return {"name": os.path.basename(str(raw).strip().rstrip("/")) or "file", "error": str(e)}

    def register(self, raw, now=None, create=True):
        """A SEND_FILE path -> {id, name, size, mime}, or {name, error} when it isn't served. With
        create=False (history) only an id that already exists is given; nothing is added or renewed."""
        checked = self._checked(raw)
        if isinstance(checked, dict):
            return checked
        real, st, name = checked
        now = now or time.time()
        record = {"path": real, "name": name, "size": st.st_size, "mime": mime_of(name), "dev": st.st_dev,
                  "ino": st.st_ino, "mtime_ns": st.st_mtime_ns, "at": now}
        with self._lock:
            ids = self._load()
            found = self._keys.get(self._key(record))
            if found is not None and now - ids[found].get("at", 0) <= KEEP_SECONDS:
                fid = found
            elif not create:
                return {"name": name, "error": "no longer available"}
            else:
                self._prune(now)
                fid = secrets.token_hex(16)
                ids[fid] = record
                self._keys[self._key(record)] = fid
                self._save()
            r = ids[fid]
        return {"id": fid, "name": r["name"], "size": r["size"], "mime": r["mime"]}

    def describe(self, paths, create=True):
        """An event's `files` (SEND_FILE paths) -> the app's `sent_files` list (create=False: look up only)."""
        return [self.register(p, create=create) for p in paths or [] if isinstance(p, str)]

    def open(self, fid, now=None):
        """A registered id -> (open file, record), or None when it is unknown, expired or no longer the
        same file (replaced, grown past the cap, or gone). The caller owns the file."""
        if not isinstance(fid, str) or not ID.fullmatch(fid):
            return None
        now = now or time.time()
        with self._lock:
            r = self._load().get(fid)
            r = dict(r) if r and now - r.get("at", 0) <= KEEP_SECONDS else None
        if r is None:
            return None
        try:
            fd = os.open(r["path"], os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
        except OSError:
            return None
        f = os.fdopen(fd, "rb")
        st = os.fstat(f.fileno())
        if (not stat.S_ISREG(st.st_mode) or st.st_nlink > 1 or (st.st_dev, st.st_ino) != (r["dev"], r["ino"])
                or st.st_size > self.max_bytes or (st.st_size, st.st_mtime_ns) != (r["size"], r["mtime_ns"])):
            f.close()
            return None
        return f, r
