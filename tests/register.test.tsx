import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, EventResult, On, SessionContextUsage, SessionMessage, SessionRateLimit } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { QuotaAlerts } from '../types'

// Everything here is made up: no real session, account or path.

const PLUGIN = 'subagent-cost'
const NOW = Date.parse('2026-01-01T13:00:00.000Z')
const RESET_5H = '2026-01-01T15:00:00.000Z'
const RESET_7D = '2026-01-05T00:00:00.000Z'

type World = {
  toasts: string[]
  compactions: string[]
  tokensAfter: number
  context: SessionContextUsage
  agents: AgentInfo[]
  toolUseIds: string[]
  cwd: () => EventResult<'session.cwd'> | Promise<EventResult<'session.cwd'>>
  /** What the engine does before it answers a turn's end. */
  completing: (turnId: string) => void | Promise<void>
  /** The last value the mod wrote for `agentToolRuns`. */
  toolRuns: unknown
  /** What `$.store` holds across sessions. */
  store: Map<string, unknown>
  /** Agent types whose definition names a model of its own. */
  ownModels: Record<string, string>
  /** The main conversation as `$.session.messages()` reads it. */
  rows: SessionMessage[]
  clock: ReturnType<typeof mock.clock>
  session: ReturnType<typeof mock.session>
}

/** What the engine would answer beneath the plugin. */
function world(on: On): World {
  const w: World = {
    toasts: [],
    compactions: [],
    tokensAfter: 8_000,
    context: { tokens: 20_000, window: 1_000_000, percent: 2 },
    agents: [],
    toolUseIds: [],
    cwd: () => ({ value: '/work/demo' }),
    completing: () => undefined,
    toolRuns: undefined,
    store: new Map<string, unknown>(),
    ownModels: { Explore: 'claude-haiku-5-5' },
    rows: [],
    clock: mock.clock(on, { now: NOW }),
    session: mock.session(on),
  }
  on('session.messages', () => ({ value: w.rows }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.cwd', () => w.cwd())
  on('session.usage', () => ({
    value: { startedAt: NOW, context: w.context, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: w.agents }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => {
    await w.completing(e.turnId)
    return { text: '' }
  })
  on('state.set', { plugin: PLUGIN, key: 'agentToolRuns' }, (_$, e, next) => {
    w.toolRuns = e.value
    return next(e)
  })
  on('classic.Stop', () => ({}))
  on('session.compact', (_$, e) => {
    w.compactions.push(e.instructions ?? '')
    return { messages: [{ role: 'user', text: 'Summary of the work so far.', toolUses: [] }], tokensAfter: w.tokensAfter }
  })
  on('agent.spawn', (_$, e) => ({
    model: e.model ?? w.ownModels[e.subagentType] ?? e.parentModel,
    agentId: `agent-${e.tool_use_id}`,
  }))
  on('tool.call', (_$, e) => {
    w.toolUseIds.push(e.tool_use_id)
    if (e.tool === 'Agent') {
      return {
        result: {
          status: 'completed',
          agentId: 'agent-spawn-1',
          agentType: 'Explore',
          content: [{ type: 'text', text: 'found it' }],
          resolvedModel: 'claude-haiku-5-5',
          totalToolUseCount: 23,
          totalDurationMs: 41_000,
          totalTokens: 9_000,
          usage: {
            input_tokens: 100,
            output_tokens: 200,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 8_000,
            server_tool_use: null,
            service_tier: null,
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 300 },
          },
          prompt: 'look for the config loader',
        },
      }
    }
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  return w
}

function limits(five: number, seven = 10): SessionRateLimit[] {
  return [
    { kind: 'five_hour', percentUsed: five, resetsAt: RESET_5H },
    { kind: 'seven_day', percentUsed: seven, resetsAt: RESET_7D },
  ]
}

async function measure($: Engine, five: number, seven = 10, context?: SessionContextUsage) {
  await measureLimits($, limits(five, seven), context)
}

async function measureLimits($: Engine, rateLimits: SessionRateLimit[], context?: SessionContextUsage) {
  await $.session.measure({
    context: context ?? { tokens: 20_000, window: 1_000_000, percent: 2 },
    rateLimits,
    changed: ['rateLimits'],
  })
}

/** One main-loop turn, answered with `answer`. */
async function mainTurn($: Engine, id: string, answer: string, inputTokens = 1_000) {
  await $.turn.start({ text: 'go', turnId: id })
  await $.turn.complete({
    answer,
    durationMs: 1_000,
    isAborted: false,
    turnId: id,
    reason: 'answer',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: inputTokens,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 10_000,
    },
  })
}

/** A subagent spawned from the main loop, run, and returned. */
async function subagent($: Engine, w: World, output = 2_000) {
  await $.agent.spawn({
    tool_use_id: 'spawn-1',
    prompt: 'look for the config loader',
    description: 'find loader',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  await $.turn.complete({
    answer: 'found it',
    durationMs: 41_000,
    isAborted: false,
    turnId: 'sub-1',
    agentId: 'agent-spawn-1',
    reason: 'answer',
    usage: {
      model: 'claude-haiku-5-5',
      input_tokens: 12_000,
      output_tokens: output,
      cache_creation_input_tokens: 41_000,
      cache_read_input_tokens: 80_000,
    },
  })
  await $.tool.call({
    tool: 'Agent',
    description: 'find loader',
    prompt: 'look for the config loader',
    subagent_type: 'Explore',
  })
  const id = w.toolUseIds.at(-1)
  if (!id) throw new Error('no tool_use_id')
  return id
}

const BAND_PROPS = {
  hasSurvey: false,
  isCollapsed: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
} as const

function toolUseProps(id: string) {
  return {
    tool_use_id: id,
    tool: 'Agent',
    input: { description: 'find loader', prompt: 'look for the config loader' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  }
}

test('the quota band preserves the next AbovePrompt render', async ($, on) => {
  world(on)
  on('ui.render', { component: 'AbovePrompt', plugin: PLUGIN }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>Downstream notice</Text>
  })
  await measure($, 30)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect((await ui.find({ type: 'Text', text: /5h 30%/ }))?.text).toContain('5h 30%')
    expect((await ui.find({ type: 'Text', text: 'Downstream notice' }))?.text).toBe('Downstream notice')
    await ui.unmount()
  }
})

test('a subagent row shows tokens alone until the estimate has two points', async ($, on) => {
  const w = world(on)
  await measure($, 40)
  const id = await subagent($, w)
  await measure($, 41)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      requestId: id,
      props: toolUseProps(id),
    })
    const line = await ui.find({ type: 'Text', text: /subagent Explore/ })
    expect(line?.text).toContain('claude-haiku-5-5')
    expect(line?.text).toContain('in 12k / out 2k / cache write 41k (5m) / cache read 80k')
    expect(line?.text).toContain('23 tools')
    expect(line?.text).toContain('41s')
    expect(line?.text).not.toContain('5h quota')
    await ui.unmount()
  }

  // Spend more, and the window moves past two points: a share appears.
  await mainTurn($, 'm1', 'Done.', 400_000)
  await measure($, 44)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'ToolUse',
    requestId: id,
    props: toolUseProps(id),
  })
  const line = await ui.find({ type: 'Text', text: /subagent Explore/ })
  expect(line?.text).toMatch(/≈[\d.<]+% of 5h quota \(estimate\)/)
  await ui.unmount()
})

