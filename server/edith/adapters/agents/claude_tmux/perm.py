#!/usr/bin/env python3
"""Minimal stdio MCP server that relays Claude Code permission prompts to Telegram.

Claude Code (headless, --permission-prompt-tool mcp__edith_perm__approve) calls the
`approve` tool whenever a tool use needs permission. We write the request to
PERM_DIR/<id>.req.json, the bridge shows Allow/Deny buttons on Telegram and writes
PERM_DIR/<id>.decision ("allow" or "deny"), and we answer Claude with the result.
"""
# From legacy/edith/bridge/perm_mcp.py, with the same protocol, files, timeout and answers. Also
# used by hook.py for the main lane's PermissionRequest hook. Changes from legacy:
# - ask() waits for the decision file on inotify (watch.py) instead of checking it every 0.5 s,
#   and only takes it once it is completely written (legacy could read a half-written, empty file
#   and treat it as "no approval").
# - PERM_DIR and TIMEOUT are read from the environment at call time.
import json
import os
import secrets
import sys
import time

TOOL = {
    "name": "approve",
    "description": "Ask Arpit on Telegram to allow or deny a tool use.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "tool_name": {"type": "string"},
            "input": {"type": "object"},
            "tool_use_id": {"type": "string"},
        },
        "required": ["tool_name", "input"],
    },
}


# Arpit doesn't want to approve file edits (project files, CLAUDE.md, memory, Claude
# settings, bridge code); EDITH only edits those when Arpit asks (2026-10-27).
# Only the safety guard hook and credentials still need a tap.
FILE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
PROTECTED = [
    os.path.expanduser("~/.claude/hooks/"),
    os.path.expanduser("~/.config/gcloud-keys/"),
    os.path.expanduser("~/.config/gcloud/"),
    os.path.expanduser("~/.config/gh/"),
    os.path.expanduser("~/.ssh/"),
]


def perm_dir():
    return os.path.expanduser(os.environ.get("EDITH_PERM_DIR") or os.path.join(
        os.environ.get("EDITH_STATE_DIR") or "~/.cache/edith", "perms"))


def timeout():
    """Seconds to wait for Arpit (EDITH_PERM_TIMEOUT, default 600); may be fractional."""
    value = float(os.environ.get("EDITH_PERM_TIMEOUT", "600"))
    return int(value) if value.is_integer() else value


__all__ = ["FILE_TOOLS", "PERM_DIR", "PROTECTED", "TIMEOUT", "TOOL", "ask", "auto_allow", "main", "perm_dir",
           "send", "timeout"]


def __getattr__(name):  # the legacy module constants, for the perm_mcp.py wrapper
    if name == "PERM_DIR":
        return perm_dir()
    if name == "TIMEOUT":
        return timeout()
    raise AttributeError(name)


def auto_allow(tool_name, tool_input):
    if tool_name not in FILE_TOOLS:
        return False
    path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if not path:
        return False
    path = os.path.realpath(os.path.expanduser(path))
    return not any(path == p.rstrip("/") or path.startswith(p) for p in PROTECTED)


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _decision(path):
    """The decision once it is fully written, else None."""
    try:
        with open(path) as f:
            return f.read().strip() or None
    except FileNotFoundError:
        return None


def ask(tool_name, tool_input):
    if auto_allow(tool_name, tool_input):
        return {"behavior": "allow", "updatedInput": tool_input}
    from .watch import IN_CLOSE_WRITE, IN_MOVED_TO, Watch, wait_for  # only when waiting for Arpit (ctypes is slow to import)
    folder, limit = perm_dir(), timeout()
    os.makedirs(folder, exist_ok=True)
    rid = secrets.token_hex(4)
    req = os.path.join(folder, f"{rid}.req.json")
    dec = os.path.join(folder, f"{rid}.decision")
    # The watch exists before the request does, so a decision can never slip past it.
    with Watch(folder, mask=IN_CLOSE_WRITE | IN_MOVED_TO) as watch:
        with open(req + ".tmp", "w") as f:
            json.dump({"id": rid, "tool_name": tool_name, "input": tool_input, "ts": time.time(),
                       "run": os.environ.get("EDITH_RUN_ID")}, f)
        os.replace(req + ".tmp", req)
        decision = wait_for(lambda: _decision(dec), watch, limit) or "timeout"
    for p in (req, dec):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass

    if decision == "allow":
        return {"behavior": "allow", "updatedInput": tool_input}
    reason = "Arpit denied this on Telegram." if decision == "deny" else \
        f"No approval from Arpit within {int(limit) // 60} minutes."
    return {"behavior": "deny", "message": reason}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        mid, method = msg.get("id"), msg.get("method")
        if mid is None:
            continue  # notification
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": msg["params"].get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "edith_perm", "version": "1.0"},
            }})
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [TOOL]}})
        elif method == "tools/call":
            args = msg["params"].get("arguments", {})
            result = ask(args.get("tool_name", "?"), args.get("input", {}))
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": json.dumps(result)}]}})
        elif method == "ping":
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        else:
            send({"jsonrpc": "2.0", "id": mid,
                  "error": {"code": -32601, "message": f"Unknown method {method}"}})


if __name__ == "__main__":
    main()
