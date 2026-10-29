#!/usr/bin/env python3
"""E.D.I.T.H Telegram bridge: Telegram <-> Claude Code.

- Long-polls the Telegram Bot API; only senders in access.json allowFrom are served.
- Main lane: an interactive `claude` in tmux (edith-claude.service, socket `-L edith`,
  watch it with edith-attach). Messages are pasted into it; hooks/edith_hook.py reports
  each turn's prompt, reply and permission prompts back. Everything runs in ~/edith, so
  ~/edith/.claude settings, permissions and the EDITH output style apply.
- One main-lane task at a time. If it's busy, new messages run at once in a parallel lane
  (`claude -p`, a fork of the conversation, up to MAX_SIDE at a time); the main lane is
  told what the parallel lanes did on its next turn. /queue forces the main lane instead.
- Reminders (reminders.py, added via ~/edith/bin/remind.py) are fired from here.
- Permission prompts (sudo / rm -rf) go through perm_mcp.py (parallel lanes) or the
  PermissionRequest hook (main lane) and come back here as Allow/Deny buttons.
- Commands: /new, /stop, /status, /sessions, /resume, /name, /queue, /menu, quick
  actions, /reminders, /restart, /help.

Stdlib only, so it runs with the system python3.
"""
import json
import mimetypes
import os
import queue
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reminders  # noqa: E402

HOME = os.path.expanduser("~")
TG_DIR = os.environ.get("TELEGRAM_STATE_DIR", os.path.join(HOME, ".claude/channels/telegram"))
WORK_DIR = os.path.join(HOME, "edith")
BRIDGE_DIR = os.path.join(WORK_DIR, "bridge")
STATE_DIR = os.path.join(HOME, ".cache/edith")
PERM_DIR = os.path.join(STATE_DIR, "perms")
INBOX = os.path.join(WORK_DIR, "inbox")
STATE_FILE = os.path.join(STATE_DIR, "bridge-state.json")
CLAUDE = os.environ.get("CLAUDE_BIN", os.path.join(HOME, ".local/bin/claude"))
MAX_MSG = 4000
MAX_SIDE = 2  # parallel lanes allowed while the main lane is busy

TMUX = ["tmux", "-L", "edith"]
TMUX_TARGET = "edith"
TMUX_SESSION_FILE = os.path.join(STATE_DIR, "tmux-session.json")  # written by the SessionStart hook
TMUX_EVENTS = os.path.join(STATE_DIR, "tmux-events.jsonl")  # prompt/stop events from the hooks
TMUX_RUN_FILE = os.path.join(STATE_DIR, "tmux-run")  # lets the permission hook tag its request
LAUNCH = os.path.join(BRIDGE_DIR, "edith-claude.sh")
PROJECT_DIR = os.path.join(HOME, ".claude/projects", re.sub(r"[^A-Za-z0-9]", "-", WORK_DIR))


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def read_token():
    tok = os.environ.get("TELEGRAM_BOT_TOKEN")
    if tok:
        return tok
    with open(os.path.join(TG_DIR, ".env")) as f:
        for line in f:
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    sys.exit("No TELEGRAM_BOT_TOKEN found")


def allowed_ids():
    # Re-read on every message so allowlist edits apply without a restart.
    try:
        with open(os.path.join(TG_DIR, "access.json")) as f:
            return {str(x) for x in json.load(f).get("allowFrom", [])}
    except (OSError, ValueError):
        return set()


def default_chat():
    return next(iter(sorted(allowed_ids())), None)


TOKEN = read_token()
API = f"https://api.telegram.org/bot{TOKEN}/"


# ---------- Telegram API ----------

def tg(method, timeout=40, **params):
    data = json.dumps({k: v for k, v in params.items() if v is not None}).encode()
    req = urllib.request.Request(API + method, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r).get("result")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        if "message is not modified" not in body:
            log(f"tg {method} HTTP {e.code}: {body[:200]}")
        if e.code == 409:
            time.sleep(5)  # another poller is using this token
        return None
    except Exception as e:
        log(f"tg {method} error: {e}")
        return None


def tg_send_file(chat_id, path, caption=None):
    boundary = secrets.token_hex(16)
    name = os.path.basename(path)
    is_photo = name.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
    field, method = ("photo", "sendPhoto") if is_photo else ("document", "sendDocument")
    with open(path, "rb") as f:
        content = f.read()
    parts = [f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}\r\n".encode()]
    if caption:
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{caption}\r\n".encode())
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{name}\"\r\n"
                 f"Content-Type: {ctype}\r\n\r\n".encode() + content + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(API + method, data=b"".join(parts),
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r).get("ok")
    except Exception as e:
        log(f"send file {path} failed: {e}")
        return False


def send_text(chat_id, text, **kw):
    text = text or "(empty reply)"
    last = None
    for i in range(0, len(text), MAX_MSG):
        last = tg("sendMessage", chat_id=chat_id, text=text[i:i + MAX_MSG], **kw)
    return last


def reply_to(msg_id):
    return {"message_id": msg_id, "allow_sending_without_reply": True} if msg_id else None


# Reactions bots may set (Telegram's standard set); anything else is rejected by the API.
REACTIONS = set("👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 "
                "🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 "
                "💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡".split())


def react(chat_id, message_id, emoji):
    """Set the bot's reaction on one of Arpit's messages. Best effort, never raises."""
    if not message_id:
        return False
    emoji = emoji.replace("️", "")  # ❤️ -> ❤ etc.
    if emoji not in REACTIONS:
        return False
    return bool(tg("setMessageReaction", timeout=10, chat_id=chat_id, message_id=message_id,
                   reaction=[{"type": "emoji", "emoji": emoji}]))