test('a subagent that inherits Opus raises one notice and is counted on the band', async ($, on) => {
  const w = world(on)
  await $.agent.spawn({
    tool_use_id: 'spawn-gp',
    prompt: 'refactor the parser',
    description: 'refactor',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('inherited the main model (Opus)')
  await measure($, 30)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  const band = await ui.find({ type: 'Text', text: /5h 30%/ })
  expect(band?.text).toContain('resets in 2h')
  expect(band?.text).toContain('7d 10%')
  expect(band?.text).toContain('(1, 1 inherited Opus)')
  await ui.unmount()
})

test('downgrade applies from the second spawn of a type that inherited, and leaves a type with its own model alone', { options: { subagentModelPolicy: 'downgrade:sonnet' } }, async ($, on) => {
  const w = world(on)
  const spawn = (id: string, subagentType: string, model?: string) =>
    $.agent.spawn({
      tool_use_id: id,
      prompt: 'look into the parser',
      description: 'parser',
      subagentType,
      provider: { plugin: 'engine', tier: 'core' },
      ...(model ? { model } : {}),
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    })

  // First general-purpose spawn: not yet known, so it runs as the engine says
  // (here on the parent's Opus), and the notice says what comes next.
  const first = await spawn('spawn-gp-1', 'general-purpose')
  expect(first.model).toBe('claude-opus-5-5')
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('Later general-purpose subagents will run on sonnet')

  const second = await spawn('spawn-gp-2', 'general-purpose')
  expect(second.model).toBe('sonnet')

  // Explore names Haiku of its own: seen once, never rewritten.
  expect((await spawn('spawn-ex-1', 'Explore')).model).toBe('claude-haiku-5-5')
  expect((await spawn('spawn-ex-2', 'Explore')).model).toBe('claude-haiku-5-5')

  // A model passed in the call is kept.
  expect((await spawn('spawn-named', 'general-purpose', 'haiku')).model).toBe('haiku')
  expect(w.toasts.length).toBe(1)
})

function spawnUnder($: Engine, id: string, subagentType = 'general-purpose') {
  return $.agent.spawn({
    tool_use_id: id,
    prompt: 'look into the parser',
    description: 'parser',
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
}

test('what a type was seen to do is checked again after a week', { options: { subagentModelPolicy: 'downgrade:sonnet' } }, async ($, on) => {
  const w = world(on)
  expect((await spawnUnder($, 'gp-1')).model).toBe('claude-opus-5-5')
  expect((await spawnUnder($, 'gp-2')).model).toBe('sonnet')

  // The definition now names Haiku of its own. Within the week the record stands.
  w.ownModels['general-purpose'] = 'claude-haiku-5-5'
  expect((await spawnUnder($, 'gp-3')).model).toBe('sonnet')

  // After it, one spawn runs unchanged and the type is learned again.
  await w.clock.advance(8 * 24 * 3_600_000)
  expect((await spawnUnder($, 'gp-4')).model).toBe('claude-haiku-5-5')
  expect((await spawnUnder($, 'gp-5')).model).toBe('claude-haiku-5-5')
})

test('a record an earlier version stored is learned again', { options: { subagentModelPolicy: 'downgrade:sonnet' } }, async ($, on) => {
  const w = world(on)
  w.store.set('inherits:general-purpose', true)
  expect((await spawnUnder($, 'gp-1')).model).toBe('claude-opus-5-5')
  expect((await spawnUnder($, 'gp-2')).model).toBe('sonnet')
})

test('a spawn under a cheap main model teaches nothing', { options: { subagentModelPolicy: 'downgrade:sonnet' } }, async ($, on) => {
  world(on)
  const spawn = (id: string, parentModel: string) =>
    $.agent.spawn({
      tool_use_id: id,
      prompt: 'look into the parser',
      description: 'parser',
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel,
      background: false,
      fork: false,
    })
  // Under Haiku the subagent runs on Haiku too, which says nothing about
  // whether the type inherits; the first spawn under Opus is still unchanged.
  expect((await spawn('spawn-cheap', 'claude-haiku-5-5')).model).toBe('claude-haiku-5-5')
  expect((await spawn('spawn-opus-1', 'claude-opus-5-5')).model).toBe('claude-opus-5-5')
  expect((await spawn('spawn-opus-2', 'claude-opus-5-5')).model).toBe('sonnet')
})

test('88%: one warning and a warning band; 90%: the handoff request, once', async ($, on) => {
  const w = world(on)
  await measure($, 87)
  expect(w.toasts.length).toBe(0)

  await measure($, 88)
  await measure($, 89)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('5-hour quota at 88%')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ type: 'Text', text: /⚠ 5h 89%/ }))?.text).toBeDefined()
  await ui.unmount()

  // Between turns the request is appended at once.
  await measure($, 90)
  await measure($, 91)
  const rows = w.session.appended()
  expect(rows.length).toBe(1)
  const text = JSON.stringify(rows[0]?.message.content)
  expect(text).toContain('write a handoff brief to `HANDOFF.md`')
  expect(text).toContain('Goal; Decisions made; Done; In progress; Next steps; Key files (absolute paths); Open questions')
  expect(text).toContain('/work/demo')
  expect(w.toasts.length).toBe(2)
})

