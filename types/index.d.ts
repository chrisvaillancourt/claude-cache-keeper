export type Mode = 'auto' | 'on' | 'off'

export type Config = {
  enabled: boolean
  ttlMs: number
  leadMs: number
  maxIdleMs: number
  minContextTokens: number
  maxLimitPercent: number
}

export type PingRecord = {
  at: number
  outcome: 'hit' | 'miss' | 'error'
  cacheRead: number
  cacheWrite: number
  input: number
  output: number
  detail?: string
}

export type Session = {
  mode: Mode
  /** A /keepwarm for|until window: keeps warm at least this long, whatever the mode. */
  untilMs: number | null
  /** When the cache was last refreshed: the end of a main turn or a ping. */
  lastRequestAt: number | null
  /** When the last real (non-ping) main turn ended. */
  lastTurnAt: number | null
  isTurnRunning: boolean
  /** The main turn in progress, from its turn.start; null between turns. */
  turnId: string | null
  /** The prompt-cache TTL the engine last reported (on a model switch or resume). */
  cacheTtl: '5m' | '1h' | null
  /** Compacted since the last main-loop request: nothing cached matches the next one. */
  isCompacted: boolean
  /** Pings since the last real turn. */
  pings: number
  /** Ping errors in a row since the last hit or real turn. */
  pingErrors: number
  lastPing: PingRecord | null
  stopReason: string | null
  /** Set at the start of a real turn that follows a pinged break longer than the TTL. */
  probe: { contextTokens: number; idleMinutes: number; pings: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { session: Session }
  }
}
