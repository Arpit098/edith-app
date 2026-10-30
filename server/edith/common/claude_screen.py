"""What a Claude Code screen in tmux shows (busy, blocked on a prompt, its last "●" line), read from
`tmux capture-pane` text. Used by the status panel and by account switching (which must not restart
a busy agent)."""
import re

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
BOX = re.compile(r"[─-▟]+")  # box drawing and block elements (borders, separators)
BOTTOM = 15  # lines at the end of the screen that hold Claude Code's prompt, footer and dialogs
PERMISSION = re.compile(r"Do you want to (?:proceed|make this edit|create|allow|run)|Would you like to proceed"
                        r"|❯\s*1\.\s*Yes", re.I)
USAGE_LIMIT = re.compile(r"usage limit reached|hit your limit|limit reached|limit will reset", re.I)
LAST_LINE = 100  # characters


def clean(line: str) -> str:
    return " ".join(BOX.sub(" ", ANSI.sub("", line)).split())


def read_screen(screen: str) -> dict:
    """What a Claude Code screen shows: {state: busy | idle | blocked, blocked: permission |
    usage_limit | None, last: the last "●" line or None}."""
    lines = [ln for ln in map(clean, screen.splitlines()) if ln]
    bottom = "\n".join(lines[-BOTTOM:])
    busy = "esc to interrupt" in bottom.lower()
    blocked = ("permission" if PERMISSION.search(bottom)
               else "usage_limit" if not busy and USAGE_LIMIT.search(bottom) else None)
    last = next((ln[1:].strip() for ln in reversed(lines) if ln.startswith("●")), None)
    if last and len(last) > LAST_LINE:
        last = last[:LAST_LINE - 1].rstrip() + "…"
    return {"state": "blocked" if blocked else "busy" if busy else "idle", "blocked": blocked, "last": last}
