"""Saved Claude logins (contracts/accounts.md): one folder per account under
~/.config/edith/claude-accounts/<id>/ (mode 700) holding

- credentials.json: a copy of Claude Code's ~/.claude/.credentials.json for that account (mode 600);
- account.json: {label, email, plan, account_uuid, oauth_account, added} (mode 600), where
  oauth_account is the `oauthAccount` block of ~/.claude.json that goes with it.

The active account is the one whose account_uuid is in ~/.claude.json now; the login in use when
the list is first read is saved as a profile, so it can be switched back to. Tokens are only ever
copied file to file: nothing here returns, logs or prints them.

Used by the feature and by the switch runner (another process), so every change holds an flock on
<root>/.lock, and every write is atomic (tmp + os.replace, fsynced).
"""
import contextlib
import fcntl
import json
import os
import re
import secrets
import shutil
import time

ID = re.compile(r"^[0-9a-f]{8}$")
LABEL_MAX = 60


class ProfileError(Exception):
    """A request that can't be done (unknown id, the active account, bad credentials)."""


def write_private(path: str, data: bytes, mode: int = 0o600) -> None:
    """Write `path` atomically, readable by its owner only from the first byte."""
    tmp = f"{path}.tmp-{os.getpid()}-{secrets.token_hex(3)}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def read_json(path: str):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def check_credentials(data: bytes) -> dict:
    """Claude Code's credentials file, parsed; ProfileError if it isn't a usable subscription login."""
    try:
        creds = json.loads(data)
    except ValueError:
        raise ProfileError("the credentials file isn't JSON") from None
    oauth = creds.get("claudeAiOauth") if isinstance(creds, dict) else None
    if not isinstance(oauth, dict) or not isinstance(oauth.get("refreshToken"), str) or not oauth["refreshToken"]:
        raise ProfileError("the credentials file has no Claude login")
    return creds


