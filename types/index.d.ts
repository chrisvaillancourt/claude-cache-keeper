export type Mode = 'auto' | 'on' | 'off'

export type Config = {
  enabled: boolean
  ttlMs: number
  leadMs: number
  maxIdleMs: number
  minContextTokens: number
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
  /** When the cache was last refreshed: the end of a main-loop request or turn, or a ping. */
  lastRequestAt: number | null
  /** When the last real (non-ping) main-loop request or turn ended. */
  lastTurnAt: number | null
  /**
   * A main-loop request is running or about to (from turn.start to its first
   * request). False between a turn's requests, while a tool runs or a prompt
   * (a question, a permission) waits for the person: the cache can lapse then.
   */
  isRequestRunning: boolean
  /** The main turn in progress, from its turn.start; null between turns. */
  turnId: string | null
  /** The prompt-cache TTL the engine last reported (on a model switch or resume). */
  cacheTtl: '5m' | '1h' | null
  /** Compacted since the last main-loop request: nothing cached matches the next one. */
  isCompacted: boolean
  /**
   * The main loop's model (`$.session.model()`) at the start of the last
   * main-loop request; null before one. A different model now is a switch,
   * even one whose classic.PostModelSwitch never reached this module.
   */
  model: string | null
  /** Pings since the last real main-loop request. */
  pings: number
  /** Ping errors in a row since the last hit or real request. */
  pingErrors: number
  lastPing: PingRecord | null
  stopReason: string | null
  /** Set at the start of a main-loop request that follows a pinged break longer than the TTL. */
  probe: { contextTokens: number; idleMinutes: number; pings: number } | null
}

/**
 * The /keepwarm setting as kept in `$.store` under `mode/<session id>`, so it
 * survives the session moving to a new process (where `$.state` reads empty).
 * `at` is refreshed on every write. Only the setting: the rest of Session is the
 * old process's cache bookkeeping.
 */
export type ModeRecord = { mode: Mode; untilMs: number | null; at: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { session: Session }
  }
}
