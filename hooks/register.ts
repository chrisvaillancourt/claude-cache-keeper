import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, PluginOptions, Register, SessionUsage, Timer } from 'claude-code'

import { classifyPing, decide, parseKeepwarmArgs, retryAt } from './policy'
import type { Config, PingRecord, Session } from '../types'

const MIN = 60_000
const HOUR = 60 * MIN

const PING_PROMPT =
  '[cache-keeper keep-alive] This is an automated ping to keep the prompt cache warm. Reply with exactly: ok'

const INITIAL: Session = {
  mode: 'auto',
  untilMs: null,
  lastRequestAt: null,
  lastTurnAt: null,
  isTurnRunning: false,
  turnId: null,
  cacheTtl: null,
  isCompacted: false,
  pings: 0,
  pingErrors: 0,
  lastPing: null,
  stopReason: null,
  probe: null,
}

const sessionAtom = atom({ plugin: 'cache-keeper', key: 'session' } as const, INITIAL)

// Module variables reset on a hot reload; session.start fires again then and
// reschedules from $.state, which survives.
let config: Config = configFrom({})
let isActive = false
let isPinging = false
let timer: Timer | null = null

function num(v: unknown, fallback: number) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function configFrom(options: PluginOptions): Config {
  return {
    enabled: options.enabled !== false,
    ttlMs: num(options.ttlMinutes, 60) * MIN,
    leadMs: num(options.leadMinutes, 5) * MIN,
    maxIdleMs: num(options.maxIdleHours, 8) * HOUR,
    minContextTokens: num(options.minContextTokens, 60_000),
  }
}

function hhmm(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function kTokens(n: number) {
  return `${Math.round(n / 1000)}k`
}

function limitsOf(u: SessionUsage) {
  return u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed }))
}

function cancelTimer() {
  timer?.cancel()
  timer = null
}

/** Appends one JSON line to ~/.claude/cache-keeper/<session id>.jsonl; best effort. */
async function appendLog($: EngineInterface, record: Record<string, unknown>) {
  try {
    const home = await $.env.get('HOME')
    if (!home) return
    const path = `${home}/.claude/cache-keeper/${await $.session.id()}.jsonl`
    const before = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    const line = JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), ...record })
    await $.fs.write(path, `${before}${line}\n`)
  } catch {
    // Logging must never stop the keeper.
  }
}

/** What a stop line needs to be audited later: context, plan usage, model and version. */
async function logContext($: EngineInterface) {
  try {
    const usage = await $.session.usage()
    return {
      contextTokens: usage.context.tokens ?? null,
      limits: limitsOf(usage),
      model: await $.session.model(),
      version: (await $.session.version()).version,
    }
  } catch {
    return {}
  }
}

/**
 * Logs a stop when its reason differs from the current one, so a stop that
 * holds across turns (off) logs once. A stop ends only when the keeper is
 * active again: waiting for a ping, or after a hit.
 */
async function stop($: EngineInterface, reason: string, extra: Record<string, unknown> = {}) {
  const s = await read($, sessionAtom)
  if (s.stopReason !== reason) {
    await update($, sessionAtom, cur => ({ ...cur, stopReason: reason }))
    await appendLog($, { kind: 'stop', reason, pings: s.pings, ...(await logContext($)), ...extra })
  }
  $.ui.status(reason === 'off' ? undefined : `cache-keeper: stopped (${reason})`)
}

/**
 * A fork that missed the cache (anthropics/claude-code#100083) costs about a
 * full re-cache, and a fork that hit but didn't extend the main entry's TTL
 * buys nothing. Either benches automatic pings, in every session, until
 * Claude Code's version changes. A manual `/keepwarm now` hit lifts a miss.
 */
async function isBenched($: EngineInterface) {
  const version = (await $.session.version()).version
  const miss = (await $.store.get('forkMiss')) as { version?: string } | undefined
  const refreshFail = (await $.store.get('refreshFail')) as { version?: string } | undefined
  return miss?.version === version || refreshFail?.version === version
}

