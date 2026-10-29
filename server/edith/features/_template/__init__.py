"""Template feature: copy this folder to start a new one (see docs/ADDING_A_FEATURE.md).

A feature may import edith.core, edith.ports and edith.common. It must not import another
feature or an adapter. Talk to other features through events and to services through ctx.ports.
"""
from edith.core import CommandCall, Context, Event, Feature


def setup(ctx: Context) -> None:
    def ping(call: CommandCall) -> str:
        return "pong"

    def on_turn_done(ev: Event) -> None:
        ctx.log("turn %s finished", ev.data.get("ref"))

    ctx.add_command("ping", "Check that EDITH is alive", ping)
    ctx.subscribe("turn.done", on_turn_done)


FEATURE = Feature(name="_template", setup=setup, description="Example feature")
