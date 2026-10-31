"""ClaudeTmux, the agent port. Main lane = the interactive Claude in tmux; while it is busy, new
messages run at once in side lanes (`claude -p` forks of the conversation, up to max_side_lanes),
and the main lane is told what they did on its next turn; otherwise they queue.

The rules are the legacy bridge's (dispatch, run_tmux, run_claude, sessions, /stop, the permission
relay). What Telegram showed is now a stream of events (contracts/events.md) that the frontends
render.

Brute-force fixes from legacy:
- The main lane waits on the hook events and the transcript with inotify (watch.py), not a 0.5 s
  loop that also re-parsed tmux-session.json and ran `tmux has-session` every time. tmux-session.json
  is re-read only when it changes; tmux is checked every 5 s; /stop wakes the wait at once and the
  15 s grace ends exactly on time.
- A fixed set of threads: one main-lane worker, max_side_lanes side-lane workers and one permission
  watcher. Legacy started a thread per side-lane message plus a typing thread per turn.
- Permission requests are noticed through inotify on perms/, not by listing it every 0.5 s.
- Switching conversations waits for the SessionStart hook through inotify, not a 1 s loop.
- A side lane's stderr goes to a temp file: legacy piped it and read it only at the end, so a
  chatty stderr (over 64 KB) could block Claude for good.
- The queue is bounded (MAX_QUEUE); decisions and tmux-run are written atomically.
"""
import collections
import datetime
import functools
import json
import logging
import os
import queue
import re
import secrets
import signal
import subprocess
import tempfile
import threading
import time

from edith.common.paths import resolve
from edith.common.state import StateFile
from edith.common.text import clean_prompt, reply_parts, take_directives
from edith.core import Event
from edith.ports.agent import RunInfo, StopResult, TurnHandle

from .live import LiveView, cursor, history
from .sessions import Sessions
from .stats import SessionStats
from .tmux import Tmux
from .transcript import Tail, tool_uses
from .watch import Watch, wait_for

log = logging.getLogger("edith.adapter.claude_tmux")

MAX_QUEUE = 50          # messages waiting for the main lane; more than this is refused
MAX_REFS = 500          # run id -> ref of delivered messages, so the live view can skip their transcript copy
MID_TURN = "The user sent a new message while you were working"
COMPACT_ERROR = re.compile(r"Error (?:during compaction|compacting conversation)[^\n]*")
PANE_CHECK = 5.0        # seconds; /compact errors appear only on screen, which can't be watched
MAX_TYPED = 16          # slash commands typed for frontends, remembered to skip their transcript echo
ECHO_WINDOW = 30.0      # seconds: a matching bare "/…" transcript entry later than this was typed in tmux
MAX_HISTORY = 500       # events per history page
SESSION_ID = re.compile(r"[A-Za-z0-9-]{1,64}")
STOPPED_CODES = (-signal.SIGTERM, -signal.SIGKILL, 143, 137)
NOTES_HEADER = ("[While you were busy, parallel lanes (forks of this conversation) handled these. "
                "You didn't see them, so here they are for context:]")


def entry_time(entry):
    """A transcript entry's time (unix seconds), or None if it has none."""
    try:
        return datetime.datetime.fromisoformat(entry["timestamp"]).timestamp()
    except (KeyError, TypeError, ValueError):
        return None


def own_turn(entry):
    """Whether a transcript entry holding our [tg-ref] is the prompt of its own turn (a user entry with
    the message as its text), rather than a message Claude Code folded into a running turn."""
    content = entry.get("message", {}).get("content")
    if entry.get("type") != "user":
        return False
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return False
        content = " ".join(b.get("text", "") for b in content if isinstance(b, dict))
    return isinstance(content, str) and MID_TURN not in content


class Run:
    def __init__(self, ref, lane, origin):
        self.ref, self.lane, self.origin = ref, lane, origin
        self.rid = secrets.token_hex(3)
        self.started = time.time()
        self.step, self.steps = None, 0
        self.proc, self.watch, self.stop_requested = None, None, None


