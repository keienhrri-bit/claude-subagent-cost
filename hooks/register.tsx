import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type {
  AgentRow,
  CompactState,
  ContextReading,
  MainTally,
  PendingNote,
  WindowReading,
} from '../types'
import {
  COMPACT_INSTRUCTIONS,
  EMPTY_TALLY,
  FIVE_HOUR,
  REGROWTH_TOKENS,
  addRun,
  addTally,
  agentLine,
  alertsFor,
  applySplit,
  bandLine,
  cacheSplit,
  contextOverThreshold,
  endsWithQuestion,
  familyOf,
  handoffNote,
  handoffToast,
  isExpensive,
  langOf,
  liveWindows,
  mergeWindows,
  parsePolicy,
  pastHandoff,
  pastWarn,
  rearm,
  stepEstimate,
  tallyOf,
  totalTokens,
  warnToast,
  weigh,
} from './logic'
import type { CompactSettings, Lang, ModelPolicy, Thresholds } from './logic'


const agentsAtom = atom({ plugin: 'subagent-cost', key: 'agents' } as const, {} as Record<string, AgentRow>)
const mainAtom = atom({ plugin: 'subagent-cost', key: 'main' } as const, {
  usage: EMPTY_TALLY,
  weighted: 0,
  turns: 0,
} as MainTally)
const windowsAtom = atom({ plugin: 'subagent-cost', key: 'windows' } as const, [] as WindowReading[])
const contextAtom = atom({ plugin: 'subagent-cost', key: 'context' } as const, {} as ContextReading)
const baselineAtom = atom({ plugin: 'subagent-cost', key: 'baseline' } as const, null)
const rateAtom = atom({ plugin: 'subagent-cost', key: 'rate' } as const, null)
const warnedAtom = atom({ plugin: 'subagent-cost', key: 'warned' } as const, [] as string[])
const handedOffAtom = atom({ plugin: 'subagent-cost', key: 'handedOff' } as const, [] as string[])
const pendingAtom = atom({ plugin: 'subagent-cost', key: 'pendingNote' } as const, null as PendingNote | null)
const compactAtom = atom({ plugin: 'subagent-cost', key: 'compact' } as const, { isSuggested: false } as CompactState)

const BUSY_STATUSES = new Set(['pending', 'running', 'waiting'])
const COMPACT_DELAY_MS = 1500

type Config = {
  lang: Lang
  policy: ModelPolicy
  compact: CompactSettings
  th: Thresholds
  handoffPath: string
}

// Set by `register`; a reload runs it again with the current options.
let cfg: Config = configOf({})

// Transient, per main-loop turn: nothing draws these, so a reload may lose them.
let isMainTurnRunning = false
let askedByTool = false
let lastStop: { at: number; inFlight: number } | null = null
// Tool calls a subagent made in its current run, by agent id, until the run ends.
const toolCalls = new Map<string, number>()

/** How long what was seen of a subagent type stands before one spawn checks it again. */
const RELEARN_MS = 7 * 24 * 3_600_000

/** One line to the debug log (`claude --debug`), never to the transcript. */
function dbg($: EngineInterface, text: string): void {
  $.ui.log(`subagent-cost: ${text}`, { to: 'debug' })
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function configOf(options: PluginOptions): Config {
  const rawMode = String(options.autoCompact ?? 'auto')
  return {
    lang: langOf(options.language),
    policy: parsePolicy(options.subagentModelPolicy),
    compact: {
      mode: rawMode === 'ask' || rawMode === 'off' ? rawMode : 'auto',
      atPercent: num(options.compactAtPercent, 60),
      atTokens: num(options.compactAtTokens, 150_000),
    },
    th: {
      warnAt: num(options.warnAt, 88),
      handoffAt: num(options.handoffAt, 90),
      warnAt7d: num(options.warnAt7d, 88),
      handoffAt7d: num(options.handoffAt7d, 90),
    },
    handoffPath: String(options.handoffPath || 'HANDOFF.md'),
  }
}

function sameModel(a: string | undefined, b: string | undefined): boolean {
  const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/\[.*\]$/, '').trim()
  return norm(a) !== '' && norm(a) === norm(b)
}

