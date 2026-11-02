"""The filter on everything the backup sends out (contracts/backup.md, "Privacy"): the prompt, the
history, every tool result and every web query. Both free providers may train on what they get, so
this errs on the side of dropping text.

On top of common/redact.py (key=value secrets, Bearer, known key prefixes, JWTs, bot tokens, long
mixed strings, user:pass@ in URLs) it removes:
- PEM blocks ("-----BEGIN … KEY-----" to its END, or to the end of the text when cut off) and PuTTY keys;
- NAME=value lines whose name ends in KEY, TOKEN, SECRET, PASSWORD, PASS, PWD, CREDENTIAL(S), AUTH,
  COOKIE or SESSION (.env style), and key=/sig=/signature=/code= query values in URLs;
- more key shapes: NVIDIA nvapi-, Slack/Stripe/Google OAuth/GitLab/npm/PyPI/HF/Anthropic prefixes, AWS
  secret keys, long hex and base64 runs, and any high-entropy word of 24+ characters;
- paths into ~/.config, ~/.claude, ~/.ssh, ~/.gnupg, ~/.aws and the like, written with ~, $HOME or
  /home/<user>: replaced by [blocked path].
"""
import math
import re

from edith.common.redact import redact as base_redact

R = "[redacted]"
PEM = re.compile(r"-----BEGIN [A-Z0-9 ]*-----.*?(?:-----END [A-Z0-9 ]*-----|\Z)", re.S)
PUTTY = re.compile(r"PuTTY-User-Key-File-\d.*?(?:Private-MAC:\s*\S+|\Z)", re.S)
ENV_LINE = re.compile(
    r"(?im)^(\s*(?:export\s+)?[A-Z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH|COOKIE|SESSION"
    r"|PRIVATE)[A-Z0-9_]*\s*[=:]\s*)(\S.*)$")
QUERY = re.compile(r"(?i)([?&;](?:key|api_?key|sig|signature|code|auth|access_token|token|secret|password|pass)=)[^&#\s]+")
SHAPES = re.compile(
    r"\bnvapi-[A-Za-z0-9_-]{20,}"
    r"|\bsk-ant-[A-Za-z0-9_-]{10,}"
    r"|\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}"
    r"|\bxapp-[A-Za-z0-9-]{10,}"
    r"|\bglpat-[A-Za-z0-9_-]{16,}"
    r"|\bnpm_[A-Za-z0-9]{30,}"
    r"|\bpypi-[A-Za-z0-9_-]{30,}"
    r"|\bhf_[A-Za-z0-9]{30,}"
    r"|\bGOCSPX-[A-Za-z0-9_-]{10,}"
    r"|\b1//[A-Za-z0-9_-]{20,}"                      # Google refresh token
    r"|\b[0-9a-fA-F]{32,}\b"                         # long hex (keys, hashes)
    r"|(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}"   # long base64 runs
)
WORD = re.compile(r"[A-Za-z0-9_+/=.-]{24,}")
HOME_SECRET_DIRS = r"\.(?:config|claude|ssh|gnupg|aws|kube|docker|netrc|git-credentials|npmrc|pypirc|password-store|local/share/keyrings)"
PATHS = re.compile(rf"(?:~|\$HOME|\$\{{HOME\}}|/home/[A-Za-z0-9._-]+|/root)/{HOME_SECRET_DIRS}(?:/[^\s'\"`)\]]*)?")


def entropy(s: str) -> float:
    counts = {}
    for c in s:
        counts[c] = counts.get(c, 0) + 1
    return -sum(n / len(s) * math.log2(n / len(s)) for n in counts.values())


def _random_word(m):
    w = m.group(0)
    if "/" in w and w.count("/") > 2 or w.count(".") > 2 or w.count("-") > 3 or w.count("_") > 3:
        return w  # a path, a dotted name or a long_identifier_like_this: not a secret
    classes = sum(bool(re.search(p, w)) for p in (r"[a-z]", r"[A-Z]", r"\d"))
    return R if classes >= 2 and entropy(w) >= 4.0 else w


def scrub(text):
    """`text` with anything that looks like a secret or a secret path removed. Non-strings come back as they are."""
    if not isinstance(text, str) or not text:
        return text
    text = PEM.sub("[redacted key]", text)
    text = PUTTY.sub("[redacted key]", text)
    text = PATHS.sub("[blocked path]", text)
    text = ENV_LINE.sub(lambda m: m.group(1) + R, text)
    text = QUERY.sub(lambda m: m.group(1) + R, text)
    text = SHAPES.sub(R, text)
    text = base_redact(text)
    return WORD.sub(_random_word, text)


def scrub_messages(messages: list[dict]) -> list[dict]:
    """A copy of chat messages (OpenAI shapes) with every text and tool-call argument scrubbed."""
    out = []
    for m in messages:
        m = dict(m)
        if isinstance(m.get("content"), str):
            m["content"] = scrub(m["content"])
        if m.get("tool_calls"):
            m["tool_calls"] = [{**c, "function": {**c["function"], "arguments": scrub(c["function"]["arguments"])}}
                               for c in m["tool_calls"]]
        out.append(m)
    return out
