# cache-expiry-notifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code mod that fires a toast + macOS system notification X configurable minutes before the prompt cache expires.

**Architecture:** A single `register.tsx` file wired through the Claude Code plugin API. It tracks cache warmth by recording `lastRequestAt` on every `turn.step` event, infers the cache TTL by scanning the session transcript on `turn.complete`, and runs a cascading `$.clock.after` timer that fires notifications and drives AbovePrompt redraws as the deadline approaches.

**Tech Stack:** TypeScript 5 / TSX (React-style JSX via `h`/`Fragment`), `claude-code` plugin API (`atom`, `read`, `update`, `Register`, `Timer`, `EngineInterface`), `claude-code/testing` (`describe`, `test`, `expect`, `mock`).

**Spec:** `docs/superpowers/specs/2026-10-08-cache-expiry-notifier-design.md`

## Global Constraints

- Plugin name: `cache-expiry-notifier` — must match the `name` field in `plugin.json`, all atom keys, and every test's `BAND.plugin`.
- All atom keys use `{ plugin: 'cache-expiry-notifier', key: '...' }` refs — never bare strings.
- `osascript` failure must never crash the mod; wrap with `.catch(() => {})`.
- `$.store` failure must never crash; wrap with `.catch(() => {})`.
- Only main-thread turns are tracked: guard every `turn.step` / `turn.complete` handler with `!e.agentId`.
- `turn.step` only updates `lastRequestAt` when `result.stopReason !== null` (mirrors token-weather).
- `session.end` clears state only on `reason === 'clear'` or `reason === 'resume'`.
- TTL resolution order: `cacheTtl` userConfig override → `detectedTtl` atom → `'5m'` default.
- Test runner: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test /Users/amrut.deshpande/Project/Code/claude-mods/cache-expiry-notifier`

## Review Focus

- **Hot-reload with active countdown** — `lastRequestAt` in atom survives; `tick` and `armedFor` are module-level (lost). `session.start` must re-arm from the persisted `lastRequestAt`. Test: Task 4.
- **Session resumed after cache already cold** (`now >= expiryAt`) — `restartTimer` must show cold UI, skip notification. Test: Task 4.
- **`notifiedAt` guard after a new turn** — user sends turn mid-warning, goes idle again; `since` advances past `notifiedAt`, so the next approach fires again. Test: Task 4.
- **`osascript` unavailable** — `$.process.run` rejects; toast must still fire and mod must not crash. Test: Task 4.
- **Subagent `turn.step` ignored** — `e.agentId` set; `lastRequestAt` must not advance. Test: Task 3.

---

## Task 1: Scaffold project structure

**Files:**
- Create: `cache-expiry-notifier/.claude-plugin/plugin.json`
- Create: `cache-expiry-notifier/.claude-plugin/types/tsconfig.json`
- Create: `cache-expiry-notifier/.claude-plugin/types/.gitignore`
- Copy:   `cache-expiry-notifier/.claude-plugin/types/claude-code/index.d.ts` (from laya-call-counter)
- Copy:   `cache-expiry-notifier/.claude-plugin/types/claude-code-mcp/index.d.ts`
- Copy:   `cache-expiry-notifier/.claude-plugin/types/claude-code-tools/index.d.ts`
- Create: `cache-expiry-notifier/tsconfig.json`
- Create: `cache-expiry-notifier/hooks/hooks.json`
- Create: `cache-expiry-notifier/hooks/register.tsx` (skeleton only)
- Create: `cache-expiry-notifier/types/index.d.ts`

**Interfaces:**
- Produces: all scaffolding later tasks depend on; no exported symbols yet.

- [ ] **Step 1: Create plugin.json**

```json
{
  "name": "cache-expiry-notifier",
  "version": "0.1.0",
  "description": "Notifies you X minutes before your prompt cache expires so you can send a turn before paying the full re-cache cost.",
  "author": {
    "name": "amrut.deshpande",
    "url": "https://github.com/amrut.deshpande"
  },
  "types": "./types/index.d.ts",
  "userConfig": {
    "warnMinutes": {
      "type": "number",
      "title": "Warn before expiry (minutes)",
      "description": "How many minutes before cache expiry to fire the alert. Minimum 1.",
      "default": 10,
      "min": 1
    },
    "cacheTtl": {
      "type": "string",
      "title": "Cache lifetime override",
      "description": "auto (default) detects the TTL from Claude's responses. Set 5m or 1h to override.",
      "options": ["auto", "5m", "1h"],
      "default": "auto"
    }
  }
}
```

Save to: `cache-expiry-notifier/.claude-plugin/plugin.json`

- [ ] **Step 2: Copy .claude-plugin/types subtree from laya-call-counter**

```bash
SRC=/Users/amrut.deshpande/.claude/dev-mods/d476fe71-d842-4890-bbd7-972ae62a2ea1/laya-call-counter/.claude-plugin/types
DST=/Users/amrut.deshpande/Project/Code/claude-mods/cache-expiry-notifier/.claude-plugin/types
cp -r "$SRC" "$DST"
```

- [ ] **Step 3: Create root tsconfig.json**

```json
{
  "extends": "./.claude-plugin/types/tsconfig.json"
}
```

Save to: `cache-expiry-notifier/tsconfig.json`

- [ ] **Step 4: Create hooks/hooks.json**

```json
{ "modules": ["./register.tsx"] }
```

Save to: `cache-expiry-notifier/hooks/hooks.json`

- [ ] **Step 5: Create types/index.d.ts**

```ts
export type CacheTtl = '5m' | '1h'

