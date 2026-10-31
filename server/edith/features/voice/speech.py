"""What the app says aloud for a voice turn (PLAN.md §4.7): a short, TTS-friendly line, not the reply.

EDITH's voice rule (output_style.md) asks for a 1-2 sentence spoken summary first, then the details. This
takes that first paragraph and makes it speakable: no code, markdown, links, emoji or frontend directives,
at most MAX_SENTENCES sentences and about MAX_CHARS characters. If EDITH opened with code or a list
anyway, the first paragraph that has words in it is used.
"""
import re
import unicodedata

from edith.common.text import take_directives

MAX_SENTENCES = 2
MAX_CHARS = 300

FENCE = re.compile(r"```.*?(```|\Z)", re.S)
LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
URL = re.compile(r"https?://\S+")
INLINE_CODE = re.compile(r"`([^`]*)`")
EMPHASIS = re.compile(r"(\*\*|__|\*|~~)(?=\S)(.+?)(?<=\S)\1")
LINE_MARK = re.compile(r"^\s*(#{1,6}\s+|>\s*|[-*+•]\s+|\d+[.)]\s+)")
TABLE_RULE = re.compile(r"^\s*\|?[\s:|-]+\|[\s:|-]*$")
SENTENCE_END = re.compile(r"(?<=[.!?।])\s+")
ENDS_SENTENCE = (".", "!", "?", "।", ":", ";")

FAILED = {
    "not_ready": "Claude isn't ready yet. Try again in a moment.",
    "queue_full": "Too many messages are waiting. Try again in a bit.",
    "crashed": "That task crashed.",
}


def _speakable(ch: str) -> bool:
    """Drop emoji and other symbols TTS would read out by name (✅ → "check mark button")."""
    return unicodedata.category(ch) not in ("So", "Sk", "Cs", "Co") and ch not in "‍️︎"


def clean(paragraph: str) -> str:
    """One paragraph of markdown as plain spoken text: lines joined into sentences."""
    lines = []
    for line in paragraph.splitlines():
        if TABLE_RULE.match(line):
            continue
        line = LINE_MARK.sub("", line)
        line = LINK.sub(r"\1", line)
        line = URL.sub("a link", line)
        line = INLINE_CODE.sub(r"\1", line)
        line = EMPHASIS.sub(r"\2", line)
        line = "".join(ch for ch in line.replace("|", " ") if _speakable(ch))
        line = " ".join(line.split())
        if line:
            lines.append(line if line.endswith(ENDS_SENTENCE) else line + ".")  # list items become sentences
    return " ".join(lines)


def shorten(text: str) -> str:
    """At most MAX_SENTENCES sentences, then cut to about MAX_CHARS at a word."""
    text = " ".join(SENTENCE_END.split(text)[:MAX_SENTENCES])
    if len(text) <= MAX_CHARS:
        return text
    cut = text[:MAX_CHARS].rsplit(" ", 1)[0].rstrip(",;:-")
    return cut + "…"


def spoken_summary(reply: str) -> str:
    """The line to speak for a finished turn's reply ("" if nothing in it is speakable)."""
    text = reply or ""
    for key in ("SEND_FILE", "REACT"):
        text = take_directives(text, key)[1]
    text = FENCE.sub("\n\n", text)
    for paragraph in re.split(r"\n\s*\n", text):
        spoken = clean(paragraph)
        if any(ch.isalnum() for ch in spoken):
            return shorten(spoken)
    return ""


def speak_for(kind: str, data: dict) -> tuple[str, str] | None:
    """(outcome, line to speak) for a voice turn's event, or None if it says nothing aloud."""
    if kind == "turn.done":
        return "done", spoken_summary(data.get("text", "")) or "Done."
    if kind == "turn.failed":
        return "failed", FAILED.get(data.get("reason"), "Something went wrong with that task.")
    if kind == "turn.stopped":
        return "stopped", "Stopped."
    if kind == "turn.queued" and data.get("fold"):  # the running task reads it before it answers
        return "queued", "Got it. I'll read that before I answer."
    if kind == "turn.queued":
        return "queued", f"Queued. You're number {data.get('position', 1)}."
    return None
