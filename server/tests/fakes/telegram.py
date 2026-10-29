"""A fake Telegram Bot API that records every call.

It has the same call shape as the bridge's tg(method, timeout=40, **params), so it can replace it
in the legacy bridge and in the new Telegram adapter alike.
"""
import itertools
import threading


class FakeTelegram:
    def __init__(self, first_message_id: int = 1000, changed=None):
        self.changed = changed or threading.Condition()  # notified after every call, to wait on
        self.calls: list[tuple[str, dict]] = []   # (method, params), None params dropped like tg() does
        self.files: list[dict] = []               # send_file() calls
        self.updates: list[dict] = []             # handed out (and cleared) by the next getUpdates
        self._ids = itertools.count(first_message_id)

    def __call__(self, method: str, timeout: int = 40, **params):
        params = {k: v for k, v in params.items() if v is not None}
        try:
            return self._answer(method, params)
        finally:
            self._notify()

    def once(self, method: str, timeout: int = 40, **params):
        """BotApi.once (a single attempt): recorded like any call."""
        return self(method, timeout, **params)

    def _notify(self):
        with self.changed:
            self.changed.notify_all()

    def wait(self, check, timeout=20):
        """Block until check() is true (re-checked after every call), or fail after `timeout`."""
        with self.changed:
            if not self.changed.wait_for(check, timeout):
                raise AssertionError("timed out waiting")

    def _answer(self, method, params):
        self.calls.append((method, params))
        if method == "sendMessage":
            sent = {"message_id": next(self._ids), "chat": {"id": params["chat_id"]}, "text": params.get("text", "")}
            if "reply_markup" in params:
                sent["reply_markup"] = params["reply_markup"]
            return sent
        if method == "getUpdates":
            out, self.updates = self.updates, []
            return out
        if method == "getFile":
            return {"file_path": f"files/{params['file_id']}"}
        return True

    def send_file(self, chat_id, path: str, caption: str | None = None) -> bool:
        self.files.append({"chat_id": chat_id, "path": path, "caption": caption})
        self.calls.append(("send_file", {k: v for k, v in (("chat_id", chat_id), ("path", path), ("caption", caption)) if v}))
        self._notify()
        return True

    def get_updates(self, offset, timeout=30):
        """The new frontend's long poll (legacy calls getUpdates through urllib itself)."""
        self.calls.append(("getUpdates", {"offset": offset}))
        out, self.updates = self.updates, []
        return out

    def download(self, file_path: str, dest: str) -> bool:
        """Stands in for fetching a file Arpit sent: writes a small placeholder."""
        with open(dest, "wb") as f:
            f.write(b"fake " + file_path.encode())
        return True

    def texts(self) -> list[str]:
        return [p["text"] for m, p in self.calls if m == "sendMessage"]

    def record(self) -> list[dict]:
        """Calls as plain data, for golden files."""
        return [{"method": m, **p} for m, p in self.calls]


def message(text: str = "", chat_id: int = 111, user_id: int = 111, message_id: int = 1, **extra) -> dict:
    """A Telegram `message` update from Arpit (a private chat by default)."""
    msg = {"message_id": message_id, "chat": {"id": chat_id, "type": "private"},
           "from": {"id": user_id, "is_bot": False}, "text": text}
    msg.update(extra)
    return msg


def callback(data: str, chat_id: int = 111, user_id: int = 111, message_id: int = 500,
             text: str = "", cb_id: str = "cb1") -> dict:
    """A `callback_query` update: Arpit pressed a button on message `message_id`."""
    return {"id": cb_id, "from": {"id": user_id}, "data": data,
            "message": {"message_id": message_id, "chat": {"id": chat_id}, "text": text}}