/**
 * Judges the first request of the first real turn after a pinged break longer
 * than the TTL: had the pings not refreshed the main entry, it re-writes most
 * of the context. Only the first request counts; later ones in the turn write
 * what the turn added.
 */
async function verifyRefresh($: EngineInterface, probe: NonNullable<Session['probe']>, usage: ModelUsage) {
  const verdict = usage.cache_creation_input_tokens < 0.5 * probe.contextTokens ? 'warm' : 'cold'
  const version = (await $.session.version()).version
  await appendLog($, {
    kind: 'verify',
    verdict,
    ...probe,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
    version,
  })
  const at = await $.clock.now()
  if (verdict === 'cold') {
    await $.store.set('refreshFail', { version, at })
    $.ui.toast('cache-keeper: pings did not keep the cache warm on this version; automatic pings paused')
  } else {
    await $.store.set('refreshVerified', { version, at })
  }
}

/** Pings once. A manual ping's error doesn't count toward the automatic retry. */
async function ping($: EngineInterface, isManual = false): Promise<PingRecord> {
  isPinging = true
  try {
    const before = await $.session.usage()
    const result = await $.model.fork({ prompt: PING_PROMPT })
    const now = await $.clock.now()
    const after = await $.session.usage()
    // Usage that counted a prompt says whether the cache served the fork,
    // whatever ended it. An api-error whose one request was refused carries
    // all zeros: that's an error, not a miss.
    const counted: ModelUsage | undefined = 'usage' in result ? result.usage : undefined
    const prompt = counted
      ? counted.cache_read_input_tokens + counted.cache_creation_input_tokens + counted.input_tokens
      : 0
    const usage = prompt > 0 ? counted : undefined
    const outcome = usage ? classifyPing(usage) : 'error'
    const record: PingRecord = {
      at: now,
      outcome,
      cacheRead: usage?.cache_read_input_tokens ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0,
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      ...(result.isAnswered ? {} : { detail: result.reason }),
    }
    const s = await update($, sessionAtom, cur => ({
      ...cur,
      lastPing: record,
      pingErrors: outcome !== 'error' ? 0 : isManual ? cur.pingErrors : cur.pingErrors + 1,
      ...(outcome === 'hit' ? { lastRequestAt: now, pings: cur.pings + 1, stopReason: null } : {}),
    }))
    await appendLog($, {
      kind: 'ping',
      ...record,
      ping: s.pings,
      idleMinutes: s.lastTurnAt === null ? null : Math.round((now - s.lastTurnAt) / MIN),
      contextTokens: before.context.tokens ?? null,
      limitsBefore: limitsOf(before),
      limitsAfter: limitsOf(after),
      costBefore: before.cost?.usd ?? null,
      costAfter: after.cost?.usd ?? null,
    })
    if (outcome === 'miss') {
      await $.store.set('forkMiss', {
        version: (await $.session.version()).version,
        at: now,
        cacheRead: record.cacheRead,
        cacheWrite: record.cacheWrite,
      })
    } else if (outcome === 'hit') {
      await $.store.delete('forkMiss')
    }
    if (outcome === 'hit') $.ui.toast(`cache-keeper: kept ${kTokens(record.cacheRead)} cached (ping ${s.pings})`)
    return record
  } finally {
    isPinging = false
  }
}

