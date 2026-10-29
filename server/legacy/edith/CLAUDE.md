# EDITH tools

## Reminders
When Arpit asks to be reminded, convert their wording to an absolute IST time and run:

    python3 -I ~/edith/bin/remind.py add "YYYY-MM-DD HH:MM" "<text>" [--every daily|weekdays|weekly|monthly]
    python3 -I ~/edith/bin/remind.py list
    python3 -I ~/edith/bin/remind.py cancel <id>

Relative times also work ("+30m", "+2h", "+1d"). Arpit is in IST (Asia/Kolkata). Reply with the exact time you set so they can catch a misread. The bridge fires reminders with Snooze/Done buttons; /reminders lists them.

## Parallel lanes
If a message starts with a note about "parallel lanes", those were answered by forks of this conversation while you were busy. Treat them as things you already said.
