# subagent-cost

A Claude Code mod that shows what each subagent used under its tool row, keeps your 5-hour and 7-day quota above the prompt, compacts the context after a finished task, and asks Claude for a handoff brief when the quota is nearly used up.

[中文说明](README.zh-CN.md)

![Illustration of the subagent row and the quota line](docs/preview.svg)

*Illustration, not a screenshot: the lines are produced by the mod's own formatting code, fed with invented numbers.*

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install subagent-cost --marketplace keienhrri-bit/claude-subagent-cost
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install subagent-cost --marketplace keienhrri-bit/claude-subagent-cost
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `keienhrri-bit/claude-subagent-cost`, then **Add plugin**. A mod installed from a terminal at user scope also loads in the desktop app's local sessions (per Claude Code's plugin documentation).

Built and tested against the mod engine of Claude Code 2.1.325.

## What it shows

**Under each Agent tool row**, once the subagent has finished:

```
subagent Explore · claude-haiku-5-5 · in 12k / out 3k / cache write 41k (5m) / cache read 80k · 23 tools · 41s
```

Subagent type, the model it actually ran on, input / output / cache-write (with the cache lifetime, 5m or 1h) / cache-read tokens, tool calls and duration. Once the estimate below has enough data, the line ends with `≈0.8% of 5h quota (estimate)`; until then it shows tokens only.

A subagent that runs in the background returns no Agent result with these totals: the mod counts its tool calls itself, and its line has no cache lifetime. A subagent continued with a message (SendMessage) runs again under the same id; that run's tokens, tool calls and time are added to its original row.

**Above the prompt**, one line:

```
5h 63% (resets in 2h) · 7d 41% · main 123k / subagents 272k tokens (2, 1 inherited Opus)
```

The 5-hour and 7-day usage and when the 5-hour window resets, tokens used by the main session and by its subagents, how many subagents ran, and how many of them inherited an expensive model (`Opus/Fable` when there were several). When Claude Code reports no usage windows, the line shows tokens only; a reading whose reset time has passed is left out until a new one arrives.

**A notice when a subagent inherits Opus, Fable or Mythos.** A subagent called without a `model` runs on whatever its own definition names, or on the main session's model when its definition names none. If that is an expensive model, a toast says so and how to avoid it.

## What it does

### Compaction after a finished task

After a turn that ended with an answer, if the context has reached 60% of the window or 150,000 tokens (whichever comes first), the mod compacts it, with instructions to keep decisions made, key file paths, the work in progress and open questions verbatim.

It does not compact when:

- the turn ended with a question to you: the last line ends in `?` or `？`, or the turn called `AskUserQuestion` (this is a heuristic);
- a background agent or task is still running;
- the turn was interrupted;
- usage is past the handoff threshold (the brief comes first);
- a previous compaction left the context large and it has grown less than 20,000 tokens since.

In a session that the desktop app or the Agent SDK runs, Claude Code does not yet let a mod compact between turns; there the mod queues a `/compact` with the same instructions instead, which runs as a turn of its own.

`autoCompact: ask` shows a **Compact context** button on the quota line instead. `off` turns this off. If another mod or setting of yours also compacts automatically, turn one of them off.

### Quota warnings and the handoff brief