test('90% during a turn: the request rides the next tool result', { options: { handoffPath: 'notes/HANDOFF.md' } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, 90)
  expect(w.session.appended().length).toBe(0)

  const res = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(JSON.stringify(res.context ?? [])).toContain('notes/HANDOFF.md')

  // Delivered once: neither the next tool nor the turn's end repeats it.
  const again = await $.tool.call({ tool: 'Bash', command: 'pwd' })
  expect(again.context ?? []).toEqual([])
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.session.appended().length).toBe(0)
})

test('the 7-day window has its own thresholds', { options: { warnAt7d: 50, handoffAt7d: 60 } }, async ($, on) => {
  const w = world(on)
  await measure($, 20, 55)
  expect(w.toasts[0]).toContain('7-day quota at 55%')
  await measure($, 20, 60)
  expect(w.session.appended().length).toBe(1)
})

test('both windows due at once: one request names both', async ($, on) => {
  const w = world(on)
  await measure($, 91, 92)
  const rows = w.session.appended()
  expect(rows.length).toBe(1)
  const text = JSON.stringify(rows[0]?.message.content)
  expect(text).toContain('5-hour usage window is at 91%')
  expect(text).toContain('7-day usage window is at 92%')
})

test('a window that comes due before the first request went out joins it', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, 91, 10)
  await measure($, 91, 92)
  const res = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const context = JSON.stringify(res.context ?? [])
  expect(context).toContain('5-hour usage window is at 91%')
  expect(context).toContain('7-day usage window is at 92%')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.session.appended().length).toBe(0)
})

test('a low reading does not rearm a window with the same reset time', async ($, on) => {
  const w = world(on)
  for (const percent of [88, 3, 89, 91, 3, 91]) await measure($, percent)
  expect(w.toasts.length).toBe(2)
  expect(w.session.appended().length).toBe(1)
})