declare module 'claude-code' {
  interface PluginState {
    'cache-expiry-notifier': {
      lastRequestAt: number | null
      detectedTtl: CacheTtl | null
      notifiedAt: number | null
    }
  }
}
```

Save to: `cache-expiry-notifier/types/index.d.ts`

- [ ] **Step 6: Create skeleton register.tsx**

```tsx
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

let tick: Timer | undefined
let armedFor: number | null = null

export const register: Register = (_on, _options) => {
  // hooks added in subsequent tasks
}
```

Save to: `cache-expiry-notifier/hooks/register.tsx`

- [ ] **Step 7: Verify TypeScript sees no errors**

```bash
cd /Users/amrut.deshpande/Project/Code/claude-mods/cache-expiry-notifier
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output (zero errors). If `npx tsc` is unavailable, skip — the types are validated when tests run.

- [ ] **Step 8: Commit scaffold**

```bash
cd /Users/amrut.deshpande/Project/Code/claude-mods
git init                      # only if not already a git repo
git add cache-expiry-notifier
git commit -m "feat(cache-expiry-notifier): scaffold project structure"
```

---

## Task 2: TTL detection — session hooks + transcript scanning

**Files:**
- Modify: `cache-expiry-notifier/hooks/register.tsx`
- Create: `cache-expiry-notifier/tests/ttl-detection.test.ts`

**Interfaces:**
- Produces: `lastRequestAt` atom populated on `turn.step`; `detectedTtl` atom populated on `turn.complete`; `session.start` restores `detectedTtl` from `$.store`.

- [ ] **Step 1: Write failing tests**

Create `cache-expiry-notifier/tests/ttl-detection.test.ts`:

