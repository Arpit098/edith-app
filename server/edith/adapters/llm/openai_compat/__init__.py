"""The backup AI's chat models (ports/llm.py) through their OpenAI-compatible chat-completions APIs:
NVIDIA Nemotron (build.nvidia.com), Gemini Flash (Google AI Studio) and Mistral (on hold).

Keys live in files, one per provider, mode 600 (default ~/.config/edith/<name>-key: nvidia-key,
gemini-key, mistral-key). A missing key file, or one others can read, switches that provider off.
The key is read when a call is made (so adding one needs no restart), sent only in the
Authorization header, and never logged, printed or put in an error.

    [adapters]
    llm = "openai_compat"

    [adapter.openai_compat]
    order = ["nemotron", "gemini", "mistral"]   # the default
    key_dir = "~/.config/edith"                 # the default
    [adapter.openai_compat.providers.gemini]    # optional overrides of the defaults below
    model = "gemini-flash-latest"

stdlib only (urllib): one POST per call, with the caller's timeout. Retries and skipping are the
backup feature's job (contracts/backup.md, "Providers").
"""
import datetime as dt
import email.utils
import json
import logging
import os
import re
import stat
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

from edith.common.redact import redact
from edith.ports.llm import ChatReply, ProviderError, ToolCall

log = logging.getLogger("edith.adapter.openai_compat")

DEFAULTS = {
    "nemotron": {"label": "Nemotron", "base_url": "https://integrate.api.nvidia.com/v1",
                 "model": "nvidia/nemotron-3-super-120b-a12b", "key_file": "nvidia-key",
                 "daily_reset_tz": "UTC", "params": {"temperature": 0.6, "top_p": 0.95, "max_tokens": 4096}},
    "gemini": {"label": "Gemini", "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
               "model": "gemini-flash-latest", "key_file": "gemini-key",
               "daily_reset_tz": "America/Los_Angeles", "params": {"max_tokens": 4096}},
    "mistral": {"label": "Mistral", "base_url": "https://api.mistral.ai/v1", "model": "mistral-medium-latest",
                "key_file": "mistral-key", "daily_reset_tz": "UTC", "params": {"max_tokens": 4096}},
}
ORDER = ("nemotron", "gemini", "mistral")
MAX_ANSWER = 2 * 1024 * 1024  # bytes read from one answer
THINK = re.compile(r"<think>.*?</think>\s*", re.S)  # a reasoning model's thoughts in its content
DAILY = re.compile(r"per ?day|daily|PerDay", re.I)
RETRY_DELAY = re.compile(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"')


def retry_after(header: str | None, body: str, now: float) -> float | None:
    """Seconds to wait from a 429: the Retry-After header (seconds or an HTTP date), else Gemini's
    retryDelay in the body; None if neither says."""
    if header:
        header = header.strip()
        if re.fullmatch(r"\d+(?:\.\d+)?", header):
            return float(header)
        try:
            return max(0.0, email.utils.parsedate_to_datetime(header).timestamp() - now)
        except (TypeError, ValueError):
            pass
    m = RETRY_DELAY.search(body or "")
    return float(m.group(1)) if m else None


def short(body: str) -> str:
    """The provider's own error message, short and redacted."""
    try:
        err = json.loads(body)
        err = err[0] if isinstance(err, list) and err else err
        msg = err.get("error", err) if isinstance(err, dict) else err
        msg = msg.get("message") or msg.get("detail") or json.dumps(msg) if isinstance(msg, dict) else str(msg)
    except ValueError:
        msg = body
    return redact(" ".join(str(msg).split()))[:200]


class Provider:
    def __init__(self, name: str, settings: dict, key_dir: str, opener=None, clock=None):
        self.name = name
        self.label = settings.get("label") or name.title()
        self.base_url = settings["base_url"].rstrip("/")
        self.model = settings["model"]
        self.params = dict(settings.get("params") or {})
        self.reset_tz = settings.get("daily_reset_tz") or "UTC"
        key = settings.get("key_file") or f"{name}-key"
        self.key_file = os.path.join(key_dir, key) if not os.path.isabs(os.path.expanduser(key)) else os.path.expanduser(key)
        self._open = opener or urllib.request.urlopen
        self._warned = set()

    def _warn_once(self, what):
        if what not in self._warned:
            self._warned.add(what)
            log.warning("%s: %s", self.name, what)

    def _key(self) -> str | None:
        try:
            st = os.stat(self.key_file)
        except OSError:
            return None
        if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077:
            self._warn_once(f"key file {self.key_file} must be a file of mode 600; provider off")
            return None
        try:
            with open(self.key_file) as f:
                key = f.read().strip()
        except OSError:
            return None
        return key or None

    def available(self) -> bool:
        return self._key() is not None

    def daily_reset(self, now: float) -> float:
        zone = ZoneInfo(self.reset_tz)
        t = dt.datetime.fromtimestamp(now, zone)
        return (t.replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(days=1)).timestamp()

    def chat(self, messages, tools, timeout):
        key = self._key()
        if key is None:
            raise ProviderError("auth", "no key file")
        body = {"model": self.model, "messages": messages, **self.params}
        if tools:
            body["tools"], body["tool_choice"] = tools, "auto"
        req = urllib.request.Request(f"{self.base_url}/chat/completions", data=json.dumps(body).encode(),
                                     method="POST", headers={"Content-Type": "application/json",
                                                             "Accept": "application/json",
                                                             "Authorization": f"Bearer {key}"})
        del key
        try:
            with self._open(req, timeout=timeout) as r:
                raw = r.read(MAX_ANSWER)
        except urllib.error.HTTPError as e:
            try:
                text = e.read(65536).decode("utf-8", "replace")
            except Exception:
                text = ""
            if e.code == 429:
                raise ProviderError("rate_limit", short(text), 429, retry_after(e.headers.get("Retry-After"), text,
                                                                              time.time()),
                                    daily=bool(DAILY.search(text))) from None
            if e.code in (401, 403):
                raise ProviderError("auth", short(text), e.code) from None
            if e.code >= 500 or e.code == 408:
                raise ProviderError("down", short(text) or f"HTTP {e.code}", e.code) from None
            raise ProviderError("bad_request", short(text) or f"HTTP {e.code}", e.code) from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise ProviderError("down", type(getattr(e, "reason", e)).__name__) from None
        try:
            answer = json.loads(raw)
            msg = answer["choices"][0]["message"]
        except (ValueError, KeyError, IndexError, TypeError):
            raise ProviderError("down", "an answer that couldn't be read") from None
        calls = []
        for c in msg.get("tool_calls") or []:
            fn = c.get("function") or {}
            args = fn.get("arguments")
            calls.append(ToolCall(str(c.get("id") or f"call_{len(calls)}"), str(fn.get("name") or ""),
                                  args if isinstance(args, str) else json.dumps(args or {})))
        text = msg.get("content")
        if isinstance(text, list):  # some providers answer with content parts
            text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
        text = THINK.sub("", text).strip() if isinstance(text, str) else None
        return ChatReply(text or None, calls)


class Models:
    def __init__(self, providers):
        self.providers = providers


def create(config: dict):
    key_dir = os.path.expanduser(config.get("key_dir", "~/.config/edith"))
    overrides = config.get("providers") or {}
    providers = []
    for name in config.get("order", ORDER):
        settings = {**DEFAULTS.get(name, {}), **(overrides.get(name) or {})}
        if not settings.get("base_url") or not settings.get("model"):
            log.warning("provider %s has no base_url or model; skipped", name)
            continue
        if settings.get("enabled", True):
            providers.append(Provider(name, settings, key_dir))
    return Models(providers)
