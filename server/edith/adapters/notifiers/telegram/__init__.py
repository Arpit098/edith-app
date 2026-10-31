"""Notifications sent as Telegram messages to Arpit (the first allowed chat), for the notifier port.

Uses the Telegram frontend's Bot API client (timeouts and retries) and the same token. Nothing is
read until the first notify().
"""
from edith.adapters.frontends.telegram.api import BotApi, allowed_ids, read_token
from edith.common.paths import resolve


class TelegramNotifier:
    name = "telegram"

    def __init__(self, config: dict, api=None):
        self.paths = resolve(config)
        self._api = api

    def notify(self, title: str, body: str, priority: str = "default", data: dict | None = None) -> bool:
        if self._api is None:
            self._api = BotApi(read_token(self.paths.telegram_dir))
        chat = next(iter(sorted(allowed_ids(self.paths.telegram_dir))), None)
        if chat is None:
            return False
        text = f"{title}\n{body}" if body else title
        return bool(self._api("sendMessage", chat_id=chat, text=text, disable_notification=priority == "low" or None))


def create(config: dict):
    return TelegramNotifier(config)
