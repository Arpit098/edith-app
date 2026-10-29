#!/usr/bin/env python3
"""The fake `claude` executable (see claude.py). Stdlib only, no imports from the repo."""
import json
import os
import signal
import sys
import time


def main():
    if os.environ.get("FAKE_CLAUDE_LOG"):
        with open(os.environ["FAKE_CLAUDE_LOG"], "a") as f:
            f.write(json.dumps(sys.argv[1:]) + "\n")
    with open(os.environ["FAKE_CLAUDE_PLAN"]) as f:
        plan = json.load(f)
    if "--resume" in sys.argv and "if_resume" in plan:
        plan = plan["if_resume"]
    if plan.get("stderr_first"):
        sys.stderr.write(plan["stderr_first"])
        sys.stderr.flush()
    for ev in plan.get("events", []):
        if plan.get("hang") and ev.get("type") == "result":
            break  # keeps working: everything but the result, then wait to be stopped
        print(json.dumps(ev), flush=True)
        time.sleep(plan.get("delay", 0))
    if plan.get("hang"):
        signal.pause()  # until /stop or shutdown kills us
    sys.stderr.write(plan.get("stderr", ""))
    sys.exit(plan.get("exit", 0))


if __name__ == "__main__":
    main()
