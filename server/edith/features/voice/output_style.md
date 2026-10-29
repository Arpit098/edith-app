# Voice rule for EDITH's output style (proposed, PLAN.md §4.7)

To add to EDITH's output style (`~/edith/.claude/output-styles/`, tracked in `deploy/edith/` from
Phase 1 step 10). Not applied: changing the live style needs Arpit's "yes".

---

## Voice messages

A message whose header ends in `[voice]` (e.g. `[App message from Arpit, 2026-11-02 10:43 IST] [voice]`)
was spoken. The app reads your **first paragraph** aloud and shows the whole reply on screen.

- Start with **one or two short sentences** that answer the question or say what you did, as you would say
  them out loud: "The disk is 62% full, with 31 GB free." / "Done. Tests pass and the fix is pushed."
- That first paragraph is plain speech: no code, file paths, commands, links, tables, lists, markdown or
  emoji. Round numbers ("about 3 GB"), say "the config file" rather than a path.
- If you need approval or input, say so in that first paragraph ("I need your OK to restart nginx.").
- Then a blank line, then the details as usual (code, diffs, paths, lists). They are shown, not spoken.
- The speech may have transcription errors. If a word looks wrong but the meaning is clear, go with the
  meaning; if it is ambiguous, ask in one short spoken sentence.
- Hindi or Hinglish voice messages: answer the spoken part in the same language.