def _write_atomic(path, text):
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


class ClaudeTmux:
    def __init__(self, config: dict, tmux: Tmux | None = None):
        self.paths = p = resolve(config)
        bridge = os.path.join(p.work_dir, "bridge")
        self.claude = config.get("claude_bin") or os.environ.get("CLAUDE_BIN") or os.path.join(p.home, ".local/bin/claude")
        self.mcp_config = config.get("mcp_config") or os.path.join(bridge, "mcp.json")
        self.launch = config.get("launch") or os.path.join(bridge, "edith-claude.sh")
        self.max_side = self.max_side_lanes = int(config.get("max_side_lanes", 2))
        self.ready_timeout = float(config.get("ready_timeout", 90))
        self.alive_every = float(config.get("check_alive_every", 5))
        self.stop_grace = float(config.get("stop_grace", 15))
        self.compact_timeout = float(config.get("compact_timeout", 300))  # a long conversation takes minutes
        self.live_view = bool(config.get("live_view", True))  # transcript -> message/tool events for every turn
        self._live = None
        self.tmux = tmux or Tmux(config.get("tmux_socket", "edith"), config.get("tmux_target", "edith"),
                                 config.get("tmux_service", "edith-claude"))
        self._chat_key = config.get("chat_key")

        self.bus = None
        self.main_busy = threading.Event()
        self._main: queue.Queue = queue.Queue(maxsize=MAX_QUEUE)
        self._side: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._runs: dict[str, Run] = {}
        self._side_busy = 0
        self._decided: dict[str, str] = {}
        self._threads: list[threading.Thread] = []
        self._stopping = threading.Event()
        self._held: list | None = None  # while held (hold()): the messages that came in, in order
        self._perm_watch = None
        self._session_cache = (None, {})
        self._refs: collections.OrderedDict[str, str] = collections.OrderedDict()
        # Slash commands the bridge typed for a frontend (/compact, /clear) and when: Claude writes each
        # to the transcript as a bare "/…" entry, which the live view skips instead of showing as Terminal.
        self._typed: collections.deque[tuple[str, float]] = collections.deque(maxlen=MAX_TYPED)

    # Read on first use, so building the adapter (e.g. `make check`) touches no file.
    @functools.cached_property
    def state(self):
        return StateFile.at(self.paths.bridge_state)

    @functools.cached_property
    def sessions(self):
        return Sessions(self.paths.transcripts, self.state)

    @functools.cached_property
    def stats(self):
        return SessionStats(entry_time)

    @functools.cached_property
    def key(self):
        """The bridge-state "sessions" key: the Telegram chat (the first allowed id), as in legacy."""
        return str(self._chat_key or self._default_chat() or "default")

    def _default_chat(self):
        try:
            with open(os.path.join(self.paths.telegram_dir, "access.json")) as f:
                return next(iter(sorted(str(x) for x in json.load(f).get("allowFrom", []))), None)
        except (OSError, ValueError):
            return None

    # ---- lifecycle ----

    def start(self, bus):
        self.bus = bus
        os.makedirs(self.paths.perm_dir, exist_ok=True)
        for name in os.listdir(self.paths.perm_dir):  # stale requests from a previous run
            os.remove(os.path.join(self.paths.perm_dir, name))
        self._remove(self.paths.tmux_run)
        workers = [("main", self._main_worker)] + [(f"side{i}", self._side_worker) for i in range(self.max_side)]
        workers += [("perms", self._perm_watcher)]
        if self.live_view:
            self._live = LiveView(self.paths, self._tmux_session, self._publish_live, self._origin_of, self._known, self._typed_echo)
            workers.append(("live", lambda: self._live.run(self._stopping)))
        for name, target in workers:
            t = threading.Thread(target=target, name=f"claude_tmux:{name}", daemon=True)
            t.start()
            self._threads.append(t)

    def shutdown(self, timeout=5.0):
        """Stop side lanes and our threads; no `claude -p` outlives this. The tmux Claude keeps running."""
        with self._lock:  # after this, no new side-lane process can start (see _run_side)
            self._stopping.set()
            live = [r for r in self._runs.values() if r.proc and r.proc.poll() is None]
        for r in live:
            self._kill(r.proc)
        for q, n in ((self._main, 1), (self._side, self.max_side)):
            for _ in range(n):
                try:
                    q.put_nowait(None)
                except queue.Full:
                    pass
        if self._perm_watch:
            self._perm_watch.wake()
        if self._live and self._live.watch:
            self._live.watch.wake()
        deadline = time.monotonic() + timeout
        for t in self._threads:
            if t.name.startswith(("claude_tmux:side", "claude_tmux:perms", "claude_tmux:live")):
                t.join(max(0.0, deadline - time.monotonic()))

    @staticmethod
    def _kill(proc):
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass  # already gone

    def _publish_live(self, type, origin, session_id, data):
        if self.bus:
            self.bus.publish(Event(type, data, origin=origin, session_id=session_id))

    def _origin_of(self, rid):
        with self._lock:
            run = self._runs.get(rid)
        return run.origin if run else None

    def _publish(self, type, run_or_origin, **data):
        if self.bus:
            origin = run_or_origin.origin if isinstance(run_or_origin, Run) else run_or_origin
            self.bus.publish(Event(type, data, origin=origin or "system"))

    def _accepted(self, text, origin, ref, delivery, lane):
        """message.user for a message a frontend handed over (contracts/events.md, "Messages")."""
        if self.bus:
            self.bus.publish(Event("message.user", {"ref": ref, **clean_prompt(text), "delivery": delivery, "lane": lane},
                                   origin=origin or "system", session_id=self.current_session()))

    def _delivered(self, run, delivery):
        with self._lock:
            self._refs[run.rid] = run.ref
            while len(self._refs) > MAX_REFS:
                self._refs.popitem(last=False)
        self._publish("message.delivered", run, ref=run.ref, delivery=delivery, rid=run.rid)

    def _known(self, rid):
        """Whether a [tg-ref <rid>] belongs to a message a frontend handed over (its message.user is sent)."""
        with self._lock:
            return rid in self._refs or any(r.rid == rid for r in self._runs.values())

    def _type_command(self, command):
        """Type a slash command into the tmux Claude for a frontend, remembering it (see _typed_echo)."""
        with self._lock:
            self._typed.append((" ".join(command.split()), time.monotonic()))
        self.tmux.command(command)

    def _typed_echo(self, text):
        """Whether a bare "/…" transcript entry is the echo of a command typed by _type_command in the
        last ECHO_WINDOW seconds. Each typed command matches once; the same command typed in tmux by
        hand (no match, or later) still shows, as Terminal."""
        text, now = " ".join(text.split()), time.monotonic()
        with self._lock:
            while self._typed and now - self._typed[0][1] > ECHO_WINDOW:
                self._typed.popleft()
            for i, (typed, _) in enumerate(self._typed):
                if typed == text:
                    del self._typed[i]
                    return True
        return False

    # ---- dispatch ----

    def send(self, text, origin, ref, force_queue=False):
        """Main lane if it's free; otherwise a side lane if one is free; otherwise queue (always while held)."""
        with self._lock:  # message.user goes out before the job is queued, so it always comes first
            held = self._held is not None
            if not held and not self.main_busy.is_set() and self._main.empty():
                self.main_busy.set()
                self._accepted(text, origin, ref, "main", "main")
                self._main.put((text, origin, ref))
                return TurnHandle(ref, "main")
            if not held and not force_queue and self._side_busy < self.max_side:
                self._side_busy += 1
                self._accepted(text, origin, ref, "side_lane", "side")
                self._side.put((text, origin, ref))
                return TurnHandle(ref, "side")
            self._accepted(text, origin, ref, "queued", "queued")
            waiting = len(self._held or ())
            position = self._main.qsize() + waiting + 1
            try:
                if self._main.qsize() + waiting >= MAX_QUEUE:
                    raise queue.Full
                if held:
                    self._held.append((text, origin, ref))  # the main worker never sees it until release()
                else:
                    self._main.put_nowait((text, origin, ref))
            except queue.Full:
                self._publish("turn.failed", origin, ref=ref, lane="main", reason="queue_full",
                              detail=f"{MAX_QUEUE} messages are already waiting")
                return TurnHandle(ref, "refused")
        self._publish("turn.queued", origin, ref=ref, position=position)
        return TurnHandle(ref, "queued")

    def _main_worker(self):
        while not self._stopping.is_set():
            job = self._main.get()
            if job is None or self._stopping.is_set():
                return
            self.main_busy.set()
            try:
                self._run_main(*job)
            except Exception as e:
                log.exception("main lane failed")
                self._publish("turn.failed", job[1], ref=job[2], lane="main", reason="bridge_error", detail=str(e))
            finally:
                with self._lock:
                    if self._main.empty():
                        self.main_busy.clear()

    def _side_worker(self):
        while not self._stopping.is_set():
            job = self._side.get()
            if job is None or self._stopping.is_set():
                return
            try:
                self._run_side(*job)
            except Exception as e:
                log.exception("side lane failed")
                self._publish("turn.failed", job[1], ref=job[2], lane="side", reason="bridge_error", detail=str(e))
            finally:
                with self._lock:
                    self._side_busy -= 1

    def _track(self, run):
        with self._lock:
            self._runs[run.rid] = run

    def _untrack(self, run):
        with self._lock:
            self._runs.pop(run.rid, None)

    def _remove(self, path):
        try:
            os.remove(path)
        except OSError:
            pass

    # ---- the main lane: interactive Claude in tmux ----

    def _tmux_session(self):
        """tmux-session.json (written by the SessionStart hook), parsed again only when it changes."""
        try:
            st = os.stat(self.paths.tmux_session)
            key = (st.st_ino, st.st_mtime_ns, st.st_size)
        except OSError:
            return {}
        if self._session_cache[0] != key:
            try:
                with open(self.paths.tmux_session) as f:
                    self._session_cache = (key, json.load(f))
            except (OSError, ValueError):
                return {}
        return self._session_cache[1]

    def _with_side_notes(self, prompt):
        def take(state):
            return state.pop("side_notes", None)
        notes = self.state.update(take) if self.state.get("side_notes") else None
        if not notes:
            return prompt
        lines = [NOTES_HEADER] + [f"- Arpit: {n['q']}\n  EDITH: {n['a']}" for n in notes]
        return "\n".join(lines) + "\n\n" + prompt

    def _run_main(self, text, origin, ref):
        """Hand the message to the tmux Claude and follow the turn: the hooks log a "prompt" event
        when our message (tagged [tg-ref <rid>]) is submitted and a "stop" event with the reply; the
        transcript gives live progress and shows an Esc interrupt (which fires no Stop hook)."""
        prompt = self._with_side_notes(text)
        if not self.tmux.wait_ready(self.ready_timeout):
            self._publish("turn.failed", origin, ref=ref, lane="main", reason="not_ready",
                          detail="The Claude session in tmux isn't ready")
            return
        run = Run(ref, "main", origin)
        self._track(run)
        _write_atomic(self.paths.tmux_run, run.rid)
        self._publish("turn.started", run, ref=ref, lane="main")
        tag = f"[tg-ref {run.rid}]"
        events = Tail(self.paths.tmux_events)
        transcript = Tail(self._tmux_session().get("transcript_path"))
        outcome, reply, sid, submitted, delivered = None, None, None, False, False
        early_stop, tag_ts = None, None
        try:
            with Watch(self.paths.state_dir, self.paths.transcripts) as watch:
                run.watch = watch
                self.tmux.submit(f"{prompt}\n{tag}")
                last_check = time.monotonic()
                while outcome is None:
                    for ev, _ in events.read():
                        if ev.get("event") == "prompt" and ev.get("ref") == run.rid:
                            submitted, sid = True, ev.get("session_id")
                            if not delivered:
                                delivered = True
                                self._delivered(run, "main")
                        elif ev.get("event") == "stop" and submitted:
                            reply, sid, outcome = ev.get("text") or "", ev.get("session_id") or sid, "done"
                        elif ev.get("event") == "stop":
                            early_stop = ev  # may belong to us if our tag is in this same batch of the transcript
                    current = self._tmux_session().get("transcript_path")
                    if current != transcript.path:  # /clear or a resume switched transcripts
                        transcript.switch(current)
                    for entry, raw in transcript.read():
                        if tag in raw:
                            submitted = True  # also covers a message queued into a running turn
                            tag_ts = entry_time(entry)
                            if not delivered:
                                delivered = True
                                self._delivered(run, "main" if own_turn(entry) else "mid_turn")
                        if not submitted or entry.get("isSidechain"):
                            continue
                        for step in tool_uses(entry):
                            run.steps, run.step = run.steps + 1, step
                            self._publish("turn.progress", run, ref=ref, lane="main", steps=run.steps, step=step,
                                          elapsed=int(time.time() - run.started))
                        if entry.get("type") == "user" and "[Request interrupted by user" in raw and outcome is None:
                            outcome = "stopped"
                    if outcome is None and submitted and early_stop is not None:
                        # The stop hook was read before our tag in the transcript (both arrived between two
                        # wake-ups): it is ours if it came after the entry with our tag.
                        if tag_ts is None or early_stop.get("ts", 0) >= tag_ts:
                            reply, outcome = early_stop.get("text") or "", "done"
                            sid = early_stop.get("session_id") or sid
                        early_stop = None
                    now = time.monotonic()
                    if outcome is None and run.stop_requested and now - run.stop_requested > self.stop_grace:
                        outcome = "stopped"
                    if outcome is None and now - last_check >= self.alive_every:
                        last_check = now
                        if not self.tmux.alive():
                            outcome = "crashed"
                    if outcome is None:
                        wait = self.alive_every - (now - last_check)
                        if run.stop_requested:
                            wait = min(wait, run.stop_requested + self.stop_grace - now + 0.01)
                        watch.wait(wait)
        finally:
            self._untrack(run)
            self._remove(self.paths.tmux_run)
        elapsed = int(time.time() - run.started)

        if sid:  # side lanes fork from whatever the tmux session is now
            self.state.update(lambda s: s.setdefault("sessions", {}).__setitem__(self.key, sid))
        if outcome == "stopped":
            self._publish("turn.stopped", run, ref=ref, lane="main")
        elif outcome == "crashed":
            self._publish("turn.failed", run, ref=ref, lane="main", reason="crashed",
                          detail="The Claude session in tmux exited; it restarts on its own")
        else:
            parts = reply_parts(reply)
            self._publish("turn.done", run, ref=ref, lane="main", text=reply, steps=run.steps, elapsed=elapsed,
                          is_error=False, subtype="success", display_text=parts["text"], files=parts["files"],
                          reaction=parts["reaction"])

    # ---- side lanes: `claude -p` forks ----

    def _run_side(self, text, origin, ref, retry=False):
        session = self.state.get("sessions", {}).get(self.key)
        cmd = [self.claude, "-p", text, "--output-format", "stream-json", "--verbose",
               "--mcp-config", self.mcp_config, "--permission-prompt-tool", "mcp__edith_perm__approve"]
        if session:
            cmd += ["--resume", session, "--fork-session"]
        run = Run(ref, "side", origin)
        self._publish("turn.started", run, ref=ref, lane="side")
        if not retry:
            self._delivered(run, "side_lane")
        env = dict(os.environ, EDITH_PERM_DIR=self.paths.perm_dir, EDITH_RUN_ID=run.rid)
        result = None
        with tempfile.TemporaryFile("w+", errors="replace") as stderr:
            with self._lock:  # shutdown() sets _stopping under this lock, so nothing starts after it
                if self._stopping.is_set():
                    return
                run.proc = subprocess.Popen(cmd, cwd=self.paths.work_dir, stdout=subprocess.PIPE, stderr=stderr,
                                            text=True, env=env, start_new_session=True)
                self._runs[run.rid] = run
            try:
                for line in run.proc.stdout:
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    if ev.get("type") == "system" and ev.get("session_id"):
                        self._save_fork(ev["session_id"])
                    elif ev.get("type") == "result":
                        result = ev
                    for step in tool_uses(ev):
                        run.steps, run.step = run.steps + 1, step
                        self._publish("turn.progress", run, ref=ref, lane="side", steps=run.steps, step=step,
                                      elapsed=int(time.time() - run.started))
                run.proc.wait()
                stderr.seek(0)
                err = stderr.read()
            finally:
                self._untrack(run)
        elapsed = int(time.time() - run.started)

        if result is None:
            if run.proc.returncode in STOPPED_CODES:
                self._publish("turn.stopped", run, ref=ref, lane="side")
            elif session and "No conversation found" in err:
                # The conversation expired or was deleted: start fresh, once.
                self.state.update(lambda s: s.get("sessions", {}).pop(self.key, None))
                self._publish("turn.retrying", run, ref=ref, lane="side", reason="no_conversation")
                return self._run_side(text, origin, ref, retry=True)
            else:
                log.warning("side lane failed: code %s %s", run.proc.returncode, err[-300:])
                self._publish("turn.failed", run, ref=ref, lane="side", reason="error",
                              code=run.proc.returncode, stderr=err.strip()[-800:])
            return

        self._save_fork(result.get("session_id"))
        reply, is_error, subtype = result.get("result") or "", bool(result.get("is_error")), result.get("subtype", "unknown")
        self._remember_side_note(text, reply, is_error, subtype)
        parts = reply_parts(reply)
        if parts["text"]:  # the main transcript never has a side lane's answer: send it as a message
            self._publish("message.assistant", run, text=parts["text"], lane="side", ref=ref, files=parts["files"])
        self._publish("turn.done", run, ref=ref, lane="side", text=reply, steps=run.steps, elapsed=elapsed,
                      is_error=is_error, subtype=subtype, display_text=parts["text"], files=parts["files"],
                      reaction=parts["reaction"])

    def _save_fork(self, sid):
        """Remember side-lane forks so the conversation list can hide them."""
        if not sid:
            return

        def add(state):
            forks = state.setdefault("side_sessions", [])
            if sid not in forks:
                forks.append(sid)
                del forks[:-200]
        if sid not in self.state.get("side_sessions", []):
            self.state.update(add)

    def _remember_side_note(self, prompt, reply, is_error, subtype):
        """The main conversation never saw this turn; hand it over on its next turn."""
        _, text = take_directives(reply, "SEND_FILE")
        _, text = take_directives(text, "REACT")
        if is_error and not text:
            text = f"❌ Error: {subtype}"
        asked = prompt.split("\n", 1)[-1]

        def add(state):
            notes = state.setdefault("side_notes", [])
            notes.append({"q": asked[:400], "a": text[:1200]})
            del notes[:-5]
        self.state.update(add)

    # ---- control ----

    def stop(self):
        dropped = []
        with self._lock:
            held = list(self._held or ())
            if self._held is not None:
                self._held.clear()
        for job in held:
            dropped.append(job[2])
            self._publish("turn.stopped", job[1], ref=job[2], lane="queued")
        while True:
            try:
                job = self._main.get_nowait()
            except queue.Empty:
                break
            if job is None:
                self._main.put(None)  # keep a shutdown signal
                break
            dropped.append(job[2])
            self._publish("turn.stopped", job[1], ref=job[2], lane="queued")
        with self._lock:
            live = [r for r in self._runs.values() if r.lane == "main" or (r.proc and r.proc.poll() is None)]
        for r in live:
            if r.lane == "main":
                self.tmux.interrupt()
                r.stop_requested = time.monotonic()
                if r.watch:
                    r.watch.wake()
            else:
                self._kill(r.proc)
        return StopResult(len(live), dropped)

    def status(self):
        with self._lock:
            runs = sorted(self._runs.values(), key=lambda r: r.started)
            queued = self._main.qsize() + len(self._held or ())
        return [RunInfo(r.ref, r.lane, r.started, r.step) for r in runs], queued

    def busy(self):
        return self.main_busy.is_set()

    def hold(self):
        """Stop starting work until release(): messages queue up (none runs, no side lane starts) and
        the tmux Claude isn't started or switched. For a Claude account switch, which restarts it."""
        with self._lock:
            if self._held is None:
                self._held = []

    def release(self):
        """End a hold: the messages that came in meanwhile run in order."""
        with self._lock:
            held, self._held = self._held or [], None
            for job in held:
                self._main.put_nowait(job)  # within MAX_QUEUE: send() counted them

    def held(self):
        return self._held is not None

    # ---- conversations ----

    def current_session(self):
        return self._tmux_session().get("session_id")

    def tmux_alive(self):
        return self.tmux.alive()

    def has_conversation(self):
        return bool(self.state.get("sessions", {}).get(self.key))

    def list_sessions(self, limit=8):
        items = self.sessions.recent(limit)
        self.state.update(lambda s: s.__setitem__("last_listing", [sid for sid, _, _ in items]))
        return [{"session_id": sid, "title": title, "updated": mtime} for sid, title, mtime in items]

    def find_session(self, arg):
        return self.sessions.find(arg)

    def session_stats(self, session_id=None):
        sid = session_id or self.current_session()
        path = sid and SESSION_ID.fullmatch(sid) and os.path.join(self.paths.transcripts, f"{sid}.jsonl")
        return self.stats.get(path) if path and os.path.exists(path) else None

    def session_title(self, session_id):
        return self.sessions.title(session_id)

    def name_session(self, title, session_id=None):
        sid = session_id or self.current_session()
        if not sid or (session_id and not self.sessions.exists(session_id)):
            return None
        self.state.update(lambda s: s.setdefault("session_names", {}).__setitem__(sid, title[:60]))
        return sid

    def resume(self, session_id, before=None):
        if self.main_busy.is_set() or self.held():
            return "busy"
        if not self.sessions.exists(session_id):
            return "missing"
        if self.current_session() == session_id:
            return "already"
        if before:
            before()
        self.main_busy.set()  # keep new messages off the main lane while Claude restarts
        try:
            t0 = time.time()
            with Watch(self.paths.state_dir) as watch:
                if self.tmux.alive():
                    self.tmux.respawn(f"{self.launch} {session_id}")
                else:
                    self.tmux.start()
                wait_for(lambda: self._tmux_session().get("ts", 0) >= t0, watch, 60)  # the SessionStart hook
            if not self.tmux.wait_ready(30):
                return "failed"
        finally:
            with self._lock:
                if self._main.empty():
                    self.main_busy.clear()
        now = self.current_session() or session_id

        def switched(state):
            state.setdefault("sessions", {})[self.key] = now
            state.pop("side_notes", None)
        self.state.update(switched)
        self._publish("session.changed", "system", session_id=now, title=self.session_title(now), source="resume")
        return "ok"

    def compact(self, instructions=""):
        """Claude Code's /compact in the tmux Claude, when nothing else is going on. Done = the
        SessionStart hook reports source "compact" (tmux-session.json, watched with inotify); an error
        shows only on screen, so the pane is read on each wake-up, at least every PANE_CHECK seconds."""
        with self._lock:
            if self.main_busy.is_set() or self.held() or not self._main.empty() or os.path.exists(self.paths.tmux_run) \
                    or self._perms_pending():
                return "busy", ""
            self.main_busy.set()  # new messages go to a side lane or wait, as during a switch
        try:
            if not self.tmux.wait_ready(10):
                return "failed", "the Claude session in tmux isn't ready"
            started = time.time()
            command = " ".join(f"/compact {instructions}".split())  # one line: a newline would submit early
            with Watch(self.paths.state_dir, self.paths.transcripts) as watch:
                self.tmux.clear_input()
                self._type_command(command)
                deadline = time.monotonic() + self.compact_timeout
                while True:
                    session = self._tmux_session()
                    if session.get("source") == "compact" and session.get("ts", 0) >= started:
                        return "ok", ""
                    error = COMPACT_ERROR.search(self.tmux.pane())
                    if error:
                        return "failed", error.group(0).strip()
                    left = deadline - time.monotonic()
                    if left <= 0:
                        return "failed", f"no answer from Claude in {int(self.compact_timeout)} s"
                    watch.wait(min(left, PANE_CHECK))
        finally:
            with self._lock:
                if self._main.empty():
                    self.main_busy.clear()

    def _perms_pending(self):
        try:
            return any(n.endswith(".req.json") for n in os.listdir(self.paths.perm_dir))
        except OSError:
            return False

    def new_session(self):
        if self.main_busy.is_set() or self.held():
            return "busy"
        if self.tmux.wait_ready(10):
            self._type_command("/clear")

        def cleared(state):
            state.get("sessions", {}).pop(self.key, None)
            state.pop("side_notes", None)
        self.state.update(cleared)
        self._publish("session.changed", "system", session_id=None, title=None, source="new")
        return "ok"

    def history(self, session_id=None, after=None, before=None, limit=50):
        sid = session_id or self.current_session()
        if not sid or not SESSION_ID.fullmatch(sid):
            return None
        path = os.path.join(self.paths.transcripts, f"{sid}.jsonl")
        if not os.path.exists(path):
            if session_id:
                return None
            return {"session_id": sid, "events": [], "start": cursor(path, 0), "cursor": cursor(path, 0),
                    "more": False, "reset": False}

        def offset(c):
            """A cursor's byte offset, or None if it belongs to another conversation."""
            if c is None:
                return None
            owner, _, n = str(c).rpartition(":")
            if not n.isdigit():
                raise ValueError("bad cursor")
            return int(n) if owner == sid else None
        after_at, before_at = offset(after), offset(before)
        reset = (after is not None and after_at is None) or (before is not None and before_at is None)
        page = history(path, after_at, before_at, max(1, min(int(limit), MAX_HISTORY)), self._origin_of)
        return {"session_id": sid, "events": page["events"], "start": cursor(path, page["start"]),
                "cursor": cursor(path, page["end"]), "more": page["more"], "reset": reset}

    # ---- permission relay (perm.py writes requests, we show them and write decisions) ----

    def resolve_permission(self, request_id, allow):
        folder = self.paths.perm_dir
        if not os.path.exists(os.path.join(folder, f"{request_id}.req.json")):
            return False
        decision = "allow" if allow else "deny"
        self._decided[request_id] = decision
        _write_atomic(os.path.join(folder, f"{request_id}.decision"), decision)
        return True

    def _perm_watcher(self):
        folder, known = self.paths.perm_dir, {}
        with Watch(folder) as watch:
            self._perm_watch = watch
            while not self._stopping.is_set():
                try:
                    current = {n[:-len(".req.json")] for n in os.listdir(folder) if n.endswith(".req.json")}
                except OSError:
                    current = set()
                for rid in sorted(current - set(known)):
                    try:
                        with open(os.path.join(folder, f"{rid}.req.json")) as f:
                            req = json.load(f)
                    except (OSError, ValueError):
                        continue  # half-written or already gone; seen again on the next change
                    with self._lock:
                        run = self._runs.get(req.get("run") or "")
                    inp = req.get("input", {})
                    detail = inp.get("command") or inp.get("file_path") or json.dumps(inp)[:500]
                    known[rid] = run
                    self._publish("permission.request", run.origin if run else "system", id=rid,
                                  tool=req.get("tool_name"), detail=detail,
                                  ref=run.ref if run else None, lane=run.lane if run else None)
                for rid in sorted(set(known) - current):
                    run = known.pop(rid)
                    self._publish("permission.resolved", run.origin if run else "system", id=rid,
                                  decision=self._decided.pop(rid, "gone"), ref=run.ref if run else None,
                                  lane=run.lane if run else None)
                watch.wait(60)  # wakes on any change in perms/; the timeout is only a safety net
