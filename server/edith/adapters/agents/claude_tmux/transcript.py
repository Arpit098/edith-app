"""Reading Claude Code's JSONL files (session transcripts, tmux-events.jsonl): only the bytes added
since a saved offset, never the whole file again. All parsing of Claude's formats lives here."""
import json
import os


def file_size(path):
    try:
        return os.path.getsize(path)
    except (OSError, TypeError):
        return 0


class Tail:
    """Complete JSON lines appended to a file since a saved byte offset. A partly written last
    line stays unread until its newline arrives."""

    def __init__(self, path=None, offset=None):
        self.path = path
        self.offset = file_size(path) if offset is None else offset

    def switch(self, path):
        """Follow another file from its start (e.g. after /clear or a resume)."""
        self.path, self.offset = path, 0

    def read(self):
        """[(object, raw line)] since the last read."""
        return [(obj, raw) for obj, raw, _ in self.read_spans()]

    def read_spans(self):
        """[(object, raw line, byte offset just after the line)] since the last read."""
        if not self.path:
            return []
        try:
            with open(self.path, "rb") as f:
                f.seek(self.offset)
                data = f.read()
        except OSError:
            return []
        out = [(obj, raw, end) for obj, raw, _, end in lines(data, self.offset)]
        self.offset += data.rfind(b"\n") + 1
        return out


def lines(data: bytes, base: int = 0):
    """[(object, raw line, start, end)] for the complete JSON lines in `data`, which starts at byte
    `base` of its file; start/end are file offsets (end is just after the newline)."""
    out, pos = [], 0
    while True:
        nl = data.find(b"\n", pos)
        if nl < 0:
            return out
        raw = data[pos:nl].decode(errors="replace")
        try:
            out.append((json.loads(raw), raw, base + pos, base + nl + 1))
        except ValueError:
            pass
        pos = nl + 1


def read_forward(path, offset, max_bytes):
    """(lines, end, more): the complete JSON lines from byte `offset`, reading about max_bytes (at
    least one whole line). `end` is the offset just after the last complete line read; `more` is
    True if complete lines may remain after it (the read stopped at max_bytes, not at the end)."""
    size = file_size(path)
    if offset >= size:
        return [], offset, False
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read(max_bytes)
        while b"\n" not in data and offset + len(data) < size:  # one line longer than max_bytes
            data += f.read(max_bytes)
    return lines(data, offset), offset + data.rfind(b"\n") + 1, offset + len(data) < size


def read_backward(path, before, max_bytes, chunk=64 * 1024):
    """The complete JSON lines that end at or before byte `before` (None: the end of the file),
    newest first, read from the end in chunks, so older lines are only read when asked for. A
    partly written last line is skipped (lines() needs its newline). Stops after about max_bytes."""
    end = file_size(path) if before is None else min(before, file_size(path))
    spent, carry = 0, b""
    with open(path, "rb") as f:
        while end > 0 and spent < max_bytes:
            start = max(0, end - chunk)
            f.seek(start)
            data = f.read(end - start) + carry
            spent += end - start
            cut = 0 if start == 0 else data.find(b"\n") + 1  # the first line may be cut: finish it next chunk
            if start and cut == 0:  # no newline in this chunk: a long line, read on
                carry, end = data, start
                continue
            carry, end = data[:cut], start
            yield from reversed(lines(data[cut:], start + cut))


def describe_tool(name, inp):
    if name == "Bash":
        return f"$ {inp.get('description') or inp.get('command', '')}"[:120]
    for key in ("file_path", "path", "pattern", "url", "query"):
        if key in inp:
            return f"{name}: {inp[key]}"[:120]
    return name


def tool_uses(entry):
    """Tool summaries in one transcript entry or stream-json event (type "assistant")."""
    content = entry.get("message", {}).get("content")
    if entry.get("type") != "assistant" or not isinstance(content, list):
        return []
    return [describe_tool(b.get("name", ""), b.get("input", {})) for b in content if b.get("type") == "tool_use"]