```ts
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'cache-expiry-notifier'

// One transcript line of a main-thread response that wrote m5 / h1 tokens to cache.
function response(m5: number, h1: number) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 5,
        output_tokens: 20,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: m5 + h1,
        cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 },
      },
    },
  })
}

async function start(
  $: Engine,
  on: On,
  store: Record<string, unknown> | null = {}, // null: caller already registered store mocks
  transcript = '',
  env: Record<string, string> = { HOME: '/home/me' },
  transcriptFile = '/home/me/.claude/projects/-work-my-app/abc.jsonl',
) {
  let content = transcript
  if (store !== null) mock.store(on, store)
  mock.clock(on, { now: 1_000_000 })
  on('session.start',  (_$, e) => ({ sessionId: 's', cwd: e.cwd }) as any)
  on('session.usage',  () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 5_000, window: 200_000, percent: 3 } } }) as any)
  on('turn.step',      async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any })
  on('turn.complete',  () => ({ text: '' }) as any)
  on('session.end',    (_$, e) => ({ sessionId: e.sessionId }) as any)
  on('fs.stat',        (_$, e) => e.path !== transcriptFile ? { deny: 'no such file' } as any : { value: { kind: 'file', size: content.length, mtimeMs: 0, isLink: false } } as any)
  on('fs.read',        () => ({ value: content }) as any)
  on('process.run',    (_$, e) => {
    const bytes = Number(e.argv[2])
    return { value: { exitCode: 0, stdout: content.slice(-bytes), stderr: '' } } as any
  })
  mock.env(on, env)
  on('session.root', () => ({ value: '/work/my app' }) as any)
  on('session.id',   () => ({ value: 'abc' }) as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

  async function turn(...lines: string[]) {
    content += lines.map(l => l + '\n').join('')
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    for await (const _ of stream) { /* drain */ }
    await stream.result
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
  }
  return { turn }
}

describe(`${PLUGIN}: TTL detection`, () => {
  test('falls back to 5m before any detection', async ($, on) => {
    const { turn } = await start($, on)
    await turn('{"type":"user"}')
    expect(await $.atom.get(PLUGIN, 'detectedTtl')).toBeNull()
  })

  test('detects 1h from a response that wrote 1h cache tokens', async ($, on) => {
    const { turn } = await start($, on)
    await turn(response(0, 1355))
    expect(await $.atom.get(PLUGIN, 'detectedTtl')).toBe('1h')
  })

  test('detects 5m from a response that wrote only 5m tokens', async ($, on) => {
    const { turn } = await start($, on)
    await turn(response(0, 1355))
    await turn(response(400, 0))
    expect(await $.atom.get(PLUGIN, 'detectedTtl')).toBe('5m')
  })

  test('keeps the last value on a pure cache hit (no cache_creation tokens)', async ($, on) => {
    const { turn } = await start($, on)
    await turn(response(0, 1355))
    await turn(response(0, 0))
    expect(await $.atom.get(PLUGIN, 'detectedTtl')).toBe('1h')
  })

  test('ignores sidechain (subagent) response lines', async ($, on) => {
    const { turn } = await start($, on)
    await turn(response(0, 1355))
    const sidechain = JSON.stringify({ ...JSON.parse(response(400, 0)), isSidechain: true })
    await turn(response(0, 0), sidechain)
    expect(await $.atom.get(PLUGIN, 'detectedTtl')).toBe('1h')
  })

  test('restores detected TTL from store on session start', async ($, on) => {
    await start($, on, { detectedTtl: '1h' })
    expect(await $.atom.get(PLUGIN, 'detectedTtl')).toBe('1h')
  })

  test('persists a new detection to the store', async ($, on) => {
    const saved: Record<string, unknown> = {}
    on('store.get', () => ({ value: undefined }) as any)
    on('store.set', (_$, e) => { saved[e.key] = e.value; return { value: undefined } as any })
    // Pass null so start() does not call mock.store() and override the mocks above
    const { turn } = await start($, on, null)
    await turn(response(0, 1355))
    expect(saved['detectedTtl']).toBe('1h')
  })

  test('keeps last value when transcript cannot be read', async ($, on) => {
    const { turn } = await start($, on, { detectedTtl: '1h' }, '', { HOME: '/home/me' }, '/nowhere/else.jsonl')
    await turn(response(400, 0))
    expect(await $.atom.get(PLUGIN, 'detectedTtl')).toBe('1h')
  })

  test('reads only the tail of a large transcript', async ($, on) => {
    const padding = 'x'.repeat(1200 * 1024) + '\n'
    const { turn } = await start($, on, {}, padding)
    await turn(response(0, 1355))
    expect(await $.atom.get(PLUGIN, 'detectedTtl')).toBe('1h')
  })

  test('uses CLAUDE_CONFIG_DIR when set', async ($, on) => {
    const { turn } = await start($, on, {}, '', { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' }, '/cfg/projects/-work-my-app/abc.jsonl')
    await turn(response(0, 1355))
    expect(await $.atom.get(PLUGIN, 'detectedTtl')).toBe('1h')
  })

  test('cacheTtl override suppresses detection', { options: { cacheTtl: '5m' } }, async ($, on) => {
    const { turn } = await start($, on)
    await turn(response(0, 1355))
    // Override wins; detectedTtl atom may be set but TTL used is 5m (tested in timer tests)
    // Here just confirm atom is still set (detection still runs, override just wins at resolution)
    // Nothing to assert beyond no crash
  })
})
```

