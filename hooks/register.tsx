import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type {
  AgentRow,
  AgentToolRun,
  CompactState,
  ContextReading,
  HandoffBatch,
  HandoffClaim,
  MainTally,
  PendingNote,
  QuotaAlerts,
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
  isLiveAlertKey,
  langOf,
  liveWindows,
  mergeWindows,
  parsePolicy,
  pastHandoff,
  pastWarn,
  rearm,
  rememberReset,
  rememberResets,
  requestTag,
  stepEstimate,
  tallyOf,
  totalTokens,
  warnToast,
  weigh,
  windowKey,
} from './logic'
import type { Alert, CompactSettings, Lang, ModelPolicy, Thresholds } from './logic'


const agentsAtom = atom({ plugin: 'subagent-cost', key: 'agents' } as const, {} as Record<string, AgentRow>)
const agentToolRunsAtom = atom({ plugin: 'subagent-cost', key: 'agentToolRuns' } as const, {} as Record<string, AgentToolRun>)
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
const alertsAtom = atom({ plugin: 'subagent-cost', key: 'quotaAlerts' } as const, null as QuotaAlerts | null)
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

/** The ids of the handoff claims this load of the mod is sending. A claim in
 * the session's state that is not here was cut short: the mod reloaded or the
 * session restarted mid-send, or the send could not be settled. */
const ownClaims = new Set<string>()

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

async function loadQuotaAlerts($: EngineInterface): Promise<QuotaAlerts> {
  const current = await read($, alertsAtom)
  if (current) return current

  const [warned, handedOff, note] = await Promise.all([
    read($, warnedAtom), read($, handedOffAtom), read($, pendingAtom),
  ])
  const waiting = note
    ? { windows: note.windows ?? [], legacy: note.windows?.length ? undefined : note }
    : null
  // Older versions marked requests as handed off before sending them.
  const waitingKeys = new Set(note?.key.split(' + '))
  const initial = { warned, handedOff: handedOff.filter(key => !waitingKeys.has(key)), waiting, sending: null }
  return (await update($, alertsAtom, state => state ?? initial)) ?? initial
}

function handoffKeys(batch: HandoffBatch | null): string[] {
  if (!batch) return []
  return [...(batch.legacy?.key.split(' + ') ?? []), ...batch.windows.map(windowKey)]
}

function mergeHandoffs(first: HandoffBatch | null, second: HandoffBatch | null): HandoffBatch | null {
  if (!first || !second) return first ?? second
  return { windows: mergeWindows(first.windows, second.windows), legacy: first.legacy ?? second.legacy }
}

/** A claim's windows and text, without its id: what goes back in the queue. */
function batchOf(claim: HandoffClaim): HandoffBatch {
  return claim.legacy ? { windows: claim.windows, legacy: claim.legacy } : { windows: claim.windows }
}

/** The request's text, opened by its tag. */
function requestText(batch: HandoffBatch, id: string, cwd: string, now: number): string | undefined {
  const legacy = batch.legacy?.text
  if (batch.windows.length > 0) return handoffNote(batch.windows, cfg.handoffPath, cwd, now, legacy, id)
  return legacy ? `${legacy}\n\n${requestTag(id)}` : undefined
}

function liveHandoff(
  batch: HandoffBatch | null,
  now: number,
  readings: readonly WindowReading[] = [],
): HandoffBatch | null {
  if (!batch) return null
  const dated = liveWindows(batch.windows.map(w => rememberReset(w, readings)), now)
  const stillDue = new Set(rearm(dated.map(windowKey), readings, cfg.th))
  const windows = dated.filter(w => stillDue.has(windowKey(w)))
  const legacy = batch.legacy?.key.split(' + ').some(key => isLiveAlertKey(key, now)) ? batch.legacy : undefined
  return windows.length > 0 || legacy ? { windows, legacy } : null
}

async function observeAlerts($: EngineInterface, windows: WindowReading[], now: number): Promise<Alert[]> {
  const initial = await loadQuotaAlerts($)
  let alerts: Alert[] = []
  await update($, alertsAtom, current => {
    const state = current ?? initial
    const warned = rememberResets(rearm(state.warned, windows, cfg.th), windows)
    const handedOff = rememberResets(rearm(state.handedOff, windows, cfg.th), windows)
    const waiting = liveHandoff(state.waiting, now, windows)
    const sending = state.sending && {
      ...state.sending,
      windows: state.sending.windows.map(w => rememberReset(w, windows)),
    }
    const reserved = rememberResets([...handoffKeys(waiting), ...handoffKeys(sending)], windows)
    alerts = alertsFor(windows, cfg.th, warned, [...handedOff, ...reserved], now)
    const due = alerts.filter(a => a.kind === 'handoff').map(a => a.window)
    return {
      warned: [...warned, ...alerts.filter(a => a.kind === 'warn').map(a => a.key)],
      handedOff,
      waiting: due.length > 0 ? mergeHandoffs(waiting, { windows: due }) : waiting,
      sending,
    }
  })
  return alerts
}

