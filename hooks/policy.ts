import type { ModelUsage } from 'claude-code'

import type { Config, Mode, Session } from '../types'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export type Facts = {
  contextTokens: number
}

export type StopReason = 'off' | 'expired' | 'short-ttl' | 'idle-limit' | 'small-context'

export type Decision =
  | { action: 'idle' }
  | { action: 'wait'; at: number }
  | { action: 'ping' }
  | { action: 'stop'; reason: StopReason }

/**
 * What to do about the session's cache at `now`. Pure: the caller supplies
 * the session's state, the context size and the config.
 */
export const decide = (s: Session, now: number, facts: Facts, config: Config): Decision => {
  const isInWindow = s.untilMs !== null && now <= s.untilMs
  const isOn = isInWindow || s.mode === 'on' || (s.mode === 'auto' && config.enabled)
  if (!isOn) return { action: 'stop', reason: 'off' }
  if (s.isTurnRunning || s.lastRequestAt === null || s.isCompacted) return { action: 'idle' }
  // A five-minute cache needs a ping every few minutes: within the hour that costs more than a re-cache.
  if (s.cacheTtl === '5m') return { action: 'stop', reason: 'short-ttl' }

  const expiresAt = s.lastRequestAt + config.ttlMs
  if (now >= expiresAt) return { action: 'stop', reason: 'expired' }

  const pingAt = expiresAt - config.leadMs
  if (now < pingAt) return { action: 'wait', at: pingAt }

  // lastTurnAt moves on every main-loop turn, typed or not (a background
  // agent's result, a /loop wakeup): those extend the idle window by design.
  // A /keepwarm for|until window extends that, never shortens it.
  const keepUntil = Math.max(s.untilMs ?? 0, (s.lastTurnAt ?? s.lastRequestAt) + config.maxIdleMs)
  if (now > keepUntil) return { action: 'stop', reason: 'idle-limit' }
  if (facts.contextTokens < config.minContextTokens) return { action: 'stop', reason: 'small-context' }
  // No plan-usage ceiling: past the limit, extra usage bills per token, and a
  // ping costs about a twentieth of the re-cache it saves. A blocked ping is
  // an API error, which stops pinging without benching.

  return { action: 'ping' }
}

const RETRY_MS = 2 * MIN
const RETRY_MARGIN_MS = 30_000

/**
 * When to retry a failed ping: two minutes on, or halfway to expiry when the
 * cache would lapse first; null when too little of it is left.
 */
export const retryAt = (s: Session, now: number, config: Config): number | null => {
  if (s.lastRequestAt === null) return null
  const expiresAt = s.lastRequestAt + config.ttlMs
  const at = Math.min(now + RETRY_MS, now + (expiresAt - now) / 2)
  return expiresAt - at >= RETRY_MARGIN_MS ? at : null
}

/** A fork the cache served at least 80% of is a hit; otherwise it paid for the prefix. */
export const classifyPing = (u: ModelUsage): 'hit' | 'miss' => {
  const prompt = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
  return prompt > 0 && u.cache_read_input_tokens / prompt >= 0.8 ? 'hit' : 'miss'
}

export type KeepwarmCommand =
  | { kind: 'status' }
  | { kind: 'now' }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'until'; untilMs: number }
  | { kind: 'error'; message: string }

export const USAGE = 'Usage: /keepwarm [status | on | off | auto | now | for <n>h|<n>m | until HH:MM]'

/**
 * Parses /keepwarm's arguments. `tzOffsetMinutes` is Date#getTimezoneOffset():
 * minutes to add to local time to get UTC.
 */
export const parseKeepwarmArgs = (args: string, now: number, tzOffsetMinutes: number): KeepwarmCommand => {
  const [head, arg] = args.trim().toLowerCase().split(/\s+/).filter(Boolean)

  if (head === undefined || head === 'status') return { kind: 'status' }
  if (head === 'now') return { kind: 'now' }
  if (head === 'on' || head === 'off' || head === 'auto') return { kind: 'mode', mode: head }

  if (head === 'for' && arg !== undefined) {
    const m = /^(\d+(?:\.\d+)?)(h|m)$/.exec(arg)
    if (m) return { kind: 'until', untilMs: now + Number(m[1]) * (m[2] === 'h' ? HOUR : MIN) }
  }

  if (head === 'until' && arg !== undefined) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(arg)
    if (m && Number(m[1]) < 24 && Number(m[2]) < 60) {
      const offset = tzOffsetMinutes * MIN
      const localMidnight = Math.floor((now - offset) / DAY) * DAY
      let untilMs = localMidnight + Number(m[1]) * HOUR + Number(m[2]) * MIN + offset
      if (untilMs <= now) untilMs += DAY
      return { kind: 'until', untilMs }
    }
  }

  return { kind: 'error', message: USAGE }
}
