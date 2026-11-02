"""Our own small tool loop (no Goose, no shell): ask the model, run the tools it calls, give it the
results, until it answers or MAX_TOOLS tool uses are spent. Everything sent out goes through
redact.scrub_messages first, at this one place."""
import time
from dataclasses import dataclass, field

from edith.common import usertime

from .chain import AllUnavailable, Chain
from .redact import scrub, scrub_messages

MAX_TOOLS = 8           # tool uses per message
CALL_TIMEOUT = 60.0     # seconds per model call
TURN_LIMIT = 240.0      # seconds for one whole answer

SYSTEM = """You are EDITH's backup assistant. Claude, EDITH's main AI, is unavailable right now (usage limit or \
login problem), so you answer Arpit on Telegram and in his app until Claude is back.

What you can do: read files under ~/edith, ~/Projects and the inbox, search them, check EDITH's services, \
logs, status, reminders, coding agents and the server, and search or read the web. Use the tools; don't guess.
What you can't do: write or change anything, run commands, send messages or mail, deploy, restart, or read \
mail and calendar. When Arpit asks for any of that, call queue_for_claude with a clear task for Claude, then \
tell him "I'll queue that for Claude." Never claim you did something you can't do.

Be brief and plain. Times are IST (Asia/Kolkata); it is now {now}. Never repeat anything that looks like a \
password, key or token."""


@dataclass
class Answer:
    text: str
    provider: object = None  # the ChatProvider that answered (None when none could)
    steps: int = 0
    unavailable: AllUnavailable | None = None
    tools_used: list = field(default_factory=list)


def answer(chain: Chain, tools, history: list[dict], question: str, on_step=lambda step, n: None,
           clock=time.monotonic) -> Answer:
    """Answer `question` with the last messages `history` ([{role, content}]) as context."""
    messages = [{"role": "system", "content": SYSTEM.format(now=usertime.stamp())}] + list(history) + \
               [{"role": "user", "content": question}]
    if hasattr(tools, "begin_turn"):
        tools.begin_turn(question)  # which links may be opened, and what web searches may not carry
    specs, used, provider, deadline = tools.specs(), 0, None, clock() + TURN_LIMIT
    names = []
    while True:
        offer = specs if used < MAX_TOOLS and clock() < deadline else []
        if not offer:
            messages.append({"role": "user", "content": "(No more tools for this message: answer now with what "
                                                         "you have.)"})
        try:
            provider, reply = chain.call(scrub_messages(messages), offer, CALL_TIMEOUT, prefer=provider)
        except AllUnavailable as e:
            return Answer("", None, used, e, names)
        calls = reply.tool_calls if offer else []
        if not calls:
            return Answer(reply.text or "(no answer)", provider, used, None, names)
        messages.append({"role": "assistant", "content": reply.text or "",
                         "tool_calls": [{"id": c.id, "type": "function",
                                         "function": {"name": c.name, "arguments": c.arguments}} for c in calls]})
        for c in calls:
            if used >= MAX_TOOLS:
                result = "error: the tool limit for this message is reached; answer now"
            else:
                used += 1
                names.append(c.name)
                on_step(f"{c.name}", used)
                result = tools.call(c.name, c.arguments)
            messages.append({"role": "tool", "tool_call_id": c.id, "content": scrub(result)})
