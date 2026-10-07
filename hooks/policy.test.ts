import { describe, expect, test } from 'claude-code/testing'

import { classifyPing, decide, parseKeepwarmArgs } from './policy'
import type { Config, Session } from '../types'

const MIN = 60_000
const HOUR = 60 * MIN

const config: Config = {
  enabled: true,
  ttlMs: HOUR,
  leadMs: 5 * MIN,
  maxIdleMs: 4 * HOUR,
  minContextTokens: 60_000,
  maxLimitPercent: 85,
}

const session = (over: Partial<Session> = {}): Session => ({
  mode: 'auto',
  untilMs: null,
  lastRequestAt: 0,
  lastTurnAt: 0,
  isTurnRunning: false,
  pings: 0,
  lastPing: null,
  stopReason: null,
  probe: null,
  ...over,
})

const facts = { contextTokens: 200_000, limits: [{ kind: 'five_hour', percentUsed: 20 }] }

describe('decide', () => {
  test('waits until the lead before expiry', () => {
    expect(decide(session(), 10 * MIN, facts, config)).toEqual({ action: 'wait', at: 55 * MIN })
  })

  test('pings inside the lead window', () => {
    expect(decide(session(), 56 * MIN, facts, config)).toEqual({ action: 'ping' })
  })

  test('stops once the cache has already expired, e.g. after sleep', () => {
    expect(decide(session(), 61 * MIN, facts, config)).toEqual({ action: 'stop', reason: 'expired' })
  })

  test('counts from the last ping, not the last turn', () => {
    const s = session({ lastRequestAt: 3 * HOUR, pings: 3 })
    expect(decide(s, 3 * HOUR + 20 * MIN, facts, config)).toEqual({
      action: 'wait',
      at: 3 * HOUR + 55 * MIN,
    })
  })

  test('stops past the idle limit after the last real turn', () => {
    const s = session({ lastRequestAt: 4 * HOUR })
    expect(decide(s, 4 * HOUR + 56 * MIN, facts, config)).toEqual({ action: 'stop', reason: 'idle-limit' })
  })

  test('an explicit until overrides the idle limit', () => {
    const s = session({ lastRequestAt: 4 * HOUR, untilMs: 9 * HOUR })
    expect(decide(s, 4 * HOUR + 56 * MIN, facts, config)).toEqual({ action: 'ping' })
  })

  test('off mode and disabled config stop', () => {
    expect(decide(session({ mode: 'off' }), 56 * MIN, facts, config)).toEqual({ action: 'stop', reason: 'off' })
    expect(decide(session(), 56 * MIN, facts, { ...config, enabled: false })).toEqual({
      action: 'stop',
      reason: 'off',
    })
  })

  test('on mode overrides a disabled config', () => {
    expect(decide(session({ mode: 'on' }), 56 * MIN, facts, { ...config, enabled: false })).toEqual({
      action: 'ping',
    })
  })

  test('skips small contexts', () => {
    expect(decide(session(), 56 * MIN, { ...facts, contextTokens: 10_000 }, config)).toEqual({
      action: 'stop',
      reason: 'small-context',
    })
  })

  test('stops near a plan limit', () => {
    const limits = [
      { kind: 'five_hour', percentUsed: 20 },
      { kind: 'seven_day', percentUsed: 85 },
    ]
    expect(decide(session(), 56 * MIN, { ...facts, limits }, config)).toEqual({
      action: 'stop',
      reason: 'near-limit',
    })
  })

  test('waits for a running turn', () => {
    expect(decide(session({ isTurnRunning: true }), 56 * MIN, facts, config)).toEqual({ action: 'idle' })
  })

  test('nothing to do before the first turn', () => {
    expect(decide(session({ lastRequestAt: null, lastTurnAt: null }), 56 * MIN, facts, config)).toEqual({
      action: 'idle',
    })
  })
})

describe('classifyPing', () => {
  test('a mostly-cached fork is a hit', () => {
    expect(
      classifyPing({ input_tokens: 3, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 40, output_tokens: 5 }),
    ).toBe('hit')
  })

  test('a fork that paid for the prefix is a miss', () => {
    expect(
      classifyPing({ input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 200_000, output_tokens: 5 }),
    ).toBe('miss')
  })
})

describe('parseKeepwarmArgs', () => {
  const now = Date.UTC(2026, 9, 6, 15, 0) // 15:00 UTC

  test('plain words', () => {
    expect(parseKeepwarmArgs('', now, 0)).toEqual({ kind: 'status' })
    expect(parseKeepwarmArgs('status', now, 0)).toEqual({ kind: 'status' })
    expect(parseKeepwarmArgs('on', now, 0)).toEqual({ kind: 'mode', mode: 'on' })
    expect(parseKeepwarmArgs('OFF', now, 0)).toEqual({ kind: 'mode', mode: 'off' })
    expect(parseKeepwarmArgs('auto', now, 0)).toEqual({ kind: 'mode', mode: 'auto' })
    expect(parseKeepwarmArgs('now', now, 0)).toEqual({ kind: 'now' })
  })

  test('for a duration', () => {
    expect(parseKeepwarmArgs('for 3h', now, 0)).toEqual({ kind: 'until', untilMs: now + 3 * HOUR })
    expect(parseKeepwarmArgs('for 90m', now, 0)).toEqual({ kind: 'until', untilMs: now + 90 * MIN })
    expect(parseKeepwarmArgs('for 1.5h', now, 0)).toEqual({ kind: 'until', untilMs: now + 90 * MIN })
  })

  test('until a local clock time, rolling to tomorrow when past', () => {
    // offset: local = UTC - 240 minutes (EDT)
    expect(parseKeepwarmArgs('until 18:00', now, 240)).toEqual({
      kind: 'until',
      untilMs: Date.UTC(2026, 9, 6, 22, 0),
    })
    expect(parseKeepwarmArgs('until 9:30', now, 240)).toEqual({
      kind: 'until',
      untilMs: Date.UTC(2026, 9, 7, 13, 30),
    })
  })

  test('rejects garbage', () => {
    expect(parseKeepwarmArgs('for ever', now, 0)).toEqual({ kind: 'error', message: expect.any(String) })
    expect(parseKeepwarmArgs('until 25:00', now, 0)).toEqual({ kind: 'error', message: expect.any(String) })
  })
})
