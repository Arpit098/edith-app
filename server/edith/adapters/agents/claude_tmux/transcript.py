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
        if not self.path:
            return []
        try:
            with open(self.path, "rb") as f:
                f.seek(self.offset)
                data = f.read()
        except OSError:
            return []
        end = data.rfind(b"\n") + 1
        self.offset += end
        out = []
        for raw in data[:end].decode(errors="replace").splitlines():
            try:
                out.append((json.loads(raw), raw))
            except ValueError:
                pass
        return out


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
