"""What a feature gets: the bus, the ports, its own config, and ways to register commands and routes."""
import logging
from dataclasses import dataclass, field
from typing import Any, Callable

from .events import EventBus


MAX_ACTION_BYTES = 64  # Telegram's callback_data limit (contracts/events.md, "Replies and buttons")


@dataclass
class Button:
    label: str
    action: str  # "<prefix>:<args…>", handled by the feature that registered <prefix>

    def __post_init__(self):
        if not self.action:
            raise ValueError("a button needs an action")
        if len(self.action.encode()) > MAX_ACTION_BYTES:
            raise ValueError(f"action {self.action!r} is over {MAX_ACTION_BYTES} bytes")


@dataclass
class Reply:
    """A reply with buttons. Plain replies can stay plain strings."""
    text: str
    buttons: list[list[Button]] = field(default_factory=list)  # rows

    def as_data(self) -> dict:
        """The contract's JSON shape: {text, buttons: [[{label, action}]]}."""
        return {"text": self.text,
                "buttons": [[{"label": b.label, "action": b.action} for b in row] for row in self.buttons]}


@dataclass
class CommandCall:
    """One invocation of a command from any frontend."""
    args: str
    origin: str  # telegram | app | terminal
    reply: Callable[[str | Reply], None]
    ref: str | None = None     # the message it came in (turn events for it carry this ref)
    prompt: str | None = None  # the rest of the message as an agent prompt, built by the frontend
    #                            (e.g. Telegram's "[Telegram message from Arpit, …]" header), or None if empty


@dataclass
class Command:
    name: str
    description: str  # shown in a frontend's command menu (Telegram's setMyCommands), when `menu`
    handler: Callable[[CommandCall], str | Reply | None]  # a returned value is sent as the reply
    owner: str
    help: str | None = None   # its /help line ("start a fresh conversation"); None: not in /help
    usage: str = ""           # arguments shown in /help, e.g. "<title>"
    menu: bool = False        # listed in the command menu
    order: int = 1000         # position in /help and the menu
    group: str | None = None  # commands of one group share a /help line ("/brief /mail … – quick actions")
    takes_prompt: bool = False  # the frontend builds CommandCall.prompt (with attachments) for it, e.g. /queue


@dataclass
class ActionResult:
    """What a button press shows: a short popup, and/or a note appended to the pressed message
    (which then loses its buttons). Both optional."""
    toast: str | None = None
    note: str | None = None


@dataclass
class ActionCall:
    """One button press from any frontend."""
    action: str  # the full action string, e.g. "rem:snooze:15:ab12cd"
    origin: str
    reply: Callable[[str | Reply], None]  # send a new message to where the press came from
    ref: str | None = None  # a ref for a turn this press starts (e.g. a quick action)

    @property
    def args(self) -> list[str]:
        """The parts after the prefix: "rem:snooze:15:ab12cd" -> ["snooze", "15", "ab12cd"]."""
        return self.action.split(":")[1:]


@dataclass
class Action:
    prefix: str
    handler: Callable[[ActionCall], ActionResult | None]
    owner: str


@dataclass
class Job:
    """Background work, one thread per job (core/jobs.py). run() returns how many seconds to wait
    before running again: the time until the next thing is due, not a fixed tick."""
    name: str
    run: Callable[[], float]
    owner: str


@dataclass
class Route:
    method: str
    path: str  # e.g. "/v1/sessions"
    handler: Callable[[dict[str, Any]], Any]  # request JSON -> response JSON
    owner: str


@dataclass
class Ports:
    """Adapters chosen in config.toml; None when not configured."""
    agent: Any = None      # ports.agent.AgentBackend
    stt: Any = None        # ports.stt.SpeechToText
    mail: Any = None       # ports.mail.MailBox
    calendar: Any = None   # ports.calendar.Calendar
    notifiers: list = field(default_factory=list)  # [ports.notifier.Notifier]