test('blank reset times share the undated alert key', async ($, on) => {
  const w = world(on)
  for (const resetsAt of ['', '', '  ', undefined]) {
    await measureLimits($, [{ kind: 'five_hour', percentUsed: 91, resetsAt }])
  }
  expect(w.toasts.length).toBe(1)
  expect(w.session.appended().length).toBe(1)
})

test('a reset time appearing or disappearing does not repeat an alert in the same window', async ($, on) => {
  const w = world(on)
  const bare = (kind: string) => ({ kind, percentUsed: 91 })
  await measureLimits($, [bare('five_hour'), limits(20, 91)[1]!])
  await measureLimits($, [limits(91)[0]!, bare('seven_day')])
  await measure($, 91, 91)

  expect(w.session.appended().length).toBe(1)
  expect(w.toasts.length).toBe(2)

  await w.clock.advance(2 * 3_600_000 + 1)
  await measureLimits($, [bare('five_hour'), bare('seven_day')])
  const rows = w.session.appended()
  expect(rows.length).toBe(2)
  expect(JSON.stringify(rows[1]?.message.content)).toContain('5-hour usage window')
  expect(JSON.stringify(rows[1]?.message.content)).not.toContain('7-day usage window')
})

test('an undated handoff does not stand for the window after it', async ($, on) => {
  const w = world(on)
  await measureLimits($, [{ kind: 'five_hour', percentUsed: 91 }])
  expect(w.session.appended().length).toBe(1)

  // More than five hours on, the next window's first reading has a reset time.
  await w.clock.advance(5 * 3_600_000 + 60_000)
  const next = new Date(w.clock.now() + 4 * 3_600_000).toISOString()
  await measureLimits($, [{ kind: 'five_hour', percentUsed: 3, resetsAt: next }])
  await measureLimits($, [{ kind: 'five_hour', percentUsed: 91, resetsAt: next }])
  expect(w.session.appended().length).toBe(2)
})

test('a window that began after an undated handoff alerts again, even at a high first reading', async ($, on) => {
  const w = world(on)
  await measureLimits($, [{ kind: 'five_hour', percentUsed: 91 }])
  expect(w.session.appended().length).toBe(1)

  // An hour on, a window that started half an hour after that reading.
  await w.clock.advance(3_600_000)
  const next = new Date(NOW + 5.5 * 3_600_000).toISOString()
  await measureLimits($, [{ kind: 'five_hour', percentUsed: 40, resetsAt: next }])
  await measureLimits($, [{ kind: 'five_hour', percentUsed: 91, resetsAt: next }])
  expect(w.session.appended().length).toBe(2)
})

/** A `session.append` hook that holds the first note until released, then
 * stores it or, with `deny`, refuses it. */
function holdFirstNote(on: On, deny?: string) {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  let isHeld = false
  on('session.append', { door: 'note' }, async (_$, e, next) => {
    if (isHeld) return next(e)
    isHeld = true
    enter()
    await released
    return deny === undefined ? next(e) : { deny }
  })
  return { entered, release }
}

test('a window reset seen while an undated handoff is being sent is not undone by its confirmation', async ($, on) => {
  const held = holdFirstNote(on)
  const w = world(on)
  const measuring = measureLimits($, [{ kind: 'five_hour', percentUsed: 91 }])
  await Promise.race([held.entered, measuring])
  try {
    await measureLimits($, [{ kind: 'five_hour', percentUsed: 3 }])
  } finally {
    held.release()
  }
  await measuring
  expect(w.session.appended().length).toBe(1)

  await measureLimits($, [{ kind: 'five_hour', percentUsed: 91 }])
  expect(w.session.appended().length).toBe(2)
})

test('a window reset seen while an undated handoff is being refused does not queue it again', async ($, on) => {
  const held = holdFirstNote(on, 'test refusal')
  const w = world(on)
  const measuring = measureLimits($, [{ kind: 'five_hour', percentUsed: 91 }])
  await Promise.race([held.entered, measuring])
  try {
    await measureLimits($, [{ kind: 'five_hour', percentUsed: 3 }])
  } finally {
    held.release()
  }
  await measuring
  await mainTurn($, 't1', 'Done.')
  expect(w.session.appended().length).toBe(0)

  await measureLimits($, [{ kind: 'five_hour', percentUsed: 91 }])
  expect(w.session.appended().length).toBe(1)
})

test('a request 0.1.0 left pending for an undated window is dropped by a low reading', async ($, on) => {
  const w = world(on)
  const legacy = { key: 'five_hour@none', text: '[subagent-cost] The 5-hour usage window is at 91%. Write the handoff brief.' }
  on('state.get', { plugin: PLUGIN, key: 'pendingNote' }, async (_$, e, next) => {
    const stored = await next(e)
    return stored.value?.version === 0 ? { value: { version: 0, value: legacy } } : stored
  })
  on('state.get', { plugin: PLUGIN, key: 'handedOff' }, async (_$, e, next) => {
    const stored = await next(e)
    return stored.value?.version === 0 ? { value: { version: 0, value: [legacy.key] } } : stored
  })
  await measure($, 3)
  expect(w.session.appended().length).toBe(0)

  await measure($, 91)
  expect(w.session.appended().length).toBe(1)
  const text = JSON.stringify(w.session.appended()[0]?.message.content)
  expect(text).not.toContain('Write the handoff brief.')
  expect(text).toContain('5-hour usage window is at 91%')
})

