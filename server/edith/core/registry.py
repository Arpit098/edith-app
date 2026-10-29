"""Loads the features and adapters named in config.toml. One broken module never stops the others."""
import importlib
import importlib.util
import logging
from dataclasses import dataclass, field
from typing import Callable

from .context import Context, Ports, Registry
from .events import EventBus

log = logging.getLogger("edith.registry")


@dataclass
class Feature:
    name: str
    setup: Callable[[Context], None]
    description: str = ""


@dataclass
class LoadReport:
    loaded: list[str] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)  # name -> error


def load_adapter(port: str, name: str, config: dict, package: str = "edith.adapters"):
    """Import edith.adapters.<port>.<name> and call its create(config). Returns None on failure."""
    try:
        module = importlib.import_module(f"{package}.{port}.{name}")
        return module.create(config)
    except Exception:
        log.exception("adapter %s/%s failed to load; continuing without it", port, name)
        return None


def load_port(port: str, folder: str, name: str, config: dict, shared: dict | None = None,
              package: str = "edith.adapters"):
    """The adapter `name` for one port. Either a one-port adapter, edith.adapters.<folder>.<name>
    (create(config) returns the port object), or an adapter package that serves several ports,
    edith.adapters.<name> with PORTS = ("mail", "calendar", …): it is created once per `shared`
    dict and each port gets its attribute (e.g. google.mail and google.calendar share one login).
    Returns None on failure, like load_adapter."""
    try:
        one = importlib.util.find_spec(f"{package}.{folder}.{name}")
    except ModuleNotFoundError:  # no edith.adapters.<folder> package at all
        one = None
    if one:
        return load_adapter(folder, name, config, package)
    shared = {} if shared is None else shared
    try:
        if name not in shared:
            module = importlib.import_module(f"{package}.{name}")
            if port not in getattr(module, "PORTS", ()):
                raise LookupError(f"adapter {name} does not serve the {port} port")
            shared[name] = module.create(config)
        return getattr(shared[name], port)
    except Exception:
        log.exception("adapter %s for port %s failed to load; continuing without it", name, port)
        return None


def load_features(names: list[str], bus: EventBus, ports: Ports, registry: Registry,
                  configs: dict[str, dict], package: str = "edith.features") -> LoadReport:
    """Import each edith.features.<name>, then run FEATURE.setup(ctx) in isolation.

    If setup fails half-way, the commands, routes, actions and jobs it already registered are rolled back so
    nothing half-loaded stays active."""
    report = LoadReport()
    for name in names:
        before_cmds, before_routes = set(registry.commands), set(registry.routes)
        before_actions, before_jobs = set(registry.actions), set(registry.jobs)
        before_subs = len(bus._subs)
        try:
            module = importlib.import_module(f"{package}.{name}")
            feature: Feature = module.FEATURE
            feature.setup(Context(name, bus, ports, registry, configs.get(name, {})))
            report.loaded.append(name)
        except Exception as e:
            log.exception("feature %s failed to load; it is disabled, the rest continue", name)
            for k in set(registry.commands) - before_cmds:
                del registry.commands[k]
            for k in set(registry.routes) - before_routes:
                del registry.routes[k]
            for k in set(registry.actions) - before_actions:
                del registry.actions[k]
            for k in set(registry.jobs) - before_jobs:
                del registry.jobs[k]
            with bus._lock:
                del bus._subs[before_subs:]
            report.failed[name] = f"{type(e).__name__}: {e}"
    return report
