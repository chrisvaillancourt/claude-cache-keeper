import { describe, expect, mock, test } from 'claude-code/testing'
import type { ModelForkResult, ModelUsage, On } from 'claude-code'

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

const ZERO: ModelUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** An overloaded API: the fork's one request was refused, so its usage is all zeros. */
const API_ERROR: ModelForkResult = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }

/** The world beneath the plugin: clock, env, files, session figures and the fork. */
const world = (
  on: On,
  opts: {
    usage?: ModelUsage
    contextTokens?: number
    percentUsed?: number
    store?: Record<string, unknown>
    /** Fork results in order; once used up, a hit with `usage`. */
    forkResults?: ModelForkResult[]
    /** Runs while a fork is in flight, before it answers. */
    duringFork?: () => Promise<void>
  } = {},
) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/t' })
  mock.store(on, opts.store ?? {})
  on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292', builtAt: '2026-10-01' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))

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
  on('session.compact', () => ({ messages: SUMMARY }))
  on('classic.PostModelSwitch', () => ({}))
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
  const queued = [...(opts.forkResults ?? [])]
  let duringFork = opts.duringFork
  on('model.fork', async ($, e) => {
    forks.push(e.prompt)
    if (duringFork) {
      const run = duringFork
      duringFork = undefined
      await run()
    }
    return { value: queued.shift() ?? { isAnswered: true as const, text: 'ok', usage: opts.usage ?? HIT } }
  })

  let stepUsage: ModelUsage = HIT
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { ...stepUsage, model: 'claude-opus-5-5' },
    }
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

  return { clock, files, forks, toasts, statuses, logLines, stepUsage: (u: ModelUsage) => (stepUsage = u) }
}

const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

const turn = async ($: any, turnId: string, usage?: ModelUsage) => {
  await $.turn.start({ text: 'hi', turnId })
  await $.turn.complete({
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    turnId,
    reason: 'answer',
    ...(usage ? { usage: { ...usage, model: 'claude-opus-5-5' } } : {}),
  })
}

const startAndTurn = async ($: any) => {
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await turn($, 't1')
}

/** One main-loop model request of turn `turnId`, answered with `usage`. */
const step = async ($: any, w: { stepUsage: (u: ModelUsage) => void }, turnId: string, index: number, usage: ModelUsage) => {
  w.stepUsage(usage)
  const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 10 })
  for await (const _ of s);
  return s.result
}