test('an expired reading is ignored before estimating or scheduling a handoff', async ($, on) => {
  const w = world(on)
  let estimated = false
  on('state.set', { plugin: PLUGIN, key: 'baseline' }, (_$, e, next) => {
    estimated = true
    return next(e)
  })
  await w.clock.advance(2 * 3_600_000 + 1)
  await measure($, 92)
  expect(w.session.appended().length).toBe(0)
  expect(w.toasts.length).toBe(0)
  expect(estimated).toBe(false)

  await measureLimits($, [{ kind: 'five_hour', percentUsed: 10, resetsAt: '2026-01-01T20:00:00.000Z' }])
  expect(estimated).toBe(true)
})

test('an expired pending window is left out of the next handoff request', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, 91)
  await w.clock.advance(2 * 3_600_000 + 1)
  await measure($, 91, 92)
  const res = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const context = (res.context ?? []).join('\n')
  expect(context).toContain('7-day usage window is at 92%')
  expect(context).not.toContain('5-hour usage window')
})

test('a tool result and an overlapping measurement deliver each window once', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, 91)
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  let hold = true
  w.cwd = async () => {
    if (hold) {
      hold = false
      enter()
      await released
    }
    return { value: '/work/demo' }
  }

  const measuring = measure($, 91, 92)
  await Promise.race([measuring, entered])
  hold = false
  const first = await $.tool.call({ tool: 'Bash', command: 'ls' }).finally(release)
  await measuring
  const second = await $.tool.call({ tool: 'Bash', command: 'pwd' })
  const text = [...(first.context ?? []), ...(second.context ?? [])].join('\n')
  expect(text.match(/5-hour usage window/g)?.length).toBe(1)
  expect(text.match(/7-day usage window/g)?.length).toBe(1)
})

test('two simultaneous tool results carry the queued handoff only once', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, 91)
  const results = await Promise.all([
    $.tool.call({ tool: 'Bash', command: 'ls' }),
    $.tool.call({ tool: 'Bash', command: 'pwd' }),
  ])
  expect(results.flatMap(result => result.context ?? []).length).toBe(1)
})

test('a handoff request stays pending when its working directory cannot be read', async ($, on) => {
  const w = world(on)
  w.cwd = () => ({ deny: 'cwd unavailable' })
  await measure($, 91)
  expect(w.session.appended().length).toBe(0)

  w.cwd = () => ({ value: '/work/demo' })
  await mainTurn($, 't1', 'Done.')
  expect(w.session.appended().length).toBe(1)
  expect(JSON.stringify(w.session.appended()[0]?.message.content)).toContain('5-hour usage window is at 91%')
})

test('a refused append keeps both its claimed window and one queued meanwhile', async ($, on) => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  let appendStarted = false
  on('session.append', { door: 'note' }, async (_$, e, next) => {
    if (appendStarted) return next(e)
    appendStarted = true
    enter()
    await released
    return { deny: 'test refusal' }
  })
  const w = world(on)

  const measuring = measure($, 91)
  await Promise.race([entered, measuring])
  expect(appendStarted).toBe(true)
  try {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await measure($, 91, 92)
  } finally {
    release()
  }
  await measuring
  expect(w.session.appended().length).toBe(0)
  const res = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const text = (res.context ?? []).join('\n')
  expect(text).toContain('5-hour usage window is at 91%')
  expect(text).toContain('7-day usage window is at 92%')
})

test('a legacy pending handoff keeps its text when another window comes due', async ($, on) => {
  const w = world(on)
  const key = 'five_hour@' + Math.round(Date.parse(RESET_5H) / 600_000)
  const legacy = { key, text: '[subagent-cost] The 5-hour usage window is at 91%. Write the handoff brief.' }
  let readLegacy = false
  on('state.get', { plugin: PLUGIN, key: 'pendingNote' }, async (_$, e, next) => {
    const stored = await next(e)
    if (stored.value?.version !== 0) return stored
    readLegacy = true
    return { value: { version: 0, value: legacy } }
  })
  on('state.get', { plugin: PLUGIN, key: 'handedOff' }, async (_$, e, next) => {
    const stored = await next(e)
    return stored.value?.version === 0 ? { value: { version: 0, value: [key] } } : stored
  })
  await measure($, 91, 92)
  expect(readLegacy).toBe(true)
  expect(w.session.appended().length).toBe(1)
  const text = JSON.stringify(w.session.appended()[0]?.message.content)
  expect(text).toContain(legacy.text)
  expect(text.match(/5-hour usage window/g)?.length).toBe(1)
  expect(text).toContain('7-day usage window is at 92%')
})

