import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CacheTtl } from '../types'

const TAIL_BYTES = 1024 * 1024
const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const
const FAST_BELOW_MS = 2 * 60_000
const SLOW_STEP_MS = 15_000
const SLOWER_ABOVE_MS = 10 * 60_000
const SLOWER_STEP_MS = 30_000

const lastRequestAt = atom({ plugin: 'cache-expiry-notifier', key: 'lastRequestAt' } as const, null as number | null)
const detectedTtl   = atom({ plugin: 'cache-expiry-notifier', key: 'detectedTtl'   } as const, null as CacheTtl | null)
const notifiedAt    = atom({ plugin: 'cache-expiry-notifier', key: 'notifiedAt'    } as const, null as number | null)

// Module-level timer state — lost on hot reload, re-armed in session.start
let tick: Timer | undefined
let armedFor: number | null = null

export const register: Register = (on, options) => {
  const override: CacheTtl | null =
    options.cacheTtl === '5m' || options.cacheTtl === '1h' ? options.cacheTtl : null
  const warnMinutes: number = typeof options.warnMinutes === 'number' ? options.warnMinutes : 10
  const minTokens: number   = typeof options.minTokens   === 'number' ? options.minTokens   : 50_000

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if ((await read($, detectedTtl)) === null) {
      const known = await $.store.get('detectedTtl').catch(() => undefined)
      if (known === '5m' || known === '1h') await update($, detectedTtl, () => known)
    }
    const since = await read($, lastRequestAt)
    if (since !== null) {
      const now = await $.clock.now()
      await restartTimer($, since, now, await ttlMsFor($, override), warnMinutes)
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      stop()
      await update($, lastRequestAt, () => null)
      await update($, notifiedAt,    () => null)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result.stopReason !== null) {
      const now = await $.clock.now()
      await update($, lastRequestAt, () => now)
      const { context } = await $.session.usage()
      if ((context?.tokens ?? 0) >= minTokens) {
        await restartTimer($, now, now, await ttlMsFor($, override), warnMinutes)
      } else {
        stop() // session too small — cancel any running timer
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && override === null) {
      const found = ttlFromTranscript(await readTail($))
      if (found !== null) await detectTtl($, found, warnMinutes)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const since = await read($, lastRequestAt)
    if (since === null) return rest
    const { context } = await $.session.usage()
    if ((context?.tokens ?? 0) < minTokens) return rest

    const now    = await $.clock.now()
    const ttlMs  = await ttlMsFor($, override)
    const left   = since + ttlMs - now
    const warnMs = warnMinutes * 60_000

    if (left > warnMs) return rest

    const { Box, Text } = $.ui.resolve(e)

    if (left <= 0) {
      return (
        <Box flexDirection="column">
          <Box paddingX={1}>
            <Text color="red">{'❄ Cache cold — next turn re-caches'}</Text>
          </Box>
          {rest}
        </Box>
      ) as any
    }

    const secs = Math.ceil(left / 1000)
    const countdown = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

    return (
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text color="yellow">{`⚠ Cache expires in ${countdown} — send a turn to refresh`}</Text>
        </Box>
        {rest}
      </Box>
    ) as any
  })
}

// --- Module-level helpers (all functions that receive $ must be top-level declarations) ---

function stop() {
  tick?.cancel()
  tick = undefined
  armedFor = null
}

async function ttlMsFor($: EngineInterface, override: CacheTtl | null): Promise<number> {
  return TTL_MS[override ?? (await read($, detectedTtl)) ?? '5m']
}

async function detectTtl($: EngineInterface, ttl: CacheTtl, warnMinutes: number) {
  // Only called when override === null (guarded at call site), so TTL_MS[ttl] is always correct.
  if ((await read($, detectedTtl)) === ttl) return
  await update($, detectedTtl, () => ttl)
  await $.store.set('detectedTtl', ttl).catch(() => {})
  const now = await $.clock.now()
  const since = await read($, lastRequestAt)
  if (since !== null) await restartTimer($, since, now, TTL_MS[ttl], warnMinutes)
}

async function restartTimer($: EngineInterface, since: number, now: number, ttlMs: number, warnMinutes: number) {
  const warnMs   = warnMinutes * 60_000
  const warnAt   = since + ttlMs - warnMs
  const expiryAt = since + ttlMs
  stop()
  armedFor = since
  if (now < warnAt) {
    tick = $.clock.after(warnAt - now, () => {
      $.clock.now().then(t => onWarn($, since, t, ttlMs, warnMinutes)).catch(() => {})
    })
  } else if (now < expiryAt) {
    await onWarn($, since, now, ttlMs, warnMinutes)
  } else {
    $.ui.invalidate('ui.render')
  }
}

async function onWarn($: EngineInterface, since: number, now: number, ttlMs: number, warnMinutes: number) {
  $.ui.invalidate('ui.render') // immediately show the warning band before anything else
  const lastNotified = await read($, notifiedAt)
  if (lastNotified !== null && lastNotified >= since) {
    arm($, since, now, ttlMs)
    return
  }
  await update($, notifiedAt, () => now)
  $.ui.toast(`⚠ Cache expires in ${warnMinutes}m — send a turn to stay warm`)
  await $.process.run([
    'osascript', '-e',
    `display notification "Cache expires in ${warnMinutes} minutes — send a turn to refresh" with title "Claude Code" subtitle "Prompt cache expiring soon"`,
  ]).catch(() => {})
  arm($, since, now, ttlMs)
}

function arm($: EngineInterface, since: number, now: number, ttlMs: number) {
  if (armedFor !== since) return
  tick?.cancel()
  const left = since + ttlMs - now
  if (left <= 0) {
    $.ui.invalidate('ui.render')
    return
  }
  const isFast = left <= FAST_BELOW_MS
  const step   = isFast ? 1_000 : left > SLOWER_ABOVE_MS ? SLOWER_STEP_MS : SLOW_STEP_MS
  tick = $.clock.after(step, () => {
    $.ui.invalidate('ui.render')
    $.clock.now().then(t => arm($, since, t, ttlMs)).catch(() => {})
  })
}

async function readTail($: EngineInterface): Promise<string> {
  try {
    const path = await transcriptPath($)
    if (path === null) return ''
    const { size } = await $.fs.stat(path)
    if (size <= TAIL_BYTES) return await $.fs.read(path)
    const { exitCode, stdout } = await $.process.run(['tail', '-c', String(TAIL_BYTES), path])
    return exitCode === 0 ? stdout : ''
  } catch {
    return ''
  }
}

async function transcriptPath($: EngineInterface): Promise<string | null> {
  const home      = await $.env.get('HOME')
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : undefined)
  if (!configDir) return null
  const project = (await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')
  return `${configDir}/projects/${project}/${await $.session.id()}.jsonl`
}

function ttlFromTranscript(text: string): CacheTtl | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown
    try { entry = JSON.parse(lines[i] ?? '') } catch { continue }
    const msg = entry as {
      type?: string
      isSidechain?: boolean
      message?: { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } }
    }
    if (msg?.type !== 'assistant' || msg.isSidechain || !msg.message?.usage) continue
    const written = msg.message.usage.cache_creation
    if (Number(written?.ephemeral_1h_input_tokens) > 0) return '1h'
    if (Number(written?.ephemeral_5m_input_tokens) > 0) return '5m'
    return null
  }
  return null
}
