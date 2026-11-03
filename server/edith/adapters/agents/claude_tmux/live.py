"""The live view: every entry Claude adds to the current conversation's transcript, as events
(message.user, message.assistant, tool.call, tool.result, file.diff), whoever started the turn:
Telegram, the app, or someone typing in tmux ("terminal"). Each event's data carries a `cursor`,
"<session id>:<byte offset just after its entry>", so the app can join it up with history().

One thread. It waits on inotify (the transcript folder and tmux-session.json) and reads only the
bytes added since its saved offset; it follows /clear and resumes to the new transcript, starting
at its end. All parsing of Claude Code's transcript format is in transcript.py, background.py and here.

It also keeps the conversation's background work (background.py): the jobs are seeded from the
transcript's last SEED_BYTES at start (a bridge restart doesn't forget a running job), kept up to
date entry by entry, and published as `background.changed` whenever they change. Claude's own
session file has the last word: once it says `idle` after a job started, that job is over (its end
notification was missed, or Claude restarted).

The conversation's subagents (subagents.py: every Agent call, foreground or background, with its
state) are kept the same way, published as `subagents.changed`; a running one Claude's session file
contradicts is marked stopped. A switch to another conversation starts both lists afresh (a resumed
one is seeded from its own transcript).
"""
import datetime as dt
import difflib
import json
import logging
import os
import re
import threading
import time

from edith.common.claude_sessions import by_session_id
from edith.common.text import HEADER_LINE, clean_prompt, reply_parts, take_files
from edith.common.usertime import localize_limit_text

from .background import Background
from .subagents import Subagents, last_activity
from .transcript import Tail, describe_tool, read_backward, read_forward
from .watch import Watch

log = logging.getLogger("edith.adapter.claude_tmux")