/** What the session held for `quotaAlerts` before this load of the mod. */
function seedAlerts(on: On, alerts: QuotaAlerts) {
  on('state.get', { plugin: PLUGIN, key: 'quotaAlerts' }, async (_$, e, next) => {
    const stored = await next(e)
    return stored.value?.version === 0 ? { value: { version: 0, value: alerts } } : stored
  })
}

test('a handoff request a reload cut short is sent again, with a window that came due since', async ($, on) => {
  const w = world(on)
  // An earlier load claimed the request and went away before settling it.
  seedAlerts(on, { warned: [], handedOff: [], waiting: null, sending: { id: 'cut00001', windows: [limits(91)[0]!] } })
  await measure($, 91, 92)
  const rows = w.session.appended()
  expect(rows.length).toBe(1)
  const text = JSON.stringify(rows[0]?.message.content)
  expect(text).toContain('5-hour usage window is at 91%')
  expect(text).toContain('7-day usage window is at 92%')
  // The request names itself, so a later load can tell whether it went out.
  expect(text).toMatch(/\[subagent-cost [0-9a-f]{8}\]/)

  await measure($, 91, 92)
  expect(w.session.appended().length).toBe(1)
})

test('a claim 0.1.2 left unsettled goes out when the next turn ends', async ($, on) => {
  const w = world(on)
  // An earlier request of 0.1.2 carries the same bare tag; it says nothing of this claim.
  w.rows = [{ role: 'user', text: '[subagent-cost] The 7-day usage window is at 90% (resets in 3d).', toolUses: [] }]
  seedAlerts(on, { warned: [], handedOff: [], waiting: null, sending: { windows: [limits(91)[0]!] } })
  await mainTurn($, 't1', 'Done.')
  expect(w.session.appended().length).toBe(1)
  expect(JSON.stringify(w.session.appended()[0]?.message.content)).toContain('5-hour usage window is at 91%')
})

test('a cut-short request the conversation shows went out is settled, not sent again', async ($, on) => {
  const w = world(on)
  w.rows = [{ role: 'user', text: '[subagent-cost cut00002] The 5-hour usage window is at 91% (resets in 2h).', toolUses: [] }]
  seedAlerts(on, { warned: [], handedOff: [], waiting: null, sending: { id: 'cut00002', windows: [limits(91)[0]!] } })
  await measure($, 91, 92)
  const rows = w.session.appended()
  expect(rows.length).toBe(1)
  const text = JSON.stringify(rows[0]?.message.content)
  expect(text).toContain('7-day usage window is at 92%')
  expect(text).not.toContain('5-hour usage window')

  await measure($, 93, 93)
  expect(w.session.appended().length).toBe(1)
})

test('an empty reading clears the quota figures and holds nothing off', async ($, on) => {
  const w = world(on)
  w.context = BIG
  await measure($, 92)
  await $.session.measure({ context: BIG, rateLimits: [], changed: ['rateLimits'] })

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await mainTurn($, 't1', 'Done.')
  const band = await ui.find({ type: 'Text', text: /main/ })
  expect(band?.text).not.toContain('5h')
  expect(band?.text).not.toContain('⚠')
  await ui.unmount()

  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(1)
})

test('a reading whose reset time has passed holds nothing off', async ($, on) => {
  const w = world(on)
  w.context = BIG
  await measure($, 92)
  await w.clock.advance(2 * 3_600_000 + 60_000)
  await mainTurn($, 't1', 'Done.')
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(1)
})

