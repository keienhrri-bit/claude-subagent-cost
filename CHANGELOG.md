# Changelog

## 0.1.1 (2026-11-17)

Fixes from a code review.

- Handoff: when the 5-hour and 7-day windows come due together, or one comes due before the other's request has gone out, Claude gets one request naming both; before, the later request replaced the earlier one.
- Alerts: a window is matched by its reset time with a tolerance, so a reset time that moves by seconds across a ten-minute mark no longer fires a warning or handoff twice. Where Claude Code gives no reset time, a reading under half the warning threshold starts a new window, so the next one alerts again.
- Quota line and compaction: an empty usage reading now clears the old one, and a reading whose reset time has passed is ignored, so a stale 90% no longer shows or holds compaction off.
- Estimate: each subagent run is priced at its own model when it ends; a later run's model or cache split no longer reprices earlier runs.
- `downgrade`: what was seen of a subagent type is checked again after 7 days, so a type whose definition later names its own model is not overridden for good; records from 0.1.0 are learned again.
- Background subagents: the mod counts their tool calls, and a subagent continued with SendMessage adds its time and tools to its row.
- The quota line names every inherited family (`Opus/Fable`), not only the first.
- README: a Related section linking claude-code-usage-audit and agent-cite-check; tested and untested parts brought up to date.

Tested: 50 unit and engine tests; in throwaway sessions, the rows on screen in a terminal session and the combined handoff request. Not tested: drawing in the desktop app, and the estimate's error.

## 0.1.0 (2026-11-16)

First release.

- A line under each Agent tool row: subagent type, the model it ran on, input / output / cache write (5m or 1h) / cache read tokens, tool calls, duration, and an estimated share of the 5-hour quota once the estimate has a rate behind it.
- A line above the prompt: 5-hour and 7-day usage, the 5-hour reset, main-session and subagent tokens, and how many subagents inherited Opus, Fable or Mythos.
- A toast when a subagent inherits an expensive model; `subagentModelPolicy` `warn` / `off` / `downgrade:<model>`, where `downgrade` applies per subagent type once that type has been seen inheriting.
- Compaction after a turn that ended with an answer, at 60% of the context window or 150,000 tokens; skipped after a question, while background work runs, after an interruption and past the handoff threshold. `autoCompact` `auto` / `ask` / `off`. Where Claude Code does not let a mod compact between turns (desktop app and SDK sessions), a queued `/compact` with the same instructions.
- A warning at 88% and a handoff-brief request at 90% of the 5-hour window, once per window; separate thresholds for the 7-day window.

Tested in throwaway headless sessions: the handoff request, compaction and its skip rules, subagent usage kept apart from the main loop's. Not tested: drawing on screen (terminal or desktop app), and the error of the quota-share estimate, which has not been measured. See "What has been tested, and what has not" in the README.