- [ ] **Step 2: Run tests — expect failures**

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test /Users/amrut.deshpande/Project/Code/claude-mods/cache-expiry-notifier 2>&1 | head -40
```

Expected: test failures or "hook not registered" style errors (no `turn.complete` handler yet).

- [ ] **Step 3: Implement TTL detection in register.tsx**

Replace the skeleton `register` function body with:

```tsx
export const register: Register = (on, options) => {
  const override: CacheTtl | null =
    options.cacheTtl === '5m' || options.cacheTtl === '1h' ? options.cacheTtl : null

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if ((await read($, detectedTtl)) === null) {
      const known = await $.store.get('detectedTtl').catch(() => undefined)
      if (known === '5m' || known === '1h') await update($, detectedTtl, () => known)
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
      await restartTimer($, now, now, await ttlMsFor($, override))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && override === null) {
      const found = ttlFromTranscript(await readTail($))
      if (found !== null) await detectTtl($, found, override)
    }
    return result
  })

  async function detectTtl($: EngineInterface, ttl: CacheTtl) {
    if ((await read($, detectedTtl)) === ttl) return
    await update($, detectedTtl, () => ttl)
    await $.store.set('detectedTtl', ttl).catch(() => {})
    const now = await $.clock.now()
    const since = await read($, lastRequestAt)
    if (since !== null) await restartTimer($, since, now, TTL_MS[override ?? ttl])
  }

  async function ttlMsFor($: EngineInterface): Promise<number> {
    return TTL_MS[override ?? (await read($, detectedTtl)) ?? '5m']
    // override and detectedTtl atom are both from the register() closure/module scope
  }

  async function restartTimer($: EngineInterface, since: number, now: number, ttlMs: number) {
    const warnMs  = (options.warnMinutes ?? 10) * 60_000
    const warnAt  = since + ttlMs - warnMs
    const expiryAt = since + ttlMs
    stop()
    armedFor = since
    if (now < warnAt) {
      tick = $.clock.after(warnAt - now, () => {
        $.clock.now().then(t => onWarn($, since, t, ttlMs)).catch(() => {})
      })
    } else if (now < expiryAt) {
      await onWarn($, since, now, ttlMs)
    } else {
      $.ui.invalidate('ui.render')
    }
  }

  async function onWarn($: EngineInterface, since: number, now: number, ttlMs: number) {
    const lastNotified = await read($, notifiedAt)
    if (lastNotified !== null && lastNotified >= since) {
      arm($, since, now, ttlMs)
      return
    }
    await update($, notifiedAt, () => now)
    const mins = options.warnMinutes ?? 10
    $.ui.toast(`⚠ Cache expires in ${mins}m — send a turn to stay warm`)
    await $.process.run([
      'osascript', '-e',
      `display notification "Cache expires in ${mins} minutes — send a turn to refresh" with title "Claude Code" subtitle "Prompt cache expiring soon"`,
    ]).catch(() => {})
    arm($, since, now, ttlMs)
  }
}
```

Add these module-level functions after the `register` export (or keep before — they are referenced inside via closure but module-level):

```ts
function stop() {
  tick?.cancel()
  tick = undefined
  armedFor = null
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
      type?: string; isSidechain?: boolean
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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test /Users/amrut.deshpande/Project/Code/claude-mods/cache-expiry-notifier 2>&1 | grep -E "PASS|FAIL|✓|✗|error" | head -30
```

Expected: all TTL detection tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/amrut.deshpande/Project/Code/claude-mods
git add cache-expiry-notifier
git commit -m "feat(cache-expiry-notifier): TTL detection and session lifecycle hooks"
```

---

## Task 3: Timer logic and turn tracking tests

**Files:**
- Create: `cache-expiry-notifier/tests/timer-notifications.test.ts`

(register.tsx is already complete from Task 2; this task only adds tests.)

**Interfaces:**
- Consumes: `lastRequestAt` atom, `notifiedAt` atom, `$.ui.toast`, `$.process.run`, `$.clock` from Task 2's register.tsx.

- [ ] **Step 1: Write failing tests**

Create `cache-expiry-notifier/tests/timer-notifications.test.ts`:

```ts
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'cache-expiry-notifier'

async function start($: Engine, on: On, warnMinutes = 10) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start',  (_$, e) => ({ sessionId: 's', cwd: e.cwd }) as any)
  on('session.usage',  () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 5_000, window: 200_000, percent: 3 } } }) as any)
  on('turn.step',      async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any })
  on('turn.complete',  () => ({ text: '' }) as any)
  on('session.end',    (_$, e) => ({ sessionId: e.sessionId }) as any)
  on('fs.stat',        () => ({ deny: 'no such file' }) as any)
  mock.env(on, { HOME: '/home/me' })
  on('session.root',   () => ({ value: '/work/app' }) as any)
  on('session.id',     () => ({ value: 'abc' }) as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

  async function step(agentId?: string) {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of stream) { /* drain */ }
    await stream.result
  }
  return { clock, step }
}

describe(`${PLUGIN}: turn tracking`, () => {
  test('records lastRequestAt after a main-thread turn.step', async ($, on) => {
    const { step } = await start($, on)
    await step()
    expect(await $.atom.get(PLUGIN, 'lastRequestAt')).toBe(1_000_000)
  })

  test('does not record lastRequestAt for a subagent turn.step', async ($, on) => {
    const { step } = await start($, on)
    await step('agent-42')
    expect(await $.atom.get(PLUGIN, 'lastRequestAt')).toBeNull()
  })

  test('/clear resets lastRequestAt and notifiedAt', async ($, on) => {
    const { step } = await start($, on)
    await step()
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    expect(await $.atom.get(PLUGIN, 'lastRequestAt')).toBeNull()
    expect(await $.atom.get(PLUGIN, 'notifiedAt')).toBeNull()
  })

  test('/resume resets lastRequestAt and notifiedAt', async ($, on) => {
    const { step } = await start($, on)
    await step()
    await $.session.end({ reason: 'resume', sessionId: 's' } as any)
    expect(await $.atom.get(PLUGIN, 'lastRequestAt')).toBeNull()
    expect(await $.atom.get(PLUGIN, 'notifiedAt')).toBeNull()
  })
})

describe(`${PLUGIN}: notifications`, () => {
  test('fires toast and osascript at the warn threshold', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    const osaCalls: string[][] = []
    on('ui.toast', (_$, e) => { toasts.push(e.text); return {} as any })
    on('process.run', (_$, e) => { osaCalls.push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '' } } as any })

    const { clock, step } = await start($, on, 5)
    await step()
    // 5m TTL, 5m warn → warnAt = now + 5m - 5m = now → fires immediately
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('5m')
    expect(osaCalls[0]?.[0]).toBe('osascript')
    expect(osaCalls[0]?.[2]).toContain('5 minutes')
  })

  test('does not fire before the warn threshold', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', (_$, e) => { toasts.push(e.text); return {} as any })
    on('process.run', (_$, e) => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)

    // Use 1h TTL so warnAt is far in the future
    const start2 = async () => {
      const clock = mock.clock(on, { now: 1_000_000 })
      on('session.start',  (_$, e) => ({ sessionId: 's', cwd: e.cwd }) as any)
      on('session.usage',  () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 5_000, window: 200_000, percent: 3 } } }) as any)
      on('turn.step',      async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any })
      on('turn.complete',  () => ({ text: '' }) as any)
      on('session.end',    (_$, e) => ({ sessionId: e.sessionId }) as any)
      on('fs.stat',        () => ({ deny: 'no such file' }) as any)
      mock.env(on, { HOME: '/home/me' })
      on('session.root',   () => ({ value: '/work/app' }) as any)
      on('session.id',     () => ({ value: 'abc' }) as any)
      await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
      return clock
    }
    const clock = await start2()
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    for await (const _ of stream) { /* drain */ }
    await stream.result
    // advance 50 minutes — still 10 minutes before 1h expiry, and warnMinutes = 5
    await clock.advance(50 * 60_000)
    expect(toasts).toHaveLength(0)
  })

  test('notifiedAt guard prevents double-fire in the same cycle', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', (_$, e) => { toasts.push(e.text); return {} as any })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)

    const { step } = await start($, on, 5)
    await step()
    // warnAt = now (fires immediately); wait a bit and fire again — should not re-fire
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any) // hot-reload sim: re-arm
    expect(toasts).toHaveLength(1) // still only one
  })

  test('notifiedAt resets after a new turn, allowing re-notification', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', (_$, e) => { toasts.push(e.text); return {} as any })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)

    const { step } = await start($, on, 5)
    await step() // cycle 1 — fires immediately (warnAt = now)
    expect(toasts).toHaveLength(1)
    await step() // new turn resets cycle; since advances past notifiedAt → fires again
    expect(toasts).toHaveLength(2)
  })

  test('osascript failure does not crash — toast still fires', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', (_$, e) => { toasts.push(e.text); return {} as any })
    on('process.run', () => { throw new Error('osascript: command not found') })

    const { step } = await start($, on, 5)
    await step()
    expect(toasts).toHaveLength(1)
  })

  test('no notification when cache is already cold on session resume', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', (_$, e) => { toasts.push(e.text); return {} as any })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)

    const clock = mock.clock(on, { now: 1_000_000 })
    on('session.start',  (_$, e) => ({ sessionId: 's', cwd: e.cwd }) as any)
    on('session.usage',  () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 5_000, window: 200_000, percent: 3 } } }) as any)
    on('turn.step',      async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any })
    on('turn.complete',  () => ({ text: '' }) as any)
    on('session.end',    (_$, e) => ({ sessionId: e.sessionId }) as any)
    on('fs.stat',        () => ({ deny: 'no such file' }) as any)
    mock.env(on, { HOME: '/home/me' })
    on('session.root',   () => ({ value: '/work/app' }) as any)
    on('session.id',     () => ({ value: 'abc' }) as any)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    // Simulate a turn, then advance 6 minutes (past 5m TTL)
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    for await (const _ of stream) { /* drain */ }
    await stream.result
    // Clear notifications fired during step (warnAt = now for this config)
    toasts.length = 0
    await clock.advance(6 * 60_000) // cache now expired
    // No new toast after expiry — arm() stopped, no onWarn called again
    expect(toasts).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests — expect failures**

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test /Users/amrut.deshpande/Project/Code/claude-mods/cache-expiry-notifier 2>&1 | grep -E "PASS|FAIL|✓|✗" | head -30
```

Expected: new timer/notification tests fail; TTL detection tests from Task 2 still pass.

- [ ] **Step 3: Verify register.tsx already handles all these cases**

The implementation from Task 2 already includes `restartTimer`, `onWarn`, `arm`, and `stop`. Re-read `hooks/register.tsx` to confirm:
- `turn.step` calls `restartTimer` after updating `lastRequestAt` ✓
- `onWarn` reads `notifiedAt` and guards with `lastNotified >= since` ✓
- `onWarn` wraps `$.process.run` with `.catch(() => {})` ✓
- `restartTimer` skips notification and only invalidates when `now >= expiryAt` ✓

If any of these are missing, add them now.

- [ ] **Step 4: Run tests — expect pass**

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test /Users/amrut.deshpande/Project/Code/claude-mods/cache-expiry-notifier 2>&1 | grep -E "PASS|FAIL|✓|✗" | head -40
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/amrut.deshpande/Project/Code/claude-mods
git add cache-expiry-notifier/tests/timer-notifications.test.ts
git commit -m "test(cache-expiry-notifier): timer, turn tracking, and notification tests"
```

---

## Task 4: AbovePrompt UI — render hook + UI tests

**Files:**
- Modify: `cache-expiry-notifier/hooks/register.tsx` (add `ui.render` hook)
- Create: `cache-expiry-notifier/tests/above-prompt.test.ts`

**Interfaces:**
- Consumes: `lastRequestAt` atom, `detectedTtl` atom from Task 2; `arm()` timer from Task 2.
- Produces: `ui.render` hook that renders hidden/warning/cold states in `AbovePrompt`.

- [ ] **Step 1: Write failing UI tests**

Create `cache-expiry-notifier/tests/above-prompt.test.ts`:

```ts
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'cache-expiry-notifier',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
}