test('an Agent result that arrives before the run ends is not counted twice', async ($, on) => {
  const w = world(on)
  await $.agent.spawn({
    tool_use_id: 'spawn-1',
    prompt: 'look for the config loader',
    description: 'find loader',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  await $.tool.call({ tool: 'Agent', description: 'find loader', prompt: 'look for the config loader', subagent_type: 'Explore' })
  const id = w.toolUseIds.at(-1) ?? ''
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-spawn-1' })
  await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'agent-spawn-1' })
  await $.turn.complete({
    answer: 'found it',
    durationMs: 41_000,
    isAborted: false,
    turnId: 'sub-1',
    agentId: 'agent-spawn-1',
    reason: 'answer',
    usage: { model: 'claude-haiku-5-5', input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'ToolUse', requestId: id, props: toolUseProps(id) })
  const line = await ui.find({ type: 'Text', text: /subagent Explore/ })
  expect(line?.text).toContain('23 tools')
  expect(line?.text).toContain('41s')
  await ui.unmount()
})

test('a background subagent can complete with zero tools', async ($, on) => {
  world(on)
  await $.agent.spawn({
    tool_use_id: 'spawn-zero',
    prompt: 'check the calculation',
    description: 'check calculation',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  await $.turn.complete({
    answer: 'checked',
    durationMs: 1_000,
    isAborted: false,
    turnId: 'zero-1',
    agentId: 'agent-spawn-zero',
    reason: 'answer',
    usage: {
      model: 'claude-haiku-5-5',
      input_tokens: 20,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'spawn-zero',
    props: toolUseProps('spawn-zero'),
  })
  expect((await ui.find({ type: 'Text', text: /subagent Explore/ }))?.text).toContain('0 tools')
  await ui.unmount()
})

test('a background run restores and clears its unsettled tool count from session state', async ($, on) => {
  const w = world(on)
  const agentId = 'agent-spawn-restored'
  on('state.get', { plugin: PLUGIN, key: 'agentToolRuns' }, async (_$, e, next) => {
    const stored = await next(e)
    if (stored.value?.version !== 0) return stored
    return { value: { version: 0, value: { [agentId]: { turnId: 'bg-before-reload', count: 2 } } } }
  })
  await $.agent.spawn({
    tool_use_id: 'spawn-restored',
    prompt: 'check the build',
    description: 'check build',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  const finish = (turnId: string) => $.turn.complete({
    answer: 'checked',
    durationMs: 1_000,
    isAborted: false,
    turnId,
    agentId,
    reason: 'answer',
    usage: {
      model: 'claude-haiku-5-5',
      input_tokens: 20,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId })
  await finish('bg-before-reload')
  expect(w.toolRuns).toEqual({})
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'spawn-restored',
    props: toolUseProps('spawn-restored'),
  })
  const line = () => ui.find({ type: 'Text', text: /subagent Explore/ })
  expect((await line())?.text).toContain('3 tools')

  await $.turn.start({ text: 'check again', turnId: 'bg-next-run', agentId })
  await $.tool.call({ tool: 'Bash', command: 'pwd', agentId })
  await finish('bg-next-run')
  expect((await line())?.text).toContain('4 tools')
  await ui.unmount()
})

test('a new run of a subagent does not take the tool count of one still settling', async ($, on) => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const w = world(on)
  // What sits beneath the mod takes its time over the first run's end.
  w.completing = async turnId => {
    if (turnId !== 'bg-a') return
    enter()
    await released
  }
  const agentId = 'agent-spawn-bg'
  await $.agent.spawn({
    tool_use_id: 'spawn-bg',
    prompt: 'watch the build',
    description: 'watch build',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  const finish = (turnId: string) => $.turn.complete({
    answer: 'checked',
    durationMs: 1_000,
    isAborted: false,
    turnId,
    agentId,
    reason: 'answer',
    usage: { model: 'claude-haiku-5-5', input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })

  await $.turn.start({ text: 'watch', turnId: 'bg-a', agentId })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId })
  await $.tool.call({ tool: 'Bash', command: 'pwd', agentId })
  const settling = finish('bg-a')
  await Promise.race([entered, settling])
  try {
    // Continued with SendMessage while the first run is still settling.
    await $.turn.start({ text: 'again', turnId: 'bg-b', agentId })
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId })
  } finally {
    release()
  }
  await settling

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'spawn-bg',
    props: toolUseProps('spawn-bg'),
  })
  const line = () => ui.find({ type: 'Text', text: /subagent Explore/ })
  expect((await line())?.text).toContain('2 tools')
  await finish('bg-b')
  expect((await line())?.text).toContain('3 tools')
  expect(w.toolRuns).toEqual({})
  await ui.unmount()
})

test('a background subagent counts its own tool calls, and a continued run adds to its row', async ($, on) => {
  world(on)
  await $.agent.spawn({
    tool_use_id: 'spawn-bg',
    prompt: 'watch the build',
    description: 'watch build',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    model: 'sonnet',
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  const run = async (turnId: string, calls: number, durationMs: number) => {
    for (let i = 0; i < calls; i++) {
      await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-spawn-bg' })
    }
    await $.turn.complete({
      answer: 'checked',
      durationMs,
      isAborted: false,
      turnId,
      agentId: 'agent-spawn-bg',
      reason: 'answer',
      usage: {
        model: 'claude-sonnet-5-5',
        input_tokens: 1_000,
        output_tokens: 500,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 3_000,
      },
    })
  }
  await run('bg-1', 2, 30_000)
  await run('bg-2', 3, 15_000)

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'spawn-bg',
    props: toolUseProps('spawn-bg'),
  })
  const line = await ui.find({ type: 'Text', text: /subagent general-purpose/ })
  expect(line?.text).toContain('in 2k / out 1k / cache write 4k / cache read 6k')
  expect(line?.text).toContain('5 tools')
  expect(line?.text).toContain('45s')
  await ui.unmount()
})

const BIG = { tokens: 200_000, window: 1_000_000, percent: 20 }

test('an answered turn over the threshold compacts, keeping what was decided', async ($, on) => {
  const w = world(on)
  w.context = BIG
  await mainTurn($, 't1', 'All done: the loader now reads both files.')
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(1)
  expect(w.compactions[0]).toContain('decisions already made')

})

test('a compaction that leaves the context large waits for it to grow again', async ($, on) => {
  const w = world(on)
  w.context = BIG
  w.tokensAfter = 160_000
  await mainTurn($, 't1', 'All done.')
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(1)

  // Still over 150k, but not 20k past what the compaction left: wait.
  w.context = { tokens: 170_000, window: 1_000_000, percent: 17 }
  await mainTurn($, 't2', 'Also renamed the helper.')
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(1)

  w.context = { tokens: 185_000, window: 1_000_000, percent: 18 }
  await mainTurn($, 't3', 'And updated the docs.')
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(2)
})

test('a turn that ends with a question does not compact', async ($, on) => {
  const w = world(on)
  w.context = BIG
  await mainTurn($, 't1', 'Two ways to fix it.\n\nWhich one do you want?')
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(0)

  // A desktop next-step question counts as asking too.
  await $.turn.start({ text: 'go', turnId: 't2' })
  await $.tool.call({ tool: 'mcp__app__wrap_up', recap: 'Fixed.', ask: 'Commit it?' })
  await $.turn.complete({ answer: 'Fixed.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(0)
})

test('a running background agent holds compaction off', async ($, on) => {
  const w = world(on)
  w.context = BIG
  w.agents = [{ id: 'bg-1', description: 'watch tests', type: 'general-purpose', status: 'running' }]
  await mainTurn($, 't1', 'Started the watcher.')
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(0)

  // A background shell the Stop hook reports holds it off too.
  w.agents = []
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'sh-1', type: 'shell', status: 'running', description: 'npm test --watch' }],
  })
  await mainTurn($, 't2', 'Still watching.')
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(0)
})

