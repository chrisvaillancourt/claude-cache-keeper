import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, PluginOptions, Register, SessionUsage, Timer } from 'claude-code'

import { classifyPing, decide, parseKeepwarmArgs } from './policy'
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
  pings: 0,
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
    maxLimitPercent: num(options.maxLimitPercent, 85),
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

async function stop($: EngineInterface, reason: string, extra: Record<string, unknown> = {}) {
  const s = await read($, sessionAtom)
  if (s.stopReason !== reason) {
    await update($, sessionAtom, cur => ({ ...cur, stopReason: reason }))
    await appendLog($, { kind: 'stop', reason, pings: s.pings, ...extra })
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
 * Judges the first real turn after a pinged break longer than the TTL: had the
 * pings not refreshed the main entry, that turn re-writes most of the context.
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

async function ping($: EngineInterface): Promise<PingRecord> {
  isPinging = true
  try {
    const before = await $.session.usage()
    const result = await $.model.fork({ prompt: PING_PROMPT })
    const now = await $.clock.now()
    const after = await $.session.usage()
    const usage: ModelUsage | undefined = 'usage' in result ? result.usage : undefined
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
    if (outcome === 'hit') {
      $.ui.toast(`cache-keeper: kept ${kTokens(record.cacheRead)} cached (ping ${s.pings})`)
    } else {
      await stop($, outcome === 'miss' ? 'cache-miss' : 'error', { detail: record.detail ?? null })
    }
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
  const d = decide(s, now, { contextTokens: usage.context.tokens ?? 0, limits: limitsOf(usage) }, config)

  switch (d.action) {
    case 'idle':
      $.ui.status(undefined)
      return
    case 'wait':
      $.ui.status(`cache warm until ${hhmm(d.at + config.leadMs)} · keep-alive ${hhmm(d.at)}`)
      timer = $.clock.after(d.at - now, () => void schedule($))
      return
    case 'stop':
      await stop($, d.reason)
      return
    case 'ping':
      if (await isBenched($)) {
        await stop($, 'fork-miss-on-this-version')
        return
      }
      if ((await ping($)).outcome === 'hit') await schedule($)
      return
  }
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
  if (s.untilMs !== null) parts.push(`keeping warm until ${hhmm(s.untilMs)}`)
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
    await update($, sessionAtom, s => ({ ...s, isTurnRunning: false }))
    await schedule($)
    return result
  })

  on('turn.start', async ($, e, next) => {
    cancelTimer()
    const now = await $.clock.now()
    const s = await read($, sessionAtom)
    const isProbe =
      s.pings > 0 &&
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
    await update($, sessionAtom, cur => ({ ...cur, isTurnRunning: true, probe }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || isPinging) return result
    const now = await $.clock.now()
    const { probe } = await read($, sessionAtom)
    if (probe && e.usage !== undefined) await verifyRefresh($, probe, e.usage)
    await update($, sessionAtom, s => ({
      ...s,
      probe: null,
      isTurnRunning: false,
      lastRequestAt: now,
      lastTurnAt: now,
      pings: 0,
      stopReason: null,
    }))
    await schedule($)
    return result
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const cmd = parseKeepwarmArgs(e.args, await $.clock.now(), new Date().getTimezoneOffset())
    switch (cmd.kind) {
      case 'error':
        return { text: cmd.message }
      case 'status':
        return { text: await statusText($) }
      case 'mode':
        await update($, sessionAtom, s => ({ ...s, mode: cmd.mode, stopReason: null }))
        await schedule($)
        return { text: `Keep-warm ${cmd.mode}. ${await statusText($)}` }
      case 'until':
        await update($, sessionAtom, s => ({ ...s, mode: 'on' as const, untilMs: cmd.untilMs, stopReason: null }))
        await schedule($)
        return { text: `Keeping warm until ${hhmm(cmd.untilMs)}. ${await statusText($)}` }
      case 'now': {
        cancelTimer()
        const r = await ping($)
        if (r.outcome === 'hit') await schedule($)
        return {
          text: `Ping ${r.outcome}: ${kTokens(r.cacheRead)} read from cache, ${kTokens(r.cacheWrite)} written, ${r.output} output tokens.`,
        }
      }
    }
  })
}
