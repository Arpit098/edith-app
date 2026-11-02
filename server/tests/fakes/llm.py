"""A scripted chat model for the backup AI's tests (ports/llm.py): no network, no key."""
from edith.ports.llm import ChatReply, ProviderError, ToolCall


def say(text):
    return ChatReply(text, [])


def use(name, arguments="{}", id=None):
    return ChatReply(None, [ToolCall(id or f"call_{name}", name, arguments)])


class FakeProvider:
    """Answers from `script`, in order: a ChatReply, a ProviderError (raised) or a callable
    (messages, tools) -> ChatReply. With the script used up it says "ok". Every call is kept in
    `calls` as (messages, tools), so tests can check exactly what would have been sent out."""

    def __init__(self, name="fake", label="Fake", script=(), available=True, reset_in=3600.0):
        self.name, self.label, self.script, self._available, self.reset_in = name, label, list(script), available, reset_in
        self.calls = []

    def available(self):
        return self._available

    def daily_reset(self, now):
        return now + self.reset_in

    def chat(self, messages, tools, timeout):
        self.calls.append((messages, tools))
        item = self.script.pop(0) if self.script else say("ok")
        if isinstance(item, ProviderError):
            raise item
        return item(messages, tools) if callable(item) else item


class FakeModels:
    def __init__(self, *providers):
        self.providers = list(providers)


__all__ = ["FakeModels", "FakeProvider", "ProviderError", "say", "use"]
