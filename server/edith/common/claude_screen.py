"""What a Claude Code screen in tmux shows (busy, blocked on a prompt, its last "●" line), read from
`tmux capture-pane` text. Used by the status panel and by account switching (which must not restart
a busy agent)."""
import re

from .usertime import USAGE_LIMIT, localize_limit_text

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
BOX = re.compile(r"[─-▟]+")  # box drawing and block elements (borders, separators)
BOTTOM = 15  # lines at the end of the screen that hold Claude Code's prompt, footer and dialogs
PERMISSION = re.compile(r"Do you want to (?:proceed|make this edit|create|allow|run)|Would you like to proceed"
                        r"|❯\s*1\.\s*Yes", re.I)
# USAGE_LIMIT (from usertime): Claude Code's own limit wording, never a bare "limit reached".
BLOCK = ("●", "⎿")  # how Claude Code starts a message or a tool's output
# The menu Claude shows at a rate limit ("What do you want to do?" … "Stop and wait for limit to
# reset"): a dialog, so it is read before the permission prompt it looks like.
LIMIT_MENU = re.compile(r"stop and wait for (?:the )?limit to reset", re.I)
MENU_QUESTION = re.compile(r"what do you want to do\?", re.I)
LAST_LINE = 100  # characters


def clean(line: str) -> str:
    return " ".join(BOX.sub(" ", ANSI.sub("", line)).split())


def read_screen(screen: str) -> dict:
    """What a Claude Code screen shows: {state: busy | idle | blocked, blocked: permission |
    usage_limit | None, last: the last "●" line or None}."""
    lines = [ln for ln in map(clean, screen.splitlines()) if ln]
    bottom = "\n".join(lines[-BOTTOM:])
    busy = "esc to interrupt" in bottom.lower()
    menu = LIMIT_MENU.search(bottom) or (MENU_QUESTION.search(bottom) and USAGE_LIMIT.search(bottom))
    # Without the menu, only the newest ●/⎿ line saying it: older output, or text further down a
    # reply, isn't the state Claude is in now.
    newest = next((ln for ln in reversed(lines) if ln.startswith(BLOCK)), "")
    blocked = ("usage_limit" if menu
               else "permission" if PERMISSION.search(bottom)
               else "usage_limit" if not busy and USAGE_LIMIT.search(newest) else None)
    last = next((localize_limit_text(ln[1:].strip()) for ln in reversed(lines) if ln.startswith("●")), None)
    if last and len(last) > LAST_LINE:
        last = last[:LAST_LINE - 1].rstrip() + "…"
    return {"state": "blocked" if blocked else "busy" if busy else "idle", "blocked": blocked, "last": last}
