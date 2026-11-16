import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_TALLY,
  agentLine,
  alertsFor,
  bandLine,
  cacheSplit,
  contextOverThreshold,
  endsWithQuestion,
  fmtTokens,
  isExpensive,
  parsePolicy,
  priceOf,
  shareOf,
  stepEstimate,
  weigh,
} from '../hooks/logic'
import type { AgentRow, WindowReading } from '../types'

const TH = { warnAt: 88, handoffAt: 90, warnAt7d: 88, handoffAt7d: 90 }
const RESET = '2026-01-01T15:00:00.000Z'

function five(percentUsed: number, resetsAt = RESET): WindowReading {
  return { kind: 'five_hour', percentUsed, resetsAt }
}

describe('prices', () => {
  test('known models resolve to their own row', async () => {
    expect(priceOf('claude-opus-5-5').input).toBe(4)
    expect(priceOf('claude-fable-5-2').output).toBe(40)
    expect(priceOf('claude-haiku-5-5').cacheRead).toBe(0.01)
    expect(priceOf('claude-sonnet-4-6').input).toBe(3)
    expect(priceOf('claude-opus-4-8').input).toBe(5)
  })

  test('expensive means Opus, Fable or Mythos', async () => {
    expect(isExpensive('claude-opus-5-5')).toBe(true)
    expect(isExpensive('claude-fable-5-2[1m]')).toBe(true)
    expect(isExpensive('claude-sonnet-5-5')).toBe(false)
    expect(isExpensive(undefined)).toBe(false)
  })

  test('a 1-hour cache write costs more than a 5-minute one', async () => {
    const t = { ...EMPTY_TALLY, cacheWrite: 1_000_000 }
    expect(weigh(t, 'claude-sonnet-5-5', 0)).toBe(2.5)
    expect(weigh(t, 'claude-sonnet-5-5', 1)).toBe(4)
  })

  test('the TTL split comes from the Agent result', async () => {
    expect(cacheSplit({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 10 })).toEqual({ ttl: '5m', share1h: 0 })
    expect(cacheSplit({ ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 })).toEqual({ ttl: '1h', share1h: 1 })
    expect(cacheSplit(null)).toEqual({})
  })
})

describe('the estimate', () => {
  test('too few points: no rate, so no percentage', async () => {
    let s = stepEstimate(null, null, five(40), 1)
    expect(s.rate).toBe(null)
    s = stepEstimate(s.baseline, s.rate, five(41.5), 3)
    expect(s.rate).toBe(null)
    expect(shareOf(0.5, s.rate)).toBe(undefined)
  })

  test('two points over a spend gives a rate', async () => {
    let s = stepEstimate(null, null, five(40), 1)
    s = stepEstimate(s.baseline, s.rate, five(44), 3)
    expect(s.rate?.percentPerUsd).toBe(2)
    expect(shareOf(0.5, s.rate)).toBe(1)
  })

  test('a reset starts a new baseline and keeps the last rate', async () => {
    let s = stepEstimate(null, null, five(40), 1)
    s = stepEstimate(s.baseline, s.rate, five(44), 3)
    s = stepEstimate(s.baseline, s.rate, five(1, '2026-01-01T20:00:00.000Z'), 4)
    expect(s.baseline?.percent).toBe(1)
    expect(s.baseline?.weighted).toBe(4)
    expect(s.rate?.percentPerUsd).toBe(2)
  })

  test('a reset time that moves by seconds is the same window', async () => {
    let s = stepEstimate(null, null, five(40), 1)
    s = stepEstimate(s.baseline, s.rate, five(43, '2026-01-01T15:00:20.000Z'), 2)
    expect(s.rate?.percentPerUsd).toBe(3)
  })
})