/**
 * Whether subagents of this type have been seen running on the parent's model
 * when no `model` was given: true, false, or undefined when never seen or seen
 * more than RELEARN_MS ago. Kept in `$.store`, so it carries across sessions.
 *
 * The spawn does not say what a type's definition names, so a definition that
 * changes is noticed only when the type is seen again: under `warn` or `off`,
 * or once the record is older than RELEARN_MS.
 */
async function inheritsByType($: EngineInterface, type: string): Promise<boolean | undefined> {
  const v = await $.store.get(`inherits:${type}`)
  // 0.1.0 kept a bare boolean with no time: learn the type again.
  if (!v || typeof v !== 'object') return undefined
  const { inherits, at } = v as { inherits?: unknown; at?: unknown }
  if (typeof inherits !== 'boolean' || typeof at !== 'number') return undefined
  if ((await $.clock.now()) - at > RELEARN_MS) return undefined
  return inherits
}

async function learnType($: EngineInterface, type: string, inherits: boolean): Promise<void> {
  await $.store.set(`inherits:${type}`, { inherits, at: await $.clock.now() })
}

function rowFor(agents: Record<string, AgentRow>, agentId: string): AgentRow | undefined {
  return Object.values(agents).find(a => a.agentId === agentId)
}

async function totalWeighted($: EngineInterface): Promise<number> {
  const main = await read($, mainAtom)
  const agents = await read($, agentsAtom)
  return Object.values(agents).reduce((sum, a) => sum + a.weighted, main.weighted)
}

/** Appends a waiting handoff request to the conversation, between turns. */
async function deliverByAppend($: EngineInterface): Promise<void> {
  const pending = await read($, pendingAtom)
  if (!pending) return
  await update($, pendingAtom, () => null)
  const res = await $.session.append({
    message: { type: 'user', content: [{ type: 'text', text: pending.text }] },
  })
  if (res.deny !== undefined) {
    // Keep it for the next chance.
    await update($, pendingAtom, () => pending)
    dbg($, `handoff request refused by a plugin above: ${res.deny}`)
    return
  }
  dbg($, `handoff request appended (${pending.key})`)
}

async function isBusy($: EngineInterface): Promise<boolean> {
  const list = await $.agent.list()
  if (list.some(a => BUSY_STATUSES.has(a.status))) return true
  if (lastStop && lastStop.inFlight > 0 && (await $.clock.now()) - lastStop.at < 60_000) return true
  return false
}

