"""The Telegram Bot API over HTTPS (stdlib urllib), with timeouts and retries.

Same call shape as the legacy bridge's tg(method, timeout=40, **params): None params are dropped,
the result (or None on failure) is returned, and failures are logged, never raised. Changes from
legacy: 429 waits for Telegram's retry_after, and 5xx or failed connections are retried with
backoff; a timeout after the request was sent is not retried, so a message is never sent twice.
The token is only ever part of the URL and is never logged.
"""
import json
import logging
import mimetypes
import os
import secrets
import shutil
import socket
import time
import urllib.error
import urllib.request

log = logging.getLogger("edith.adapter.telegram")

RETRIES = 3
MAX_RETRY_AFTER = 30  # seconds we are willing to wait for a 429


def read_token(telegram_dir):
    """$TELEGRAM_BOT_TOKEN, else TELEGRAM_BOT_TOKEN= in <telegram_dir>/.env (as legacy)."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if token:
        return token
    with open(os.path.join(telegram_dir, ".env")) as f:
        for line in f:
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("No TELEGRAM_BOT_TOKEN found")


def allowed_ids(telegram_dir):
    """Allowed sender ids from <telegram_dir>/access.json."""
    try:
        with open(os.path.join(telegram_dir, "access.json")) as f:
            return {str(x) for x in json.load(f).get("allowFrom", [])}
    except (OSError, ValueError):
        return set()


class BotApi:
    def __init__(self, token, sleep=time.sleep, server="https://api.telegram.org"):
        self._base = f"{server}/bot{token}/"
        self._files = f"{server}/file/bot{token}/"
        self._sleep = sleep

    def _post(self, method, data, headers, timeout, retries=RETRIES):
        """One request with up to `retries` retries. Returns the parsed body, or None after logging
        the failure."""
        for attempt in range(retries + 1):
            req = urllib.request.Request(self._base + method, data=data, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                body = e.read().decode(errors="replace")
                if e.code == 429 and attempt < retries:
                    try:
                        wait = json.loads(body).get("parameters", {}).get("retry_after", 1)
                    except ValueError:
                        wait = 1
                    self._sleep(min(MAX_RETRY_AFTER, wait))
                    continue
                if e.code >= 500 and attempt < retries:
                    self._sleep(2 ** attempt)
                    continue
                if "message is not modified" not in body:
                    log.warning("tg %s HTTP %s: %s", method, e.code, body[:200])
                if e.code == 409:
                    self._sleep(5)  # another poller is using this token
                return None
            except (TimeoutError, socket.timeout):
                log.warning("tg %s timed out", method)  # it may have arrived: don't send it twice
                return None
            except (urllib.error.URLError, ConnectionError) as e:
                if attempt < retries:  # never reached Telegram: safe to try again
                    self._sleep(2 ** attempt)
                    continue
                log.warning("tg %s error: %s", method, getattr(e, "reason", e))
                return None
            except ValueError:
                log.warning("tg %s: reply was not JSON", method)
                return None
        return None

    def __call__(self, method, timeout=40, **params):
        data = json.dumps({k: v for k, v in params.items() if v is not None}).encode()
        body = self._post(method, data, {"Content-Type": "application/json"}, timeout)
        return body.get("result") if body else None

    def once(self, method, timeout=40, **params):
        """Like a call, but a single attempt (no retries): for the startup calls, as legacy did them."""
        data = json.dumps({k: v for k, v in params.items() if v is not None}).encode()
        body = self._post(method, data, {"Content-Type": "application/json"}, timeout, retries=0)
        return body.get("result") if body else None

    def get_updates(self, offset, timeout=30):
        """Long poll, a single attempt. Returns the updates, or None on failure: the poll loop backs
        off and tries again, so retries never stack up during an outage."""
        data = json.dumps({"offset": offset, "timeout": timeout,
                           "allowed_updates": ["message", "callback_query"]}).encode()
        body = self._post("getUpdates", data, {"Content-Type": "application/json"}, timeout + 15, retries=0)
        return body.get("result", []) if body else None

    def send_file(self, chat_id, path, caption=None):
        boundary = secrets.token_hex(16)
        name = os.path.basename(path)
        is_photo = name.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
        field, method = ("photo", "sendPhoto") if is_photo else ("document", "sendDocument")
        with open(path, "rb") as f:
            content = f.read()
        parts = [f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}\r\n".encode()]
        if caption:
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{caption}\r\n".encode())
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{name}\"\r\n"
                     f"Content-Type: {ctype}\r\n\r\n".encode() + content + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        body = self._post(method, b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={boundary}"}, 120)
        return bool(body and body.get("ok"))

    def download(self, file_path, dest):
        """Save a file Arpit sent (from getFile's file_path), streamed, with a timeout."""
        try:
            with urllib.request.urlopen(self._files + file_path, timeout=60) as r, open(dest, "wb") as f:
                shutil.copyfileobj(r, f)
            return True
        except (OSError, urllib.error.URLError) as e:
            log.warning("download failed: %s", getattr(e, "reason", e))
            return False
