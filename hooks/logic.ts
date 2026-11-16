// Pure functions: prices, weighting, the quota-share estimate, formatting and
// the decisions the hooks make. Nothing here touches `$`, so tests can call
// every function directly.

import type {
  AgentRow,
  Baseline,
  Rate,
  TokenTally,
  WindowReading,
} from '../types'

// ---------------------------------------------------------------- prices

/** USD per million tokens. Cache writes are priced from `input` (1.25x for a
 * 5-minute TTL, 2x for 1 hour), as the API prices them. */
export type Price = { input: number; output: number; cacheRead: number }

// Anthropic first-party API list prices, as listed in the Claude API
// reference bundled with Claude Code 2.1.325.
// Only the ratios matter for the estimate: numerator and denominator are both
// weighted with this one table, so a uniform error cancels out.
const PRICES: ReadonlyArray<readonly [RegExp, Price]> = [
  [/(fable|mythos)-5-2/, { input: 8, output: 40, cacheRead: 0.2 }],
  [/(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/(fable|mythos)-5(?!-\d)/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-(5|4-[5-8])(?!-\d)/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet-5-5/, { input: 2, output: 10, cacheRead: 0.1 }],
  [/sonnet-5(?!-\d)/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet-4/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  // Families by name when the version is unknown (a newer model, an alias).
  [/fable|mythos/, { input: 8, output: 40, cacheRead: 0.2 }],
  [/opus/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/sonnet/, { input: 2, output: 10, cacheRead: 0.1 }],
  [/haiku/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
]

const FALLBACK_PRICE: Price = { input: 2, output: 10, cacheRead: 0.1 }

export function priceOf(model: string | undefined): Price {
  const id = (model ?? '').toLowerCase()
  for (const [pattern, price] of PRICES) {
    if (pattern.test(id)) return price
  }
  return FALLBACK_PRICE
}

/** Opus, Fable and Mythos: the models a subagent should not inherit by accident. */
export function isExpensive(model: string | undefined): boolean {
  return /opus|fable|mythos/i.test(model ?? '')
}

/** A short model family name for messages: "Opus", "Fable", ... */
export function familyOf(model: string | undefined): string {
  const m = /(opus|fable|mythos|sonnet|haiku)/i.exec(model ?? '')
  if (!m || !m[1]) return model ?? '?'
  const name = m[1].toLowerCase()
  return name.charAt(0).toUpperCase() + name.slice(1)
}

// ---------------------------------------------------------------- tallies

export const EMPTY_TALLY: TokenTally = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
}

/** The four counts an engine `TurnUsage` / `ModelUsage` carries. */
export type UsageLike = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
}

export function tallyOf(usage: UsageLike | undefined): TokenTally {
  if (!usage) return EMPTY_TALLY
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
  }
}

export function addTally(a: TokenTally, b: TokenTally): TokenTally {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
  }
}

export function totalTokens(t: TokenTally): number {
  return t.input + t.output + t.cacheWrite + t.cacheRead
}

/**
 * USD-equivalent of a tally at API list prices. `share1h` is the part of the
 * cache writes made with a 1-hour TTL (0 to 1); unknown counts as 0, the
 * 5-minute price.
 */
export function weigh(t: TokenTally, model: string | undefined, share1h = 0): number {
  const p = priceOf(model)
  const s = Math.min(1, Math.max(0, share1h))
  const writeMultiplier = 1.25 * (1 - s) + 2 * s
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheWrite * p.input * writeMultiplier +
      t.cacheRead * p.cacheRead) /
    1_000_000
  )
}

/** The cache TTL label and 1-hour share from an Agent result's last usage. */
export function cacheSplit(
  creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } | null | undefined,
): { ttl?: '5m' | '1h' | 'mixed'; share1h?: number } {
  if (!creation) return {}
  const h = creation.ephemeral_1h_input_tokens || 0
  const m = creation.ephemeral_5m_input_tokens || 0
  if (h + m === 0) return {}
  if (h === 0) return { ttl: '5m', share1h: 0 }
  if (m === 0) return { ttl: '1h', share1h: 1 }
  return { ttl: 'mixed', share1h: h / (h + m) }
}

// ---------------------------------------------------------------- windows

export const FIVE_HOUR = 'five_hour'
export const SEVEN_DAY = 'seven_day'

/** Two `resetsAt` readings name the same window when they are within ten
 * minutes: the header the figure comes from can move by seconds. */
export function sameWindow(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false
  return Math.abs(ta - tb) < 10 * 60 * 1000
}