/** Whether a user row of the main conversation holds `tag`. */
async function isInConversation($: EngineInterface, tag: string): Promise<boolean> {
  try {
    const rows = await $.session.messages()
    return rows.some(row => row.role === 'user' && row.text.includes(tag))
  } catch (err) {
    dbg($, `conversation unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** Settles a claim that no send of this load holds. A request the conversation
 * holds went out and counts as handed off; any other goes back in the queue.
 * A request attached to a tool result is settled before the result is
 * returned, so an unsettled one never reached the conversation. */
async function recoverClaim($: EngineInterface): Promise<void> {
  const held = (await loadQuotaAlerts($)).sending
  if (!held || (held.id !== undefined && ownClaims.has(held.id))) return
  const wentOut = held.id !== undefined && (await isInConversation($, requestTag(held.id)))
  let isSettled = false
  await update($, alertsAtom, current => {
    isSettled = false
    const claim = current?.sending
    if (!current || !claim || claim.id !== held.id) return current
    isSettled = true
    return {
      ...current,
      sending: null,
      waiting: wentOut ? current.waiting : mergeHandoffs(batchOf(claim), current.waiting),
      handedOff: wentOut ? [...current.handedOff, ...handoffKeys(claim)] : current.handedOff,
    }
  })
  if (isSettled) {
    dbg($, `unsettled handoff request ${held.id ?? '(0.1.2)'}: ${wentOut ? 'it went out' : 'queued again'}`)
  }
}

/** Take the current batch atomically. A failed delivery joins the requests
 * that came due while it was being sent. */
async function deliverHandoff($: EngineInterface, send: (text: string) => boolean | Promise<boolean>): Promise<boolean> {
  await recoverClaim($)
  const state = await loadQuotaAlerts($)
  if (!state.waiting || state.sending) return false

  let cwd: string
  try {
    cwd = await $.session.cwd()
  } catch (err) {
    dbg($, `handoff working directory unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  const now = await $.clock.now()
  const id = crypto.randomUUID().slice(0, 8)
  // Held before the claim is written, so no other hook of this load takes it
  // for a cut-short one.
  ownClaims.add(id)
  const claim: { batch: HandoffClaim | null } = { batch: null }
  try {
    await update($, alertsAtom, current => {
      // update can retry after another hook changes the state.
      claim.batch = null
      if (!current?.waiting || current.sending) return current
      const batch = liveHandoff(current.waiting, now)
      claim.batch = batch && { ...batch, id }
      return { ...current, waiting: null, sending: claim.batch }
    })
  } finally {
    if (!claim.batch) ownClaims.delete(id)
  }
  const batch = claim.batch
  if (!batch) return false

  let delivered = false
  try {
    const text = requestText(batch, id, cwd, now)
    if (text) delivered = await send(text)
  } catch (err) {
    dbg($, `handoff delivery failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    try {
      await update($, alertsAtom, current => {
        // This claim only: a later load may have settled it already.
        const sent = current?.sending
        if (!current || sent?.id !== id) return current
        return {
          ...current,
          sending: null,
          waiting: delivered ? current.waiting : mergeHandoffs(batchOf(sent), current.waiting),
          handedOff: delivered ? [...current.handedOff, ...handoffKeys(sent)] : current.handedOff,
        }
      })
    } finally {
      // Unsettled after this, the claim is recovered as a cut-short one.
      ownClaims.delete(id)
    }
  }
  return delivered
}

/** Appends waiting handoff requests to the conversation, between turns. */
async function deliverByAppend($: EngineInterface): Promise<void> {
  while (!isMainTurnRunning) {
    const delivered = await deliverHandoff($, async text => {
      if (isMainTurnRunning) return false
      const res = await $.session.append({
        message: { type: 'user', content: [{ type: 'text', text }] },
      })
      if (res.deny !== undefined) {
        dbg($, `handoff request refused: ${res.deny}`)
        return false
      }
      dbg($, 'handoff request appended')
      return true
    })
    if (!delivered) return
  }
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

type CompactHold = 'turn' | 'quota' | 'busy'

/** What keeps a compaction from running now, checked when the button is pressed. */
async function compactHold($: EngineInterface): Promise<CompactHold | undefined> {
  if (isMainTurnRunning) return 'turn'
  if (pastHandoff(liveWindows(await read($, windowsAtom), await $.clock.now()), cfg.th)) return 'quota'
  if (await isBusy($)) return 'busy'
  return undefined
}

function holdToast(hold: CompactHold, lang: Lang): string {
  const zh = lang === 'zh'
  if (hold === 'quota') {
    return zh
      ? '额度已过交接线，不压缩：先写交接任务书，压缩也要花额度。'
      : 'Not compacting: the quota is past the handoff threshold, so the brief comes first, and compacting spends quota too.'
  }
  if (hold === 'busy') {
    return zh
      ? '还有子代理或后台任务在跑，先不压缩；跑完再按。'
      : 'Not compacting yet: an agent or background task is still running. Press again once it is done.'
  }
  return zh ? 'Claude 这一轮还没结束，先不压缩；结束后再按。' : 'Not compacting yet: Claude is still in a turn. Press again once it ends.'
}

/** The band's button, pressed: the offer may be stale by now. */
async function compactFromButton($: EngineInterface): Promise<void> {
  const hold = await compactHold($)
  if (hold === undefined) {
    await update($, compactAtom, s => ({ ...s, isSuggested: false }))
    await runCompact($, (await read($, mainAtom)).turns)
    return
  }
  // Past the handoff threshold the offer is withdrawn; otherwise it stands.
  if (hold === 'quota') await update($, compactAtom, s => ({ ...s, isSuggested: false }))
  dbg($, `compaction held off at the button: ${hold}`)
  $.ui.toast(holdToast(hold, cfg.lang), { timeoutMs: 8000 })
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

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isMainTurnRunning = true
      askedByTool = false
      return next(e)
    }
    const agentId = e.agentId
    await update($, agentToolRunsAtom, runs => {
      const active = runs[agentId]
      const count = active?.turnId === undefined || active.turnId === e.turnId ? (active?.count ?? 0) : 0
      return { ...runs, [agentId]: { turnId: e.turnId, count } }
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A background subagent's row gets no Agent result to read its tool
      // count from; count its calls here instead.
      const agentId = e.agentId
      await update($, agentToolRunsAtom, runs => ({
        ...runs,
        [agentId]: { ...runs[agentId], count: (runs[agentId]?.count ?? 0) + 1 },
      }))
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
    if (res.deny !== undefined) return res
    let context = res.context
    await deliverHandoff($, text => {
      context = [...(context ?? []), text]
      dbg($, `handoff request attached to the ${tool} result`)
      return true
    })
    return context === res.context ? res : { ...res, context }
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
      const active = (await read($, agentToolRunsAtom))[agentId]
      const finished = active?.turnId === undefined || active.turnId === e.turnId ? active : undefined
      const calls = finished?.count ?? 0
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
        // An Agent result that came first already counts this run's tools.
        const isContinued = base.turns > 0
        const row = addRun(
          {
            ...base,
            toolUses: isContinued ? (base.toolUses ?? 0) + calls : (base.toolUses ?? calls),
            durationMs: isContinued
              ? (base.durationMs ?? 0) + e.durationMs
              : (base.durationMs ?? e.durationMs),
          },
          tally,
          e.usage?.model,
        )
        return { ...current, [key]: row }
      })
      if (finished) {
        await update($, agentToolRunsAtom, runs => {
          const active = runs[agentId]
          if (!active || active.turnId !== finished.turnId || active.count !== finished.count) return runs
          const remaining = { ...runs }
          delete remaining[agentId]
          return remaining
        })
      }
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
    const now = await $.clock.now()
    const windows = liveWindows(e.rateLimits.map(r => ({
      kind: r.kind,
      percentUsed: r.percentUsed,
      resetsAt: r.resetsAt?.trim() || undefined,
    })), now)
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

    // A compaction offered earlier is withdrawn at the handoff threshold.
    if (pastHandoff(windows, cfg.th) && (await read($, compactAtom)).isSuggested) {
      await update($, compactAtom, s => ({ ...s, isSuggested: false }))
    }

    for (const alert of await observeAlerts($, windows, now)) {
      if (alert.kind === 'warn') {
        $.ui.toast(warnToast(alert.window, cfg.th, cfg.lang), { timeoutMs: 8000 })
      } else {
        $.ui.toast(handoffToast(alert.window, cfg.handoffPath, cfg.lang), { timeoutMs: 10000 })
      }
    }
    if (!isMainTurnRunning) await deliverByAppend($)

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
    const engine = await next(e)
    if (e.props.hasSurvey) return engine
    const now = await $.clock.now()
    const windows = liveWindows(await read($, windowsAtom), now)
    const agents = Object.values(await read($, agentsAtom))
    const main = await read($, mainAtom)
    const compact = await read($, compactAtom)
    if (windows.length === 0 && agents.length === 0 && main.turns === 0) return engine

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
      <Box flexDirection="column">
        {engine}
        <Box flexDirection="row">
          <Text color={isWarn ? 'warning' : undefined} dimColor={!isWarn} wrap="truncate-end">
            {(isWarn ? '⚠ ' : '') + line}
          </Text>
          {compact.isSuggested && !pastHandoff(windows, cfg.th) ? (
            <Button
              key="compact"
              label={cfg.lang === 'zh' ? '压缩上下文' : 'Compact context'}
              onPress={() => compactFromButton($)}
            />
          ) : null}
        </Box>
      </Box>
    )
  })
}