test('an interrupted turn does not compact', async ($, on) => {
  const w = world(on)
  w.context = BIG
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(0)
})

test('past the handoff threshold nothing compacts', async ($, on) => {
  const w = world(on)
  w.context = BIG
  await measure($, 92)
  await mainTurn($, 't1', 'Wrote the brief.')
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(0)
})

test('ask mode offers a button on the band instead', { options: { autoCompact: 'ask', language: 'zh' } }, async ($, on) => {
  const w = world(on)
  w.context = BIG
  await measure($, 30)
  await mainTurn($, 't1', '改好了。')
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(0)
  expect(w.toasts.at(-1)).toContain('一键压缩')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect((await ui.find({ type: 'Text', text: /主会话/ }))?.text).toContain('5h 30%（2 小时后重置）')
    if (surface === 'desktop') {
      await ui.press({ key: 'compact' })
      expect(w.compactions.length).toBe(1)
    } else {
      expect(await ui.find({ key: 'compact' })).toBeDefined()
    }
    await ui.unmount()
  }
})

/** ask mode, a large context and an answered turn: the band offers the button. */
async function offerCompaction($: Engine, w: World) {
  w.context = BIG
  await measure($, 30)
  await mainTurn($, 't1', 'Done.')
  await w.clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  return ui
}

test('the compact button is withdrawn at the handoff threshold', { options: { autoCompact: 'ask' } }, async ($, on) => {
  const w = world(on)
  const ui = await offerCompaction($, w)
  await measure($, 92)
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
  await ui.press({ key: 'compact' }).catch(() => undefined)
  expect(w.compactions.length).toBe(0)

  // The next window does not bring the old offer back.
  await measureLimits($, [{ kind: 'five_hour', percentUsed: 3, resetsAt: '2026-01-01T20:00:00.000Z' }])
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
  await ui.unmount()
})

test('pressing the compact button checks again for a running turn and background work', { options: { autoCompact: 'ask' } }, async ($, on) => {
  const w = world(on)
  const ui = await offerCompaction($, w)

  w.agents = [{ id: 'bg-1', description: 'watch tests', type: 'general-purpose', status: 'running' }]
  await ui.press({ key: 'compact' })
  expect(w.compactions.length).toBe(0)
  expect(w.toasts.at(-1)).toContain('running')
  w.agents = []

  await $.turn.start({ text: 'go', turnId: 't2' })
  await ui.press({ key: 'compact' })
  expect(w.compactions.length).toBe(0)
  await $.turn.complete({ answer: 'Which one?', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })

  // Still offered; nothing holds it off now.
  await ui.press({ key: 'compact' })
  expect(w.compactions.length).toBe(1)
  await ui.unmount()
})

test('off mode never compacts', { options: { autoCompact: 'off' } }, async ($, on) => {
  const w = world(on)
  w.context = BIG
  await mainTurn($, 't1', 'Done.')
  await w.clock.advance(2_000)
  expect(w.compactions.length).toBe(0)
})
