"""Entry point: build core from config.toml, load adapters and features, start the frontends.

    python3 -m edith.main --config config.toml [--check]
"""
import argparse
import logging
import sys
import threading
import tomllib

from .core import EventBus, Ports, Registry, load_adapter, load_features


def build(config: dict):
    bus, registry = EventBus(), Registry()
    adapters = config.get("adapters", {})
    settings = config.get("adapter", {})  # [adapter.<name>] sections
    ports = Ports(
        agent=load_adapter("agents", adapters["agent"], settings.get(adapters["agent"], {}))
        if adapters.get("agent") else None,
        stt=load_adapter("stt", adapters["stt"], settings.get(adapters["stt"], {}))
        if adapters.get("stt") else None,
    )
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
    print(f"commands: {sorted(registry.commands)}  routes: {sorted(registry.routes)}")
    if args.check:
        return 1 if report.failed else 0
    for fe in frontends:
        fe.start(bus, registry, ports.agent)
    threading.Event().wait()  # frontends run in their own threads
    return 0


if __name__ == "__main__":
    sys.exit(main())
