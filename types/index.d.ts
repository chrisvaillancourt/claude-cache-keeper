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
  untilMs: number | null
  /** When the cache was last refreshed: the end of a main turn or a ping. */
  lastRequestAt: number | null
  /** When the last real (non-ping) main turn ended. */
  lastTurnAt: number | null
  isTurnRunning: boolean
  /** Pings since the last real turn. */
  pings: number
  lastPing: PingRecord | null
  stopReason: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { session: Session }
  }
}
