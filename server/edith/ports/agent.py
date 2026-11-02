"""The coding agent that does the work (today: Claude Code in tmux, plus `claude -p` side lanes)."""
from dataclasses import dataclass, field
from typing import Callable, Protocol


@dataclass
class TurnHandle:
    ref: str
    lane: str  # "main" | "side" | "queued" (waits for the main lane; a turn.queued event says where)


@dataclass
class StopResult:
    running: int  # turns that were told to stop
    dropped: list[str] = field(default_factory=list)  # refs of queued messages that were dropped


@dataclass
class RunInfo:
    ref: str
    lane: str
    started: float
    step: str | None  # the latest tool summary, None while thinking


class AgentBackend(Protocol):
    max_side_lanes: int  # side lanes that can run while the main lane is busy

    def start(self, bus) -> None:
        """Begin working (threads, watchers). Progress and replies arrive as events on `bus`."""

    def send(self, text: str, origin: str, ref: str, force_queue: bool = False, parallel: bool = False) -> TurnHandle:
        """Start a turn: the main lane if free. While it is busy: a side lane when `parallel` (/btw)
        and one is free, else the queue, where the running turn reads it before its answer (delivery
        "mid_turn"). force_queue (/queue): the queue, for a turn of its own. Results arrive as events
        (contracts/events.md)."""

    def stop(self) -> StopResult:
        """Interrupt running turns and drop queued ones (each dropped one gets turn.stopped, lane "queued")."""

    def status(self) -> tuple[list[RunInfo], int]:
        """Running turns (oldest first) and the number of queued messages."""

    def background(self) -> list[dict]:
        """Work the main session started in the background and that still runs, after its turn may
        have ended: [{id, kind: "shell" | "agent", label, started}] oldest first. Changes also come
        as `background.changed` events."""

    def subagents(self, with_last: bool = True) -> list[dict]:
        """The main session's subagents (its Agent calls, foreground or background): [{id,
        description, type, model, effort, background, state: "running" | "done" | "failed" |
        "stopped", started, ended, last}] oldest first, finished ones for 30 minutes after they
        ended (contracts/status.md, "Subagents"). with_last=False leaves `last` out and reads no
        subagent files. Changes also come as `subagents.changed` events."""

    def busy(self) -> bool:
        """True while the main lane is working or has messages queued."""

    def hold(self) -> None:
        """Start no work until release(): new messages wait in the queue (no turn and no side lane
        starts), and the interactive session is not started, resumed or cleared. A Claude account
        switch holds the agent while it restarts every Claude."""

    def release(self) -> None:
        """End a hold; the waiting messages run in order."""

    def held(self) -> bool: ...

    def tmux_alive(self) -> bool:
        """Whether the main lane's interactive session is running."""

    def has_conversation(self) -> bool:
        """Whether a conversation is in progress (side lanes would fork it)."""

    def current_session(self) -> str | None: ...

    def list_sessions(self, limit: int = 8) -> list[dict]:
        """[{session_id, title, updated}] newest first, without side-lane forks. Remembered so
        find_session("2") means the second one in this list."""

    def find_session(self, arg: str) -> str | None:
        """A number from the last list, a name, or a unique id prefix -> session id."""

    def session_title(self, session_id: str) -> str | None: ...

    def session_stats(self, session_id: str | None = None) -> dict | None:
        """A conversation's (the current one by default) {started (unix time or None), messages (user
        prompts plus replies with text), context_tokens (the latest prompt's size, or None)}, counted
        incrementally from the transcript; None if there is no such conversation."""

    def name_session(self, title: str, session_id: str | None = None) -> str | None:
        """Name a conversation (the current one by default); returns its id, or None if there is none."""

    def resume(self, session_id: str, before: Callable[[], None] | None = None) -> str:
        """Switch the main lane to a conversation. Returns busy | missing | already | failed | ok;
        `before` runs once the checks pass, just before the switch starts."""

    def new_session(self) -> str:
        """Start a fresh conversation (/clear). Returns busy | ok."""

    def compact(self, instructions: str = "") -> tuple[str, str]:
        """Compact the conversation (Claude Code's /compact, with optional instructions) and wait until
        it is done. Returns (busy | ok | failed, detail); busy when a task, queued message or approval
        is pending."""

    def history(self, session_id: str | None = None, after: str | None = None, before: str | None = None,
                limit: int = 50) -> dict | None:
        """A conversation's recent events (the current one by default), as the live view sends them.
        `after`/`before` are cursors from events or earlier pages. -> {session_id, events, start,
        cursor, more, reset}, or None if there is no such conversation (contracts/events.md, History)."""

    def resolve_permission(self, request_id: str, allow: bool) -> bool:
        """Answer a permission request; False if it has already gone (answered or timed out)."""

    def probe(self, timeout: float = 90.0) -> dict:
        """One tiny turn outside the conversation, on the current login: does Claude answer now?
        -> {ok: bool, kind: usage_limit | login | billing | error | None, detail: str | None}. The
        backup feature's hand-back check (contracts/backup.md). The agent also publishes
        `agent.limit` when a turn hits Claude's usage limit or a login problem."""

    def shutdown(self) -> None:
        """Stop side lanes and threads. The tmux Claude keeps running."""
