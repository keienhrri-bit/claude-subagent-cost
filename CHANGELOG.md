# Changelog

## 0.1.0 (2026-11-16)

First release.

- A line under each Agent tool row: subagent type, the model it ran on, input / output / cache write (5m or 1h) / cache read tokens, tool calls, duration, and an estimated share of the 5-hour quota once the estimate has a rate behind it.
- A line above the prompt: 5-hour and 7-day usage, the 5-hour reset, main-session and subagent tokens, and how many subagents inherited Opus, Fable or Mythos.
- A toast when a subagent inherits an expensive model; `subagentModelPolicy` `warn` / `off` / `downgrade:<model>`, where `downgrade` applies per subagent type once that type has been seen inheriting.
- Compaction after a turn that ended with an answer, at 60% of the context window or 150,000 tokens; skipped after a question, while background work runs, after an interruption and past the handoff threshold. `autoCompact` `auto` / `ask` / `off`. Where Claude Code does not let a mod compact between turns (desktop app and SDK sessions), a queued `/compact` with the same instructions.
- A warning at 88% and a handoff-brief request at 90% of the 5-hour window, once per window; separate thresholds for the 7-day window.

Tested in throwaway headless sessions: the handoff request, compaction and its skip rules, subagent usage kept apart from the main loop's. Not tested: drawing on screen (terminal or desktop app), and the error of the quota-share estimate, which has not been measured. See "What has been tested, and what has not" in the README.
