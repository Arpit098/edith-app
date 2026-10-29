"""Gmail, implementing ports.mail.MailBox (from legacy/edith/google/gmail.py).

Listing N messages fetches their metadata in one batched request instead of N requests.
"""
import base64
import html
import re
from email.message import EmailMessage

from edith.ports.mail import MailMessage, MailSummary

from .api import batch, execute

ME = "me"


def hdr(msg, name):
    for h in msg.get("payload", {}).get("headers", []):
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def body_text(payload):
    """Prefer text/plain; fall back to stripped text/html."""
    plain, htm = [], []

    def walk(p):
        mt, data = p.get("mimeType", ""), p.get("body", {}).get("data")
        if data and mt == "text/plain":
            plain.append(base64.urlsafe_b64decode(data).decode("utf-8", "replace"))
        elif data and mt == "text/html":
            htm.append(base64.urlsafe_b64decode(data).decode("utf-8", "replace"))
        for c in p.get("parts", []) or []:
            walk(c)

    walk(payload)
    if plain:
        return "\n".join(plain).strip()
    t = re.sub(r"(?is)<(script|style).*?</\1>", "", "\n".join(htm))
    t = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", t)
    t = html.unescape(re.sub(r"<[^>]+>", "", t))
    return re.sub(r"\n\s*\n+", "\n\n", t).strip()


def _message(m):
    return MailMessage(id=m["id"], thread_id=m["threadId"], date=hdr(m, "Date"), sender=hdr(m, "From"),
                       to=hdr(m, "To"), subject=hdr(m, "Subject"), body=body_text(m["payload"]))


class GmailBox:
    def __init__(self, session):
        self._session = session

    @property
    def _g(self):
        return self._session.service("gmail", "v1")

    def search(self, query, limit=10):
        g = self._g
        res = execute(g.users().messages().list(userId=ME, q=query, maxResults=limit))
        ids = [m["id"] for m in res.get("messages", [])]
        gets = [g.users().messages().get(userId=ME, id=i, format="metadata",
                                         metadataHeaders=["From", "Subject", "Date"]) for i in ids]
        return [MailSummary(id=m["id"], thread_id=m.get("threadId", ""), date=hdr(m, "Date"), sender=hdr(m, "From"),
                            subject=hdr(m, "Subject"), snippet=m.get("snippet", ""),
                            unread="UNREAD" in m.get("labelIds", []))
                for m in batch(g, gets)]

    def read(self, message_id):
        return _message(execute(self._g.users().messages().get(userId=ME, id=message_id, format="full")))

    def thread(self, thread_id):
        t = execute(self._g.users().threads().get(userId=ME, id=thread_id, format="full"))
        return [_message(m) for m in t["messages"]]

    def _modify(self, ids, remove):
        execute(self._g.users().messages().batchModify(userId=ME, body={"ids": ids, "removeLabelIds": remove}))
        return len(ids)

    def mark_read(self, message_ids):
        return self._modify(message_ids, ["UNREAD"])

    def archive(self, message_ids):
        return self._modify(message_ids, ["INBOX"])

    def _build(self, to, subject, body, reply_to):
        msg = EmailMessage()
        msg["To"], msg["Subject"] = to, subject
        out = {}
        if reply_to:
            orig = execute(self._g.users().messages().get(userId=ME, id=reply_to, format="metadata",
                                                          metadataHeaders=["Message-ID", "Subject", "References"]))
            mid = hdr(orig, "Message-ID")
            if mid:
                msg["In-Reply-To"] = mid
                msg["References"] = (hdr(orig, "References") + " " + mid).strip()
            out["threadId"] = orig["threadId"]
        msg.set_content(body)
        out["raw"] = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        return out

    def draft(self, to, subject, body, reply_to=None):
        message = self._build(to, subject, body, reply_to)
        return execute(self._g.users().drafts().create(userId=ME, body={"message": message}))["id"]

    def send(self, to, subject, body, reply_to=None):
        message = self._build(to, subject, body, reply_to)
        return execute(self._g.users().messages().send(userId=ME, body=message))["id"]