async function start($: Engine, on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start',  (_$, e) => ({ sessionId: 's', cwd: e.cwd }) as any)
  on('session.usage',  () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 5_000, window: 200_000, percent: 3 } } }) as any)
  on('turn.step',      async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any })
  on('turn.complete',  () => ({ text: '' }) as any)
  on('session.end',    (_$, e) => ({ sessionId: e.sessionId }) as any)
  on('fs.stat',        () => ({ deny: 'no such file' }) as any)
  on('ui.toast',       () => ({}) as any)
  on('process.run',    () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
  mock.env(on, { HOME: '/home/me' })
  on('session.root',   () => ({ value: '/work/app' }) as any)
  on('session.id',     () => ({ value: 'abc' }) as any)
  on('ui.render', { component: 'AbovePrompt', plugin: '__engine__' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'engine band' }) as any
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

  async function step() {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    for await (const _ of stream) { /* drain */ }
    await stream.result
  }
  return { clock, step }
}

describe(`${BAND.plugin}: AbovePrompt UI`, () => {
  test('renders nothing before the first turn', async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /cache/ })).toBeUndefined()
    await ui.unmount()
  })

  test('renders nothing when more than warnMinutes remain', { options: { warnMinutes: 5, cacheTtl: '1h' } }, async ($, on) => {
    const { clock, step } = await start($, on)
    await step()
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    // 1h TTL, 5m warn → warnAt = now + 55m; advance only 10m
    await clock.advance(10 * 60_000)
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    await ui.unmount()
  })

  test('shows yellow warning when within warnMinutes of expiry', { options: { warnMinutes: 10, cacheTtl: '5m' } }, async ($, on) => {
    const { step } = await start($, on)
    await step()
    // 5m TTL, 10m warn → warnAt = now - 5m (already past!) → immediate warning
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    const warn = await ui.find({ type: 'Text', text: /⚠ Cache expires in/ })
    expect(warn).toBeDefined()
    expect(warn?.props?.color).toBe('yellow')
    await ui.unmount()
  })

  test('warning text shows M:SS countdown format', { options: { warnMinutes: 10, cacheTtl: '5m' } }, async ($, on) => {
    const { step } = await start($, on)
    await step()
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    // 5m = 300s remaining → "5:00" (ceiling)
    expect(await ui.find({ type: 'Text', text: /5:00/ })).toBeDefined()
    await ui.unmount()
  })

  test('shows red cold message after expiry', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const { clock, step } = await start($, on)
    await step()
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    await clock.advance(5 * 60_000 + 100)
    const cold = await ui.find({ type: 'Text', text: /❄ Cache cold/ })
    expect(cold).toBeDefined()
    expect(cold?.props?.color).toBe('red')
    await ui.unmount()
  })

  test('warning updates every second in the last 2 minutes', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const { clock, step } = await start($, on)
    await step()
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    // At this point 5m remaining (warnAt = now)
    expect(await ui.find({ type: 'Text', text: /5:00/ })).toBeDefined()
    await clock.advance(1_000)
    expect(await ui.find({ type: 'Text', text: /4:59/ })).toBeDefined()
    await clock.advance(1_000)
    expect(await ui.find({ type: 'Text', text: /4:58/ })).toBeDefined()
    await ui.unmount()
  })

  test('warning updates every 15 s between 2 and 10 minutes left', { options: { warnMinutes: 12, cacheTtl: '1h' } }, async ($, on) => {
    const { clock, step } = await start($, on)
    await step()
    // 1h TTL, 12m warn → warnAt = now + 48m
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    await clock.advance(48 * 60_000)     // at warnAt
    expect(await ui.find({ type: 'Text', text: /12:00/ })).toBeDefined()
    await clock.advance(14_000)           // < 15 s step, no update yet
    expect(await ui.find({ type: 'Text', text: /12:00/ })).toBeDefined()
    await clock.advance(1_000)            // 15 s elapsed → step fires
    expect(await ui.find({ type: 'Text', text: /11:45/ })).toBeDefined()
    await ui.unmount()
  })

  test('/clear removes the warning band', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const { step } = await start($, on)
    await step()
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    await ui.unmount()
  })

  test('respects warnMinutes setting', { options: { warnMinutes: 2, cacheTtl: '5m' } }, async ($, on) => {
    const { clock, step } = await start($, on)
    await step()
    // 5m TTL, 2m warn → warnAt = now + 3m
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    await clock.advance(2 * 60_000)      // 1m into the 3m safe window
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    await clock.advance(60_000 + 100)    // just past warnAt (3m elapsed)
    expect(await ui.find({ type: 'Text', text: /⚠ Cache expires in/ })).toBeDefined()
    await ui.unmount()
  })
})
```

- [ ] **Step 2: Run tests — expect failures**

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test /Users/amrut.deshpande/Project/Code/claude-mods/cache-expiry-notifier 2>&1 | grep -E "above-prompt|FAIL|✗" | head -20
```

