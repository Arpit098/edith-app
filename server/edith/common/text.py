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
