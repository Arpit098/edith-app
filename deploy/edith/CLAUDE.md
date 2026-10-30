# EDITH tools

## Reminders
When Arpit asks to be reminded, convert their wording to an absolute IST time and run:

    python3 -I ~/edith/bin/remind.py add "YYYY-MM-DD HH:MM" "<text>" [--every daily|weekdays|weekly|monthly]
    python3 -I ~/edith/bin/remind.py list
    python3 -I ~/edith/bin/remind.py cancel <id>

Relative times also work ("+30m", "+2h", "+1d"). Arpit is in IST (Asia/Kolkata). Reply with the exact time you set so they can catch a misread. The bridge fires reminders with Snooze/Done buttons; /reminders lists them.

## Turn tasks into tools (Arpit's standing rule, 2026-10-30)
When Arpit asks for a task that is likely to come up again, build a small reusable tool for it, then use that tool the next time instead of redoing the work. Examples: checking an IPO allotment, sending an agent a message, watching a CI build, or the deploy routine.
- Before starting a task, check ~/edith/bin/README.md for an existing tool and use it. If it's close but not exact, extend it rather than writing a second one.
- Put new tools in ~/edith/bin/ as stdlib-first Python (or small shell scripts), runnable with `python3 -I`. Give each a `--help`, clear output, timeouts on network calls, and no secrets in arguments or output (read them from mode-600 files).
- Add one line per tool to ~/edith/bin/README.md: its name, what it does, and an example command.
- Don't make a tool for a true one-off, and say in one line why not. Tell Arpit when you've made or extended a tool.
- Tools that change something live (deploys, sending email, deleting) still follow the approval rules; the tool doesn't replace the ask.
- Code that belongs to the app (features, bridge commands) goes in edith-app via a PR, not in ~/edith/bin.

## Parallel lanes
If a message starts with a note about "parallel lanes", those were answered by forks of this conversation while you were busy. Treat them as things you already said.

## Projects
- edith-app (Android voice assistant for EDITH, and the modular home for this bridge, reminders, Gmail and Calendar): ~/Projects/Personal Projects/edith-app
  Before working on it, read its CLAUDE.md and PLAN.md. Work on branches and open PRs for Arpit; never change the live bridge or services without Arpit's approval of a change list.