REF = re.compile(r"\n?\[tg-ref ([0-9a-f]+)\]")
MAX_DIFF = 20_000    # characters of a file.diff
MAX_TOOL_IDS = 1000  # tool_use id -> name, for naming results
HISTORY_BYTES = 4 * 1024 * 1024  # read per history() call at most (a few huge tool results can't stall it)
SEED_BYTES = 2 * 1024 * 1024  # of the transcript's end, read once at start for background jobs still running
# While background jobs run, the session file is checked at most every BG_CHECK seconds, and the
# wait wakes at least that often: Claude's session folder isn't watched (it changes on every turn).
BG_CHECK = 15.0


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
    def __init__(self, paths, session, publish, origin_of, known=lambda rid: False, typed_echo=lambda text: False):
        """session() -> tmux-session.json as a dict; publish(type, origin, session_id, data);
        origin_of(run_id) -> "telegram" | "app" | None; known(run_id): the message was accepted from a
        frontend, so its message.user is already out; typed_echo(text): a bare "/…" entry is the echo
        of a slash command the bridge typed for a frontend (shown there already, not as Terminal)."""
        self.paths, self.session, self.publish, self.origin_of, self.known = paths, session, publish, origin_of, known
        self.typed_echo = typed_echo
        self._tools: dict[str, str] = {}
        self.watch = None
        self.ready = threading.Event()  # set once it is watching: nothing written after that is missed
        self.following = None           # the transcript it reads now
        self.switched = threading.Condition()  # notified when `following` changes
        self.claude_dir = os.path.join(paths.home, ".claude")
        self._bg, self._bg_lock, self._bg_checked = Background(), threading.Lock(), 0.0
        # background.changed goes out in the order the jobs changed: `_bg_seq` counts changes (under
        # _bg_lock); a publish snapshots the jobs inside `_bg_pub` and skips one already sent.
        # Re-entrant: a subscriber may ask background() on the same thread.
        self._bg_seq, self._bg_sent, self._bg_pub = 0, 0, threading.RLock()
        # The subagents, under the same locks, with their own change count for subagents.changed.
        self._sa, self._sa_seq, self._sa_sent = Subagents(), 0, 0
        self.now = time.time  # the wall clock (unix seconds), for the subagents' retention; tests set it
        self._last: dict[str, tuple] = {}   # subagent transcript path -> ((size, mtime), last line)
        self._meta: dict[str, str] = {}     # tool_use id -> agentId, from subagents/*.meta.json
        self._meta_seen: set[str] = set()   # meta files read already
        self._files_lock = threading.Lock()  # for the three above: status requests run on their own threads

    def run(self, stopping):
        with Watch(self.paths.state_dir, self.paths.transcripts) as self.watch:
            tail = Tail(self.session().get("transcript_path"))  # from the current end: no replay
            self._seed(tail.path)
            self._follow(tail.path)
            self.ready.set()
            while not stopping.is_set():
                session = self.session()
                current = session.get("transcript_path")
                if current != tail.path:
                    # A new conversation (/clear, a fresh start) is read from its start, so its first
                    # entries aren't missed; a resumed one from its end, so its history isn't replayed.
                    fresh = session.get("source") in ("clear", "startup")
                    tail = Tail(current, offset=0 if fresh else None)
                    self._switch(current, seed=not fresh)
                    self._follow(current)
                changed = sa_changed = False
                for entry, _, end in tail.read_spans():
                    try:  # first, and apart: an entry the event code can't read still counts for the jobs
                        with self._bg_lock:
                            if self._bg.feed(entry):
                                self._bg_seq += 1
                                changed = True
                            if self._sa.feed(entry):
                                self._sa_seq += 1
                                sa_changed = True
                    except Exception:
                        log.exception("live view: could not read a transcript entry for background work")
                    try:
                        self.entry(entry, cursor(tail.path, end))
                    except Exception:
                        log.exception("live view: could not read a transcript entry")
                if changed:
                    self._publish_background()
                if sa_changed:
                    self._publish_subagents()
                self.background(max_age=BG_CHECK)  # a session-file check, while jobs or subagents run
                with self._bg_lock:
                    running = bool(self._bg.jobs()) or self._sa.any_running()
                # Wakes on any change; the timeout is a safety net, shorter while jobs run (see BG_CHECK).
                self.watch.wait(BG_CHECK if running else 60)

    def _seed(self, path):
        """Background jobs started in the last SEED_BYTES of `path` and not over yet."""
        if not path:
            return
        try:
            entries = [e for e, *_ in read_backward(path, None, SEED_BYTES)]
        except OSError:
            return
        with self._bg_lock:
            for e in reversed(entries):  # oldest first
                self._bg.feed(e)
                self._sa.feed(e)
            self._bg_seq += 1
            self._sa_seq += 1
        self.background(max_age=0)

    def _switch(self, path, seed):
        """Another conversation: its own jobs and subagents only (the last one's are no longer
        this conversation's work). A resumed one is seeded from its transcript; a new one has none."""
        with self._bg_lock:
            self._bg, self._sa, self._bg_checked = Background(), Subagents(), 0.0
            self._bg_seq += 1
            self._sa_seq += 1
        with self._files_lock:  # another session's subagent folder: nothing cached carries over
            self._last.clear()
            self._meta.clear()
            self._meta_seen.clear()
        if seed:
            self._seed(path)
        self._publish_background()
        self._publish_subagents()

    def background(self, max_age=5.0) -> list[dict]:
        """The background jobs still running: [{id, kind, label, started}] oldest first. Checked
        against Claude's session file when it was last checked over `max_age` seconds ago; jobs it
        contradicts are dropped and running subagents it contradicts stopped (and
        `background.changed` / `subagents.changed` published)."""
        with self._bg_lock:
            jobs = self._bg.jobs()
            if not jobs and not self._sa.any_running() or time.monotonic() - self._bg_checked < max_age:
                return jobs
            self._bg_checked = time.monotonic()
        over = self._claude_idle_since()
        if over is None:
            return jobs
        with self._bg_lock:
            running = self._sa.running()
        finished = {t for t, a in running if self._meta_finished(t, a)}  # files read outside the lock
        with self._bg_lock:
            changed = self._bg.drop_started_before(over)
            if changed:
                self._bg_seq += 1
            stopped = self._sa.stop_running(over, over if over != float("inf") else self.now(), finished)
            if stopped:
                self._sa_seq += 1
            jobs = self._bg.jobs()
        if changed:
            self._publish_background()
        if stopped:
            self._publish_subagents()
        return jobs

    def subagents(self, max_age=5.0, with_last=True) -> list[dict]:
        """EDITH's subagents: [{id, description, type, model, effort, background, state, started,
        ended, last}] oldest first, running ones and those that ended in the last RETAIN seconds.
        `last` is a running one's latest step, from its own transcript (None if unknown); left out
        with with_last=False, which reads no subagent files."""
        self.background(max_age)  # the session-file check covers running subagents too
        with self._bg_lock:
            agents, running = self._sa.entries(self.now()), dict(self._sa.running())
        if with_last:
            for a in agents:
                a["last"] = self._last_of(a["id"], running[a["id"]]) if a["id"] in running else None
        return agents

    def _meta_finished(self, tool_use_id, agent_id) -> bool:
        """Whether Claude Code marked a subagent finished in its meta file (`"finished": true`):
        it ended though we missed how, so it is done rather than stopped."""
        with self._files_lock:
            folder = self._subagent_dir()
            agent_id = agent_id or (self._agent_id(folder, tool_use_id) if folder else None)
            if not agent_id:
                return False
            try:
                with open(os.path.join(folder, f"agent-{agent_id}.meta.json")) as f:
                    meta = json.load(f)
            except (OSError, ValueError):
                return False
        return isinstance(meta, dict) and meta.get("finished") is True

    def _subagent_dir(self):
        path = self.following or self.session().get("transcript_path")
        return os.path.join(path[:-len(".jsonl")], "subagents") if path and path.endswith(".jsonl") else None

    def _last_of(self, tool_use_id, agent_id):
        """A running subagent's last activity, read again only when its transcript changed."""
        with self._files_lock:
            return self._read_last(tool_use_id, agent_id)

    def _read_last(self, tool_use_id, agent_id):
        folder = self._subagent_dir()
        if not folder:
            return None
        agent_id = agent_id or self._agent_id(folder, tool_use_id)  # a foreground one's id isn't in our transcript yet
        if not agent_id:
            return None
        path = os.path.join(folder, f"agent-{agent_id}.jsonl")
        try:
            st = os.stat(path)
        except OSError:
            return None
        key = (st.st_size, st.st_mtime_ns)
        cached = self._last.get(path)
        if cached and cached[0] == key:
            return cached[1]
        line = last_activity(path)
        if line is None and cached:  # e.g. a last line longer than LAST_BYTES: keep what it did before
            line = cached[1]
        self._last[path] = (key, line)
        while len(self._last) > 50:
            self._last.pop(next(iter(self._last)))
        return line

    def _agent_id(self, folder, tool_use_id):
        """The agentId of a subagent by its tool_use id, from the meta files Claude writes next to
        the subagents' transcripts (each one read once)."""
        if tool_use_id in self._meta:
            return self._meta[tool_use_id]
        try:
            names = [n for n in os.listdir(folder) if n.endswith(".meta.json") and n not in self._meta_seen]
        except OSError:
            return None
        for name in names:
            self._meta_seen.add(name)
            try:
                with open(os.path.join(folder, name)) as f:
                    meta = json.load(f)
            except (OSError, ValueError):
                continue
            if isinstance(meta, dict) and meta.get("toolUseId"):
                self._meta[str(meta["toolUseId"])] = name[len("agent-"):-len(".meta.json")]
        if len(self._meta) > 1000:  # a long-lived bridge: keep the newest
            for k in list(self._meta)[:-500]:
                del self._meta[k]
        return self._meta.get(tool_use_id)

    def _claude_idle_since(self) -> float | None:
        """When Claude last said it has nothing to do (unix seconds): +inf if no Claude runs this
        conversation (its jobs died with it), None while it works or if unknown."""
        sid = self.session().get("session_id")
        if not sid:
            return None
        s = by_session_id(self.claude_dir, sid)
        if s is None:
            return float("inf")
        if s.get("status") != "idle":
            return None
        updated = s.get("statusUpdatedAt")
        return updated / 1000 if isinstance(updated, (int, float)) else float("inf")

    def _publish_background(self):
        """background.changed with the jobs now. Publishes are one at a time, each with the list as it
        is then, so a list another thread read earlier can never go out after a newer one."""
        with self._bg_pub:
            with self._bg_lock:
                seq, jobs = self._bg_seq, self._bg.jobs()
            if seq <= self._bg_sent:
                return  # this change (or a later one) is out already
            self._bg_sent = seq
            self.publish("background.changed", "system", self.session().get("session_id"), {"jobs": jobs})

    def _publish_subagents(self):
        """subagents.changed with the list now (without `last`, which only the status details carry),
        in order, like _publish_background."""
        with self._bg_pub:
            with self._bg_lock:
                seq, agents = self._sa_seq, self._sa.entries(self.now())
            if seq <= self._sa_sent:
                return
            self._sa_sent = seq
            self.publish("subagents.changed", "system", self.session().get("session_id"), {"agents": agents})

    def _follow(self, path):
        with self.switched:
            self.following = path
            self.switched.notify_all()

    def entry(self, e, cursor=None):
        """Publish the events of one transcript entry; `cursor` (see history()) goes in their data."""
        sid = e.get("sessionId") or self.session().get("session_id")
        for type, origin, data in events_of(e, self._tools, self.origin_of, self.known, self.typed_echo):
            if cursor:
                data["cursor"] = cursor
            self.publish(type, origin, sid, data)


