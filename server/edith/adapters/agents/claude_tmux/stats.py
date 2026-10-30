"""A conversation's numbers for the status panel: when it started, how many messages, how much context.

Counted while tailing the transcript from a saved byte offset: the first call reads the file once,
later calls only the bytes added since. A few transcripts are kept (the current one, plus whichever
was asked for last); the oldest is forgotten.
"""
import collections
import threading

from .transcript import Tail


def _is_message(entry):
    """A user prompt or an assistant reply with text (not a tool call or a tool result)."""
    if entry.get("isMeta") or entry.get("isSidechain"):
        return False
    content = entry.get("message", {}).get("content")
    if entry.get("type") == "user":
        if isinstance(content, str):
            return not content.lstrip().startswith("<")  # <command-name>, <local-command-stdout>, …
        return isinstance(content, list) and any(
            isinstance(b, dict) and b.get("type") == "text" for b in content) and not any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
    return entry.get("type") == "assistant" and isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip() for b in content)


def _context(entry):
    """Tokens in context after an assistant entry (its prompt: input + cache reads and writes), or None."""
    usage = entry.get("message", {}).get("usage") if entry.get("type") == "assistant" else None
    if not isinstance(usage, dict) or entry.get("isSidechain"):
        return None
    return sum(int(usage.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens",
                                                 "cache_creation_input_tokens")) or None


class SessionStats:
    def __init__(self, entry_time, keep=4):
        self.entry_time, self.keep = entry_time, keep
        self._seen: collections.OrderedDict[str, dict] = collections.OrderedDict()
        self._lock = threading.Lock()

    def get(self, path):
        """{started, messages, context_tokens} for a transcript, counted up to its current end."""
        with self._lock:
            s = self._seen.pop(path, None) or {"tail": Tail(path, 0), "started": None, "messages": 0,
                                                "context_tokens": None}
            self._seen[path] = s
            while len(self._seen) > self.keep:
                self._seen.popitem(last=False)
            for entry, _ in s["tail"].read():
                if s["started"] is None:
                    s["started"] = self.entry_time(entry)
                s["messages"] += _is_message(entry)
                s["context_tokens"] = _context(entry) or s["context_tokens"]
            return {k: s[k] for k in ("started", "messages", "context_tokens")}