class Profiles:
    def __init__(self, root: str, claude_dir: str, claude_json: str):
        self.root, self.claude_dir, self.claude_json = root, claude_dir, claude_json

    @property
    def credentials(self) -> str:
        """Claude Code's live credentials file."""
        return os.path.join(self.claude_dir, ".credentials.json")

    @contextlib.contextmanager
    def locked(self):
        os.makedirs(self.root, mode=0o700, exist_ok=True)
        os.chmod(self.root, 0o700)
        fd = os.open(os.path.join(self.root, ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)  # releases the lock

    def _dir(self, pid: str) -> str:
        if not ID.match(pid or ""):
            raise ProfileError("unknown account")
        return os.path.join(self.root, pid)

    def _ids(self) -> list[str]:
        try:
            return sorted(n for n in os.listdir(self.root) if ID.match(n) and os.path.isdir(os.path.join(self.root, n)))
        except FileNotFoundError:
            return []

    def _info(self, pid: str) -> dict | None:
        info = read_json(os.path.join(self._dir(pid), "account.json"))
        return info if isinstance(info, dict) else None

    def current_uuid(self) -> str | None:
        account = (read_json(self.claude_json) or {}).get("oauthAccount") or {}
        return account.get("accountUuid") if isinstance(account, dict) else None

    def _by_uuid(self, uuid: str | None) -> str | None:
        if not uuid:
            return None
        return next((pid for pid in self._ids() if (self._info(pid) or {}).get("account_uuid") == uuid), None)

    # ---- reading ----

    def list(self) -> list[dict]:
        """[{id, label, email, plan, active}], the active account first, then by label. Saves the
        login in use as a profile if it isn't one yet."""
        with self.locked():
            self._import_current()
            uuid = self.current_uuid()
            out = []
            for pid in self._ids():
                info = self._info(pid)
                if info:
                    out.append({"id": pid, "label": info.get("label") or info.get("email") or pid,
                                "email": info.get("email"), "plan": info.get("plan"),
                                "active": bool(uuid) and info.get("account_uuid") == uuid})
            return sorted(out, key=lambda a: (not a["active"], (a["label"] or "").lower()))

    def get(self, pid: str) -> dict:
        info = self._info(pid)
        if not info:
            raise ProfileError("unknown account")
        return info

    def active(self) -> str | None:
        with self.locked():
            self._import_current()
            return self._by_uuid(self.current_uuid())

    # ---- changing ----

    def _import_current(self) -> None:
        uuid = self.current_uuid()
        if not uuid or self._by_uuid(uuid):
            return
        try:
            with open(self.credentials, "rb") as f:
                data = f.read()
            check_credentials(data)
        except (OSError, ProfileError):
            return  # not logged in (or an API key): nothing to save
        self._create(data, (read_json(self.claude_json) or {}).get("oauthAccount"))

    def _create(self, data: bytes, oauth_account, label: str | None = None) -> str:
        creds = check_credentials(data)
        if not isinstance(oauth_account, dict) or not oauth_account.get("accountUuid"):
            raise ProfileError("the login has no account details")
        pid = self._by_uuid(oauth_account["accountUuid"])  # the same account logged in again: refresh it
        if pid is None:
            pid = secrets.token_hex(4)
            os.makedirs(self._dir(pid), mode=0o700)
        old = self._info(pid) or {}
        email = oauth_account.get("emailAddress")
        info = {"label": (label or "").strip()[:LABEL_MAX] or old.get("label") or oauth_account.get("displayName") or email,
                "email": email, "plan": creds["claudeAiOauth"].get("subscriptionType") or oauth_account.get("billingType"),
                "account_uuid": oauth_account["accountUuid"], "oauth_account": oauth_account,
                "added": old.get("added") or time.time()}
        write_private(os.path.join(self._dir(pid), "credentials.json"), data)
        write_private(os.path.join(self._dir(pid), "account.json"), json.dumps(info, indent=1).encode())
        return pid

    def add(self, config_dir: str, label: str | None = None) -> str:
        """Save the login a `claude auth login` made in `config_dir` (CLAUDE_CONFIG_DIR) -> its id."""
        try:
            with open(os.path.join(config_dir, ".credentials.json"), "rb") as f:
                data = f.read()
        except OSError:
            raise ProfileError("the login saved no credentials") from None
        oauth_account = (read_json(os.path.join(config_dir, ".claude.json")) or {}).get("oauthAccount")
        with self.locked():
            return self._create(data, oauth_account, label)

    def remove(self, pid: str) -> None:
        with self.locked():
            info = self.get(pid)
            if info.get("account_uuid") == self.current_uuid():
                raise ProfileError("that account is in use; switch to another one first")
            shutil.rmtree(self._dir(pid))

    def save_current(self) -> str | None:
        """Copy the live credentials back into the active account's profile (Claude refreshes them
        while it runs). Only while no Claude runs. -> that profile's id, or None if none matches."""
        with self.locked():
            self._import_current()
            pid = self._by_uuid(self.current_uuid())
            if pid is None:
                return None
            with open(self.credentials, "rb") as f:
                data = f.read()
            check_credentials(data)
            write_private(os.path.join(self._dir(pid), "credentials.json"), data)
            return pid

    def install(self, pid: str) -> None:
        """Make `pid` Claude Code's login: its credentials file, and its oauthAccount in ~/.claude.json
        (the rest of that file is kept). Only while no Claude runs, or one could write the old one back.
        Both new files are built before either is written, so a problem leaves both as they were."""
        with self.locked():
            info = self.get(pid)
            with open(os.path.join(self._dir(pid), "credentials.json"), "rb") as f:
                data = f.read()
            check_credentials(data)
            try:
                with open(self.claude_json, "rb") as f:
                    raw = f.read()
                mode = os.stat(self.claude_json).st_mode & 0o777
            except FileNotFoundError:
                raw, mode = None, 0o600
            try:
                config = json.loads(raw) if raw is not None else {}
            except ValueError:
                config = None
            if not isinstance(config, dict):
                raise ProfileError(f"{self.claude_json} isn't a JSON object; not changing it")
            config["oauthAccount"] = info["oauth_account"]
            new_config = json.dumps(config, indent=2, ensure_ascii=False).encode()
            os.makedirs(self.claude_dir, mode=0o700, exist_ok=True)
            write_private(self.credentials, data)
            write_private(self.claude_json, new_config, mode)

    def matches_live(self, pid: str) -> bool:
        """Whether Claude's live credentials are the ones saved in `pid`'s profile (same tokens; the
        JSON is compared, not its spacing)."""
        try:
            with open(self.credentials, "rb") as f:
                live = json.loads(f.read())
            with open(os.path.join(self._dir(pid), "credentials.json"), "rb") as f:
                saved = json.loads(f.read())
        except (OSError, ValueError):
            return False
        return live == saved
