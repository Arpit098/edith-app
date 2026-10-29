"""Main lane = interactive Claude in tmux (-L edith); side lanes = claude -p forks. Moved from the bridge.

hook.py and perm.py run as separate processes (Claude Code hooks and the permission MCP server),
the hook on every tool call, so this file imports nothing at import time: the adapter itself
(backend.py) loads only when create() is called.
"""


def create(config: dict):
    from .backend import ClaudeTmux
    return ClaudeTmux(config)