/** Decides what the session's cache needs now and acts: wait, ping, or stop. */
async function schedule($: EngineInterface): Promise<void> {
  cancelTimer()
  if (!isActive || isPinging) return

  const s = await read($, sessionAtom)
  const now = await $.clock.now()
  const usage = await $.session.usage()
  const d = decide(s, now, { contextTokens: usage.context.tokens ?? 0 }, config)

  switch (d.action) {
    case 'idle':
      $.ui.status(undefined)
      return
    case 'wait':
      if (s.stopReason !== null) await update($, sessionAtom, cur => ({ ...cur, stopReason: null }))
      $.ui.status(`cache warm until ${hhmm(d.at + config.leadMs)} · keep-alive ${hhmm(d.at)}`)
      timer = $.clock.after(d.at - now, () => void schedule($))
      return
    case 'stop':
      await stop($, d.reason)
      return
    case 'ping': {
      if (await isBenched($)) {
        await stop($, 'fork-miss-on-this-version')
        return
      }
      const r = await ping($)
      if (r.outcome === 'hit') return schedule($)
      // One retry for a transient failure (an overloaded API, a dropped connection).
      if (r.outcome === 'error' && (await read($, sessionAtom)).pingErrors < 2) return retryLater($, r)
      await stop($, r.outcome === 'miss' ? 'cache-miss' : 'error', { detail: r.detail ?? null })
      return
    }
  }
}

/** After a failed ping: tries again at retryAt, or stops when the cache would lapse first. */
async function retryLater($: EngineInterface, r: PingRecord) {
  const now = await $.clock.now()
  const at = retryAt(await read($, sessionAtom), now, config)
  if (at === null) return stop($, 'error', { detail: r.detail ?? null })
  $.ui.status(`cache-keeper: ping failed, retrying at ${hhmm(at)}`)
  timer = $.clock.after(at - now, () => void schedule($))
}

async function statusText($: EngineInterface) {
  const s = await read($, sessionAtom)
  const now = await $.clock.now()
  const parts = [`keep-warm ${s.mode}${s.mode === 'auto' ? (config.enabled ? ' (on)' : ' (off)') : ''}`]
  if (s.lastRequestAt !== null) {
    const expiresAt = s.lastRequestAt + config.ttlMs
    parts.push(now < expiresAt ? `cache warm until ${hhmm(expiresAt)}` : `cache likely cold since ${hhmm(expiresAt)}`)
    if (timer !== null) parts.push(`next ping ${hhmm(expiresAt - config.leadMs)}`)
  }
  if (s.untilMs !== null && s.untilMs > now) parts.push(`keeping warm until ${hhmm(s.untilMs)}`)
  parts.push(`${s.pings} ping${s.pings === 1 ? '' : 's'} since last turn`)
  if (s.lastPing) {
    parts.push(`last ping ${hhmm(s.lastPing.at)} ${s.lastPing.outcome} (${kTokens(s.lastPing.cacheRead)} cached)`)
  }
  if (s.stopReason) parts.push(`stopped: ${s.stopReason}`)
  return parts.join(' · ')
}

