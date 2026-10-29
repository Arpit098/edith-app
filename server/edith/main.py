"""Entry point: build core from config.toml, load adapters and features, start the frontends.

    python3 -m edith.main --config config.toml [--check]
"""
import argparse
import logging
import signal
import sys
import threading
import tomllib

from .core import EventBus, JobRunner, Ports, Registry, load_adapter, load_features, load_port


def build(config: dict):
    bus, registry = EventBus(), Registry()
    adapters = config.get("adapters", {})
    settings = config.get("adapter", {})  # [adapter.<name>] sections
    shared = {}  # adapters that serve several ports (e.g. google: mail + calendar) are built once

    def port(name: str, folder: str):
        chosen = adapters.get(name)
        return load_port(name, folder, chosen, settings.get(chosen, {}), shared) if chosen else None

    ports = Ports(agent=port("agent", "agents"), stt=port("stt", "stt"),
                  mail=port("mail", "mail"), calendar=port("calendar", "calendar"))
    ports.notifiers = [n for n in (load_adapter("notifiers", name, settings.get(name, {}))
                                   for name in adapters.get("notifiers", [])) if n]
    features = config.get("features", {})
    report = load_features(features.get("enabled", []), bus, ports, registry, features)
    frontends = [f for f in (load_adapter("frontends", name, settings.get(name, {}))
                             for name in adapters.get("frontends", [])) if f]
    return bus, registry, ports, frontends, report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.toml")
    ap.add_argument("--check", action="store_true", help="load everything, print a report, exit")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    with open(args.config, "rb") as f:
        config = tomllib.load(f)

    bus, registry, ports, frontends, report = build(config)
    print(f"features loaded: {report.loaded}  failed: {report.failed}")
    print(f"commands: {sorted(registry.commands)}  routes: {sorted(registry.routes)}  "
          f"actions: {sorted(registry.actions)}")
    if args.check:
        return 1 if report.failed else 0
    if ports.agent:
        ports.agent.start(bus)
    for fe in frontends:
        fe.start(bus, registry, ports.agent)
    jobs = JobRunner(list(registry.jobs.values()))
    jobs.start()

    stopping = threading.Event()  # frontends and jobs run in their own threads
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopping.set())
    stopping.wait()
    jobs.stop()
    for fe in frontends:
        fe.stop()
    if ports.agent:
        ports.agent.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
