"""What a feature gets: the bus, the ports, its own config, and ways to register commands and routes."""
import logging
from dataclasses import dataclass, field
from typing import Any, Callable

from .events import EventBus


@dataclass
class CommandCall:
    """One invocation of a command from any frontend."""
    args: str
    origin: str  # telegram | app | terminal
    reply: Callable[[str], None]


@dataclass
class Command:
    name: str
    description: str
    handler: Callable[[CommandCall], str | None]  # a returned string is sent as the reply
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
    notifiers: list = field(default_factory=list)  # [ports.notifier.Notifier]


class Registry:
    """Commands and routes registered by features. Frontends read from here."""

    def __init__(self):
        self.commands: dict[str, Command] = {}
        self.routes: dict[tuple[str, str], Route] = {}

    def add_command(self, cmd: Command) -> None:
        if cmd.name in self.commands:
            raise ValueError(f"command /{cmd.name} already registered by {self.commands[cmd.name].owner}")
        self.commands[cmd.name] = cmd

    def add_route(self, route: Route) -> None:
        key = (route.method.upper(), route.path)
        if key in self.routes:
            raise ValueError(f"route {key} already registered by {self.routes[key].owner}")
        self.routes[key] = route


class Context:
    def __init__(self, feature: str, bus: EventBus, ports: Ports, registry: Registry, config: dict):
        self.feature = feature
        self.bus = bus
        self.ports = ports
        self.config = config
        self._registry = registry
        self._log = logging.getLogger(f"edith.feature.{feature}")

    def add_command(self, name: str, description: str, handler) -> None:
        self._registry.add_command(Command(name, description, handler, self.feature))

    def add_route(self, method: str, path: str, handler) -> None:
        self._registry.add_route(Route(method, path, handler, self.feature))

    def subscribe(self, pattern: str, handler) -> None:
        self.bus.subscribe(pattern, handler, owner=self.feature)

    def log(self, msg: str, *args) -> None:
        self._log.info(msg, *args)
