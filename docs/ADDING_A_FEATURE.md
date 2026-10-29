# Adding a feature

## Server feature

1. Copy the template:
   ```bash
   cp -r server/edith/features/_template server/edith/features/my_feature
   ```
2. In `my_feature/__init__.py`, set the name and fill in `setup(ctx)`:
   ```python
   from edith.core import Feature, Context, Event

   def setup(ctx: Context) -> None:
       ctx.add_command("ping", "Check that EDITH is alive", lambda call: "pong")
       ctx.bus.subscribe("turn.done", lambda ev: ctx.log(f"turn finished: {ev.data}"))

   FEATURE = Feature(name="my_feature", setup=setup)
   ```
   - Commands work on every frontend: `/ping` on Telegram and a button or route in the app.
   - Talk to other features **only through events** (`ctx.bus.publish(...)`), never by importing them.
   - Use ports (`ctx.ports.agent`, `ctx.ports.stt`, …) for outside services, never a library directly.
     This keeps the feature testable and lets the service be swapped later.
   - **Buttons:** return a `Reply` with rows of `Button(label, action)`, and handle presses with
     `ctx.add_action(prefix, handler)`. The handler gets an `ActionCall` (`call.args` are the parts
     after the prefix) and returns an `ActionResult(toast, note)`. Keep action strings under 64 bytes:
     ```python
     from edith.core import ActionResult, Button, Reply

     ctx.add_command("hello", "Say hi", lambda call: Reply("Hi!", [[Button("👋 Wave", "hello:wave")]]))
     ctx.add_action("hello", lambda call: ActionResult(toast="Waved", note="👋"))
     ```
3. Enable it in `config.toml`:
   ```toml
   [features]
   enabled = ["sessions", "approvals", "my_feature"]

   [features.my_feature]   # optional, passed to the feature as ctx.config
   greeting = "hi"
   ```
4. Add a test in `server/tests/features/test_my_feature.py`. `make test` also runs the isolation
   test, which fails if a feature imports another feature.

## Server adapter (a new implementation of a port)

1. Create `server/edith/adapters/<port>/<name>/__init__.py` with a `create(config)` function that
   returns an object implementing the port in `server/edith/ports/<port>.py`.
2. Select it in `config.toml`, e.g. `[adapters] stt = "my_engine"`.

## App feature

1. Copy `app/src/features/_template` to `app/src/features/my-feature`.
2. Fill in the exported `FeatureModule`: its screens, settings and event handlers.
3. Add it to `app/src/features/index.ts` (one line).
4. If it needs a device capability, add or use a **port** in `app/src/core/ports.ts` and an
   adapter in `app/src/adapters/`. Don't call native modules from the feature directly.

## New event or API shape

Add it to `contracts/events.md` first. Both the server and the app read from that single description.