export const register: Register = (on, options) => {
  config = configFrom(options)
  isActive = false
  isPinging = false
  timer = null

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    isActive = e.isInteractive
    if (!isActive) return result
    await $.command.register({
      name: 'keepwarm',
      description: 'Prompt-cache keep-alive: status, on, off, auto, now, for <n>h, until HH:MM',
      argumentHint: '[status|on|off|auto|now|for 3h|until 18:00]',
    })
    // Spread over INITIAL so state saved by an older version gains the fields added since.
    await update($, sessionAtom, s => ({ ...INITIAL, ...s, isTurnRunning: false, turnId: null }))
    await schedule($)
    return result
  })

  on('turn.start', async ($, e, next) => {
    cancelTimer()
    const now = await $.clock.now()
    const s = await read($, sessionAtom)
    const isProbe =
      s.pings > 0 &&
      !s.isCompacted &&
      s.lastTurnAt !== null &&
      s.lastRequestAt !== null &&
      now - s.lastTurnAt > config.ttlMs &&
      now - s.lastRequestAt < config.ttlMs
    const probe = isProbe
      ? {
          contextTokens: (await $.session.usage()).context.tokens ?? 0,
          idleMinutes: Math.round((now - (s.lastTurnAt ?? now)) / MIN),
          pings: s.pings,
        }
      : null
    await update($, sessionAtom, cur => ({ ...cur, isTurnRunning: true, turnId: e.turnId, probe }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined) return result
    try {
      const s = await read($, sessionAtom)
      if (s.turnId !== e.turnId) return result
      if (s.isCompacted) await update($, sessionAtom, cur => ({ ...cur, isCompacted: false }))
      if (e.index === 0 && s.probe !== null) {
        await update($, sessionAtom, cur => ({ ...cur, probe: null }))
        if (result.usage !== null) await verifyRefresh($, s.probe, result.usage)
      }
    } catch {
      // The check is best effort; never fail the turn over it.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    // A ping's fork may raise a turn.complete of its own: while one runs, only
    // the main turn whose start this module saw counts.
    const { turnId } = await read($, sessionAtom)
    if (isPinging && e.turnId !== turnId) return result
    const now = await $.clock.now()
    await update($, sessionAtom, s => ({
      ...s,
      probe: null,
      isTurnRunning: false,
      turnId: null,
      lastRequestAt: now,
      lastTurnAt: now,
      pings: 0,
      pingErrors: 0,
      untilMs: s.untilMs !== null && s.untilMs <= now ? null : s.untilMs,
    }))
    await schedule($)
    return result
  })

  // A compaction replaces the conversation: the next request shares no cached
  // prefix with the last one, so there is nothing to keep warm, and its first
  // request can't show whether pings worked. A precompute installs nothing.
  // This hook and the next only observe: on a failure, `.catch` lets the event
  // go on as it settled.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || result.messages === undefined) return result
    await update($, sessionAtom, s => ({ ...s, isCompacted: true, probe: null }))
    await schedule($)
    return result
  }).catch(($, e, next) => next(e))

  // A new model has no cache entry until its first request, and a fork before
  // then would miss and bench pings. The engine also says the cache's TTL here.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id !== undefined) return result
    const isNewModel = e.from_model !== e.to_model
    await update($, sessionAtom, s => ({
      ...s,
      cacheTtl: e.cache_ttl,
      ...(isNewModel ? { lastRequestAt: null, probe: null } : {}),
    }))
    await schedule($)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const cmd = parseKeepwarmArgs(e.args, await $.clock.now(), new Date().getTimezoneOffset())
    switch (cmd.kind) {
      case 'error':
        return { text: cmd.message }
      case 'status':
        return { text: await statusText($) }
      case 'mode':
        await update($, sessionAtom, s => ({ ...s, mode: cmd.mode, untilMs: null }))
        await schedule($)
        return { text: `Keep-warm ${cmd.mode}. ${await statusText($)}` }
      case 'until':
        await update($, sessionAtom, s => ({ ...s, untilMs: cmd.untilMs }))
        await schedule($)
        return { text: `Keeping warm until ${hhmm(cmd.untilMs)}. ${await statusText($)}` }
      case 'now': {
        // After a model switch or compaction a fork would re-write the context
        // and read as a miss, benching pings everywhere.
        const s = await read($, sessionAtom)
        if (s.lastRequestAt === null || s.isCompacted) {
          return { text: 'Nothing cached to keep warm yet: the next turn caches the conversation.' }
        }
        cancelTimer()
        const r = await ping($, true)
        const now = await $.clock.now()
        if (r.outcome === 'miss') await stop($, 'cache-miss', { detail: r.detail ?? null })
        // Inside the ping window, an error waits for the retry rather than pinging again at once.
        else if (r.outcome === 'error' && now >= s.lastRequestAt + config.ttlMs - config.leadMs) await retryLater($, r)
        else await schedule($)
        return {
          text: `Ping ${r.outcome}: ${kTokens(r.cacheRead)} read from cache, ${kTokens(r.cacheWrite)} written, ${r.output} output tokens.`,
        }
      }
    }
  })
}
