// The values subagent-cost keeps in `$.state` for the session.

/** Token counts in the four kinds the API bills. */
export type TokenTally = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** One rate-limit window as `session.measure` reported it. */
export type WindowReading = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** One subagent run, keyed by the Agent tool call that started it. */
export type AgentRow = {
  toolUseId: string
  agentId?: string
  /** The agent type (`Explore`, `general-purpose`, `fork`, ...). */
  type: string
  /** The model the spawn resolved to. */
  model?: string
  /** The model the subagent's own turns reported. */
  usageModel?: string
  /** It ran on Opus, Fable or Mythos without the call naming a model. */
  inherited: boolean
  background: boolean
  /** Summed over every `turn.complete` of the agent's loop. */
  usage: TokenTally
  /** USD-equivalent of `usage` at list prices (see hooks/logic.ts). */
  weighted: number
  turns: number
  cacheTtl?: '5m' | '1h' | 'mixed'
  share1h?: number
  toolUses?: number
  durationMs?: number
}

export type MainTally = {
  usage: TokenTally
  weighted: number
  turns: number
  model?: string
}

/** Where the estimate started counting in the current 5-hour window. */
export type Baseline = {
  resetsAt?: string
  percent: number
  weighted: number
}

/** Percentage points of the 5-hour window per USD-equivalent spent. */
export type Rate = {
  percentPerUsd: number
  /** How many points the rate was measured over. */
  points: number
}

export type CompactState = {
  /** `ask` mode: a compaction is offered on the band. */
  isSuggested: boolean
  /** Context tokens right after the last automatic compaction. */
  tokensAfter?: number
  /** No automatic compaction before this main-loop turn count. */
  holdUntilTurn?: number
}

/** A handoff request waiting to reach the model. */
export type PendingNote = {
  key: string
  text: string
}

export type ContextReading = {
  tokens?: number
  percent?: number
  window?: number
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-cost': {
      agents: Record<string, AgentRow>
      main: MainTally
      windows: WindowReading[]
      context: ContextReading
      baseline: Baseline | null
      rate: Rate | null
      warned: string[]
      handedOff: string[]
      pendingNote: PendingNote | null
      compact: CompactState
    }
  }
}