async function runCompact($: EngineInterface, turns: number): Promise<void> {
  try {
    dbg($, 'compacting')
    const res = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
    if (res.skip !== undefined) {
      await update($, compactAtom, s => ({ ...s, isSuggested: false, holdUntilTurn: turns + 3 }))
      dbg($, `compaction skipped: ${res.skip}`)
      return
    }
    const after = res.tokensAfter ?? (await $.session.usage()).context.tokens
    await update($, compactAtom, () => ({ isSuggested: false, tokensAfter: after }))
    dbg($, `compacted: ${res.tokensBefore ?? '?'} -> ${after ?? '?'} tokens`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // A session the desktop app or the SDK runs has no between-turn
    // compaction yet; there it runs as a queued `/compact`, inside a turn.
    if (/headless|SDK/i.test(message)) {
      await compactByCommand($, turns)
      return
    }
    // A turn started meanwhile, or the engine refused: try again later.
    await update($, compactAtom, s => ({ ...s, holdUntilTurn: turns + 1 }))
    dbg($, `compaction rejected: ${message}`)
  }
}

async function compactByCommand($: EngineInterface, turns: number): Promise<void> {
  try {
    dbg($, 'compacting with a queued /compact')
    // Compacting starts a turn of its own; the hold keeps the turn counted
    // for it from scheduling another compaction straight after.
    await update($, compactAtom, s => ({ ...s, isSuggested: false, holdUntilTurn: turns + 2 }))
    await $.command.run({ command: 'compact', args: COMPACT_INSTRUCTIONS })
    const after = (await $.session.usage()).context.tokens
    await update($, compactAtom, s => ({ ...s, tokensAfter: after }))
    dbg($, `compacted by command: now ${after ?? '?'} tokens`)
  } catch (err) {
    await update($, compactAtom, s => ({ ...s, holdUntilTurn: turns + 1 }))
    dbg($, `compaction by command rejected: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Runs a little after a main-loop turn that answered: compacts when the
 * context is large and nothing else is running. */
async function maybeCompact($: EngineInterface, turnAtSchedule: number): Promise<void> {
  const main = await read($, mainAtom)
  if (main.turns !== turnAtSchedule || isMainTurnRunning) return
  const state = await read($, compactAtom)
  if (state.holdUntilTurn !== undefined && main.turns < state.holdUntilTurn) return
  // Past the handoff threshold a compaction could drop the handoff request,
  // and it spends quota of its own.
  if (pastHandoff(liveWindows(await read($, windowsAtom), await $.clock.now()), cfg.th)) return
  const usage = await $.session.usage()
  const ctx = { tokens: usage.context.tokens, percent: usage.context.percent }
  if (!contextOverThreshold(ctx, cfg.compact)) {
    if (state.isSuggested) await update($, compactAtom, s => ({ ...s, isSuggested: false }))
    return
  }
  if (state.tokensAfter !== undefined && (ctx.tokens ?? 0) < state.tokensAfter + REGROWTH_TOKENS) {
    dbg($, `no compaction: context ${ctx.tokens} has not grown ${REGROWTH_TOKENS} past ${state.tokensAfter}`)
    return
  }
  if (await isBusy($)) {
    dbg($, 'no compaction: an agent or background task is running')
    return
  }

  if (cfg.compact.mode === 'ask') {
    if (!state.isSuggested) {
      await update($, compactAtom, s => ({ ...s, isSuggested: true }))
      $.ui.toast(
        cfg.lang === 'zh'
          ? '这件事做完了，上下文偏大：输入框上方可一键压缩。'
          : 'Task done and the context is large: compact it from the row above the prompt.',
      )
    }
    return
  }
  await runCompact($, main.turns)
}

async function compactFromButton($: EngineInterface): Promise<void> {
  await update($, compactAtom, s => ({ ...s, isSuggested: false }))
  await runCompact($, (await read($, mainAtom)).turns)
}

export const register: Register = (on, options) => {
  cfg = configOf(options)

  // ------------------------------------------------------------ subagents
  //
  // The hooks on events a hook could refuse (agent.spawn, tool.call,
  // classic.Stop) only observe. Each has a `.catch` that lets the call go on
  // when the hook fails: where it had already called `next`, that answer stands.

  on('agent.spawn', async ($, e, next) => {
    if (e.resume || e.isTeammate || e.workflow) return next(e)

    // With no `model` given, the agent's own definition decides first, then the
    // parent. The spawn does not say which one a type uses, so a type is
    // downgraded only after it has been seen running on the parent's model:
    // setting `model` on a type that names its own (Explore on Haiku) would
    // replace that model.
    let input = e
    let isDowngraded = false
    const isUnpinned = !e.fork && !e.model
    if (cfg.policy.kind === 'downgrade' && isUnpinned && isExpensive(e.parentModel)) {
      if ((await inheritsByType($, e.subagentType)) === true) {
        input = { ...e, model: cfg.policy.model }
        isDowngraded = true
      }
    }
    const res = await next(input)
    if ('deny' in res && res.deny) return res

    // Learn only under an expensive parent: under a cheap one (Haiku), a type
    // that names Haiku of its own looks the same as one that inherits.
    if (isUnpinned && !isDowngraded && res.model && isExpensive(e.parentModel)) {
      await learnType($, e.subagentType, sameModel(res.model, e.parentModel))
    }

    const inherited =
      !isDowngraded &&
      (e.fork || !e.model) &&
      isExpensive(res.model) &&
      sameModel(res.model, e.parentModel)

    await update($, agentsAtom, agents => {
      const prev = agents[e.tool_use_id]
      const row: AgentRow = {
        toolUseId: e.tool_use_id,
        agentId: res.agentId,
        type: e.fork ? 'fork' : e.subagentType,
        model: res.model,
        inherited,
        background: e.background,
        usage: prev?.usage ?? EMPTY_TALLY,
        weighted: prev?.weighted ?? 0,
        turns: prev?.turns ?? 0,
      }
      return { ...agents, [e.tool_use_id]: row }
    })

    if (inherited && cfg.policy.kind === 'warn') {
      const fam = familyOf(res.model)
      const name = e.fork ? 'fork' : e.subagentType
      $.ui.toast(
        cfg.lang === 'zh'
          ? `子代理 ${name} 继承了主模型 ${fam}。省额度可在调用时指定 model（如 haiku / sonnet），或把 subagentModelPolicy 设为 downgrade:sonnet。`
          : `Subagent ${name} inherited the main model (${fam}). To save quota, pass a model (haiku / sonnet) or set subagentModelPolicy to downgrade:sonnet.`,
        { timeoutMs: 8000 },
      )
    } else if (inherited && cfg.policy.kind === 'downgrade' && !e.fork) {
      const fam = familyOf(res.model)
      const target = cfg.policy.model
      $.ui.toast(
        cfg.lang === 'zh'
          ? `子代理 ${e.subagentType} 继承了主模型 ${fam}。之后的 ${e.subagentType} 子代理会改用 ${target}（subagentModelPolicy）。`
          : `Subagent ${e.subagentType} inherited the main model (${fam}). Later ${e.subagentType} subagents will run on ${target} (subagentModelPolicy).`,
        { timeoutMs: 8000 },
      )
    }
    return res
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const res = await next(e)
    if (res.deny !== undefined || res.isError || !res.result) return res
    const raw = res.result
    if (!('status' in raw) || raw.status !== 'completed') return res
    const result = raw

    const split = cacheSplit(result.usage.cache_creation)
    await update($, agentsAtom, agents => {
      const prev = agents[e.tool_use_id] ?? rowFor(agents, result.agentId)
      const base: AgentRow = prev ?? {
        toolUseId: e.tool_use_id,
        agentId: result.agentId,
        type: result.agentType ?? 'agent',
        model: result.resolvedModel,
        inherited: false,
        background: false,
        usage: EMPTY_TALLY,
        weighted: 0,
        turns: 0,
      }
      // The split is the result's last request's, and is applied to the run
      // the result reports (the latest); earlier runs keep their price.
      const row = applySplit(
        {
          ...base,
          toolUseId: e.tool_use_id,
          agentId: base.agentId ?? result.agentId,
          model: base.model ?? result.resolvedModel,
          toolUses: result.totalToolUseCount,
          durationMs: result.totalDurationMs,
          cacheTtl: split.ttl ?? base.cacheTtl,
        },
        split.share1h,
      )
      const out = { ...agents }
      // A row first filed under another key (found by its agent id) moves here.
      if (prev && prev.toolUseId !== e.tool_use_id) delete out[prev.toolUseId]
      out[e.tool_use_id] = row
      return out
    })
    dbg(
      $,
      `Agent result ${result.agentId}: totalTokens ${result.totalTokens}, usage ${JSON.stringify({
        input: result.usage.input_tokens,
        output: result.usage.output_tokens,
        cacheWrite: result.usage.cache_creation_input_tokens,
        cacheRead: result.usage.cache_read_input_tokens,
      })}, ${result.totalToolUseCount} tools, ${result.resolvedModel ?? '?'}`,
    )
    return res
  }).catch(($, e, next) => next(e))

  // ------------------------------------------------------------ main loop

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      isMainTurnRunning = true
      askedByTool = false
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A background subagent's row gets no Agent result to read its tool
      // count from; count its calls here instead.
      toolCalls.set(e.agentId, (toolCalls.get(e.agentId) ?? 0) + 1)
      return next(e)
    }
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (tool === 'AskUserQuestion') askedByTool = true
    if (tool.endsWith('wrap_up') && typeof input.ask === 'string' && input.ask.trim() !== '') {
      askedByTool = true
    }
    const res = await next(e)
    // A handoff request reaches the model after this tool's result, the way
    // a PostToolUse hook's context does, so it lands mid-turn.
    const pending = await read($, pendingAtom)
    if (pending && res.deny === undefined) {
      await update($, pendingAtom, () => null)
      dbg($, `handoff request attached to the ${tool} result (${pending.key})`)
      return { ...res, context: [...(res.context ?? []), pending.text] }
    }
    return res
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    lastStop = { at: await $.clock.now(), inFlight: e.background_tasks?.length ?? 0 }
    dbg($, `Stop: ${lastStop.inFlight} background task(s) in flight`)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)

    if (e.agentId !== undefined) {
      // A subagent's loop ended a turn: its usage covers that whole run.
      const agentId = e.agentId
      const tally = tallyOf(e.usage)
      const calls = toolCalls.get(agentId) ?? 0
      toolCalls.delete(agentId)
      const agents = await read($, agentsAtom)
      let type = 'agent'
      if (!rowFor(agents, agentId)) {
        const info = (await $.agent.list()).find(a => a.id === agentId)
        type = info?.type ?? type
      }
      await update($, agentsAtom, current => {
        const prev = rowFor(current, agentId)
        const key = prev?.toolUseId ?? `agent:${agentId}`
        const base: AgentRow = prev ?? {
          toolUseId: key,
          agentId,
          type,
          inherited: false,
          background: true,
          usage: EMPTY_TALLY,
          weighted: 0,
          turns: 0,
        }
        // A subagent continued with a message runs again under its id: the
        // run adds to the row, its tools and time with it.
        const isContinued = base.turns > 0
        const row = addRun(
          {
            ...base,
            toolUses: calls > 0 ? (base.toolUses ?? 0) + calls : base.toolUses,
            durationMs: isContinued
              ? (base.durationMs ?? 0) + e.durationMs
              : (base.durationMs ?? e.durationMs),
          },
          tally,
          e.usage?.model,
        )
        return { ...current, [key]: row }
      })
      dbg(
        $,
        `subagent ${agentId} turn ${e.reason}: ${JSON.stringify(tally)} on ${e.usage?.model ?? '?'}, ` +
          `${calls} tool call(s) seen, ${e.durationMs}ms`,
      )
      return res
    }

    // The main loop.
    isMainTurnRunning = false
    const tally = tallyOf(e.usage)
    const main = await update($, mainAtom, m => ({
      usage: addTally(m.usage, tally),
      weighted: m.weighted + weigh(tally, e.usage?.model, 0),
      turns: m.turns + 1,
      model: e.usage?.model ?? m.model,
    }))

    dbg($, `main turn ${e.reason}: ${JSON.stringify(tally)} on ${e.usage?.model ?? '?'}`)

    // A handoff request no tool result carried goes in between turns.
    await deliverByAppend($)

    if (e.reason !== 'answer' || cfg.compact.mode === 'off') return res
    if (endsWithQuestion(e.answer, askedByTool)) {
      dbg($, 'no compaction: the turn ended with a question')
      return res
    }
    const turns = main.turns
    $.clock.after(COMPACT_DELAY_MS, () => {
      maybeCompact($, turns).catch(() => undefined)
    })
    return res
  })

  // ------------------------------------------------------------ quota

  on('session.measure', async ($, e, next) => {
    const windows: WindowReading[] = e.rateLimits.map(r => ({
      kind: r.kind,
      percentUsed: r.percentUsed,
      resetsAt: r.resetsAt,
    }))
    await update($, contextAtom, () => ({
      tokens: e.context.tokens,
      percent: e.context.percent,
      window: e.context.window,
    }))
    // The windows the last response reported, whole: an empty list means none
    // has a reading now (off a subscription, say), not "unchanged".
    await update($, windowsAtom, () => windows)

    // The estimate.
    const five = windows.find(w => w.kind === FIVE_HOUR)
    if (five) {
      const weighted = await totalWeighted($)
      const step = stepEstimate(await read($, baselineAtom), await read($, rateAtom), five, weighted)
      await update($, baselineAtom, () => step.baseline)
      await update($, rateAtom, () => step.rate)
      dbg(
        $,
        `measure: 5h ${five.percentUsed}% (resets ${five.resetsAt ?? '?'}), weighted $${weighted.toFixed(4)}, ` +
          `context ${e.context.tokens ?? '?'} tokens, cost ${e.cost?.usd?.toFixed(4) ?? '?'}, rate ${JSON.stringify(step.rate)}`,
      )
    }

    // The alerts, one of each per window. A reading far under the thresholds
    // means its window reset, which re-arms that kind.
    const warned = await read($, warnedAtom)
    const handedOff = await read($, handedOffAtom)
    const warnedNow = rearm(warned, windows, cfg.th)
    const handedOffNow = rearm(handedOff, windows, cfg.th)
    if (warnedNow.length !== warned.length) await update($, warnedAtom, () => warnedNow)
    if (handedOffNow.length !== handedOff.length) await update($, handedOffAtom, () => handedOffNow)

    const alerts = alertsFor(windows, cfg.th, warnedNow, handedOffNow)
    const due = alerts.filter(a => a.kind === 'handoff')
    for (const alert of alerts) {
      if (alert.kind !== 'warn') continue
      await update($, warnedAtom, keys => [...keys, alert.key])
      $.ui.toast(warnToast(alert.window, cfg.th, cfg.lang), { timeoutMs: 8000 })
    }
    if (due.length > 0) {
      await update($, handedOffAtom, keys => [...keys, ...due.map(a => a.key)])
      // One request for every window due, joined with any still waiting to go
      // out. (A request an earlier version left waiting names no windows: the
      // new one, which asks the same, takes its place.)
      const waiting = await read($, pendingAtom)
      const named = mergeWindows(waiting?.windows ?? [], due.map(a => a.window))
      const key = [waiting?.key, ...due.map(a => a.key)].filter(k => k).join(' + ')
      const text = handoffNote(named, cfg.handoffPath, await $.session.cwd(), await $.clock.now())
      await update($, pendingAtom, () => ({ key, text, windows: named }))
      for (const alert of due) {
        $.ui.toast(handoffToast(alert.window, cfg.handoffPath, cfg.lang), { timeoutMs: 10000 })
      }
      // Between turns the note can go in at once; during a turn it rides the
      // next tool result, or the turn's end.
      if (!isMainTurnRunning) await deliverByAppend($)
    }

    return next(e)
  })

  // ------------------------------------------------------------ drawing

  on('ui.render', { component: 'ToolUse', props: { tool: 'Agent' } }, async ($, e, next) => {
    const engine = await next(e)
    const agents = await read($, agentsAtom)
    const row = agents[e.props.tool_use_id]
    if (!row) return engine
    const rate = await read($, rateAtom)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {engine}
        <Text dimColor wrap="truncate-end">
          {'  ⎿ ' + agentLine(row, rate, cfg.lang)}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const now = await $.clock.now()
    const windows = liveWindows(await read($, windowsAtom), now)
    const agents = Object.values(await read($, agentsAtom))
    const main = await read($, mainAtom)
    const compact = await read($, compactAtom)
    if (windows.length === 0 && agents.length === 0 && main.turns === 0) return next(e)

    const line = bandLine({
      windows,
      mainTokens: totalTokens(main.usage),
      agents,
      now,
      lang: cfg.lang,
    })
    const isWarn = pastWarn(windows, cfg.th)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        <Text color={isWarn ? 'warning' : undefined} dimColor={!isWarn} wrap="truncate-end">
          {(isWarn ? '⚠ ' : '') + line}
        </Text>
        {compact.isSuggested ? (
          <Button
            key="compact"
            label={cfg.lang === 'zh' ? '压缩上下文' : 'Compact context'}
            onPress={() => compactFromButton($)}
          />
        ) : null}
      </Box>
    )
  })
}
