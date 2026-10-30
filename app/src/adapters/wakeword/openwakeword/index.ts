// Adapter: implements the matching port in src/core/ports.ts. Built in the phase noted in PLAN.md.
// TODO(Phase 4): the WakeWord port on a WakeWordService (foreground service, microphone type) running
// openWakeWord on the bundled hey_edith model, only while the "Hey Edith" switch is on. It needs the
// Phase 3 voice flow (listening overlay) to hand a detection to. Until then no adapter is wired, so the
// app has no installed model and the switch stays off.
