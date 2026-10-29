# EDITH tools

## Reminders
When Arpit asks to be reminded, convert their wording to an absolute IST time and run:

    python3 -I ~/edith/bin/remind.py add "YYYY-MM-DD HH:MM" "<text>" [--every daily|weekdays|weekly|monthly]
    python3 -I ~/edith/bin/remind.py list
    python3 -I ~/edith/bin/remind.py cancel <id>

Relative times also work ("+30m", "+2h", "+1d"). Arpit is in IST (Asia/Kolkata). Reply with the exact time you set so they can catch a misread. The bridge fires reminders with Snooze/Done buttons; /reminders lists them.

## Parallel lanes
If a message starts with a note about "parallel lanes", those were answered by forks of this conversation while you were busy. Treat them as things you already said.

## Projects
- edith-app (Android voice assistant for EDITH, and the modular home for this bridge, reminders, Gmail and Calendar): ~/Projects/Personal Projects/edith-app
  Before working on it, read its CLAUDE.md and PLAN.md. Work on branches and open PRs for Arpit; never change the live bridge or services without Arpit's approval of a change list.
