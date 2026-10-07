import { describe, expect, mock, test } from 'claude-code/testing'
import type { ModelUsage, On } from 'claude-code'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.UTC(2026, 9, 6, 14, 0)
const LOG = '/home/t/.claude/cache-keeper/sid-1.jsonl'

const HIT: ModelUsage = {
  input_tokens: 4,
  output_tokens: 2,
  cache_read_input_tokens: 200_000,
  cache_creation_input_tokens: 0,
}

const MISS: ModelUsage = { ...HIT, cache_read_input_tokens: 0, cache_creation_input_tokens: 200_000 }

/** The world beneath the plugin: clock, env, files, session figures and the fork. */
const world = (
  on: On,
  opts: { usage?: ModelUsage; contextTokens?: number; percentUsed?: number; store?: Record<string, unknown> } = {},
) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/t' })
  mock.store(on, opts.store ?? {})
  on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292', builtAt: '2026-10-01' } }))

  const files = new Map<string, string>()
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`missing ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.usage', () => ({
    value: {
      startedAt: T0,
      context: { tokens: opts.contextTokens ?? 200_000, window: 1_000_000, percent: 20 },
      rateLimits: [{ kind: 'five_hour', percentUsed: opts.percentUsed ?? 20 }],
    },
  }))

  const forks: string[] = []
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true as const, text: 'ok', usage: opts.usage ?? HIT } }
  })

  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  const logLines = () => (files.get(LOG) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))

  return { clock, files, forks, toasts, statuses, logLines }
}

const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

const startAndTurn = async ($: any) => {
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
}

describe('cache-keeper', () => {
  test('pings once just before the TTL lapses, and logs it', async ($, on) => {
    const w = world(on)
    await startAndTurn($)

    await w.clock.advance(54 * MIN)
    expect(w.forks.length).toBe(0)

    await w.clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.logLines()).toEqual([expect.objectContaining({ kind: 'ping', outcome: 'hit', cacheRead: 200_000 })])
    expect(w.toasts.length).toBe(1)

    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('stops after the idle limit', async ($, on) => {
    const w = world(on)
    await startAndTurn($)

    await w.clock.advance(12 * HOUR)
    // pings every 55 minutes up to 440; the one due at 495 is past 8 hours
    expect(w.forks.length).toBe(8)
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'stop', reason: 'idle-limit' }))
  })

  test('a real turn resets the clock', async ($, on) => {
    const w = world(on)
    await startAndTurn($)

    await w.clock.advance(50 * MIN)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' })
    await w.clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    await w.clock.advance(5 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a subagent turn is not activity', async ($, on) => {
    const w = world(on)
    await startAndTurn($)

    await w.clock.advance(50 * MIN)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'a1' })
    await w.clock.advance(5 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a cache miss stops pinging', async ($, on) => {
    const w = world(on, { usage: MISS })
    await startAndTurn($)

    await w.clock.advance(3 * HOUR)
    expect(w.forks.length).toBe(1)
    expect(w.logLines().map(l => l.kind)).toEqual(['ping', 'stop'])
    expect(w.logLines()[1]).toEqual(expect.objectContaining({ reason: 'cache-miss' }))
  })

  test('a fork miss benches pinging for this Claude Code version, across sessions', async ($, on) => {
    const w = world(on, { usage: MISS })
    await startAndTurn($)
    await w.clock.advance(1 * HOUR)
    expect(w.forks.length).toBe(1)

    await $.turn.start({ text: 'back', turnId: 't2' })
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' })
    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(1)
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'stop', reason: 'fork-miss-on-this-version' }))
  })

  test('a recorded miss on this version stops pings before they are sent', async ($, on) => {
    const w = world(on, { store: { forkMiss: { version: '2.1.292', at: 0 } } })
    await startAndTurn($)
    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'stop', reason: 'fork-miss-on-this-version' }))
  })

  test('a miss recorded on an older version does not bench a new one', async ($, on) => {
    const w = world(on, { store: { forkMiss: { version: '2.1.291', at: 0 } } })
    await startAndTurn($)
    await w.clock.advance(56 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a real turn after a pinged idle hour checks that the ping kept the cache warm', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await w.clock.advance(70 * MIN) // ping at 55; the turn comes 70 minutes after the last real one
    expect(w.forks.length).toBe(1)
    await $.turn.start({ text: 'back', turnId: 't2' })
    const usage = { ...HIT, cache_creation_input_tokens: 3_000, model: 'claude-opus-5-5' }
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', usage })
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'verify', verdict: 'warm', idleMinutes: 70 }))
  })

  test('a cold turn after pings benches automatic pings for this version', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await w.clock.advance(70 * MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    const usage = { ...HIT, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 190_000, model: 'claude-opus-5-5' }
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', usage })
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'verify', verdict: 'cold' }))
    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(1)
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'stop', reason: 'fork-miss-on-this-version' }))
  })

  test('no verify record without an idle hour', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await w.clock.advance(57 * MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', usage: { ...HIT, model: 'm' } })
    expect(w.logLines().map(l => l.kind)).toEqual(['ping'])
  })

  test('small contexts are left alone', async ($, on) => {
    const w = world(on, { contextTokens: 5_000 })
    await startAndTurn($)

    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('/keepwarm off stops and on resumes', async ($, on) => {
    const w = world(on)
    await startAndTurn($)

    const off = await $.command.run({ command: 'keepwarm', args: 'off', ...COMMAND })
    expect(off.text).toContain('off')
    await w.clock.advance(61 * MIN)
    expect(w.forks.length).toBe(0)

    // the cache lapsed meanwhile, so turning on waits for the next turn
    await $.command.run({ command: 'keepwarm', args: 'on', ...COMMAND })
    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('/keepwarm now pings immediately', async ($, on) => {
    const w = world(on)
    await startAndTurn($)

    const r = await $.command.run({ command: 'keepwarm', args: 'now', ...COMMAND })
    expect(w.forks.length).toBe(1)
    expect(r.text).toContain('200k')
  })

  test('/keepwarm status reports the schedule', async ($, on) => {
    const w = world(on)
    await startAndTurn($)

    const r = await $.command.run({ command: 'keepwarm', args: '', ...COMMAND })
    expect(r.text).toContain('next ping')
    expect(w.forks.length).toBe(0)
  })

  test('headless sessions do nothing', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })
})
