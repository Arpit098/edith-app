"""Email (today: Gmail via adapters/google). Read-only by default; sending needs Arpit's OK."""
from dataclasses import dataclass
from typing import Protocol


@dataclass
class MailSummary:
    id: str
    thread_id: str
    date: str     # the Date header as sent
    sender: str   # the From header
    subject: str
    snippet: str
    unread: bool


@dataclass
class MailMessage:
    id: str
    thread_id: str
    date: str
    sender: str
    to: str
    subject: str
    body: str     # plain text (HTML is converted)


class MailBox(Protocol):
    def search(self, query: str, limit: int = 10) -> list[MailSummary]:
        """Newest first, e.g. search("is:unread in:inbox")."""

    def read(self, message_id: str) -> MailMessage: ...

    def thread(self, thread_id: str) -> list[MailMessage]: ...

    def mark_read(self, message_ids: list[str]) -> int:
        """Returns how many messages were changed."""

    def archive(self, message_ids: list[str]) -> int:
        """Removes them from the inbox (never deletes). Returns how many were changed."""

    def draft(self, to: str, subject: str, body: str, reply_to: str | None = None) -> str:
        """Saves a draft and returns its id. reply_to is a message id to thread the reply under."""

    def send(self, to: str, subject: str, body: str, reply_to: str | None = None) -> str:
        """Sends and returns the message id. Only when Arpit has said yes."""