describe('alerts', () => {
  test('87%: nothing', async () => {
    expect(alertsFor([five(87)], TH, [], [])).toEqual([])
  })

  test('88%: one warning, once per window', async () => {
    const first = alertsFor([five(88)], TH, [], [])
    expect(first.map(a => a.kind)).toEqual(['warn'])
    const key = first[0]?.key ?? ''
    expect(alertsFor([five(89)], TH, [key], [])).toEqual([])
  })

  test('90%: the handoff, once per window, and it supersedes the warning', async () => {
    const first = alertsFor([five(90)], TH, [], [])
    expect(first.map(a => a.kind)).toEqual(['handoff'])
    const key = first[0]?.key ?? ''
    expect(alertsFor([five(95)], TH, [], [key])).toEqual([])
  })

  test('a new window alerts again', async () => {
    const first = alertsFor([five(90)], TH, [], [])
    const key = first[0]?.key ?? ''
    const next = alertsFor([five(90, '2026-01-01T20:00:00.000Z')], TH, [], [key])
    expect(next.map(a => a.kind)).toEqual(['handoff'])
  })

  test('the 7-day window has its own thresholds', async () => {
    const th = { ...TH, warnAt7d: 50, handoffAt7d: 60 }
    const out = alertsFor([{ kind: 'seven_day', percentUsed: 55 }], th, [], [])
    expect(out.map(a => a.kind)).toEqual(['warn'])
  })
})

describe('compaction decisions', () => {
  test('a question at the end, in either script', async () => {
    expect(endsWithQuestion('Done.\n\nWhich one first?', false)).toBe(true)
    expect(endsWithQuestion('改好了。\n要我顺手提交吗？', false)).toBe(true)
    expect(endsWithQuestion('**Shall I go on?**', false)).toBe(true)
    expect(endsWithQuestion('All done.', false)).toBe(false)
    expect(endsWithQuestion('Is it? Yes, done.', false)).toBe(false)
    expect(endsWithQuestion('All done.', true)).toBe(true)
  })

  test('either threshold, whichever comes first', async () => {
    const s = { mode: 'auto' as const, atPercent: 60, atTokens: 150_000 }
    expect(contextOverThreshold({ tokens: 100_000, percent: 10 }, s)).toBe(false)
    expect(contextOverThreshold({ tokens: 160_000, percent: 16 }, s)).toBe(true)
    expect(contextOverThreshold({ tokens: 130_000, percent: 65 }, s)).toBe(true)
    expect(contextOverThreshold({ tokens: 160_000 }, { ...s, atTokens: 0 })).toBe(false)
  })

  test('the model policy', async () => {
    expect(parsePolicy(undefined)).toEqual({ kind: 'warn' })
    expect(parsePolicy('off')).toEqual({ kind: 'off' })
    expect(parsePolicy('downgrade:sonnet')).toEqual({ kind: 'downgrade', model: 'sonnet' })
    expect(parsePolicy('downgrade:')).toEqual({ kind: 'warn' })
  })
})

describe('formatting', () => {
  test('token counts', async () => {
    expect(fmtTokens(950, 'en')).toBe('950')
    expect(fmtTokens(12_345, 'en')).toBe('12.3k')
    expect(fmtTokens(3000, 'zh')).toBe('3 千')
    expect(fmtTokens(12_000, 'zh')).toBe('1.2 万')
    expect(fmtTokens(480_000, 'zh')).toBe('48 万')
  })

  const row: AgentRow = {
    toolUseId: 't1',
    agentId: 'a1',
    type: 'Explore',
    model: 'claude-haiku-5-5',
    inherited: false,
    background: false,
    usage: { input: 12_000, output: 3000, cacheWrite: 41_000, cacheRead: 80_000 },
    weighted: 0.01,
    turns: 1,
    cacheTtl: '5m',
    toolUses: 23,
    durationMs: 41_000,
  }

  test('the subagent line, with and without a rate', async () => {
    expect(agentLine(row, null, 'zh')).toBe(
      '子代理 Explore · claude-haiku-5-5 · 输入 1.2 万 / 输出 3 千 / 缓存写 4.1 万（5m） / 缓存读 8 万 · 23 次工具 · 41 秒',
    )
    expect(agentLine(row, { percentPerUsd: 80, points: 4 }, 'en')).toBe(
      'subagent Explore · claude-haiku-5-5 · in 12k / out 3k / cache write 41k (5m) / cache read 80k · 23 tools · 41s · ≈0.8% of 5h quota (estimate)',
    )
  })

  test('the band line', async () => {
    const now = Date.parse('2026-01-01T13:00:00.000Z')
    const line = bandLine({
      windows: [five(63), { kind: 'seven_day', percentUsed: 41 }],
      mainTokens: 123_000,
      agents: [row, { ...row, toolUseId: 't2', inherited: true, model: 'claude-opus-5-5' }],
      now,
      lang: 'zh',
    })
    expect(line).toBe('5h 63%（2 小时后重置） · 7d 41% · 主会话 12.3 万 / 子代理 27.2 万（2 个，1 个继承了 Opus）')
  })
})
