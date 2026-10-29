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
# The docstring above is printed as help, word for word from legacy/edith/google/gmail.py. EDITH
# runs this as `gmail.py …` from ~/edith/google (a wrapper), so the guard hook still sees the same
# command. The mailbox comes from the mail port (EDITH_MAIL_ADAPTER, default google).
import argparse
import os
import sys

from edith.core import load_port

COMMANDS = ("unread", "search", "read", "thread", "mark-read", "archive", "draft", "send")


def mailbox():
    box = load_port("mail", "mail", os.environ.get("EDITH_MAIL_ADAPTER", "google"), {})
    if box is None:
        sys.exit("The mail adapter failed to load; see the error above.")
    return box


def print_list(items):
    if not items:
        print("No messages.")
    for m in items:
        unread = "●" if m.unread else " "
        print(f"{unread} [{m.id}] {m.date[:22]} | {m.sender[:40]} | {m.subject[:80]}\n    {m.snippet[:140]}")


def main(argv=None, box=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in COMMANDS:
        print(__doc__)
        return
    cmd, rest = argv[0], argv[1:]
    box = box or mailbox()
    if cmd == "unread":
        print_list(box.search("is:unread in:inbox", int(rest[0]) if rest else 10))
    elif cmd == "search":
        print_list(box.search(rest[0], int(rest[1]) if len(rest) > 1 else 10))
    elif cmd == "read":
        m = box.read(rest[0])
        print(f"From: {m.sender}\nTo: {m.to}\nDate: {m.date}\nSubject: {m.subject}\nThread: {m.thread_id}\n")
        print(m.body[:20000])
    elif cmd == "thread":
        for m in box.thread(rest[0]):
            print(f"--- {m.date} | {m.sender}\n{m.body[:6000]}\n")
    elif cmd in ("mark-read", "archive"):
        n = box.mark_read(rest) if cmd == "mark-read" else box.archive(rest)
        print(f"Done: {n} message(s).")
    else:
        p = argparse.ArgumentParser()
        p.add_argument("--to", required=True)
        p.add_argument("--subject", required=True)
        p.add_argument("--body", required=True)
        p.add_argument("--reply-to")
        a = p.parse_args(rest)
        if cmd == "draft":
            print(f"Draft saved (id {box.draft(a.to, a.subject, a.body, a.reply_to)}). It's in Gmail → Drafts.")
        else:
            print(f"Sent (id {box.send(a.to, a.subject, a.body, a.reply_to)}).")


if __name__ == "__main__":
    main()