def download(file_id, filename):
    info = tg("getFile", file_id=file_id)
    if not info:
        return None
    os.makedirs(INBOX, exist_ok=True)
    dest = os.path.join(INBOX, f"{int(time.time())}_{re.sub(r'[^A-Za-z0-9._-]', '_', filename)}")
    urllib.request.urlretrieve(f"https://api.telegram.org/file/bot{TOKEN}/{info['file_path']}", dest)
    return dest


# ---------- State ----------

def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


state = load_state()
state_lock = threading.Lock()
jobs = queue.Queue()
runs = {}  # run id -> {proc, chat_id, msg_id, started, step, side}
runs_lock = threading.Lock()
main_busy = threading.Event()  # set while the worker owns a main-lane job


# ---------- Claude runs ----------

def describe_tool(name, inp):
    if name == "Bash":
        return f"$ {inp.get('description') or inp.get('command', '')}"[:120]
    for key in ("file_path", "path", "pattern", "url", "query"):
        if key in inp:
            return f"{name}: {inp[key]}"[:120]
    return name


def run_claude(chat_id, prompt, msg_id=None, side=False):
    """Run one Claude turn. Main lane resumes (and saves) the conversation; a side lane
    forks it so the two never write to the same session."""
    session = state.get("sessions", {}).get(str(chat_id))
    react(chat_id, msg_id, "⚡" if side else "👨‍💻")
    cmd = [CLAUDE, "-p", prompt, "--output-format", "stream-json", "--verbose",
           "--mcp-config", os.path.join(BRIDGE_DIR, "mcp.json"),
           "--permission-prompt-tool", "mcp__edith_perm__approve"]
    if session:
        cmd += ["--resume", session] + (["--fork-session"] if side else [])

    tag = "⚡ " if side else ""
    status = tg("sendMessage", chat_id=chat_id,
                text=f"{tag}⏳ On it{' (parallel lane)' if side else ''}…",
                reply_parameters=reply_to(msg_id) if side else None)
    status_id = status and status.get("message_id")
    started = time.time()
    rid = secrets.token_hex(3)
    run = {"proc": None, "chat_id": chat_id, "msg_id": msg_id, "started": started, "step": None, "side": side}
    steps, last_edit, result = 0, 0.0, None

    env = dict(os.environ, EDITH_PERM_DIR=PERM_DIR, EDITH_RUN_ID=rid)
    proc = subprocess.Popen(cmd, cwd=WORK_DIR, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, env=env, start_new_session=True)
    run["proc"] = proc
    with runs_lock:
        runs[rid] = run

    def save_session(sid):
        if not sid:
            return
        with state_lock:
            if side:  # remember forks so /sessions can hide them
                forks = state.setdefault("side_sessions", [])
                if sid not in forks:
                    forks.append(sid)
                    del forks[:-200]
            else:
                state.setdefault("sessions", {})[str(chat_id)] = sid
            save_state(state)

    def typing():
        while proc.poll() is None:
            tg("sendChatAction", chat_id=chat_id, action="typing", timeout=10)
            time.sleep(4.5)
    threading.Thread(target=typing, daemon=True).start()

    try:
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "system" and ev.get("session_id"):
                save_session(ev["session_id"])
            elif ev.get("type") == "assistant":
                for block in ev.get("message", {}).get("content", []):
                    if block.get("type") == "tool_use":
                        steps += 1
                        run["step"] = describe_tool(block.get("name", ""), block.get("input", {}))
            elif ev.get("type") == "result":
                result = ev
            if status_id and run["step"] and time.time() - last_edit > 3:
                elapsed = int(time.time() - started)
                tg("editMessageText", chat_id=chat_id, message_id=status_id,
                   text=f"{tag}⏳ Working… {elapsed}s · {steps} steps\n🔧 {run['step']}")
                last_edit = time.time()
        proc.wait()
        err = proc.stderr.read()
    finally:
        with runs_lock:
            runs.pop(rid, None)
    elapsed = int(time.time() - started)

    if result is None:
        if proc.returncode in (-signal.SIGTERM, -signal.SIGKILL, 143, 137):
            msg = f"{tag}🛑 Stopped."
            react(chat_id, msg_id, "🫡")
        elif session and "No conversation found" in err:
            # Session expired or deleted: start fresh once.
            with state_lock:
                state.get("sessions", {}).pop(str(chat_id), None)
                save_state(state)
            if status_id:
                tg("deleteMessage", chat_id=chat_id, message_id=status_id)
            return run_claude(chat_id, prompt, msg_id, side)
        else:
            msg = f"{tag}❌ Claude exited unexpectedly (code {proc.returncode}).\n{err.strip()[-800:]}"
            react(chat_id, msg_id, "💔")
        if status_id:
            tg("editMessageText", chat_id=chat_id, message_id=status_id, text=msg)
        else:
            send_text(chat_id, msg)
        log("run failed", proc.returncode, err[-300:])
        return

    save_session(result.get("session_id"))
    deliver(chat_id, msg_id, result.get("result") or "", result.get("is_error"), status_id,
            elapsed, steps, side=side, prompt=prompt, subtype=result.get("subtype", "unknown"))


