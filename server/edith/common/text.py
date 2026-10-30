"""Text helpers shared by frontends and features."""
import re


def chunk(text: str, size: int) -> list[str]:
    """Split text into pieces of at most `size` characters, preferring line breaks."""
    out, rest = [], text or ""
    while len(rest) > size:
        cut = rest.rfind("\n", 0, size)
        cut = cut if cut > size // 2 else size
        out.append(rest[:cut])
        rest = rest[cut:].lstrip("\n")
    return out + [rest] if rest or not out else out


def take_directives(text: str, key: str) -> tuple[list[str], str]:
    """Pull out "KEY: value" lines (e.g. SEND_FILE, REACT) that EDITH adds for the frontends.
    Returns (values, text without those lines)."""
    pattern = re.compile(rf"^\s*{re.escape(key)}:\s*(\S+)\s*$\n?", re.M)
    return pattern.findall(text), pattern.sub("", text).strip()


def voice_summary(text: str) -> str:
    """The first paragraph of a reply: what the app speaks aloud in voice mode."""
    return (text or "").strip().split("\n\n", 1)[0].strip()


HEADER = re.compile(r"^\[(?:App|Telegram) message from Arpit[^\]\n]*\]( \[voice\])?[ \t]*(?:\n|$)")
TG_REF = re.compile(r"\n?\[tg-ref [0-9a-f]+\]")
ATTACHED = re.compile(r"^\[Attached file saved at: (.+)\]$", re.M)
REPLYING = re.compile(r"^\[Arpit is replying to (?:EDITH's|an earlier) message: ([\s\S]*?)\]$", re.M)
NOTES = "[While you were busy, parallel lanes (forks of this conversation) handled these."
HEADER_LINE = re.compile(r"^\[(?:App|Telegram) message from Arpit", re.M)
PASTED = re.compile(r"<pasted_content[^>]*>\n?([\s\S]*?)\n?</pasted_content>")


def clean_prompt(prompt: str) -> dict:
    """A message as a frontend built it (or as the transcript holds it) -> what Arpit wrote:
    {text, voice, attachments, replying_to}, without the bridge's header, [voice], [tg-ref …], the
    parallel-lanes notes, the attachment and "replying to" lines (contracts/events.md, "Messages")."""
    text = PASTED.sub(lambda m: m.group(1), prompt or "").strip()
    if text.startswith(NOTES):  # the side-lane notes the main lane gets first; the message follows its header
        header = HEADER_LINE.search(text)
        text = text[header.start():] if header else ""
    m = HEADER.match(text)
    voice = bool(m and m.group(1)) or "[voice]" in (text.split("\n", 1)[0] if not m else "")
    if m:
        text = text[m.end():]
    text = TG_REF.sub("", text)
    attachments = ATTACHED.findall(text)
    text = ATTACHED.sub("", text)
    quoted = REPLYING.search(text)
    text = REPLYING.sub("", text)
    return {"text": text.strip(), "voice": voice, "attachments": attachments,
            "replying_to": quoted.group(1) if quoted else None}


def reply_parts(reply: str) -> dict:
    """A reply -> {text without REACT:/SEND_FILE: lines, files, reaction (the last REACT: pick or None)}."""
    files, text = take_directives(reply or "", "SEND_FILE")
    picks, text = take_directives(text, "REACT")
    return {"text": text, "files": files, "reaction": picks[-1] if picks else None}