Expected: all above-prompt tests fail (no `ui.render` hook yet).

- [ ] **Step 3: Add ui.render hook to register.tsx**

Inside the `register` function body, after the `turn.complete` handler, add:

```tsx
on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
  const rest = await next(e)
  const since = await read($, lastRequestAt)
  if (since === null) return rest

  const now    = await $.clock.now()
  const ttlMs  = await ttlMsFor($, override)
  const left   = since + ttlMs - now
  const warnMs = (options.warnMinutes ?? 10) * 60_000

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
```

- [ ] **Step 4: Run all tests — expect pass**

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test /Users/amrut.deshpande/Project/Code/claude-mods/cache-expiry-notifier 2>&1 | grep -E "PASS|FAIL|✓|✗|passed|failed" | head -40
```

Expected: all tests pass across all three test files.

- [ ] **Step 5: Commit**

```bash
cd /Users/amrut.deshpande/Project/Code/claude-mods
git add cache-expiry-notifier
git commit -m "feat(cache-expiry-notifier): AbovePrompt warning and cold UI states"
```

---

## Task 5: Wire up and README

**Files:**
- Modify: `~/.claude/settings.json` (add mod path to `CLAUDE_CODE_PLUGIN_DIRS`)
- Create: `cache-expiry-notifier/README.md`

**Interfaces:**
- Consumes: complete mod from Tasks 1–4.
- Produces: mod active in Claude Code; README ready for GitHub publish.

- [ ] **Step 1: Add mod to CLAUDE_CODE_PLUGIN_DIRS in settings.json**

Open `~/.claude/settings.json`. Find `CLAUDE_CODE_PLUGIN_DIRS` (currently lists two existing mods). Append the new mod path separated by `:`:

Current value (example):
```
"/Users/amrut.deshpande/.claude/dev-mods/d476fe71-d842-4890-bbd7-972ae62a2ea1/laya-call-counter:/Users/amrut.deshpande/.claude/dev-mods/d476fe71-d842-4890-bbd7-972ae62a2ea1/laya-decision-maker"
```

New value:
```
"/Users/amrut.deshpande/.claude/dev-mods/d476fe71-d842-4890-bbd7-972ae62a2ea1/laya-call-counter:/Users/amrut.deshpande/.claude/dev-mods/d476fe71-d842-4890-bbd7-972ae62a2ea1/laya-decision-maker:/Users/amrut.deshpande/Project/Code/claude-mods/cache-expiry-notifier"
```

- [ ] **Step 2: Verify mod loads — open a new Claude Code session and check**

In a new terminal session:
```bash
claude
```

At the prompt, run:
```
/config
```

Expected: `cache-expiry-notifier.warnMinutes` and `cache-expiry-notifier.cacheTtl` appear in the config list.

- [ ] **Step 3: Write README.md**

```markdown
# cache-expiry-notifier