def deliver(chat_id, msg_id, text, is_error, status_id, elapsed, steps, side=False, prompt="",
            subtype="unknown"):
    """Send a finished turn's reply: strip SEND_FILE/REACT lines, react, attach files."""
    tag = "⚡ " if side else ""
    files = re.findall(r"^\s*SEND_FILE:\s*(\S+)\s*$", text, flags=re.M)
    text = re.sub(r"^\s*SEND_FILE:\s*\S+\s*$\n?", "", text, flags=re.M).strip()
    # EDITH may pick a final reaction with a "REACT: <emoji>" line; the bridge strips it.
    picked = re.findall(r"^\s*REACT:\s*(\S+)\s*$", text, flags=re.M)
    text = re.sub(r"^\s*REACT:\s*\S+\s*$\n?", "", text, flags=re.M).strip()
    if is_error and not text:
        text = f"❌ Error: {subtype}"
    if is_error:
        react(chat_id, msg_id, "😢")
    elif not (picked and react(chat_id, msg_id, picked[-1])):
        react(chat_id, msg_id, "👍")

    if side:
        # The main conversation never saw this; hand it over on its next turn.
        asked = prompt.split("\n", 1)[-1]
        with state_lock:
            notes = state.setdefault("side_notes", [])
            notes.append({"q": asked[:400], "a": text[:1200]})
            del notes[:-5]
            save_state(state)

    if status_id:
        tg("editMessageText", chat_id=chat_id, message_id=status_id,
           text=f"{tag}{'❌' if is_error else '✅'} Done in {elapsed}s · {steps} steps")
    # New message so the phone pings; parallel answers quote the message they answer.
    send_text(chat_id, text, reply_parameters=reply_to(msg_id) if side else None)
    for path in files:
        if os.path.isfile(path):
            tg_send_file(chat_id, path)
        else:
            send_text(chat_id, f"⚠️ File not found: {path}")


# ---------- Main lane: interactive Claude in tmux ----------

def tmux(*args, input=None):
    return subprocess.run(TMUX + list(args), input=input, capture_output=True, text=True)


def tmux_alive():
    return tmux("has-session", "-t", TMUX_TARGET).returncode == 0


