"""The live view: every entry Claude adds to the current conversation's transcript, as events
(message.user, message.assistant, tool.call, tool.result, file.diff), whoever started the turn:
Telegram, the app, or someone typing in tmux ("terminal").

One thread. It waits on inotify (the transcript folder and tmux-session.json) and reads only the
bytes added since its saved offset; it follows /clear and resumes to the new transcript, starting
at its end. All parsing of Claude Code's transcript format is in transcript.py and here.
"""
import difflib
import logging
import re
import threading

from .transcript import Tail, describe_tool
from .watch import Watch

log = logging.getLogger("edith.adapter.claude_tmux")

REF = re.compile(r"\n?\[tg-ref ([0-9a-f]+)\]")
MAX_DIFF = 20_000    # characters of a file.diff
MAX_TOOL_IDS = 1000  # tool_use id -> name, for naming results


def unified(path, old, new):
    lines = difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True),
                                 fromfile=f"a/{path}", tofile=f"b/{path}")
    return "".join(lines)[:MAX_DIFF]


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


class LiveView:
    def __init__(self, paths, session, publish, origin_of):
        """session() -> tmux-session.json as a dict; publish(type, origin, session_id, data);
        origin_of(run_id) -> "telegram" | "app" | None."""
        self.paths, self.session, self.publish, self.origin_of = paths, session, publish, origin_of
        self._tools: dict[str, str] = {}
        self.watch = None
        self.ready = threading.Event()  # set once it is watching: nothing written after that is missed
        self.following = None           # the transcript it reads now
        self.switched = threading.Condition()  # notified when `following` changes

    def run(self, stopping):
        with Watch(self.paths.state_dir, self.paths.transcripts) as self.watch:
            tail = Tail(self.session().get("transcript_path"))  # from the current end: no replay
            self._follow(tail.path)
            self.ready.set()
            while not stopping.is_set():
                session = self.session()
                current = session.get("transcript_path")
                if current != tail.path:
                    # A new conversation (/clear, a fresh start) is read from its start, so its first
                    # entries aren't missed; a resumed one from its end, so its history isn't replayed.
                    tail = Tail(current, offset=0 if session.get("source") in ("clear", "startup") else None)
                    self._follow(current)
                for entry, _ in tail.read():
                    try:
                        self.entry(entry)
                    except Exception:
                        log.exception("live view: could not read a transcript entry")
                self.watch.wait(60)  # wakes on any change; the timeout is only a safety net

    def _follow(self, path):
        with self.switched:
            self.following = path
            self.switched.notify_all()

    def entry(self, e):
        if e.get("isSidechain") or e.get("isMeta"):
            return
        sid = e.get("sessionId") or self.session().get("session_id")
        content = e.get("message", {}).get("content")
        if e.get("type") == "user":
            if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        summary = text_of(b.get("content")) if not isinstance(b.get("content"), str) else b["content"]
                        self.publish("tool.result", "system", sid, {
                            "name": self._tools.get(b.get("tool_use_id"), ""), "ok": not b.get("is_error"),
                            "summary": (summary or "").strip().split("\n", 1)[0][:200]})
                return
            text = text_of(content)
            if not text or text.lstrip().startswith("<"):
                return  # slash-command and system wrappers
            m = REF.search(text)
            origin = (self.origin_of(m.group(1)) if m else None) or ("telegram" if m else "terminal")
            self.publish("message.user", origin, sid, {"text": REF.sub("", text).strip(), "voice": "[voice]" in text})
        elif e.get("type") == "assistant" and isinstance(content, list):
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and b.get("text", "").strip():
                    self.publish("message.assistant", "system", sid, {"text": b["text"]})
                elif b.get("type") == "tool_use":
                    name, inp = b.get("name", ""), b.get("input") or {}
                    self._tools[b.get("id")] = name
                    if len(self._tools) > MAX_TOOL_IDS:
                        self._tools.pop(next(iter(self._tools)))
                    self.publish("tool.call", "system", sid, {"name": name, "summary": describe_tool(name, inp)})
                    if name in ("Edit", "MultiEdit", "Write") and inp.get("file_path"):
                        path = inp["file_path"]
                        if name == "Write":
                            diff = unified(path, "", inp.get("content", ""))
                        else:
                            edits = inp.get("edits") or [inp]
                            diff = "".join(unified(path, x.get("old_string", ""), x.get("new_string", "")) for x in edits)
                        self.publish("file.diff", "system", sid, {"path": path, "diff": diff[:MAX_DIFF]})