const modelSwitch = (cacheTtl: '5m' | '1h') => ({
  from_model: 'claude-opus-5-5',
  to_model: 'claude-sonnet-5-5',
  requested_model: 'sonnet',
  source: 'command' as const,
  context_tokens: 200_000,
  prompt_cache_warm: true,
  cache_ttl: cacheTtl,
  estimated_cache_write_usd: 1.5,
  pricing: 'catalog' as const,
})

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
    await turn($, 't2')
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

  test('a turn that completes while a ping is in flight still counts', async ($, on) => {
    const w = world(on, { duringFork: () => turn($, 't2') })
    await startAndTurn($)

    await w.clock.advance(55 * MIN) // ping; t2 starts and ends meanwhile
    expect(w.forks.length).toBe(1)
    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a turn that started before a reload still counts when it completes', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true }) // hot reload
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a turn whose completion never came does not leave the keeper idle', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await $.turn.start({ text: 'lost', turnId: 't2' })
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't3', reason: 'answer' })
    await w.clock.advance(55 * MIN)
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

  test('a ping error is retried once, two minutes later', async ($, on) => {
    const w = world(on, { forkResults: [API_ERROR] })
    await startAndTurn($)

    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    await w.clock.advance(2 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.logLines().map(l => l.outcome)).toEqual(['error', 'hit'])
    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(3)
  })

  test('a second ping error in a row stops, without benching', async ($, on) => {
    const w = world(on, { forkResults: [API_ERROR, API_ERROR] })
    await startAndTurn($)

    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(2)
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'stop', reason: 'error' }))

    await turn($, 't2')
    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(3)
  })

  test('a fork that missed and then hit an API error is still a miss', async ($, on) => {
    const w = world(on, { forkResults: [{ ...API_ERROR, usage: MISS }] })
    await startAndTurn($)
    await w.clock.advance(3 * HOUR)
    expect(w.forks.length).toBe(1)
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'stop', reason: 'cache-miss' }))
  })

  test('a fork miss benches pinging for this Claude Code version, across sessions', async ($, on) => {
    const w = world(on, { usage: MISS })
    await startAndTurn($)
    await w.clock.advance(1 * HOUR)
    expect(w.forks.length).toBe(1)

    await turn($, 't2')
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

  test("the first request after a pinged idle hour checks that the ping kept the cache warm", async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await w.clock.advance(70 * MIN) // ping at 55; the turn comes 70 minutes after the last real one
    expect(w.forks.length).toBe(1)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await step($, w, 't2', 0, { ...HIT, cache_creation_input_tokens: 3_000 })
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'verify', verdict: 'warm', idleMinutes: 70 }))
  })

  test('a long turn that writes a lot after its first request is still warm', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await w.clock.advance(70 * MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await step($, w, 't2', 0, { ...HIT, cache_creation_input_tokens: 3_000 })
    await step($, w, 't2', 1, { ...HIT, cache_creation_input_tokens: 150_000 })
    const usage = { ...HIT, cache_creation_input_tokens: 153_000, model: 'claude-opus-5-5' }
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', usage })
    expect(w.logLines().filter(l => l.kind === 'verify').map(l => l.verdict)).toEqual(['warm'])
    await w.clock.advance(56 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a cold first request after pings benches automatic pings for this version', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await w.clock.advance(70 * MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await step($, w, 't2', 0, { ...HIT, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 190_000 })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'verify', verdict: 'cold' }))
    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(1)
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'stop', reason: 'fork-miss-on-this-version' }))
  })

  test('no verify when the conversation compacts before the first request', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await w.clock.advance(70 * MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await $.session.compact({ trigger: 'auto', messages: SUMMARY })
    await step($, w, 't2', 0, { ...HIT, cache_read_input_tokens: 0, cache_creation_input_tokens: 30_000 })
    const usage = { ...HIT, cache_creation_input_tokens: 150_000, model: 'claude-opus-5-5' }
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', usage })
    expect(w.logLines().map(l => l.kind)).toEqual(['ping'])
  })

  test('no verify record without an idle hour', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await w.clock.advance(57 * MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await step($, w, 't2', 0, HIT)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(w.logLines().map(l => l.kind)).toEqual(['ping'])
  })

  test('a model switch while idle stops pings until the next turn, without benching', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await w.clock.advance(70 * MIN) // one ping at 55
    await $.classic.PostModelSwitch(modelSwitch('1h'))
    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(1)

    // the next turn caches the new model's prefix: no verify, and pings resume
    await $.turn.start({ text: 'back', turnId: 't2' })
    await step($, w, 't2', 0, MISS)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(w.logLines().some(l => l.kind === 'verify')).toBe(false)
    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test("a subagent's model switch leaves the main cache alone", async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await $.classic.PostModelSwitch({ ...modelSwitch('5m'), agent_id: 'a1' })
    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a five-minute cache TTL reported by the engine stops pings', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await $.classic.PostModelSwitch(modelSwitch('5m'))
    await turn($, 't2')
    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'stop', reason: 'short-ttl' }))
  })

  test('/compact while idle stops pings until the next turn', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await w.clock.advance(10 * MIN)
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)

    // the next turn's first request caches the compacted conversation
    await $.turn.start({ text: 'back', turnId: 't2' })
    await step($, w, 't2', 0, MISS)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('small contexts are left alone', async ($, on) => {
    const w = world(on, { contextTokens: 5_000 })
    await startAndTurn($)

    await w.clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('keeps pinging at 90% plan usage', async ($, on) => {
    const w = world(on, { percentUsed: 90 })
    await startAndTurn($)
    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('stops at 95% plan usage, and the stop line records usage, model and version', async ($, on) => {
    const w = world(on, { percentUsed: 95 })
    await startAndTurn($)
    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(0)
    expect(w.logLines().at(-1)).toEqual(
      expect.objectContaining({
        kind: 'stop',
        reason: 'near-limit',
        limits: [{ kind: 'five_hour', percentUsed: 95 }],
        contextTokens: 200_000,
        model: 'claude-opus-5-5',
        version: '2.1.292',
      }),
    )
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

  test('off is logged once, not after every turn', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await $.command.run({ command: 'keepwarm', args: 'off', ...COMMAND })
    await turn($, 't2')
    await turn($, 't3')
    await w.clock.advance(2 * HOUR)
    expect(w.logLines().filter(l => l.reason === 'off').length).toBe(1)
  })

  test('/keepwarm for: an ended window leaves the usual idle limit in place', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await $.command.run({ command: 'keepwarm', args: 'for 1h', ...COMMAND })

    await w.clock.advance(2 * HOUR) // pings at 55 and 110: the 8-hour limit still holds
    expect(w.forks.length).toBe(2)

    await turn($, 't2')
    await w.clock.advance(55 * MIN)
    expect(w.forks.length).toBe(3)
    const status = await $.command.run({ command: 'keepwarm', args: 'status', ...COMMAND })
    expect(status.text).not.toContain('keeping warm until')
  })

  test('/keepwarm for keeps warm past the idle limit', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await $.command.run({ command: 'keepwarm', args: 'for 10h', ...COMMAND })
    await w.clock.advance(12 * HOUR)
    // pings every 55 minutes up to 550; the one due at 605 is past 10 hours
    expect(w.forks.length).toBe(10)
  })

  test('/keepwarm for while off keeps warm for the window, then off again', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await $.command.run({ command: 'keepwarm', args: 'off', ...COMMAND })
    await $.command.run({ command: 'keepwarm', args: 'for 1h', ...COMMAND })
    await w.clock.advance(3 * HOUR)
    expect(w.forks.length).toBe(1)
    expect(w.logLines().at(-1)).toEqual(expect.objectContaining({ kind: 'stop', reason: 'off' }))
  })

  test('/keepwarm now pings immediately', async ($, on) => {
    const w = world(on)
    await startAndTurn($)

    const r = await $.command.run({ command: 'keepwarm', args: 'now', ...COMMAND })
    expect(w.forks.length).toBe(1)
    expect(r.text).toContain('200k')
  })

  test('/keepwarm now with nothing cached sends no fork', async ($, on) => {
    const w = world(on)
    await startAndTurn($)
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    const r = await $.command.run({ command: 'keepwarm', args: 'now', ...COMMAND })
    expect(w.forks.length).toBe(0)
    expect(r.text).toContain('Nothing cached')
  })

  test('/keepwarm now failing neither pings again at once nor spends the automatic retry', async ($, on) => {
    const w = world(on, { forkResults: [API_ERROR, API_ERROR] })
    await startAndTurn($)
    await w.clock.advance(54 * MIN)
    await $.command.run({ command: 'keepwarm', args: 'now', ...COMMAND })
    expect(w.forks.length).toBe(1)
    // the automatic ping (error) and its retry (hit) still both run
    await w.clock.advance(1 * MIN)
    expect(w.forks.length).toBe(2)
    await w.clock.advance(2 * MIN)
    expect(w.forks.length).toBe(3)
    expect(w.logLines().map(l => l.outcome).filter(Boolean)).toEqual(['error', 'error', 'hit'])
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