def origin_from(text, origin_of):
    m = REF.search(text)
    if m and origin_of(m.group(1)):
        return origin_of(m.group(1))
    header = HEADER_LINE.search(text)
    if header:
        return "app" if text[header.start():].startswith("[App") else "telegram"
    return "telegram" if m else "terminal"


def remember(tools, tool_id, name):
    tools[tool_id] = name
    if len(tools) > MAX_TOOL_IDS:
        tools.pop(next(iter(tools)))


def events_of(e, tools, origin_of=lambda ref: None, known=lambda rid: False, typed_echo=lambda text: False,
              final=False):
    """[(type, origin, data)] for one transcript entry. `tools` maps tool_use ids to names (for
    naming results) and is updated; it is bounded to MAX_TOOL_IDS. `typed_echo` is asked only about
    a bare "/…" entry (no ref, no header) and consumes the match: see LiveView. `final`: this entry is
    known to be the turn's last assistant entry (history), so a missing stop_reason counts as the end."""
    if e.get("isSidechain") or e.get("isMeta"):
        return []
    out = []
    content = e.get("message", {}).get("content")
    if e.get("type") == "user":
        if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    summary = text_of(b.get("content")) if not isinstance(b.get("content"), str) else b["content"]
                    out.append(("tool.result", "system", {
                        "id": b.get("tool_use_id"), "name": tools.get(b.get("tool_use_id"), ""), "ok": not b.get("is_error"),
                        "summary": (summary or "").strip().split("\n", 1)[0][:200]}))
            return out
        text = text_of(content)
        stripped = text.lstrip()
        if not text or stripped.startswith("<") and not stripped.startswith("<pasted_content"):
            return []  # slash-command and system wrappers (long pastes are unwrapped by clean_prompt)
        m = REF.search(text)
        rid = m.group(1) if m else None
        if rid and known(rid):
            return []  # a frontend's message: its message.user went out when it was accepted
        if not rid and stripped.startswith("/") and not HEADER_LINE.search(text) and typed_echo(stripped.rstrip()):
            return []  # Claude's copy of a command the bridge typed for the app or Telegram (/compact)
        clean = clean_prompt(text)
        if not clean["text"] and not clean["attachments"]:
            return []
        return [("message.user", origin_from(text, origin_of),
                 {"text": clean["text"], "voice": clean["voice"], "rid": rid, "attachments": clean["attachments"],
                  "replying_to": clean["replying_to"]})]
    if e.get("type") == "assistant" and isinstance(content, list):
        # Files come only from a turn's final reply (Telegram sends turn.done's), not from narration.
        # stop_reason None (rare: an entry written before it was known) counts as the end only when the
        # entry is known to be the turn's last; live, turn.done brings those files instead.
        stop = (e.get("message") or {}).get("stop_reason")
        narration = stop == "tool_use" or (stop is None and not final)
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and b.get("text", "").strip():
                text = localize_limit_text(b["text"])  # Claude's limit line, in the user's zone
                if narration:  # text before a tool call: its SEND_FILE lines are talk, not files to send
                    text = take_files(text)[1]
                parts = reply_parts(text)
                if parts["text"]:  # a reply of only SEND_FILE lines says "📎 <name>" (reply_parts)
                    data = {"text": parts["text"], "files": parts["files"], "lane": "main"}
                    if e.get("isApiErrorMessage"):  # Claude Code's own error line (usage limit, login…)
                        data["api_error"] = str(e.get("error") or "unknown")
                        data["at"] = timestamp(e)
                    out.append(("message.assistant", "system", data))
            elif b.get("type") == "tool_use":
                name, inp = b.get("name", ""), b.get("input") or {}
                remember(tools, b.get("id"), name)
                out.append(("tool.call", "system", {"id": b.get("id"), "name": name, "summary": describe_tool(name, inp)}))
                if name in ("Edit", "MultiEdit", "Write") and inp.get("file_path"):
                    path = inp["file_path"]
                    if name == "Write":
                        diff = unified(path, "", inp.get("content", ""))
                    else:
                        edits = inp.get("edits") or [inp]
                        diff = "".join(unified(path, x.get("old_string", ""), x.get("new_string", "")) for x in edits)
                    out.append(("file.diff", "system", {"id": b.get("id"), "path": path, "diff": diff[:MAX_DIFF]}))
    return out