- At **88%** of the 5-hour window, the quota line turns into a warning and you get one toast.
- At **90%**, Claude is asked to write a handoff brief to `HANDOFF.md` (relative to the session's folder) with these sections: Goal, Decisions made, Done, In progress, Next steps, Key files, Open questions, and to start no new large task in this window.

Each fires once per window. The 7-day window has its own thresholds (also 88 / 90 by default); when both windows are due at once, or one comes due before the other's request has gone out, Claude gets one request that names both. A window is told from the next by its reset time; where Claude Code reports none, by its percentage falling under half the warning threshold. Below the thresholds the warnings add nothing to the conversation and spend no tokens.

How the request reaches Claude: during a turn, it is attached to the next tool result; between turns, it is added to the conversation as a message. In our test, a request added between turns was acted on with your next message, not before it.

### Subagent model policy

`subagentModelPolicy` is `warn` (the default: the toast above), `off`, or `downgrade:<model>`, for example `downgrade:sonnet`.

With `downgrade`, the mod passes `<model>` for subagents of a type that it has already seen running on the main session's model, while the main session is on Opus, Fable or Mythos. It learns this per subagent type, and remembers it across sessions:

- The first spawn of a type is never changed; if it inherited, a toast says that later ones will run on `<model>`.
- A type whose definition named its own model when it was seen (Explore on Haiku, for instance) is left alone.
- A type whose definition names the same model as the main session counts as inheriting.
- A `model` passed in the call is always kept. Forks are never changed.
- It learns only from spawns it did not rewrite while the main session was on Opus, Fable or Mythos (under `warn` or `off`, or before a type is known). Spawns under a cheaper main model teach it nothing, since a type with Haiku of its own looks the same as one that inherits Haiku.
- Claude Code does not tell a mod what a type's definition names, so a definition you change is noticed only when the type is seen again. What was seen of a type stands for 7 days; after that, one spawn of the type runs unchanged and the type is learned again. To have it learned at once (say, after giving an agent a `model` of its own), set the policy to `warn`, run one subagent of that type under Opus, Fable or Mythos, and set it back.

## Settings

Set these when you install, or later from the plugin's settings.

| Option | Default | What it does |
| --- | --- | --- |
| `language` | `en` | Language of the lines and toasts: `en` or `zh`. |
| `subagentModelPolicy` | `warn` | `warn`, `off` or `downgrade:<model>`, as above. |
| `autoCompact` | `auto` | `auto`, `ask` or `off`. |
| `compactAtPercent` | `60` | Context fill, in percent, that counts as large. `0` turns this test off. |
| `compactAtTokens` | `150000` | Context tokens that count as large. `0` turns this test off. |
| `warnAt` | `88` | 5-hour percent for the warning. |
| `handoffAt` | `90` | 5-hour percent for the handoff brief. |
| `warnAt7d` | `88` | 7-day percent for the warning. |
| `handoffAt7d` | `90` | 7-day percent for the handoff brief. |
| `handoffPath` | `HANDOFF.md` | Where the brief goes; relative to the session's folder. |

## How the "% of 5h quota" estimate works

The percentage on a subagent line is an estimate, and its error has not been measured.

1. Every response's tokens (main loop and each subagent, from Claude Code's per-turn usage) are weighted by the Anthropic API list price of the model that produced them: input, output, cache write (1.25× input for a 5-minute cache, 2× for a 1-hour one) and cache read. The prices come from the Claude API reference bundled with Claude Code 2.1.325. Only the ratios between models and token kinds matter; nothing is shown in dollars.
2. The mod reads the 5-hour usage percentage that Claude Code reports. Once that percentage has moved by at least 2 points since a baseline, the mod divides the change by the weighted spend over the same stretch, which gives "percent per unit of weighted spend".
3. A subagent's share is its weighted spend times that rate.

This assumes:

- **One session on the account.** Other sessions, other devices or claude.ai use move the same percentage, so the rate comes out too high and every share with it.
- **List-price ratios match how the plan counts usage.** Anthropic does not publish how plan usage is computed; if the ratios differ, shares are off by the same factor.
- **Cache writes are split by the one figure the mod gets.** For a subagent, the split between 5-minute and 1-hour writes comes from the Agent tool result, which reports the run's last request; the mod applies it to that whole run. Each run is priced at its own model when it ends, and a later run does not reprice an earlier one. A background subagent's writes, and the main loop's, are priced as 5-minute writes: the mod gets no split for them.
- **The percentage is coarse.** With a 2-point move, rounding alone can shift the rate by tens of percent.

Treat the share as an order of magnitude: useful to see that one subagent cost ten times another, not to tell 0.8% from 1.1%.

## What it keeps and what it reads

