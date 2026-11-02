"""Secrets out of free text shown to Arpit (contracts/status.md, "Redaction"): the status panel and
the claude_tmux adapter's subagent last steps both use it."""
import re

KEYWORD = (r"(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd"
           r"|api[_-]?key|bearer|basic)")
SECRET = re.compile(
    rf"(?i)(?:\b|(?<=[_-])){KEYWORD}\b[\s:=\"']+\S+"      # key=value, DB_PASSWORD=x, Bearer x, Basic x
    r"|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}"
    r"|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{30,}|\bya29\.[0-9A-Za-z_.-]{20,}"
    r"|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"                    # AWS access key id
    r"|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?"  # JWT, however short
    r"|\b\d{8,10}:[A-Za-z0-9_-]{30,}"            # Telegram bot token
    r"|\btk_[A-Za-z0-9]{20,}"                    # ntfy access token (the phone's and the publish one)
    r"|\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b")  # long mixed strings (also full git shas)
URL_CREDENTIALS = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@")  # scheme://user:pass@


def redact(text):
    if not isinstance(text, str):
        return text
    return SECRET.sub("[redacted]", URL_CREDENTIALS.sub(r"\1[redacted]@", text))
