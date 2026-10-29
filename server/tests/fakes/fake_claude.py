#!/usr/bin/env python3
"""The fake `claude` executable (see claude.py). Stdlib only, no imports from the repo."""
import json
import os
import sys
import time


def main():
    if os.environ.get("FAKE_CLAUDE_LOG"):
        with open(os.environ["FAKE_CLAUDE_LOG"], "a") as f:
            f.write(json.dumps(sys.argv[1:]) + "\n")
    with open(os.environ["FAKE_CLAUDE_PLAN"]) as f:
        plan = json.load(f)
    for ev in plan.get("events", []):
        print(json.dumps(ev), flush=True)
        time.sleep(plan.get("delay", 0))
    sys.stderr.write(plan.get("stderr", ""))
    sys.exit(plan.get("exit", 0))


if __name__ == "__main__":
    main()
