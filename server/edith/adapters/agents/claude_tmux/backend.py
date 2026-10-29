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
import json
import logging
import os
import queue
import secrets
import signal
import subprocess
import tempfile
import threading
import time

from edith.common.paths import resolve
from edith.common.state import StateFile
from edith.common.text import take_directives
from edith.core import Event
from edith.ports.agent import RunInfo, StopResult, TurnHandle

from .sessions import Sessions
from .tmux import Tmux
from .transcript import Tail, tool_uses
from .watch import Watch, wait_for

log = logging.getLogger("edith.adapter.claude_tmux")

MAX_QUEUE = 50          # messages waiting for the main lane; more than this is refused
STOPPED_CODES = (-signal.SIGTERM, -signal.SIGKILL, 143, 137)
NOTES_HEADER = ("[While you were busy, parallel lanes (forks of this conversation) handled these. "
                "You didn't see them, so here they are for context:]")


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
        self.max_side = int(config.get("max_side_lanes", 2))
        self.ready_timeout = float(config.get("ready_timeout", 90))
        self.alive_every = float(config.get("check_alive_every", 5))
        self.stop_grace = float(config.get("stop_grace", 15))
        self.tmux = tmux or Tmux(config.get("tmux_socket", "edith"), config.get("tmux_target", "edith"),
                                 config.get("tmux_service", "edith-claude"))
        self.state = StateFile.at(p.bridge_state)
        self.sessions = Sessions(p.transcripts, self.state)
        self.key = str(config.get("chat_key") or self._default_chat() or "default")

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
        self._perm_watch = None
        self._session_cache = (None, {})

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
        for name, target in workers + [("perms", self._perm_watcher)]:
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
        deadline = time.monotonic() + timeout
        for t in self._threads:
            if t.name.startswith(("claude_tmux:side", "claude_tmux:perms")):
                t.join(max(0.0, deadline - time.monotonic()))

    @staticmethod
    def _kill(proc):
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass  # already gone

    def _publish(self, type, run_or_origin, **data):
        if self.bus:
            origin = run_or_origin.origin if isinstance(run_or_origin, Run) else run_or_origin
            self.bus.publish(Event(type, data, origin=origin or "system"))

    # ---- dispatch ----

    def send(self, text, origin, ref, force_queue=False):
        """Main lane if it's free; otherwise a side lane if one is free; otherwise queue."""
        with self._lock:
            if not self.main_busy.is_set() and self._main.empty():
                self.main_busy.set()
                self._main.put((text, origin, ref))
                return TurnHandle(ref, "main")
            if not force_queue and self._side_busy < self.max_side:
                self._side_busy += 1
                self._side.put((text, origin, ref))
                return TurnHandle(ref, "side")
            position = self._main.qsize() + 1
            try:
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
        outcome, reply, sid, submitted = None, None, None, False
        try:
            with Watch(self.paths.state_dir, self.paths.transcripts) as watch:
                run.watch = watch
                self.tmux.submit(f"{prompt}\n{tag}")
                last_check = time.monotonic()
                while outcome is None:
                    for ev, _ in events.read():
                        if ev.get("event") == "prompt" and ev.get("ref") == run.rid:
                            submitted, sid = True, ev.get("session_id")
                        elif ev.get("event") == "stop" and submitted:
                            reply, sid, outcome = ev.get("text") or "", ev.get("session_id") or sid, "done"
                    current = self._tmux_session().get("transcript_path")
                    if current != transcript.path:  # /clear or a resume switched transcripts
                        transcript.switch(current)
                    for entry, raw in transcript.read():
                        if tag in raw:
                            submitted = True  # also covers a message queued into a running turn
                        if not submitted or entry.get("isSidechain"):
                            continue
                        for step in tool_uses(entry):
                            run.steps, run.step = run.steps + 1, step
                            self._publish("turn.progress", run, ref=ref, lane="main", steps=run.steps, step=step,
                                          elapsed=int(time.time() - run.started))
                        if entry.get("type") == "user" and "[Request interrupted by user" in raw and outcome is None:
                            outcome = "stopped"
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
            self._publish("turn.done", run, ref=ref, lane="main", text=reply, steps=run.steps, elapsed=elapsed,
                          is_error=False, subtype="success")

    # ---- side lanes: `claude -p` forks ----

    def _run_side(self, text, origin, ref):
        session = self.state.get("sessions", {}).get(self.key)
        cmd = [self.claude, "-p", text, "--output-format", "stream-json", "--verbose",
               "--mcp-config", self.mcp_config, "--permission-prompt-tool", "mcp__edith_perm__approve"]
        if session:
            cmd += ["--resume", session, "--fork-session"]
        run = Run(ref, "side", origin)
        self._publish("turn.started", run, ref=ref, lane="side")
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
                return self._run_side(text, origin, ref)
            else:
                log.warning("side lane failed: code %s %s", run.proc.returncode, err[-300:])
                self._publish("turn.failed", run, ref=ref, lane="side", reason="error",
                              code=run.proc.returncode, stderr=err.strip()[-800:])
            return

        self._save_fork(result.get("session_id"))
        reply, is_error, subtype = result.get("result") or "", bool(result.get("is_error")), result.get("subtype", "unknown")
        self._remember_side_note(text, reply, is_error, subtype)
        self._publish("turn.done", run, ref=ref, lane="side", text=reply, steps=run.steps, elapsed=elapsed,
                      is_error=is_error, subtype=subtype)

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
        while True:
            try:
                job = self._main.get_nowait()
            except queue.Empty:
                break
            if job is None:
                self._main.put(None)  # keep a shutdown signal
                break
            dropped.append(job[2])
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
        return [RunInfo(r.ref, r.lane, r.started, r.step) for r in runs], self._main.qsize()

    def busy(self):
        return self.main_busy.is_set()

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

    def session_title(self, session_id):
        return self.sessions.title(session_id)

    def name_session(self, title):
        sid = self.current_session()
        if not sid:
            return None
        self.state.update(lambda s: s.setdefault("session_names", {}).__setitem__(sid, title[:60]))
        return sid

    def resume(self, session_id, before=None):
        if self.main_busy.is_set():
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

    def new_session(self):
        if self.main_busy.is_set():
            return "busy"
        if self.tmux.wait_ready(10):
            self.tmux.command("/clear")

        def cleared(state):
            state.get("sessions", {}).pop(self.key, None)
            state.pop("side_notes", None)
        self.state.update(cleared)
        self._publish("session.changed", "system", session_id=None, title=None, source="new")
        return "ok"

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
