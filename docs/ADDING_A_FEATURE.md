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
3. **One service, several ports** (e.g. Google for mail and calendar): make one package
   `server/edith/adapters/<name>/` with `PORTS = ("mail", "calendar")` and a `create(config)` that
   returns an object with one attribute per port (`.mail`, `.calendar`). With `mail = "google"` and
   `calendar = "google"`, it is created once and both ports share it (one login). Build nothing
   expensive in `create()`; connect on first use.

## App feature

1. Copy `app/src/features/_template` to `app/src/features/my-feature`.
2. Fill in the exported `FeatureModule`: its screens, settings, event handlers and, for a tool, its
   `tool` tile for the Tools grid (see "Adding a new tool" below). A feature that must show above
   every screen (like approvals) adds a `panels: [{ slot: 'banner', component }]`.
   - A settings section is a row in Settings that opens `component` on its own page. Give it its place:
     `group` (`connection`, `notifications`, `voice`, `app`, `about`; none goes under More), an outline `icon`,
     an `order` within the group, and a `summary` hook returning one line of live state (e.g.
     `useStoreOr(model?.store, mySummary, null)`, with `mySummary` a pure function in `summary.ts`).
     A setting that is just on or off also gives a `toggle` hook (`{ on, set, disabled?, detail? }`, or
     null): the list then shows a switch in the row, and the row still opens the page.
   - Build the page from `ui/SettingsRows.tsx` (`SummaryCard` at the top, `Section` cards of `Row`,
     `SwitchRow`, `SegmentRow`, `SliderRow`, helper text under the card, one `PillButton` for the main
     action), so every page looks the same. The page draws its own cards.
   - Put the logic in `model.ts`: a `createXModel(bus, api)` with a small store (`core/store.ts`),
     subscribed to bus events in `setup(ctx)`. Resync from the API on `app.connected`; never poll.
     Screens read it with `useStore(model.store, selector)`, using module-level selectors.
   - Add `__tests__/model.test.ts` using the fakes in `app/src/testing/fakes.ts`.
3. Add it to `app/src/features/index.ts` (one line).
4. If it needs a device capability, add or use a **port** in `app/src/core/ports.ts` and an
   adapter in `app/src/adapters/`. Don't call native modules from the feature directly.
5. `cd app && npm run check` (typecheck + jest, including the import-rule test).

## New event or API shape

Add it to `contracts/events.md` first. Both the server and the app read from that single description.

## Adding a new tool (app + server)

A "tool" is a feature Arpit opens from the app's **Tools** grid (and usually also uses from Telegram).

1. **Contract first:** add its events and API routes to `contracts/events.md`.
2. **Server:** a feature folder (see "Server feature" above) with its commands (`help`/`menu` place
   them in `/help` and the Telegram menu), button actions, `ctx.add_route(...)` for the app, and any
   background job. Outside services go behind a port and an adapter.
3. **Server tests:** `server/tests/features/test_<tool>.py`; `make test` must stay green.
4. **App:** a feature folder (see "App feature" above) with its screen, plus a tile:
   ```ts
   tool: { title: 'Reminders', icon: 'alarm', screen: 'reminders' },  // icon: a MaterialCommunityIcons name
   ```
   Give it `tab: true` on a screen only if it really deserves one of the ~5 bottom tabs.
5. **Enable it:** one line in `server/config.toml` (`[features] enabled`) and one in `app/src/features/index.ts`.
