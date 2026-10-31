"""Notifications through edith's own ntfy (Phase 5; contracts/push.md), for the notifier port.

ntfy listens on the Tailscale IP only, deny-all; edith publishes with a write-only token read from a
mode-600 file (never logged). One JSON publish per notification, with a timeout; a refused or
unreachable server is retried with backoff (1 s, 2 s), a 4xx other than 429 is not.

    [adapter.ntfy]
    url = "http://100.78.124.98:2586"
    topic = "edith"
    token_file = "~/.config/edith/ntfy-publish-token"
    phone_token_file = "~/.config/edith/ntfy-phone-token"   # read-only; handed to the app (subscription())
"""
import hmac
import json
import logging
import os
import stat
import threading
import urllib.error
import urllib.request

log = logging.getLogger("edith.ntfy")

PRIORITY = {"min": 1, "low": 2, "default": 3, "high": 4}  # ntfy's 1..5


def read_token(path: str) -> str:
    st = os.stat(path)
    if st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise PermissionError(f"{path} must be readable by its owner only (chmod 600)")
    with open(path) as f:
        token = f.read().strip()
    if len(token) < 32:  # ntfy tokens are "tk_" + 29 characters
        raise ValueError(f"{path} must hold an ntfy access token")
    return token


class NtfyNotifier:
    name = "ntfy"

    def __init__(self, config: dict, timeout: float = 5.0, retries: int = 2, backoff: float = 1.0):
        self.url = config.get("url", "").rstrip("/")
        if not self.url:
            raise ValueError("[adapter.ntfy] needs url (edith's Tailscale IP and ntfy's port)")
        self.topic = config.get("topic", "edith")
        self.token_file = os.path.expanduser(config.get("token_file", "~/.config/edith/ntfy-publish-token"))
        self.phone_token_file = os.path.expanduser(config.get("phone_token_file", "~/.config/edith/ntfy-phone-token"))
        self.timeout, self.retries, self.backoff = timeout, retries, backoff
        self._token = None
        self._stop = threading.Event()  # set by close(): a retry wait ends at once

    def notify(self, title: str, body: str, priority: str = "default", data: dict | None = None) -> bool:
        """Publish one message; `data` (contracts/push.md) goes as the message, for the app to read."""
        if self._token is None:
            try:
                self._token = read_token(self.token_file)
            except (OSError, ValueError) as e:
                log.error("ntfy token unusable: %s", e)
                return False
        payload = {"topic": self.topic, "title": title, "priority": PRIORITY.get(priority, 3),
                   "message": json.dumps(data, ensure_ascii=False, separators=(",", ":")) if data else body}
        raw = json.dumps(payload, ensure_ascii=False).encode()
        delay = self.backoff
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(self.url, data=raw, method="POST", headers={
                "Content-Type": "application/json", "Authorization": f"Bearer {self._token}"})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    resp.read()
                return True
            except urllib.error.HTTPError as e:
                if e.code != 429 and 400 <= e.code < 500:
                    log.error("ntfy refused the message: %d", e.code)  # bad token or topic: retrying won't help
                    return False
                reason = f"answered {e.code}"
            except (OSError, urllib.error.URLError) as e:
                reason = f"unreachable ({getattr(e, 'reason', e)})"
            if attempt < self.retries:
                log.warning("ntfy %s; retry %d in %.0f s", reason, attempt + 1, delay)
                if self._stop.wait(delay):
                    break
                delay *= 2
        log.error("ntfy %s; message dropped", reason)
        return False

    def subscription(self) -> dict:
        """What the phone subscribes with (contracts/push.md, GET /v1/push/config): this server's url and
        topic and the phone's read-only token, read fresh (it is asked for once, when push is turned
        on). Raises ValueError, without the token in the message, when the phone token file is
        unusable or holds the publish token: that one is never handed out."""
        try:
            token = read_token(self.phone_token_file)
        except (OSError, ValueError) as e:
            raise ValueError(f"phone token unusable: {e}") from None
        if os.path.realpath(self.phone_token_file) == os.path.realpath(self.token_file):
            raise ValueError("phone_token_file is the publish token file")
        try:
            publish = read_token(self.token_file)
        except (OSError, ValueError):
            publish = None
        if publish is not None and hmac.compare_digest(token, publish):
            raise ValueError(f"{self.phone_token_file} holds the publish token")
        return {"url": self.url, "topic": self.topic, "token": token}

    def close(self) -> None:
        self._stop.set()


def create(config: dict):
    return NtfyNotifier(config)