- Per session (Claude Code's plugin state): the rows, the token totals, the latest usage readings, the estimate's baseline and rate, which warnings have fired.
- Across sessions (the plugin's own store): for each subagent type, whether it was seen inheriting the main model, and when (`inherits:<type>`).
- It reads only what Claude Code passes to mods, and makes no network requests of its own. It reads no credentials.
- The only file it writes is its own store, through Claude Code's `$.store`. The handoff brief is written by Claude, not by the mod.
- It changes the conversation in two ways only: the compaction, and the handoff request it adds.

## Compared with similar tools

As of 2026-11-16. Descriptions are taken from each project's own README or repository description; follow the link to check.

| Project | Kind | What it does |
| --- | --- | --- |
| `/usage` (built into Claude Code) | command | Shows plan usage when you run it. |
| [claude-code-usage-quota-mod](https://github.com/anantraghunath/claude-code-usage-quota-mod) | mod | Live band above the prompt: 5-hour and weekly usage with a forecast against the resets, context use, a one-click Compact, and per-session auto compact (30% by default). |
| [usage-budget](https://github.com/erikdarlingdata/claude-plugins) (in erikdarlingdata/claude-plugins) | mod | Toasts as the 5-hour and 7-day windows fill (70 / 85 / 95 by default), a note to the model from 85% so it can wrap up and write its handoff, refuses new subagents from 95%, and paces the 7-day window. |
| [subagent-band](https://github.com/erikdarlingdata/claude-plugins) (same repository) | mod | A band of running subagents with type, model, effort, steps, context, advisor calls and estimated cost in dollars; a `/fleet` pane and a `/subagent-cost` command (a command name that matches this mod's name; this mod adds no commands). |
| [claude-flightdeck](https://github.com/scasella/claude-flightdeck) | mod | A live agent dashboard in the terminal: context and cost, advisor timeline, permission checks, subagent cards and swimlanes. |
| [claude-agent-tree](https://github.com/pedrowillen/claude-agent-tree) | mod | A live Agents pane with the orchestrator and subagent tree: model, effort, tokens, tools, duration and reply preview. |
| [agent-usage-guard](https://github.com/rbartoli/agent-usage-guard) | mod | Holds subagent fan-out, heavy-context prompts and retry loops before they spend the usage window; reads the plan's usage, counts agents across sessions, and asks in Claude Code's own dialog. |
| [claude-handoff-revive](https://github.com/sofumel/claude-handoff-revive) | plugin | Saves a handoff automatically at 90% / 95% usage and resumes work after a limit without replaying the transcript; 10 languages. |
| [claude-code-usage-bar](https://github.com/leeguooooo/claude-code-usage-bar) | status line | 5-hour / 7-day usage, reset countdowns, model, context window and prompt-cache age in one line. |

Where this mod differs: it puts each finished subagent's token split and actual model under that subagent's own row; it states usage as a share of the 5-hour window rather than in dollars, and labels that share as an estimate; it compacts only after a turn that ended with an answer; it writes the handoff to a file with fixed sections; and it never refuses a subagent. It has no forecast, no pane and no dashboard.

A status-line tool draws in a terminal session. We have not checked whether the desktop app's Code tab runs a custom status line; our guess is that it does not, in which case those tools show nothing there. A mod's rows are drawn for the desktop app according to Claude Code's plugin documentation; we have seen this mod's rows on screen in a terminal session, not in the desktop app.

## What has been tested, and what has not

As of v0.1.1. The unit and engine tests pass (49 tests, `claude plugin test`). Beyond those, the mod was run in throwaway sessions started with `--plugin-dir` (Claude Code 2.1.325, Haiku as the main model), with thresholds set for the test.

Run on v0.1.1:

- **On screen, in an interactive terminal session.** While a background Explore subagent ran, the line under its row read `subagent Explore · claude-haiku-5-5 · usage pending`; once it finished, `subagent Explore · claude-haiku-5-5 · in 4 / out 508 / cache write 21.1k / cache read 20.1k · 2 tools · 5s`, the tool count being the mod's own. The line above the prompt showed the 5-hour and 7-day percentages, the 5-hour reset and the token totals, with Claude Code's own notices still drawn.
- **Both windows due at once** (headless, both handoff thresholds set to 1%): one request named both windows, rode the next tool result, and Claude wrote the brief.
- **A subagent that was not backgrounded:** the tool count from the Agent result (3) matched the mod's own count.
- No hook of the mod was skipped or refused in either debug log.

Carried over from the v0.1.0 headless runs:

- the 5-hour percentage and its reset time arrived from Claude Code;
- at the handoff threshold the toast fired, the request was added between turns, and with the next message Claude wrote the brief with the seven sections;
- no compaction followed a turn that ended with a question, or a turn while a background subagent ran; after a turn that answered, the queued `/compact` ran and the context went from 28,180 to 7,090 tokens;
- a background Explore subagent's usage was reported apart from the main loop's, and the main loop's turn did not include it;
- the per-type record was written to the plugin's store.

Not tested:

- **The desktop app's drawing.** Only the terminal was looked at; the **Compact context** button (`autoCompact: ask`) has not been seen on screen anywhere.
- **Compaction between turns in an interactive terminal session** (the direct path, not the queued `/compact`).
- **The estimate.** Its error is unknown (see above). In one test session the 5-hour percentage moved 2 points and a rate appeared, but other sessions were using the same account at the time, so that rate was too high.
- **A subagent continued with SendMessage, and the 7-day re-check of a subagent type:** unit tests only.
- **The question heuristic** can miss a question that does not end in a question mark, and can treat a rhetorical last line as a question.

## Related

By the same author:

- [claude-code-usage-audit](https://github.com/keienhrri-bit/claude-code-usage-audit): a usage ledger across sessions and days, read from local Claude Code and Codex logs, showing where the usage went.
- [agent-cite-check](https://github.com/keienhrri-bit/agent-cite-check): checks an agent's report against your local files (quoted lines, numbers, changed files), without calling a model.

## License

MIT. See [LICENSE](LICENSE).