class Registry:
    """Commands, routes and button actions registered by features. Frontends read from here."""

    def __init__(self):
        self.commands: dict[str, Command] = {}
        self.routes: dict[tuple[str, str], Route] = {}
        self.actions: dict[str, Action] = {}
        self.jobs: dict[str, Job] = {}

    def add_command(self, cmd: Command) -> None:
        if cmd.name in self.commands:
            raise ValueError(f"command /{cmd.name} already registered by {self.commands[cmd.name].owner}")
        self.commands[cmd.name] = cmd

    def add_route(self, route: Route) -> None:
        key = (route.method.upper(), route.path)
        if key in self.routes:
            raise ValueError(f"route {key} already registered by {self.routes[key].owner}")
        self.routes[key] = route

    def add_action(self, action: Action) -> None:
        if not action.prefix or ":" in action.prefix:
            raise ValueError(f"action prefix {action.prefix!r} must be non-empty and contain no ':'")
        if action.prefix in self.actions:
            raise ValueError(f"action {action.prefix}: already registered by {self.actions[action.prefix].owner}")
        self.actions[action.prefix] = action

    def add_job(self, job: Job) -> None:
        if job.name in self.jobs:
            raise ValueError(f"job {job.name} already registered by {self.jobs[job.name].owner}")
        self.jobs[job.name] = job

    def press(self, action: str, origin: str, reply, ref: str | None = None) -> ActionResult | None:
        """Route a button press to the feature that owns its prefix. Unknown prefixes return None."""
        handler = self.actions.get(action.split(":", 1)[0])
        return handler.handler(ActionCall(action, origin, reply, ref)) if handler else None

    def _listed(self, keep):
        return sorted((c for c in self.commands.values() if keep(c)), key=lambda c: (c.order, c.name))

    def help_lines(self) -> list[str]:
        """The /help lines, in order: "/name <usage> – help", one line per group."""
        lines, at = [], {}
        for c in self._listed(lambda c: c.help):
            label = f"/{c.name}" + (f" {c.usage}" if c.usage else "")
            if c.group and c.group in at:
                lines[at[c.group]][0].append(label)
                continue
            if c.group:
                at[c.group] = len(lines)
            lines.append(([label], c.help))
        return [f"{' '.join(labels)} – {text}" for labels, text in lines]

    def menu(self) -> list[dict]:
        """The command menu, in order: [{command, description}] (Telegram's setMyCommands)."""
        return [{"command": c.name, "description": c.description} for c in self._listed(lambda c: c.menu)]


class Context:
    def __init__(self, feature: str, bus: EventBus, ports: Ports, registry: Registry, config: dict):
        self.feature = feature
        self.bus = bus
        self.ports = ports
        self.config = config
        self._registry = registry
        self._log = logging.getLogger(f"edith.feature.{feature}")

    def add_command(self, name: str, description: str, handler, *, help: str | None = None, usage: str = "",
                    menu: bool = False, order: int = 1000, group: str | None = None, takes_prompt: bool = False) -> None:
        """A /command on every frontend. `help`, `usage`, `menu`, `order` and `group` place it in
        /help and the command menu (see Registry.help_lines and Registry.menu)."""
        self._registry.add_command(Command(name, description, handler, self.feature, help, usage, menu, order, group,
                                           takes_prompt))

    @property
    def registry(self) -> Registry:
        """Read-only use only (e.g. building /help from the registered commands)."""
        return self._registry

    def add_route(self, method: str, path: str, handler) -> None:
        self._registry.add_route(Route(method, path, handler, self.feature))

    def add_action(self, prefix: str, handler) -> None:
        """Handle presses of buttons whose action starts with "<prefix>:"."""
        self._registry.add_action(Action(prefix, handler, self.feature))

    def add_job(self, name: str, run) -> None:
        """Run `run` in the background from startup; it returns seconds until its next run."""
        self._registry.add_job(Job(f"{self.feature}.{name}", run, self.feature))

    def subscribe(self, pattern: str, handler) -> None:
        self.bus.subscribe(pattern, handler, owner=self.feature)

    def log(self, msg: str, *args) -> None:
        self._log.info(msg, *args)
