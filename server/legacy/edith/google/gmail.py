#!/usr/bin/env python3
"""EDITH Gmail helper (personal account arpitagrawal3048@gmail.com).

  gmail.py unread [N]                 latest N unread in Inbox (default 10)
  gmail.py search "<gmail query>" [N] e.g. "from:bank newer_than:7d"
  gmail.py read <id>                  full message (plain text)
  gmail.py thread <threadId>          whole conversation
  gmail.py mark-read <id> [...]       remove UNREAD label
  gmail.py archive <id> [...]         remove from Inbox (not deleted)
  gmail.py draft --to A --subject S --body B [--reply-to <id>]
  gmail.py send  --to A --subject S --body B [--reply-to <id>]   (needs Arpit's OK)

Never deletes mail permanently (scope doesn't allow it).
"""
import argparse
import base64
import html
import re
import sys
from email.message import EmailMessage

from gauth import service

G = service("gmail", "v1")
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


def summary(mid):
    m = G.users().messages().get(userId=ME, id=mid, format="metadata",
                                 metadataHeaders=["From", "Subject", "Date"]).execute()
    unread = "●" if "UNREAD" in m.get("labelIds", []) else " "
    return f"{unread} [{m['id']}] {hdr(m, 'Date')[:22]} | {hdr(m, 'From')[:40]} | {hdr(m, 'Subject')[:80]}\n    {m.get('snippet', '')[:140]}"


def list_q(q, n):
    res = G.users().messages().list(userId=ME, q=q, maxResults=n).execute()
    ids = [m["id"] for m in res.get("messages", [])]
    if not ids:
        print("No messages.")
    for i in ids:
        print(summary(i))


def read(mid):
    m = G.users().messages().get(userId=ME, id=mid, format="full").execute()
    print(f"From: {hdr(m, 'From')}\nTo: {hdr(m, 'To')}\nDate: {hdr(m, 'Date')}\nSubject: {hdr(m, 'Subject')}\n"
          f"Thread: {m['threadId']}\n")
    print(body_text(m["payload"])[:20000])


def thread(tid):
    t = G.users().threads().get(userId=ME, id=tid, format="full").execute()
    for m in t["messages"]:
        print(f"--- {hdr(m, 'Date')} | {hdr(m, 'From')}\n{body_text(m['payload'])[:6000]}\n")


def modify(ids, remove):
    G.users().messages().batchModify(userId=ME, body={"ids": ids, "removeLabelIds": remove}).execute()
    print(f"Done: {len(ids)} message(s).")


def build_msg(a):
    msg = EmailMessage()
    msg["To"], msg["Subject"] = a.to, a.subject
    body = {}
    if a.reply_to:
        orig = G.users().messages().get(userId=ME, id=a.reply_to, format="metadata",
                                        metadataHeaders=["Message-ID", "Subject", "References"]).execute()
        mid = hdr(orig, "Message-ID")
        if mid:
            msg["In-Reply-To"] = mid
            msg["References"] = (hdr(orig, "References") + " " + mid).strip()
        body["threadId"] = orig["threadId"]
    msg.set_content(a.body)
    body["raw"] = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return body


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd, rest = sys.argv[1], sys.argv[2:]
    if cmd == "unread":
        list_q("is:unread in:inbox", int(rest[0]) if rest else 10)
    elif cmd == "search":
        list_q(rest[0], int(rest[1]) if len(rest) > 1 else 10)
    elif cmd == "read":
        read(rest[0])
    elif cmd == "thread":
        thread(rest[0])
    elif cmd == "mark-read":
        modify(rest, ["UNREAD"])
    elif cmd == "archive":
        modify(rest, ["INBOX"])
    elif cmd in ("draft", "send"):
        p = argparse.ArgumentParser()
        p.add_argument("--to", required=True)
        p.add_argument("--subject", required=True)
        p.add_argument("--body", required=True)
        p.add_argument("--reply-to")
        body = build_msg(p.parse_args(rest))
        if cmd == "draft":
            d = G.users().drafts().create(userId=ME, body={"message": body}).execute()
            print(f"Draft saved (id {d['id']}). It's in Gmail → Drafts.")
        else:
            s = G.users().messages().send(userId=ME, body=body).execute()
            print(f"Sent (id {s['id']}).")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
