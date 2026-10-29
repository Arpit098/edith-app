#!/usr/bin/env python3
"""Claude Code hooks for the tmux-hosted E.D.I.T.H session (edith-claude.service).

Only active when EDITH_TMUX=1 (set by edith-claude.sh); headless side lanes and
manual runs in ~/edith fall straight through.

- SessionStart: records the live session id and transcript in tmux-session.json.
- UserPromptSubmit / Stop: appends prompt/stop events to tmux-events.jsonl so the
  bridge can tell which turn a reply belongs to (prompts carry a "[tg-ref <id>]" line).
- PermissionRequest: asks Arpit on Telegram through perm_mcp's Allow/Deny relay.
"""
import json
import os
import re
import sys
import time

STATE_DIR = os.path.expanduser("~/.cache/edith")
SESSION_FILE = os.path.join(STATE_DIR, "tmux-session.json")
EVENTS_FILE = os.path.join(STATE_DIR, "tmux-events.jsonl")
RUN_FILE = os.path.join(STATE_DIR, "tmux-run")  # bridge run id of the Telegram turn in progress
REF = re.compile(r"\[tg-ref ([0-9a-f]+)\]")


def append_event(ev):
    with open(EVENTS_FILE, "a") as f:
        f.write(json.dumps(ev) + "\n")


def main():
    data = json.load(sys.stdin)
    event = data.get("hook_event_name")
    if os.environ.get("EDITH_TMUX") != "1":
        # Parallel lanes (bridge-run `claude -p`, tagged with EDITH_RUN_ID) still get Telegram
        # approvals here, in case this hook pre-empts their --permission-prompt-tool.
        if event == "PermissionRequest" and os.environ.get("EDITH_RUN_ID"):
            relay_permission(data)
        return
    sid = data.get("session_id")
    os.makedirs(STATE_DIR, exist_ok=True)

    if event == "SessionStart":
        tmp = SESSION_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"session_id": sid, "transcript_path": data.get("transcript_path"),
                       "source": data.get("source"), "ts": time.time()}, f)
        os.replace(tmp, SESSION_FILE)
    elif event == "UserPromptSubmit":
        m = REF.search(data.get("prompt") or "")
        append_event({"event": "prompt", "ts": time.time(), "session_id": sid, "ref": m and m.group(1)})
    elif event == "Stop":
        text = data.get("last_assistant_message") or ""
        append_event({"event": "stop", "ts": time.time(), "session_id": sid,
                      "text": text if isinstance(text, str) else json.dumps(text)})
    elif event == "PermissionRequest":
        try:
            with open(RUN_FILE) as f:
                os.environ["EDITH_RUN_ID"] = f.read().strip()
        except OSError:
            pass
        relay_permission(data)


def relay_permission(data):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import perm_mcp
    result = perm_mcp.ask(data.get("tool_name", "?"), data.get("tool_input") or {})
    decision = {"behavior": result["behavior"]}
    if result["behavior"] == "deny":
        decision["message"] = result.get("message", "Denied on Telegram.")
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}))


if __name__ == "__main__":
    main()