def cursor(path, offset):
    return f"{os.path.basename(path or '')[:-len('.jsonl')]}:{offset}"


def timestamp(e):
    try:
        return dt.datetime.fromisoformat(e["timestamp"]).timestamp()
    except (KeyError, TypeError, ValueError):
        return None


def turn_ends(entries):
    """Indexes of assistant entries that are their turn's last: the next assistant or user entry after
    them is Arpit's next prompt (not a tool result). One at the end of the list isn't known yet."""
    ends, last = set(), None
    for i, e in enumerate(entries):
        if e.get("isSidechain") or e.get("isMeta"):
            continue
        if e.get("type") == "assistant":
            last = i
        elif e.get("type") == "user":
            content = (e.get("message") or {}).get("content")
            results = isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
            if not results and last is not None:
                ends.add(last)
            if not results:
                last = None
    return ends


def history(path, after=None, before=None, limit=50, origin_of=lambda ref: None, max_bytes=HISTORY_BYTES):
    """Transcript events as the live view sends them, read by byte offset, never the whole file:
    - after=N: the events of entries after offset N, oldest first (catching up after a reconnect);
    - otherwise the newest `limit` events, of entries ending at or before `before` (None: the end).
    Whole entries only, so a page may hold a few events more than `limit` when one entry has several.
    -> {events, start, end, more}: offsets of the first and just after the last entry read, and
    whether more entries lie past them (after the end for after=, before the start otherwise)."""
    sid = os.path.basename(path)[:-len(".jsonl")]

    def as_event(e, end, tools, final=False):
        return [{"type": t, "ts": timestamp(e), "session_id": e.get("sessionId") or sid, "origin": o,
                 "data": {**d, "cursor": cursor(path, end)}} for t, o, d in events_of(e, tools, origin_of, final=final)]

    if after is not None:
        found, end, more = read_forward(path, after, max_bytes)
        tools, out, done = {}, [], after
        ends = turn_ends([f[0] for f in found])
        for i, (e, _, _, line_end) in enumerate(found):
            evs = as_event(e, line_end, tools, i in ends)
            if out and len(out) + len(evs) > limit:
                return {"events": out, "start": after, "end": done, "more": True}
            out.extend(evs)
            done = line_end
        return {"events": out, "start": after, "end": end, "more": more}

    picked, count, start, end = [], 0, None, None
    for e, _, line_start, line_end in read_backward(path, before, max_bytes):
        n = len(events_of(e, {}))
        if picked and count + n > limit:
            break
        picked.append((e, line_end))
        start, end, count = line_start, end or line_end, count + n
        if count >= limit:
            break
    tools, out = {}, []
    oldest_first = list(reversed(picked))
    ends = turn_ends([e for e, _ in oldest_first])
    for i, (e, line_end) in enumerate(oldest_first):  # oldest first, so results are named after their calls
        out += as_event(e, line_end, tools, i in ends)
    if start is None:
        start = end = before or 0
    return {"events": out, "start": start, "end": end, "more": start > 0}