/** The key one alert is deduplicated by: one per window kind and reset. */
export function windowKey(w: WindowReading): string {
  const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  // Round to ten minutes so a jittering reset time keeps one key.
  const slot = Number.isNaN(t) ? 'none' : String(Math.round(t / 600_000))
  return `${w.kind}@${slot}`
}

export type Thresholds = {
  warnAt: number
  handoffAt: number
  warnAt7d: number
  handoffAt7d: number
}

export type Alert = { kind: 'warn' | 'handoff'; window: WindowReading; key: string }

/**
 * Which alerts a reading crosses that have not fired yet in their window.
 * The handoff alert supersedes the warning for the same window.
 */
export function alertsFor(
  windows: readonly WindowReading[],
  th: Thresholds,
  warned: readonly string[],
  handedOff: readonly string[],
): Alert[] {
  const out: Alert[] = []
  for (const w of windows) {
    let warnAt: number
    let handoffAt: number
    if (w.kind === FIVE_HOUR) {
      warnAt = th.warnAt
      handoffAt = th.handoffAt
    } else if (w.kind === SEVEN_DAY) {
      warnAt = th.warnAt7d
      handoffAt = th.handoffAt7d
    } else {
      continue
    }
    const key = windowKey(w)
    if (w.percentUsed >= handoffAt && !handedOff.includes(key)) {
      out.push({ kind: 'handoff', window: w, key })
    } else if (w.percentUsed >= warnAt && !warned.includes(key) && !handedOff.includes(key)) {
      out.push({ kind: 'warn', window: w, key })
    }
  }
  return out
}

/** True while any window is at or past its handoff threshold. */
export function pastHandoff(windows: readonly WindowReading[], th: Thresholds): boolean {
  return windows.some(
    w =>
      (w.kind === FIVE_HOUR && w.percentUsed >= th.handoffAt) ||
      (w.kind === SEVEN_DAY && w.percentUsed >= th.handoffAt7d),
  )
}

export function pastWarn(windows: readonly WindowReading[], th: Thresholds): boolean {
  return windows.some(
    w =>
      (w.kind === FIVE_HOUR && w.percentUsed >= th.warnAt) ||
      (w.kind === SEVEN_DAY && w.percentUsed >= th.warnAt7d),
  )
}

// ---------------------------------------------------------------- estimate

/** How many points the 5-hour window must move before a rate is shown. */
export const MIN_POINTS = 2

/**
 * One step of the quota-share estimate. `weighted` is everything this session
 * has spent so far (main loop and subagents), weighted with `weigh`.
 *
 * The baseline is reset when the window resets or its percentage falls; a
 * rate is taken once the window has moved MIN_POINTS since the baseline. The
 * last good rate is kept across a reset, as it describes the account's limit,
 * not one window.
 */
export function stepEstimate(
  baseline: Baseline | null,
  rate: Rate | null,
  reading: WindowReading | undefined,
  weighted: number,
): { baseline: Baseline | null; rate: Rate | null } {
  if (!reading) return { baseline, rate }
  const fresh: Baseline = {
    resetsAt: reading.resetsAt,
    percent: reading.percentUsed,
    weighted,
  }
  if (
    !baseline ||
    !sameWindow(baseline.resetsAt, reading.resetsAt) ||
    reading.percentUsed < baseline.percent ||
    weighted < baseline.weighted
  ) {
    return { baseline: fresh, rate }
  }
  const points = reading.percentUsed - baseline.percent
  const spent = weighted - baseline.weighted
  if (points >= MIN_POINTS && spent > 0) {
    return {
      baseline,
      rate: { percentPerUsd: points / spent, points: round1(points) },
    }
  }
  return { baseline, rate }
}

/** The share of the 5-hour window a weighted amount is estimated at, or
 * undefined while no rate has enough points behind it. */
export function shareOf(weighted: number, rate: Rate | null): number | undefined {
  if (!rate || !(rate.percentPerUsd > 0) || !(weighted > 0)) return undefined
  return weighted * rate.percentPerUsd
}

// ---------------------------------------------------------------- compaction

/** Whether a turn ended by asking the person something: a heuristic. The last
 * non-empty line ends with a question mark, or the turn called
 * AskUserQuestion or a `*wrap_up` tool with an `ask`. */
