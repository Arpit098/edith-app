"""Google credentials and services for one process.

- The token is read once, refreshed only when it has expired, and saved back atomically (0600).
  A long-running process keeps refreshing through the authorized HTTP client by itself.
- Each API service is built once and reused. Every request goes through an HTTP client with a
  timeout (see api.py for retries).

The module-level TOKEN / creds() / service() keep the legacy gauth.py API for the wrapper at
~/edith/google/gauth.py.
"""
import os
import tempfile
import threading

from edith.common.paths import resolve

HTTP_TIMEOUT = 30  # seconds per HTTP request


def save_private(path, data):
    """Write `data` to `path` atomically, readable by the owner only."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")  # created 0600
    try:
        with os.fdopen(fd, "w") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def _load_credentials(path):
    from google.oauth2.credentials import Credentials
    return Credentials.from_authorized_user_file(path)


def _refresh(creds):
    from google.auth.transport.requests import Request
    creds.refresh(Request())


def _build(name, version, creds):
    import google_auth_httplib2
    import httplib2
    from googleapiclient.discovery import build
    http = google_auth_httplib2.AuthorizedHttp(creds, http=httplib2.Http(timeout=HTTP_TIMEOUT))
    return build(name, version, http=http, cache_discovery=False, static_discovery=True)


class Session:
    """Credentials + services, built lazily on first use and shared by the mail and calendar ports.
    The three hooks (load, refresh, build) are the Google library calls; tests replace them."""

    def __init__(self, credentials_dir, load=_load_credentials, refresh=_refresh, build=_build):
        self.dir = credentials_dir
        self.token_path = os.path.join(credentials_dir, "token.json")
        self._load, self._refresh, self._build = load, refresh, build
        self._lock = threading.RLock()
        self._creds = None
        self._services = {}

    def credentials(self):
        with self._lock:
            if self._creds is None:
                self._creds = self._load(self.token_path)
            if not self._creds.valid:
                self._refresh(self._creds)
                save_private(self.token_path, self._creds.to_json())
            return self._creds

    def service(self, name, version):
        with self._lock:
            if (name, version) not in self._services:
                self._services[name, version] = self._build(name, version, self.credentials())
            return self._services[name, version]


# ---- The legacy gauth.py API (TOKEN, creds(), service()) for the wrapper ----

_default = None


def default_session():
    global _default
    folder = resolve().google_dir
    if _default is None or _default.dir != folder:
        _default = Session(folder)
    return _default


def creds():
    return default_session().credentials()


def service(name, version):
    return default_session().service(name, version)


def __getattr__(name):
    if name == "TOKEN":
        return default_session().token_path
    raise AttributeError(name)


__all__ = ["Session", "TOKEN", "creds", "default_session", "save_private", "service"]
