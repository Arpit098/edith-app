"""Text helpers shared by frontends and features."""
import os
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


FENCE = re.compile(r"^\s{0,3}(```|~~~)")


REACT_TAIL = re.compile(r"\s+REACT:\s*(\S+)\s*$")


def unquote(path: str) -> str:
    """A path without the backticks or quotes EDITH may put around it."""
    path = path.strip()
    while len(path) >= 2 and path[0] == path[-1] and path[0] in "`'\"":
        path = path[1:-1].strip()
    return path


def take_directives(text: str, key: str, whole_line: bool = False) -> tuple[list[str], str]:
    """Pull out "KEY: value" lines (e.g. SEND_FILE, REACT) that EDITH adds for the frontends.
    Returns (values, text without those lines). Lines inside fenced code blocks (``` or ~~~) are
    examples, never directives: they stay in the text. `value` is one word, or with `whole_line`
    the rest of the line (a path with spaces). Blank lines next to a removed line go with it."""
    value = r"(.*\S)" if whole_line else r"(\S+)"
    line_re = re.compile(rf"^\s*{re.escape(key)}:\s*{value}\s*$")
    lines, values, keep, fenced, dropped = (text or "").split("\n"), [], [], False, False
    for line in lines:
        if FENCE.match(line):
            fenced = not fenced
        found = None if fenced else line_re.match(line)
        if found:
            value, react = found.group(1), None
            if whole_line:
                # "SEND_FILE: `/a b.pdf` REACT: 🎉": the path without quotes, the reaction kept as its own line.
                tail = REACT_TAIL.search(value)
                if tail:
                    value, react = value[:tail.start()], f"REACT: {tail.group(1)}"
                value = unquote(value)
            if value:
                values.append(value)
            while keep and not keep[-1].strip():
                keep.pop()  # blank lines before it
            dropped = True
            if react:
                keep.append(react)
                dropped = False
            continue
        if dropped and not line.strip():
            continue  # blank lines after it
        dropped = False
        keep.append(line)
    return values, "\n".join(keep).strip()


def take_files(text: str) -> tuple[list[str], str]:
    """SEND_FILE lines: each one's path is the rest of its line (spaces allowed)."""
    return take_directives(text, "SEND_FILE", whole_line=True)


def file_only_text(files: list[str]) -> str:
    """What a reply that is only SEND_FILE lines says, so older apps never show an empty bubble."""
    return "\n".join(f"📎 {os.path.basename(p.rstrip('/')) or p}" for p in files)


def voice_summary(text: str) -> str:
    """The first paragraph of a reply: what the app speaks aloud in voice mode."""
    return (text or "").strip().split("\n\n", 1)[0].strip()


HEADER = re.compile(r"^\[(?:App|Telegram) message from Arpit[^\]\n]*\]( \[voice\])?[ \t]*(?:\n|$)")
TG_REF = re.compile(r"\n?\[tg-ref [0-9a-f]+\]")
ATTACHED = re.compile(r"^\[Attached file saved at: (.+)\]$", re.M)
ATTACHED_NOTE = re.compile(r"^\[Attached file note: [^\n]*\]$", re.M)
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
    text = ATTACHED_NOTE.sub("", ATTACHED.sub("", text))
    quoted = REPLYING.search(text)
    text = REPLYING.sub("", text)
    return {"text": text.strip(), "voice": voice, "attachments": attachments,
            "replying_to": quoted.group(1) if quoted else None}


QUOTE_MAX = 300  # characters of a replied-to message that go in the prompt (app/…/live-session/reply.ts QUOTE_MAX)


def reply_line(replying_to) -> str:
    """The prompt line for the message Arpit replies to (the app's swipe to reply), as Telegram's
    replies have it: "\n[Arpit is replying to EDITH's message: <quote>]", the quote on one line and
    at most QUOTE_MAX characters; "" without one. clean_prompt takes it out again as `replying_to`.
    A "]" in the quote becomes "］", so the quote can never close the bracket early; lone surrogates
    (malformed JSON text) become "?".
    `replying_to` is {text, from: "edith" | "arpit"} or None; anything else is a ValueError."""
    if replying_to is None:
        return ""
    if not isinstance(replying_to, dict) or not isinstance(replying_to.get("text"), str):
        raise ValueError("replying_to must be {text, from}")
    text = replying_to["text"].encode("utf-8", "replace").decode("utf-8")
    quote = " ".join(text.replace("]", "］").split())
    if not quote:
        return ""
    if len(quote) > QUOTE_MAX:
        quote = quote[:QUOTE_MAX - 1].rstrip() + "…"
    who = "EDITH's" if replying_to.get("from") == "edith" else "an earlier"
    return f"\n[Arpit is replying to {who} message: {quote}]"


def reply_parts(reply: str) -> dict:
    """A reply -> {text without REACT:/SEND_FILE: lines (for a reply of only SEND_FILE lines, "📎 <name>"
    per file), files, reaction (the last REACT: pick or None)}."""
    files, text = take_files(reply or "")
    picks, text = take_directives(text, "REACT")
    return {"text": text or file_only_text(files), "files": files, "reaction": picks[-1] if picks else None}


# What an attached document is, for files Claude can't open with its Read tool as they are (PDF,
# text and images it reads directly): said in the prompt so it knows how to get at the text.
DOCUMENT_NOTES = {
    ".docx": "a Word document (a zip of XML: the text is in word/document.xml)",
    ".xlsx": "an Excel workbook (a zip of XML: sheets in xl/worksheets/, their text in xl/sharedStrings.xml)",
    ".pptx": "a PowerPoint deck (a zip of XML: slides in ppt/slides/)",
    ".doc": "a Word 97-2003 document (binary OLE format)",
    ".xls": "an Excel 97-2003 workbook (binary OLE format)",
    ".ppt": "a PowerPoint 97-2003 deck (binary OLE format)",
    ".zip": "a zip archive",
}


def attachment_lines(paths) -> str:
    """The prompt lines for attached files, the Telegram format: "\n[Attached file saved at: <path>]"
    each, followed for documents by "\n[Attached file note: <name> is a Word document (…)]".
    clean_prompt takes both out again (the paths go in `attachments`)."""
    out = ""
    for path in paths:
        out += f"\n[Attached file saved at: {path}]"
        note = DOCUMENT_NOTES.get(os.path.splitext(path)[1].lower())
        if note:
            out += f"\n[Attached file note: {os.path.basename(path)} is {note}]"
    return out