def tmux_session():
    try:
        with open(TMUX_SESSION_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def tmux_ready(timeout=90):
    """Make sure the tmux Claude is up and showing its input box."""
    if not tmux_alive():
        subprocess.run(["systemctl", "--user", "start", "edith-claude"], capture_output=True)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if tmux_alive() and READY.search(tmux("capture-pane", "-p", "-t", TMUX_TARGET).stdout):
            return True
        time.sleep(1)
    return False


READY = re.compile(r"^\s*❯", re.M)


def tmux_type(text):
    """Paste text into Claude's input box (bracketed paste keeps newlines) and submit it."""
    tmux("load-buffer", "-b", "tg", "-", input=text)
    tmux("paste-buffer", "-p", "-d", "-b", "tg", "-t", TMUX_TARGET)
    time.sleep(0.7)
    tmux("send-keys", "-t", TMUX_TARGET, "Enter")


def tmux_command(cmd):
    """Run a slash command (e.g. /clear) in the tmux Claude."""
    tmux("send-keys", "-t", TMUX_TARGET, "-l", cmd)
    time.sleep(0.5)
    tmux("send-keys", "-t", TMUX_TARGET, "Enter")


def read_new(path, offset):
    """Complete JSON lines appended to path since offset -> (objects, raw lines, new offset)."""
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return [], [], offset
    end = data.rfind(b"\n") + 1
    objs, raws = [], []
    for raw in data[:end].decode(errors="replace").splitlines():
        try:
            objs.append(json.loads(raw))
            raws.append(raw)
        except ValueError:
            pass
    return objs, raws, offset + end


def file_size(path):
    try:
        return os.path.getsize(path)
    except (OSError, TypeError):
        return 0


def run_tmux(chat_id, prompt, msg_id=None):
    """Main lane: hand the message to the interactive Claude in tmux and relay the turn back.

    The hooks log a "prompt" event when our message (tagged [tg-ref <rid>]) is submitted and a
    "stop" event with the final reply; the transcript is tailed for live progress and for an
    Esc interrupt (which doesn't fire Stop)."""
    react(chat_id, msg_id, "👨‍💻")
    if not tmux_ready():
        react(chat_id, msg_id, "💔")
        send_text(chat_id, "❌ The Claude session in tmux isn't ready. Check: systemctl --user status edith-claude")
        return
    status = tg("sendMessage", chat_id=chat_id, text="⏳ On it…")
    status_id = status and status.get("message_id")
    started = time.time()
    rid = secrets.token_hex(3)
    run = {"proc": None, "tmux": True, "chat_id": chat_id, "msg_id": msg_id, "started": started,
           "step": None, "side": False}
    with runs_lock:
        runs[rid] = run
    with open(TMUX_RUN_FILE, "w") as f:
        f.write(rid)

    def typing():
        while not run.get("done"):
            tg("sendChatAction", chat_id=chat_id, action="typing", timeout=10)
            time.sleep(4.5)
    threading.Thread(target=typing, daemon=True).start()

    ref = f"[tg-ref {rid}]"
    ev_off = file_size(TMUX_EVENTS)
    tr_path = tmux_session().get("transcript_path")
    tr_off = file_size(tr_path)
    steps, last_edit, text, outcome, sid = 0, 0.0, None, None, None
    submitted = False
    try:
        tmux_type(f"{prompt}\n{ref}")
        while outcome is None:
            time.sleep(0.5)
            events, _, ev_off = read_new(TMUX_EVENTS, ev_off)
            for ev in events:
                if ev.get("event") == "prompt" and ev.get("ref") == rid:
                    submitted, sid = True, ev.get("session_id")
                elif ev.get("event") == "stop" and submitted:
                    text, sid, outcome = ev.get("text") or "", ev.get("session_id") or sid, "done"
            cur = tmux_session().get("transcript_path")
            if cur != tr_path:  # /clear or a resume switched transcripts
                tr_path, tr_off = cur, 0
            entries, raws, tr_off = read_new(tr_path, tr_off) if tr_path else ([], [], 0)
            for entry, raw in zip(entries, raws):
                if ref in raw:
                    submitted = True  # also covers a message queued into a running turn
                if not submitted or entry.get("isSidechain"):
                    continue
                content = entry.get("message", {}).get("content")
                if entry.get("type") == "assistant" and isinstance(content, list):
                    for block in content:
                        if block.get("type") == "tool_use":
                            steps += 1
                            run["step"] = describe_tool(block.get("name", ""), block.get("input", {}))
                elif entry.get("type") == "user" and "[Request interrupted by user" in raw and outcome is None:
                    outcome = "stopped"
            if outcome is None and run.get("stop_requested") and time.time() - run["stop_requested"] > 15:
                outcome = "stopped"
            if outcome is None and not tmux_alive():
                outcome = "crashed"
            if outcome is None and status_id and run["step"] and time.time() - last_edit > 3:
                tg("editMessageText", chat_id=chat_id, message_id=status_id,
                   text=f"⏳ Working… {int(time.time() - started)}s · {steps} steps\n🔧 {run['step']}")
                last_edit = time.time()
    finally:
        run["done"] = True
        with runs_lock:
            runs.pop(rid, None)
        try:
            os.remove(TMUX_RUN_FILE)
        except OSError:
            pass
    elapsed = int(time.time() - started)

    if sid:  # parallel lanes fork from whatever the tmux session is now
        with state_lock:
            state.setdefault("sessions", {})[str(chat_id)] = sid
            save_state(state)
    if outcome != "done":
        msg = "🛑 Stopped." if outcome == "stopped" else \
            "❌ The Claude session in tmux exited; it restarts on its own. Send that again in a moment."
        react(chat_id, msg_id, "🫡" if outcome == "stopped" else "💔")
        if status_id:
            tg("editMessageText", chat_id=chat_id, message_id=status_id, text=msg)
        else:
            send_text(chat_id, msg)
        return
    deliver(chat_id, msg_id, text, False, status_id, elapsed, steps)


def session_title(sid, max_lines=400):
    """A conversation's /name, else its first real message (Telegram headers stripped)."""
    name = state.get("session_names", {}).get(sid)
    if name:
        return name
    try:
        with open(os.path.join(PROJECT_DIR, f"{sid}.jsonl")) as f:
            for i, raw in enumerate(f):
                if i >= max_lines:
                    break
                try:
                    entry = json.loads(raw)
                except ValueError:
                    continue
                if entry.get("type") != "user" or entry.get("isMeta"):
                    continue
                content = entry.get("message", {}).get("content")
                if isinstance(content, list):
                    content = " ".join(b.get("text", "") for b in content if b.get("type") == "text")
                if not isinstance(content, str) or content.lstrip().startswith("<"):
                    continue
                lines = [ln.strip() for ln in content.splitlines()
                         if ln.strip() and not ln.strip().startswith(("[", "- Arpit:", "EDITH:"))]
                if lines:
                    return lines[0][:60]
    except OSError:
        pass
    return None


def recent_sessions(limit=8):
    """Recent conversations, newest first, skipping parallel-lane forks: [(sid, title, mtime)]."""
    forks = set(state.get("side_sessions", []))
    try:
        names = [n for n in os.listdir(PROJECT_DIR) if n.endswith(".jsonl")]
    except OSError:
        return []
    files = sorted(((os.path.getmtime(os.path.join(PROJECT_DIR, n)), n[:-6]) for n in names), reverse=True)
    out, seen = [], set()
    for mtime, sid in files:
        if sid in forks:
            continue
        title = session_title(sid)
        # Older forks weren't tracked; they share their parent's first message, so keep the newest.
        if title and title not in seen:
            seen.add(title)
            out.append((sid, title, mtime))
        if len(out) >= limit:
            break
    return out


def ago(ts):
    s = int(time.time() - ts)
    return f"{s // 60}m ago" if s < 3600 else f"{s // 3600}h ago" if s < 86400 else f"{s // 86400}d ago"


def list_sessions(chat_id):
    items = recent_sessions()
    if not items:
        send_text(chat_id, "No saved conversations yet.")
        return
    current = tmux_session().get("session_id")
    lines, rows = ["🗂 Recent conversations (tap to switch):"], []
    for i, (sid, title, mtime) in enumerate(items, 1):
        mark = " ◀ current" if sid == current else ""
        lines.append(f"{i}. {title} · {ago(mtime)}{mark}")
        rows.append([{"text": f"{i}. {title[:40]}", "callback_data": f"sess:{sid}"}])
    with state_lock:
        state["last_listing"] = [sid for sid, _, _ in items]
        save_state(state)
    send_text(chat_id, "\n".join(lines) + "\n\n/name <title> names the current one.",
              reply_markup={"inline_keyboard": rows})


def find_session(arg):
    """/resume argument -> session id: a number from /sessions, a name, or an id prefix."""
    listing = state.get("last_listing", [])
    if arg.isdigit() and 0 < int(arg) <= len(listing):
        return listing[int(arg) - 1]
    for sid, name in state.get("session_names", {}).items():
        if name.lower() == arg.lower():
            return sid
    matches = [n[:-6] for n in os.listdir(PROJECT_DIR) if n.startswith(arg) and n.endswith(".jsonl")]
    return matches[0] if len(matches) == 1 else None


def resume_session(chat_id, sid):
    if main_busy.is_set():
        send_text(chat_id, "⚠️ I'm in the middle of a task. /stop it first, then switch.")
        return
    if not os.path.exists(os.path.join(PROJECT_DIR, f"{sid}.jsonl")):
        send_text(chat_id, "❌ That conversation doesn't exist any more.")
        return
    if tmux_session().get("session_id") == sid:
        send_text(chat_id, "Already in that conversation.")
        return
    send_text(chat_id, f"🔄 Switching to: {session_title(sid) or sid[:8]}…")
    main_busy.set()  # keep new messages off the main lane while Claude restarts
    try:
        t0 = time.time()
        if tmux_alive():
            tmux("respawn-pane", "-k", "-t", TMUX_TARGET, f"{LAUNCH} {sid}")
        else:
            subprocess.run(["systemctl", "--user", "start", "edith-claude"], capture_output=True)
        while time.time() < t0 + 60 and tmux_session().get("ts", 0) < t0:  # SessionStart hook fired
            time.sleep(1)
        if not tmux_ready(30):
            send_text(chat_id, "❌ The session didn't come back up. Check: systemctl --user status edith-claude")
            return
    finally:
        if jobs.empty():
            main_busy.clear()
    with state_lock:
        state.setdefault("sessions", {})[str(chat_id)] = tmux_session().get("session_id") or sid
        state.pop("side_notes", None)
        save_state(state)
    send_text(chat_id, "▶️ Switched. Carry on where we left off.")


def with_side_notes(prompt):
    with state_lock:
        notes = state.pop("side_notes", None)
        if notes:
            save_state(state)
    if not notes:
        return prompt
    lines = ["[While you were busy, parallel lanes (forks of this conversation) handled these. "
             "You didn't see them, so here they are for context:]"]
    for n in notes:
        lines.append(f"- Arpit: {n['q']}\n  EDITH: {n['a']}")
    return "\n".join(lines) + "\n\n" + prompt


def safe_run(chat_id, prompt, msg_id, side):
    try:
        if side:
            run_claude(chat_id, prompt, msg_id, side)
        else:
            run_tmux(chat_id, prompt, msg_id)
    except Exception as e:
        log("run error:", repr(e))
        send_text(chat_id, f"❌ Bridge error: {e}")


def worker():
    while True:
        chat_id, prompt, msg_id = jobs.get()
        main_busy.set()
        try:
            safe_run(chat_id, with_side_notes(prompt), msg_id, False)
        finally:
            if jobs.empty():
                main_busy.clear()


def dispatch(chat_id, prompt, msg_id, force_queue=False):
    """Main lane if it's free; otherwise a parallel lane if one is free; otherwise queue."""
    with runs_lock:
        sides = sum(1 for r in runs.values() if r["side"])
    if not main_busy.is_set() and jobs.empty():
        main_busy.set()
        jobs.put((chat_id, prompt, msg_id))
    elif not force_queue and sides < MAX_SIDE:
        threading.Thread(target=safe_run, args=(chat_id, prompt, msg_id, True), daemon=True).start()
    else:
        react(chat_id, msg_id, "🥱")  # waiting in line
        send_text(chat_id, f"📥 Queued (#{jobs.qsize() + 1}). I'll get to it after the current task. /stop to cancel.")
        jobs.put((chat_id, prompt, msg_id))


# ---------- Reminders ----------

def reminder_buttons(r):
    return {"inline_keyboard": [
        [{"text": "+15m", "callback_data": f"rem:snooze:15:{r['id']}"},
         {"text": "+1h", "callback_data": f"rem:snooze:60:{r['id']}"},
         {"text": "Tomorrow 9am", "callback_data": f"rem:snooze:tm:{r['id']}"}],
        [{"text": "✅ Done", "callback_data": f"rem:done:{r['id']}"}]]}


def reminder_loop():
    while True:
        try:
            for r in reminders.pop_due():
                chat_id = r.get("chat_id") or default_chat()
                if chat_id is None:
                    continue
                text = f"⏰ {r['text']}"
                if r.get("every"):
                    text += f"\n🔁 {r['every']}"
                if time.time() - r["due"] > 120:
                    text += f"\n(late, was due {reminders.fmt(r['due'])} IST)"
                send_text(chat_id, text, reply_markup=reminder_buttons(r))
        except Exception as e:
            log("reminder error:", repr(e))
        time.sleep(15)


def list_reminders(chat_id):
    items = reminders.pending()
    if not items:
        send_text(chat_id, "No reminders set. Just tell me, e.g. \"remind me Friday 5pm to renew the domain\".")
        return
    lines = ["⏰ Upcoming reminders (IST):"]
    rows = []
    for i, r in enumerate(items[:20], 1):
        lines.append(f"{i}. {reminders.fmt(r['due'])}{' 🔁 ' + r['every'] if r.get('every') else ''} - {r['text']}")
        rows.append([{"text": f"❌ Cancel {i}", "callback_data": f"rem:cancel:{r['id']}"}])
    send_text(chat_id, "\n".join(lines), reply_markup={"inline_keyboard": rows})


def handle_reminder_callback(cb, data):
    msg = cb.get("message", {})
    parts = data.split(":")
    action, rid = parts[1], parts[-1]
    if action == "cancel":
        r = reminders.cancel(rid)
        tg("answerCallbackQuery", callback_query_id=cb["id"], text="Cancelled." if r else "Already gone.")
        if r and msg:
            tg("sendMessage", chat_id=msg["chat"]["id"], text=f"❌ Cancelled: {r['text']}")
        return
    if action == "done":
        r = next((x for x in reminders.pending() if x["id"] == rid and x.get("every")), None)
        if not r:  # one-off (fired or snoozed): clear it; repeating ones keep going
            reminders.cancel(rid)
        label = "✅ Done"
    else:
        when = reminders.tomorrow_at(9) if parts[2] == "tm" else time.time() + int(parts[2]) * 60
        r = reminders.snooze(rid, when)
        if not r:
            tg("answerCallbackQuery", callback_query_id=cb["id"], text="That reminder has expired.")
            return
        label = f"💤 Snoozed to {reminders.fmt(r['due'])}"
    tg("answerCallbackQuery", callback_query_id=cb["id"], text=label)
    if msg:
        tg("editMessageText", chat_id=msg["chat"]["id"], message_id=msg["message_id"],
           text=f"{msg.get('text', '')}\n\n{label}")


# ---------- Permission relay ----------

pending_perms = {}  # request id -> (message, run id)


def perm_watcher():
    os.makedirs(PERM_DIR, exist_ok=True)
    while True:
        for name in os.listdir(PERM_DIR):
            if not name.endswith(".req.json"):
                continue
            rid = name[:-len(".req.json")]
            if rid in pending_perms:
                continue
            try:
                with open(os.path.join(PERM_DIR, name)) as f:
                    req = json.load(f)
            except (OSError, ValueError):
                continue
            run = runs.get(req.get("run") or "")
            inp = req.get("input", {})
            detail = inp.get("command") or inp.get("file_path") or json.dumps(inp)[:500]
            text = f"🔐 Permission needed{' (parallel lane)' if run and run['side'] else ''}: " \
                   f"{req.get('tool_name')}\n\n{detail}"
            keyboard = {"inline_keyboard": [[
                {"text": "✅ Allow", "callback_data": f"perm:allow:{rid}"},
                {"text": "❌ Deny", "callback_data": f"perm:deny:{rid}"}]]}
            chat_id = (run and run["chat_id"]) or default_chat()
            if chat_id is None:
                continue
            msg = tg("sendMessage", chat_id=chat_id, text=text, reply_markup=keyboard)
            pending_perms[rid] = (msg, req.get("run"))
            if run:
                react(chat_id, run["msg_id"], "🙏")  # waiting on Arpit's approval
        # Forget requests that the MCP side has already cleaned up (answered or timed out).
        for rid in list(pending_perms):
            if not os.path.exists(os.path.join(PERM_DIR, f"{rid}.req.json")):
                msg, _ = pending_perms.pop(rid)
                if msg and "reply_markup" in msg:
                    tg("editMessageReplyMarkup", chat_id=msg["chat"]["id"], message_id=msg["message_id"],
                       reply_markup={"inline_keyboard": []})
        time.sleep(0.5)


def handle_callback(cb):
    if str(cb["from"]["id"]) not in allowed_ids():
        tg("answerCallbackQuery", callback_query_id=cb["id"], text="Not authorized.")
        return
    data = cb.get("data", "")
    if data.startswith("rem:"):
        return handle_reminder_callback(cb, data)
    if data.startswith("sess:"):
        tg("answerCallbackQuery", callback_query_id=cb["id"], text="Switching…")
        chat_id = cb.get("message", {}).get("chat", {}).get("id") or cb["from"]["id"]
        threading.Thread(target=resume_session, args=(chat_id, data[5:]), daemon=True).start()
        return
    if data.startswith("quick:") and "/" + data[6:] in QUICK:
        tg("answerCallbackQuery", callback_query_id=cb["id"], text="On it")
        chat_id = cb.get("message", {}).get("chat", {}).get("id") or cb["from"]["id"]
        dispatch(chat_id, quick_prompt("/" + data[6:]), None)
        return
    m = re.fullmatch(r"perm:(allow|deny):([0-9a-f]+)", data)
    if not m:
        tg("answerCallbackQuery", callback_query_id=cb["id"])
        return
    decision, rid = m.groups()
    if not os.path.exists(os.path.join(PERM_DIR, f"{rid}.req.json")):
        tg("answerCallbackQuery", callback_query_id=cb["id"], text="That request has expired.")
        return
    with open(os.path.join(PERM_DIR, f"{rid}.decision"), "w") as f:
        f.write(decision)
    label = "✅ Allowed" if decision == "allow" else "❌ Denied"
    tg("answerCallbackQuery", callback_query_id=cb["id"], text=label)
    msg = cb.get("message", {})
    if msg:
        tg("editMessageText", chat_id=msg["chat"]["id"], message_id=msg["message_id"],
           text=f"{msg.get('text', '')}\n\n{label}")
    _, run_id = pending_perms.pop(rid, (None, None))
    run = runs.get(run_id or "")
    if run:
        react(run["chat_id"], run["msg_id"], "⚡" if run["side"] else "👨‍💻")  # back to work


# ---------- Quick actions ----------

GOOGLE = "cd ~/edith/google && ~/edith/venv/bin/python"
QUICK = {
    "/brief": ("☀️ Brief", "Give me a short brief for today: my calendar (" + GOOGLE + " gcal.py today), "
               "unread emails that actually matter (" + GOOGLE + " gmail.py unread; skip promotions and "
               "newsletters), and reminders due today (python3 -I ~/edith/bin/remind.py list)."),
    "/mail": ("📧 Mail", "Summarise my unread emails that matter (" + GOOGLE + " gmail.py unread). Skip "
              "promotions, newsletters and notifications. Flag anything that needs a reply. Read-only."),
    "/today": ("📅 Today", "What's on my calendar today, and the first thing tomorrow? (" + GOOGLE +
               " gcal.py today / tomorrow). Mention gaps where I'm free and any reminders due today "
               "(python3 -I ~/edith/bin/remind.py list)."),
    "/servers": ("🖥 Servers", "Read-only health check, no changes: this server (disk, memory, load, the "
                 "edith-bridge service) and Cracker GCP via --configuration=cracker (VM status, Cloud Run "
                 "services and their latest revision status, error logs from the last hour). Lead with "
                 "'all good' or what's wrong."),
    "/changes": ("📝 Changes", "show changes"),
}


def quick_prompt(cmd):
    return f"[Quick action {cmd} from Arpit, {time.strftime('%Y-%m-%d %H:%M %Z')}]\n{QUICK[cmd][1]}"


def menu_keyboard():
    names = [c[1:] for c in QUICK]
    rows = [[{"text": QUICK["/" + n][0], "callback_data": f"quick:{n}"} for n in names[i:i + 3]]
            for i in range(0, len(names), 3)]
    return {"inline_keyboard": rows}


# ---------- Incoming messages ----------

HELP = ("I'm E.D.I.T.H. Just text me what you need.\n\n"
        "If I'm busy, new messages run in a parallel lane straight away (up to 2).\n\n"
        "/menu – quick action buttons\n"
        "/brief /mail /today /servers /changes – quick actions\n"
        "/reminders – upcoming reminders (say \"remind me…\" to add one)\n"
        "/queue <task> – wait for the current task instead of running in parallel\n"
        "/new – start a fresh conversation\n"
        "/sessions – switch back to an earlier conversation\n"
        "/resume <n|name> – switch by number or name\n"
        "/name <title> – name the current conversation\n"
        "/stop – stop all running tasks\n"
        "/status – what I'm doing right now\n"
        "/restart – restart the bridge (after updates)\n"
        "/help – this message")


def handle_message(msg):
    chat_id = msg["chat"]["id"]
    if msg["chat"].get("type") != "private" or str(msg.get("from", {}).get("id")) not in allowed_ids():
        return  # silently ignore strangers and groups

    msg_id = msg.get("message_id")
    text = (msg.get("text") or msg.get("caption") or "").strip()
    cmd = text.split()[0].split("@")[0].lower() if text.startswith("/") else None
    react(chat_id, msg_id, "👌" if cmd else "👀")

    if cmd in ("/start", "/help"):
        send_text(chat_id, HELP)
        return
    if cmd == "/menu":
        send_text(chat_id, "Quick actions:", reply_markup=menu_keyboard())
        return
    if cmd in QUICK:
        dispatch(chat_id, quick_prompt(cmd), msg_id)
        return
    if cmd == "/reminders":
        list_reminders(chat_id)
        return
    if cmd == "/new":
        if main_busy.is_set():
            send_text(chat_id, "⚠️ I'm in the middle of a task. /stop it first, then /new.")
            return
        if tmux_ready(10):
            tmux_command("/clear")
        with state_lock:
            state.get("sessions", {}).pop(str(chat_id), None)
            state.pop("side_notes", None)
            save_state(state)
        send_text(chat_id, "🆕 Fresh conversation started. The old one is still in /sessions.")
        return
    if cmd == "/sessions":
        list_sessions(chat_id)
        return
    if cmd == "/resume":
        arg = text.split(None, 1)[1].strip() if len(text.split(None, 1)) > 1 else ""
        sid = find_session(arg) if arg else None
        if not sid:
            list_sessions(chat_id)
            return
        threading.Thread(target=resume_session, args=(chat_id, sid), daemon=True).start()
        return
    if cmd == "/name":
        title = text.split(None, 1)[1].strip() if len(text.split(None, 1)) > 1 else ""
        sid = tmux_session().get("session_id")
        if not title or not sid:
            send_text(chat_id, "Usage: /name <title>, e.g. /name youtube automation")
            return
        with state_lock:
            state.setdefault("session_names", {})[sid] = title[:60]
            save_state(state)
        send_text(chat_id, f"🏷 This conversation is now \"{title[:60]}\".")
        return
    if cmd == "/stop":
        dropped = 0
        while not jobs.empty():
            q_chat, _, q_msg = jobs.get_nowait()
            react(q_chat, q_msg, "🕊")  # dropped
            dropped += 1
        with runs_lock:
            live = [r for r in runs.values() if r.get("tmux") or r["proc"].poll() is None]
        for r in live:
            if r.get("tmux"):
                tmux("send-keys", "-t", TMUX_TARGET, "Escape")  # interrupt, like pressing Esc
                r["stop_requested"] = time.time()
            else:
                os.killpg(r["proc"].pid, signal.SIGTERM)
        if live or dropped:
            send_text(chat_id, f"🛑 Stopping {len(live)} task(s)." +
                      (f" Also dropped {dropped} queued message(s)." if dropped else ""))
        else:
            send_text(chat_id, "Nothing is running.")
        return
    if cmd == "/status":
        with runs_lock:
            live = sorted(runs.values(), key=lambda r: r["started"])
        if live:
            lines = [f"{'⚡ Parallel' if r['side'] else '⏳ Main'}: {int(time.time() - r['started'])}s\n"
                     f"   🔧 {r['step'] or 'thinking'}" for r in live]
            send_text(chat_id, "\n".join(lines) + f"\nQueued: {jobs.qsize()}")
        else:
            send_text(chat_id, "💤 Idle. " + ("Conversation in progress." if state.get("sessions", {}).get(str(chat_id))
                                             else "No conversation yet."))
        sid = tmux_session().get("session_id")
        send_text(chat_id, f"🖥 tmux session: {'running' if tmux_alive() else 'down'}"
                           + (f" · {session_title(sid) or sid[:8]}" if sid else "")
                           + "\nWatch live: ssh in, then edith-attach")
        return
    if cmd == "/restart":
        with runs_lock:
            busy = len(runs)
        if busy and text.split()[1:2] != ["now"]:
            send_text(chat_id, f"⚠️ {busy} task(s) running; a restart would kill them. Send /restart now to force.")
            return
        send_text(chat_id, "🔄 Restarting the bridge, back in a few seconds.")
        os.kill(os.getpid(), signal.SIGTERM)  # systemd (Restart=always) brings it back
        return

    force_queue = cmd == "/queue"
    if force_queue:
        text = text.split(None, 1)[1] if len(text.split(None, 1)) > 1 else ""

    attachments = []
    if msg.get("photo"):
        attachments.append(download(msg["photo"][-1]["file_id"], "photo.jpg"))
    for kind in ("document", "voice", "audio", "video"):
        if msg.get(kind):
            f = msg[kind]
            attachments.append(download(f["file_id"], f.get("file_name") or f"{kind}{mimetypes.guess_extension(f.get('mime_type', '')) or ''}"))
    attachments = [a for a in attachments if a]

    if not text and not attachments:
        return
    prompt = f"[Telegram message from Arpit, {time.strftime('%Y-%m-%d %H:%M %Z')}]\n{text}"
    quoted = msg.get("reply_to_message")
    if quoted and (quoted.get("text") or quoted.get("caption")):
        who = "EDITH's" if quoted.get("from", {}).get("is_bot") else "an earlier"
        prompt += f"\n[Arpit is replying to {who} message: {(quoted.get('text') or quoted.get('caption'))[:1500]}]"
    for a in attachments:
        prompt += f"\n[Attached file saved at: {a}]"

    dispatch(chat_id, prompt, msg_id, force_queue)


def main():
    os.makedirs(PERM_DIR, exist_ok=True)
    for name in os.listdir(PERM_DIR):  # stale requests from a previous run
        os.remove(os.path.join(PERM_DIR, name))
    try:
        os.remove(TMUX_RUN_FILE)
    except OSError:
        pass
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=perm_watcher, daemon=True).start()
    threading.Thread(target=reminder_loop, daemon=True).start()

    tg("deleteWebhook")
    tg("setMyCommands", commands=[
        {"command": "menu", "description": "Quick action buttons"},
        {"command": "brief", "description": "Today's brief: calendar, mail, reminders"},
        {"command": "mail", "description": "Unread emails that matter"},
        {"command": "today", "description": "Today's calendar"},
        {"command": "servers", "description": "Server + Cracker health check"},
        {"command": "changes", "description": "Recent file changes"},
        {"command": "reminders", "description": "Upcoming reminders"},
        {"command": "queue", "description": "Run after the current task"},
        {"command": "new", "description": "Start a fresh conversation"},
        {"command": "sessions", "description": "Switch to an earlier conversation"},
        {"command": "name", "description": "Name the current conversation"},
        {"command": "stop", "description": "Stop all running tasks"},
        {"command": "status", "description": "What E.D.I.T.H is doing"},
        {"command": "restart", "description": "Restart the bridge"},
        {"command": "help", "description": "Help"}])

    if not state.get("clean_exit", True):
        for uid in allowed_ids():
            tg("sendMessage", chat_id=uid, text="⚠️ E.D.I.T.H restarted after a crash and is back online.")
    with state_lock:
        state["clean_exit"] = False
        save_state(state)

    def shutdown(*_):
        with state_lock:
            state["clean_exit"] = True
            save_state(state)
        with runs_lock:
            live = list(runs.values())
        for r in live:
            if r["proc"] and r["proc"].poll() is None:  # the tmux Claude keeps running
                os.killpg(r["proc"].pid, signal.SIGTERM)
        sys.exit(0)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    log("E.D.I.T.H bridge running")
    offset = state.get("offset")
    while True:
        updates = tg_get_updates(offset)
        if updates is None:
            time.sleep(3)
            continue
        for u in updates:
            offset = u["update_id"] + 1
            with state_lock:
                state["offset"] = offset  # in memory, so /restart's shutdown saves past its own message
            try:
                if "message" in u:
                    handle_message(u["message"])
                elif "callback_query" in u:
                    handle_callback(u["callback_query"])
            except Exception as e:
                log("update error:", repr(e))
        if updates:
            with state_lock:
                state["offset"] = offset
                save_state(state)


def tg_get_updates(offset):
    data = json.dumps({"offset": offset, "timeout": 30,
                       "allowed_updates": ["message", "callback_query"]}).encode()
    req = urllib.request.Request(API + "getUpdates", data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.load(r).get("result", [])
    except urllib.error.HTTPError as e:
        log(f"getUpdates HTTP {e.code}: {e.read().decode(errors='replace')[:200]}")
        if e.code == 409:
            time.sleep(5)
        return None
    except Exception as e:
        log(f"getUpdates error: {e}")
        return None


if __name__ == "__main__":
    main()