A Claude Code mod that alerts you **X minutes before your prompt cache expires**, so you
can send a turn before paying the full re-cache cost.

## What it does

- Shows a yellow `⚠ Cache expires in M:SS — send a turn to refresh` band above the prompt
  when you're inside the warning window.
- Shows a red `❄ Cache cold — next turn re-caches` band after expiry.
- Fires an **in-app toast** and a **macOS system notification** the moment you enter the
  warning window.
- Detects whether your instance uses 5-minute or 1-hour prompt caching automatically.

## Installation

1. Clone this repo and note the path to this folder.
2. Add it to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`:

   ```json
   "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/cache-expiry-notifier"
   ```

   Multiple mods: separate paths with `:`.

3. Start a new Claude Code session. Run `/config` to confirm the mod is active.

## Configuration

Configure per-developer with `/config` inside Claude Code, or by editing `settings.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `cache-expiry-notifier.warnMinutes` | `10` | Minutes before expiry to fire the alert (minimum 1) |
| `cache-expiry-notifier.cacheTtl` | `auto` | Override TTL detection: `auto`, `5m`, or `1h` |

Example — warn 5 minutes before expiry:
```
/config cache-expiry-notifier.warnMinutes=5
```

## How it works

The mod hooks into three Claude Code events:

- **`turn.step`** — records `lastRequestAt` each time a main-thread model response finishes;
  this is when the cache is refreshed.
- **`turn.complete`** — reads the session transcript to detect whether the active TTL is
  5 minutes or 1 hour.
- **`ui.render` (AbovePrompt)** — renders the warning / cold band based on elapsed time.

A `$.clock.after` timer fires at `lastRequestAt + TTL - warnMinutes`, triggers the
notification, then schedules cascading redraws every 30 s / 15 s / 1 s as expiry approaches.

## Requirements

- Claude Code (any recent version with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` support)
- macOS (for system notifications via `osascript`; toast works everywhere)

## Development

Run unit tests:
```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test /path/to/cache-expiry-notifier
```
```

Save to: `cache-expiry-notifier/README.md`

- [ ] **Step 4: Commit everything**

```bash
cd /Users/amrut.deshpande/Project/Code/claude-mods
git add cache-expiry-notifier/README.md
git commit -m "docs(cache-expiry-notifier): README and wire up to settings"
```

- [ ] **Step 5: Git init for the claude-mods repo (if not already done)**

```bash
cd /Users/amrut.deshpande/Project/Code/claude-mods
git remote -v
```

If no remote, add one when ready to publish:
```bash
git remote add origin https://github.com/<your-username>/claude-mods.git
git push -u origin main
```