export function endsWithQuestion(answer: string, askedByTool: boolean): boolean {
  if (askedByTool) return true
  const lines = answer.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
  const last = lines.at(-1) ?? ''
  // Strip trailing markdown emphasis and closing brackets or quotes.
  const bare = last.replace(/[*_`)\]）」』"'”’\s]+$/u, '')
  return /[?？]$/.test(bare)
}

export type CompactSettings = {
  mode: 'auto' | 'ask' | 'off'
  atPercent: number
  atTokens: number
}

/** The context is large enough to compact after a finished task. */
export function contextOverThreshold(
  ctx: { tokens?: number; percent?: number },
  s: CompactSettings,
): boolean {
  const byPercent = s.atPercent > 0 && (ctx.percent ?? 0) >= s.atPercent
  const byTokens = s.atTokens > 0 && (ctx.tokens ?? 0) >= s.atTokens
  return byPercent || byTokens
}

/** After an automatic compaction, wait for this much growth before another. */
export const REGROWTH_TOKENS = 20_000

export const COMPACT_INSTRUCTIONS =
  'Keep verbatim: decisions already made, key file paths, the work in progress, ' +
  'and open questions waiting for the user. If the conversation holds a request ' +
  'from subagent-cost to write a handoff brief that is not done yet, keep that ' +
  'request too.'

// ---------------------------------------------------------------- policy

export type ModelPolicy =
  | { kind: 'warn' }
  | { kind: 'off' }
  | { kind: 'downgrade'; model: string }

export function parsePolicy(raw: unknown): ModelPolicy {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === 'off') return { kind: 'off' }
  const m = /^downgrade:(.+)$/i.exec(text)
  if (m && m[1] && m[1].trim()) return { kind: 'downgrade', model: m[1].trim() }
  return { kind: 'warn' }
}

// ---------------------------------------------------------------- format

export type Lang = 'en' | 'zh'

export function langOf(raw: unknown): Lang {
  return raw === 'zh' ? 'zh' : 'en'
}

function trim0(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** 12345 -> "12.3k" (en) or "1.2 万" (zh). */
export function fmtTokens(n: number, lang: Lang): string {
  const v = Math.max(0, Math.round(n))
  if (lang === 'zh') {
    if (v < 1000) return String(v)
    if (v < 10_000) return `${trim0((v / 1000).toFixed(1))} 千`
    if (v < 100_000) return `${trim0((v / 10_000).toFixed(2))} 万`
    if (v < 100_000_000) return `${trim0((v / 10_000).toFixed(1))} 万`
    return `${trim0((v / 100_000_000).toFixed(1))} 亿`
  }
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${trim0((v / 1000).toFixed(1))}k`
  return `${trim0((v / 1_000_000).toFixed(1))}M`
}

export function fmtDuration(ms: number, lang: Lang): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return lang === 'zh' ? `${s} 秒` : `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) {
    if (lang === 'zh') return rest ? `${m} 分 ${rest} 秒` : `${m} 分`
    return rest ? `${m}m${rest}s` : `${m}m`
  }
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (lang === 'zh') return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`
  return mm ? `${h}h${mm}m` : `${h}h`
}

/** "resets in 2h10m" from an ISO time and now, or '' when unknown or past. */
export function fmtReset(resetsAt: string | undefined, now: number, lang: Lang): string {
  if (!resetsAt) return ''
  const t = Date.parse(resetsAt)
  if (Number.isNaN(t) || t <= now) return ''
  const left = fmtDuration(Math.ceil((t - now) / 60_000) * 60_000, lang)
  return lang === 'zh' ? `${left}后重置` : `resets in ${left}`
}

export function fmtPercent(n: number): string {
  if (n >= 10) return `${Math.round(n)}%`
  if (n >= 0.1) return `${trim0(n.toFixed(1))}%`
  return n > 0 ? '<0.1%' : '0%'
}

/** The line under a subagent's tool row. */
export function agentLine(row: AgentRow, rate: Rate | null, lang: Lang): string {
  const t = row.usage
  const zh = lang === 'zh'
  const parts: string[] = []
  parts.push(zh ? `子代理 ${row.type}` : `subagent ${row.type}`)
  parts.push(row.model ?? row.usageModel ?? '?')
  const ttl = row.cacheTtl ? (zh ? `（${row.cacheTtl}）` : ` (${row.cacheTtl})`) : ''
  if (row.turns > 0) {
    parts.push(
      zh
        ? `输入 ${fmtTokens(t.input, lang)} / 输出 ${fmtTokens(t.output, lang)} / 缓存写 ${fmtTokens(t.cacheWrite, lang)}${ttl} / 缓存读 ${fmtTokens(t.cacheRead, lang)}`
        : `in ${fmtTokens(t.input, lang)} / out ${fmtTokens(t.output, lang)} / cache write ${fmtTokens(t.cacheWrite, lang)}${ttl} / cache read ${fmtTokens(t.cacheRead, lang)}`,
    )
  } else {
    parts.push(zh ? '用量待回填' : 'usage pending')
  }
  if (row.toolUses !== undefined) {
    parts.push(zh ? `${row.toolUses} 次工具` : `${row.toolUses} tools`)
  }
  const ms = row.durationMs
  if (ms !== undefined) parts.push(fmtDuration(ms, lang))
  if (row.turns > 0) {
    const share = shareOf(row.weighted, rate)
    if (share !== undefined) {
      parts.push(zh ? `约占 5 小时额度 ${fmtPercent(share)}（估算）` : `≈${fmtPercent(share)} of 5h quota (estimate)`)
    }
  }
  if (row.inherited) {
    parts.push(zh ? `继承了 ${familyOf(row.model)}` : `inherited ${familyOf(row.model)}`)
  }
  return parts.join(' · ')
}

export type BandInput = {
  windows: readonly WindowReading[]
  mainTokens: number
  agents: readonly AgentRow[]
  now: number
  lang: Lang
}

/** The one-line session summary above the prompt. */
export function bandLine(b: BandInput): string {
  const zh = b.lang === 'zh'
  const parts: string[] = []
  const five = b.windows.find(w => w.kind === FIVE_HOUR)
  const seven = b.windows.find(w => w.kind === SEVEN_DAY)
  if (five) {
    const reset = fmtReset(five.resetsAt, b.now, b.lang)
    parts.push(
      `5h ${fmtPercent(five.percentUsed)}` + (reset ? (zh ? `（${reset}）` : ` (${reset})`) : ''),
    )
  }
  if (seven) parts.push(`7d ${fmtPercent(seven.percentUsed)}`)
  const subTokens = b.agents.reduce((sum, a) => sum + totalTokens(a.usage), 0)
  const inherited = b.agents.filter(a => a.inherited)
  let tally = zh
    ? `主会话 ${fmtTokens(b.mainTokens, b.lang)} / 子代理 ${fmtTokens(subTokens, b.lang)}`
    : `main ${fmtTokens(b.mainTokens, b.lang)} / subagents ${fmtTokens(subTokens, b.lang)} tokens`
  if (b.agents.length > 0) {
    const fam = inherited.length > 0 ? familyOf(inherited[0]?.model) : ''
    if (zh) {
      tally += inherited.length > 0
        ? `（${b.agents.length} 个，${inherited.length} 个继承了 ${fam}）`
        : `（${b.agents.length} 个）`
    } else {
      tally += inherited.length > 0
        ? ` (${b.agents.length}, ${inherited.length} inherited ${fam})`
        : ` (${b.agents.length})`
    }
  }
  parts.push(tally)
  return parts.join(' · ')
}

export function warnToast(w: WindowReading, th: Thresholds, lang: Lang): string {
  const label = w.kind === FIVE_HOUR ? (lang === 'zh' ? '5 小时' : '5-hour') : lang === 'zh' ? '7 天' : '7-day'
  const handoffAt = w.kind === FIVE_HOUR ? th.handoffAt : th.handoffAt7d
  return lang === 'zh'
    ? `${label}额度已用 ${fmtPercent(w.percentUsed)}；到 ${handoffAt}% 时会让 Claude 写交接任务书。`
    : `${label} quota at ${fmtPercent(w.percentUsed)}; at ${handoffAt}% Claude will be asked to write a handoff brief.`
}

export function handoffToast(w: WindowReading, path: string, lang: Lang): string {
  const label = w.kind === FIVE_HOUR ? (lang === 'zh' ? '5 小时' : '5-hour') : lang === 'zh' ? '7 天' : '7-day'
  return lang === 'zh'
    ? `${label}额度已用 ${fmtPercent(w.percentUsed)}：已请 Claude 把交接任务书写到 ${path}，并且不再开新的大活。`
    : `${label} quota at ${fmtPercent(w.percentUsed)}: Claude has been asked to write a handoff brief to ${path} and start no new large task.`
}

/** The note appended to the conversation when a window reaches handoffAt.
 * Written in English for the model either way; the brief follows the
 * conversation's language. */
export function handoffNote(w: WindowReading, path: string, cwd: string, now: number): string {
  const label = w.kind === FIVE_HOUR ? '5-hour' : '7-day'
  const reset = fmtReset(w.resetsAt, now, 'en')
  return [
    `[subagent-cost] The ${label} usage window is at ${fmtPercent(w.percentUsed)}${reset ? ` (${reset})` : ''}.`,
    `Before your current turn ends, write a handoff brief to \`${path}\` (relative paths are relative to ${cwd}).`,
    'Use these sections, in this order: Goal; Decisions made; Done; In progress; Next steps; Key files (absolute paths); Open questions.',
    'Write it so a fresh session or another coding agent can continue from the file alone, in the language of this conversation.',
    'If the file exists, update it rather than starting over. After writing it, do not start any new large task in this window: finish or pause the current step, and tell the user where the brief is.',
  ].join('\n')
}
