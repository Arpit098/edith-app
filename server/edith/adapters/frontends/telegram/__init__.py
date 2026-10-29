"""Telegram bot frontend (long polling), moved from ~/edith/bridge/edith_bridge.py.

Arpit's messages become commands (from the registry), button presses (registry actions) or turns
for the agent; the agent's and features' events become the same Telegram messages, reactions and
edits the legacy bridge sent, in the same order (tests/test_telegram_e2e.py runs both side by side).

Changes from legacy:
- One poller thread and one ticker thread (typing… and status refreshes for every running turn,
  sleeping until the next one is due). Legacy ran a typing thread per turn.
- access.json is parsed again only when it changes (legacy re-read it for every message).
- The offset is saved before each update is handled, so a crash never replays a message.
- Network calls have timeouts and retries (api.py); polling backs off 1 s → 30 s on errors.
- Nothing is read until start(): building the adapter (e.g. `make check`) touches no file.
"""
import logging
import mimetypes
import os
import re
import threading
import time

from edith.common.paths import resolve
from edith.common.state import StateFile
from edith.common.text import take_directives
from edith.core import CommandCall, Reply

from .api import BotApi, allowed_ids, read_token

log = logging.getLogger("edith.adapter.telegram")

MAX_MSG = 4000
TYPING_EVERY = 4.5   # Telegram shows "typing…" for about 5 s
STATUS_EVERY = 3.0   # main-lane status refresh ("Working… 12s · 3 steps")

# Reactions bots may set (Telegram's standard set); anything else is rejected by the API.
REACTIONS = set("👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 "
                "🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 "
                "💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡".split())
FAILURES = {
    "not_ready": "❌ The Claude session in tmux isn't ready. Check: systemctl --user status edith-claude",
    "crashed": "❌ The Claude session in tmux exited; it restarts on its own. Send that again in a moment.",
}


def reply_to(msg_id):
    return {"message_id": msg_id, "allow_sending_without_reply": True} if msg_id else None


def markup(rows):
    """Reply buttons (Button objects or contract dicts) as a Telegram inline keyboard."""
    def one(b):
        return {"text": b["label"], "callback_data": b["action"]} if isinstance(b, dict) else \
            {"text": b.label, "callback_data": b.action}
    return {"inline_keyboard": [[one(b) for b in row] for row in rows]}


class Turn:
    def __init__(self, chat, msg_id, lane):
        self.chat, self.msg_id, self.lane = chat, msg_id, lane
        self.tag = "⚡ " if lane == "side" else ""
        self.status_id, self.started, self.steps, self.step, self.last_edit = None, time.time(), 0, None, 0.0
        self.next_typing = 0.0


