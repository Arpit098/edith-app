"""Entry point: build core from config.toml, load adapters and features, start the frontends.

    python3 -m edith.main --config config.toml [--check]
"""
import argparse
import logging
import os
import signal
import sys
import threading
import tomllib

from .core import EventBus, JobRunner, Ports, Registry, load_adapter, load_features, load_port

log = logging.getLogger("edith.main")


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
    ports.presence = next((f for f in frontends if hasattr(f, "app_clients")), None)  # read by features at run time
    return bus, registry, ports, frontends, report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.toml")
    ap.add_argument("--check", action="store_true", help="load everything, print a report, exit")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    with open(os.path.expanduser(args.config), "rb") as f:
        config = tomllib.load(f)

    bus, registry, ports, frontends, report = build(config)
    print(f"features loaded: {report.loaded}  failed: {report.failed}")
    print(f"commands: {sorted(registry.commands)}  routes: {sorted(registry.routes)}  "
          f"actions: {sorted(registry.actions)}")
    if args.check:
        return 1 if report.failed else 0

    stopping = threading.Event()  # frontends and jobs run in their own threads
    for sig in (signal.SIGTERM, signal.SIGINT):  # /restart and systemd stop: shut down cleanly
        signal.signal(sig, lambda *_: stopping.set())
    if ports.agent:
        ports.agent.start(bus)
    started = []
    for fe in frontends:
        try:
            fe.start(bus, registry, ports.agent)
            started.append(fe)
        except Exception:
            log.exception("frontend %s failed to start", getattr(fe, "name", fe))
    # A required frontend (Telegram by default) that can't run means exit 1, so systemd retries
    # (as the legacy bridge did on a missing token); the others may fail on their own.
    missing = set(config.get("adapters", {}).get("required_frontends", ["telegram"])) - {fe.name for fe in started}
    if missing:
        log.error("required frontend(s) %s not running; exiting so systemd restarts us", sorted(missing))
        for fe in started:
            fe.stop()
        if ports.agent:
            ports.agent.shutdown()
        return 1
    jobs = JobRunner(list(registry.jobs.values()))
    jobs.start()
    log.info("E.D.I.T.H running: features %s, frontends %s", report.loaded, [fe.name for fe in started])

    stopping.wait()
    log.info("shutting down")
    jobs.stop()
    for fe in started:
        fe.stop()
    if ports.agent:
        ports.agent.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
