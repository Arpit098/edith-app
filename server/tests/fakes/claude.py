"""A fake `claude -p` binary for side-lane tests: point CLAUDE_BIN (or the adapter's config) at FAKE_CLAUDE.

It reads a plan from the JSON file in $FAKE_CLAUDE_PLAN, prints its stream-json events, writes
its stderr, then exits with its code. If $FAKE_CLAUDE_LOG is set, it appends its argv there as a
JSON line, so tests can check flags such as --resume and --fork-session. A plan may hold
"if_resume" (another plan, used when run with --resume), "stderr_first" (written before stdout) and
"hang" (print everything but the result, then wait until killed: a turn that is still working).
"""
import json
import os
import pathlib

FAKE_CLAUDE = str(pathlib.Path(__file__).with_name("fake_claude.py"))


def plan(session_id: str = "sess-1", reply: str = "Done.", tools=(("Bash", {"command": "ls"}),),
         exit_code: int = 0, stderr: str = "", delay: float = 0.0, events: list | None = None, **extra) -> dict:
    """A plan: by default init, one tool call per `tools`, then a result."""
    if events is None:
        events = [{"type": "system", "subtype": "init", "session_id": session_id}]
        for name, inp in tools:
            events.append({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": name, "input": inp}]}})
        events.append({"type": "result", "subtype": "success", "is_error": False, "result": reply,
                       "session_id": session_id})
    return {"events": events, "exit": exit_code, "stderr": stderr, "delay": delay, **extra}


def write_plan(directory, **kw) -> str:
    """Write a plan file (see plan()) and return its path."""
    path = os.path.join(directory, "fake-claude-plan.json")
    with open(path, "w") as f:
        json.dump(plan(**kw), f)
    return path