class TelegramFrontend:
    name = "telegram"

    def __init__(self, config: dict, api=None):
        self.config = config
        self.paths = resolve(config)
        self.api = api
        self.poll = config.get("poll", True)
        self.bus = self.registry = self.agent = self.state = None
        self._turns: dict[str, Turn] = {}
        self._system: dict[str, tuple] = {}  # message.system key -> (chat, message_id)
        self._held_events: dict[str, list] = {}  # turn events waiting for their button press to be answered
        self._cond = threading.Condition()
        self._stopping = threading.Event()
        self._threads: list[threading.Thread] = []
        self._allowed_key, self._allowed = None, set()

    # ---- lifecycle ----

    def start(self, bus, registry, agent):
        self.bus, self.registry, self.agent = bus, registry, agent
        self.state = StateFile.at(self.paths.bridge_state)
        if self.api is None:
            self.api = BotApi(read_token(self.paths.telegram_dir))
        for pattern, handler in (("turn.*", self._on_turn), ("permission.*", self._on_permission),
                                 ("message.system", self._on_system), ("message.buttons_cleared", self._on_cleared)):
            bus.subscribe(pattern, handler, owner="telegram")
        self.api("deleteWebhook")
        self.api("setMyCommands", commands=registry.menu())
        if not self.state.get("clean_exit", True):
            for uid in self.allowed():
                self.api("sendMessage", chat_id=uid, text="⚠️ E.D.I.T.H restarted after a crash and is back online.")
        self.state.update(lambda s: s.__setitem__("clean_exit", False))
        workers = [("ticker", self._ticker)] + ([("poller", self._poller)] if self.poll else [])
        for name, target in workers:
            t = threading.Thread(target=target, name=f"telegram:{name}", daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self):
        self._stopping.set()
        with self._cond:
            self._cond.notify_all()
        if self.state:
            self.state.update(lambda s: s.__setitem__("clean_exit", True))
        for t in self._threads:
            if t.name == "telegram:ticker":  # the poller may be inside a 30 s long poll; it is a daemon
                t.join(5)

    def allowed(self):
        """Allowed sender ids from access.json, parsed again only when the file changes, so
        allowlist edits still apply without a restart (as legacy, which re-read it every time)."""
        try:
            st = os.stat(os.path.join(self.paths.telegram_dir, "access.json"))
            key = (st.st_ino, st.st_mtime_ns, st.st_size)
        except OSError:
            return set()
        if key != self._allowed_key:
            self._allowed, self._allowed_key = allowed_ids(self.paths.telegram_dir), key
        return self._allowed

    def default_chat(self):
        return next(iter(sorted(self.allowed())), None)

    # ---- sending ----

    def send_text(self, chat_id, text, **kw):
        text = text or "(empty reply)"
        last = None
        for i in range(0, len(text), MAX_MSG):
            last = self.api("sendMessage", chat_id=chat_id, text=text[i:i + MAX_MSG], **kw)
        return last

    def send_reply(self, chat_id, out):
        if isinstance(out, Reply):
            return self.send_text(chat_id, out.text, reply_markup=markup(out.buttons) if out.buttons else None)
        return self.send_text(chat_id, out)

    def react(self, chat_id, message_id, emoji):
        """Set the bot's reaction on one of Arpit's messages. Best effort, never raises."""
        if not message_id:
            return False
        emoji = emoji.replace("️", "")  # ❤️ -> ❤ etc.
        if emoji not in REACTIONS:
            return False
        return bool(self.api("setMessageReaction", timeout=10, chat_id=chat_id, message_id=message_id,
                             reaction=[{"type": "emoji", "emoji": emoji}]))

    def download(self, file_id, filename):
        info = self.api("getFile", file_id=file_id)
        if not info:
            return None
        os.makedirs(self.paths.inbox, exist_ok=True)
        dest = os.path.join(self.paths.inbox, f"{int(time.time())}_{re.sub(r'[^A-Za-z0-9._-]', '_', filename)}")
        return dest if self.api.download(info["file_path"], dest) else None

    # ---- incoming ----

    @staticmethod
    def ref(chat_id, msg_id):
        return f"tg:{chat_id}:{msg_id}"

    @staticmethod
    def parse_ref(ref):
        """-> (chat_id, message_id or None)."""
        if not ref or not ref.startswith("tg:"):
            return None, None
        _, chat, msg = ref.split(":", 2)
        return int(chat), (int(msg) if msg.isdigit() else None)

    def _poller(self):
        offset, failures = self.state.get("offset"), 0
        while not self._stopping.is_set():
            updates = self.api.get_updates(offset)
            if updates is None:
                failures += 1
                self._stopping.wait(min(30, 2 ** (failures - 1)))  # back off: 1, 2, 4 … 30 s
                continue
            failures = 0
            for u in updates:
                offset = u["update_id"] + 1
                self.state.update(lambda s: s.__setitem__("offset", offset))  # before handling: never replayed
                self.handle_update(u)

    def handle_update(self, u):
        try:
            if "message" in u:
                self.handle_message(u["message"])
            elif "callback_query" in u:
                self.handle_callback(u["callback_query"])
        except Exception:
            log.exception("update failed")

    def _prompt(self, msg, text):
        """The agent prompt for a message: header, text, the quoted message, attached files."""
        attachments = []
        if msg.get("photo"):
            attachments.append(self.download(msg["photo"][-1]["file_id"], "photo.jpg"))
        for kind in ("document", "voice", "audio", "video"):
            if msg.get(kind):
                f = msg[kind]
                attachments.append(self.download(f["file_id"], f.get("file_name") or
                                                 f"{kind}{mimetypes.guess_extension(f.get('mime_type', '')) or ''}"))
        attachments = [a for a in attachments if a]
        if not text and not attachments:
            return None
        prompt = f"[Telegram message from Arpit, {time.strftime('%Y-%m-%d %H:%M %Z')}]\n{text}"
        quoted = msg.get("reply_to_message")
        if quoted and (quoted.get("text") or quoted.get("caption")):
            who = "EDITH's" if quoted.get("from", {}).get("is_bot") else "an earlier"
            prompt += f"\n[Arpit is replying to {who} message: {(quoted.get('text') or quoted.get('caption'))[:1500]}]"
        for a in attachments:
            prompt += f"\n[Attached file saved at: {a}]"
        return prompt

    def handle_message(self, msg):
        chat_id = msg["chat"]["id"]
        if msg["chat"].get("type") != "private" or str(msg.get("from", {}).get("id")) not in self.allowed():
            return  # silently ignore strangers and groups
        msg_id = msg.get("message_id")
        text = (msg.get("text") or msg.get("caption") or "").strip()
        cmd = text.split()[0].split("@")[0].lower() if text.startswith("/") else None
        self.react(chat_id, msg_id, "👌" if cmd else "👀")
        ref = self.ref(chat_id, msg_id)
        command = self.registry.commands.get(cmd[1:]) if cmd else None
        if command:
            rest = text.split(None, 1)[1] if len(text.split(None, 1)) > 1 else ""
            prompt = self._prompt(msg, rest) if command.takes_prompt else None
            out = command.handler(CommandCall(rest, "telegram", lambda r: self.send_reply(chat_id, r), ref, prompt))
            if out is not None:
                self.send_reply(chat_id, out)
            return
        prompt = self._prompt(msg, text)
        if prompt:
            self.agent.send(prompt, "telegram", ref)

    def handle_callback(self, cb):
        if str(cb["from"]["id"]) not in self.allowed():
            self.api("answerCallbackQuery", callback_query_id=cb["id"], text="Not authorized.")
            return
        msg = cb.get("message", {})
        chat_id = msg.get("chat", {}).get("id") or cb["from"]["id"]
        held, holding = [], [True]
        ref = f"tg:{chat_id}:cb{cb['id']}"

        def reply(out):  # replies made during the press go out after the button is answered
            if holding[0]:
                held.append(out)
            else:
                self.send_reply(chat_id, out)
        with self._cond:
            self._held_events[ref] = []  # so does a turn the press starts (e.g. a quick action)
        try:
            result = self.registry.press(cb.get("data", ""), "telegram", reply, ref=ref)
        finally:
            holding[0] = False
        self.api("answerCallbackQuery", callback_query_id=cb["id"], text=result.toast if result else None)
        if result and result.note and msg:
            self.api("editMessageText", chat_id=msg["chat"]["id"], message_id=msg["message_id"],
                     text=f"{msg.get('text', '')}\n\n{result.note}")
        for out in held:
            self.send_reply(chat_id, out)
        while True:  # then the held turn events, in order (more may arrive while we send)
            with self._cond:
                events = self._held_events.get(ref) or []
                if not events:
                    self._held_events.pop(ref, None)
                    break
                self._held_events[ref] = []
            for ev in events:
                self._on_turn(ev)

    # ---- the agent's turns ----

    def _turn(self, data, create_lane=None):
        ref = data.get("ref")
        turn = self._turns.get(ref)
        if turn is None and create_lane:
            chat, msg_id = self.parse_ref(ref)
            if chat is None:
                return None
            turn = Turn(chat, msg_id, create_lane)
        return turn

    def _edit_or_send(self, turn, text):
        if turn.status_id:
            self.api("editMessageText", chat_id=turn.chat, message_id=turn.status_id, text=text)
        else:
            self.send_text(turn.chat, text)

    def _on_turn(self, ev):
        d, kind = ev.data, ev.type
        if ev.origin != "telegram" and d.get("ref") not in self._turns:
            return
        ref = d.get("ref")
        with self._cond:
            if ref in self._held_events:  # its button press hasn't been answered yet
                self._held_events[ref].append(ev)
                return
        if kind == "turn.queued":
            chat, msg_id = self.parse_ref(ref)
            self.react(chat, msg_id, "🥱")  # waiting in line
            self.send_text(chat, f"📥 Queued (#{d['position']}). I'll get to it after the current task. /stop to cancel.")
        elif kind == "turn.started":
            turn = self._turn(d, create_lane=d["lane"])
            if turn.lane == "side":
                self.react(turn.chat, turn.msg_id, "⚡")
                status = self.api("sendMessage", chat_id=turn.chat, text="⚡ ⏳ On it (parallel lane)…",
                                  reply_parameters=reply_to(turn.msg_id))
            else:
                self.react(turn.chat, turn.msg_id, "👨‍💻")
                status = self.api("sendMessage", chat_id=turn.chat, text="⏳ On it…")
            turn.status_id = status and status.get("message_id")
            with self._cond:
                self._turns[ref] = turn
                self._cond.notify_all()
        elif kind == "turn.progress":
            turn = self._turns.get(ref)
            if turn:
                turn.steps, turn.step = d["steps"], d["step"]
                if time.time() - turn.last_edit > STATUS_EVERY:
                    self._show_progress(turn)
        elif kind == "turn.retrying":
            turn = self._turns.pop(ref, None)
            if turn and turn.status_id:
                self.api("deleteMessage", chat_id=turn.chat, message_id=turn.status_id)
        elif kind == "turn.done":
            self._deliver(self._turns.pop(ref, None) or self._turn(d, create_lane=d["lane"]), d)
        elif kind == "turn.stopped":
            if d.get("lane") == "queued":
                chat, msg_id = self.parse_ref(ref)
                self.react(chat, msg_id, "🕊")  # dropped
                return
            turn = self._turns.pop(ref, None) or self._turn(d, create_lane=d["lane"])
            self.react(turn.chat, turn.msg_id, "🫡")
            self._edit_or_send(turn, f"{turn.tag}🛑 Stopped.")
        elif kind == "turn.failed":
            self._failed(self._turns.pop(ref, None), d)

    def _failed(self, turn, d):
        reason = d.get("reason")
        if turn is None:
            chat, msg_id = self.parse_ref(d.get("ref"))
            turn = Turn(chat, msg_id, d.get("lane") or "main")
            if reason == "not_ready":
                self.react(turn.chat, turn.msg_id, "👨‍💻")  # legacy reacted before finding tmux not ready
        if reason in ("bridge_error", "queue_full"):
            text = f"❌ Bridge error: {d.get('detail')}" if reason == "bridge_error" else \
                f"📥 The queue is full ({d.get('detail')}). /stop it or wait until I'm done."
            self.send_text(turn.chat, text)
            return
        self.react(turn.chat, turn.msg_id, "💔")
        if reason == "error":
            text = f"{turn.tag}❌ Claude exited unexpectedly (code {d.get('code')}).\n{d.get('stderr', '')}"
        else:
            text = FAILURES.get(reason, f"❌ {d.get('detail') or reason}")
        if reason == "not_ready":
            self.send_text(turn.chat, text)
        else:
            self._edit_or_send(turn, text)

    def _deliver(self, turn, d):
        """A finished turn's reply: strip SEND_FILE/REACT lines, react, attach files."""
        files, text = take_directives(d.get("text") or "", "SEND_FILE")
        picked, text = take_directives(text, "REACT")  # EDITH may pick a final reaction
        is_error = d.get("is_error")
        if is_error and not text:
            text = f"❌ Error: {d.get('subtype', 'unknown')}"
        if is_error:
            self.react(turn.chat, turn.msg_id, "😢")
        elif not (picked and self.react(turn.chat, turn.msg_id, picked[-1])):
            self.react(turn.chat, turn.msg_id, "👍")
        if turn.status_id:
            self.api("editMessageText", chat_id=turn.chat, message_id=turn.status_id,
                     text=f"{turn.tag}{'❌' if is_error else '✅'} Done in {d.get('elapsed', 0)}s · {d.get('steps', 0)} steps")
        # New message so the phone pings; parallel answers quote the message they answer.
        self.send_text(turn.chat, text, reply_parameters=reply_to(turn.msg_id) if turn.lane == "side" else None)
        for path in files:
            if os.path.isfile(path):
                self.api.send_file(turn.chat, path)
            else:
                self.send_text(turn.chat, f"⚠️ File not found: {path}")

    def _show_progress(self, turn):
        if turn.status_id and turn.step:
            self.api("editMessageText", chat_id=turn.chat, message_id=turn.status_id,
                     text=f"{turn.tag}⏳ Working… {int(time.time() - turn.started)}s · {turn.steps} steps\n🔧 {turn.step}")
            turn.last_edit = time.time()

    def _ticker(self):
        """typing… for every running turn, and the main lane's elapsed time, each when it is due."""
        while not self._stopping.is_set():
            now = time.time()
            due = []
            with self._cond:
                turns = list(self._turns.values())
            chats = set()
            for t in turns:
                if t.next_typing <= now and t.chat not in chats:
                    chats.add(t.chat)
                    t.next_typing = now + TYPING_EVERY
                    self.api("sendChatAction", chat_id=t.chat, action="typing", timeout=10)
                due.append(t.next_typing)
                if t.lane == "main" and t.step:
                    if now - t.last_edit >= STATUS_EVERY:
                        self._show_progress(t)
                    due.append(t.last_edit + STATUS_EVERY)
            with self._cond:
                if not self._stopping.is_set():
                    self._cond.wait(max(0.05, min(due) - time.time()) if due else None)

    # ---- permissions and feature messages ----

    def _on_permission(self, ev):
        d = ev.data
        turn = self._turns.get(d.get("ref"))
        if not turn:
            return
        if ev.type == "permission.request":
            self.react(turn.chat, turn.msg_id, "🙏")  # waiting on Arpit's approval
        elif d.get("decision") in ("allow", "deny"):
            self.react(turn.chat, turn.msg_id, "⚡" if turn.lane == "side" else "👨‍💻")  # back to work

    def _on_system(self, ev):
        d = ev.data
        turn = self._turns.get(d.get("ref"))
        chat = turn.chat if turn else self.default_chat()
        if chat is None:
            return
        rows = d.get("buttons") or []
        sent = self.send_text(chat, d["text"], reply_markup=markup(rows) if rows else None)
        if d.get("key") and sent:
            self._system[d["key"]] = (chat, sent.get("message_id"))

    def _on_cleared(self, ev):
        where = self._system.pop(ev.data.get("key"), None)
        if where:
            self.api("editMessageReplyMarkup", chat_id=where[0], message_id=where[1], reply_markup={"inline_keyboard": []})


def create(config: dict):
    return TelegramFrontend(config)
