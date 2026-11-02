"""The agent port as the frontends and features see it: send() first offers each message to the
features' diverters (Registry.diverters, e.g. the backup AI while Claude is down); a message no
diverter takes goes to the agent unchanged. Everything else passes straight through."""
import logging

log = logging.getLogger("edith.divert")


class DivertingAgent:
    def __init__(self, agent, registry):
        self._agent, self._registry = agent, registry

    @property
    def inner(self):
        return self._agent

    def send(self, text, origin, ref, force_queue=False, parallel=False):
        for d in list(self._registry.diverters):
            try:
                handle = d.handler(text, origin, ref, force_queue, parallel)
            except Exception:
                log.exception("diverter from %s failed; the message goes to the agent", d.owner)
                continue
            if handle is not None:
                return handle
        return self._agent.send(text, origin, ref, force_queue=force_queue, parallel=parallel)

    def __getattr__(self, name):
        return getattr(self._agent, name)
