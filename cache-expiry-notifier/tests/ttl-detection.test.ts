import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'cache-expiry-notifier',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
}

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
  store: Record<string, unknown> | null = {},
  transcript = '',
  env: Record<string, string> = { HOME: '/home/me' },
  transcriptFile = '/home/me/.claude/projects/-work-my-app/abc.jsonl',
) {
  let content = transcript
  if (store !== null) mock.store(on, store)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start',  (_$, e) => ({ sessionId: 's', cwd: e.cwd }) as any)
  on('session.usage',  () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 5_000, window: 200_000, percent: 3 } } }) as any)
  on('turn.step',      async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any })
  on('turn.complete',  () => ({ text: '' }) as any)
  on('session.end',    (_$, e) => ({ sessionId: e.sessionId }) as any)
  on('fs.stat',        (_$, e) => (e as any).path !== transcriptFile ? { deny: 'no such file' } as any : { value: { kind: 'file', size: content.length, mtimeMs: 0, isLink: false } } as any)
  on('fs.read',        () => ({ value: content }) as any)
  on('process.run',    (_$, e) => {
    const bytes = Number((e as any).argv[2])
    return { value: { exitCode: 0, stdout: content.slice(-bytes), stderr: '' } } as any
  })
  on('ui.toast',       () => ({ value: undefined }) as any)
  on('ui.render',      ($, e) => { const { Text } = ($ as any).ui.resolve(e); return Text({ children: 'engine band' }) as any })
  mock.env(on, env)
  on('session.root',   () => ({ value: '/work/my app' }) as any)
  on('session.id',     () => ({ value: 'abc' }) as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

  async function turn(...lines: string[]) {
    content += lines.map((l: string) => l + '\n').join('')
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    for await (const _ of stream) { /* drain */ }
    await stream.result
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
  }
  return { clock, turn }
}

describe('cache-expiry-notifier: TTL detection', () => {
  // warnMinutes=60 so the band always shows immediately after a turn (warn threshold = entire TTL)
  test('falls back to 5m before any detection', { options: { warnMinutes: 60, cacheTtl: 'auto' } }, async ($, on) => {
    const { turn } = await start($, on)
    await turn('{"type":"user"}')
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    // 5m TTL with 60m warn → warnAt = now - 55m (already past) → shows countdown from 5:00
    expect(await ui.find({ type: 'Text', text: /5:0/ })).toBeDefined()
    await ui.unmount()
  })

  test('detects 1h from a response that wrote 1h cache tokens', { options: { warnMinutes: 60, cacheTtl: 'auto' } }, async ($, on) => {
    const { turn } = await start($, on)
    await turn(response(0, 1355))
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /60:00/ })).toBeDefined()
    await ui.unmount()
  })

  test('detects 5m from a response that wrote only 5m tokens', { options: { warnMinutes: 60, cacheTtl: 'auto' } }, async ($, on) => {
    const { turn } = await start($, on)
    await turn(response(0, 1355))  // 1h first
    await turn(response(400, 0))   // then 5m
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /5:0/ })).toBeDefined()
    await ui.unmount()
  })

  test('keeps the last value on a pure cache hit', { options: { warnMinutes: 60, cacheTtl: 'auto' } }, async ($, on) => {
    const { turn } = await start($, on)
    await turn(response(0, 1355))
    await turn(response(0, 0))  // pure cache hit — no cache_creation tokens
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /60:00/ })).toBeDefined()
    await ui.unmount()
  })

  test('ignores sidechain (subagent) response lines', { options: { warnMinutes: 60, cacheTtl: 'auto' } }, async ($, on) => {
    const { turn } = await start($, on)
    await turn(response(0, 1355))
    const sidechain = JSON.stringify({ ...JSON.parse(response(400, 0)), isSidechain: true })
    await turn(response(0, 0), sidechain)
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /60:00/ })).toBeDefined()
    await ui.unmount()
  })

  test('restores 1h detection from store on session start', { options: { warnMinutes: 60, cacheTtl: 'auto' } }, async ($, on) => {
    const { turn } = await start($, on, { detectedTtl: '1h' })
    await turn('{"type":"user"}')
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /60:00/ })).toBeDefined()
    await ui.unmount()
  })

  test('persists a new detection to the store', { options: { warnMinutes: 60, cacheTtl: 'auto' } }, async ($, on) => {
    const saved: Record<string, unknown> = {}
    on('store.get', () => ({ value: undefined }) as any)
    on('store.set', (_$: any, e: any) => { saved[e.key] = e.value; return { value: undefined } as any })
    const { turn } = await start($, on, null)
    await turn(response(0, 1355))
    expect(saved['detectedTtl']).toBe('1h')
  })

  test('keeps last value when transcript cannot be read', { options: { warnMinutes: 60, cacheTtl: 'auto' } }, async ($, on) => {
    // Store says 1h; transcript file is at wrong path → unreadable → keeps 1h
    const { turn } = await start($, on, { detectedTtl: '1h' }, '', { HOME: '/home/me' }, '/nowhere/else.jsonl')
    await turn(response(400, 0))  // would detect 5m if readable
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /60:00/ })).toBeDefined()
    await ui.unmount()
  })

  test('reads only the tail of a large transcript', { options: { warnMinutes: 60, cacheTtl: 'auto' } }, async ($, on) => {
    const padding = 'x'.repeat(1200 * 1024) + '\n'
    const { turn } = await start($, on, {}, padding)
    await turn(response(0, 1355))
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /60:00/ })).toBeDefined()
    await ui.unmount()
  })

  test('uses CLAUDE_CONFIG_DIR when set', { options: { warnMinutes: 60, cacheTtl: 'auto' } }, async ($, on) => {
    const { turn } = await start($, on, {}, '', { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' }, '/cfg/projects/-work-my-app/abc.jsonl')
    await turn(response(0, 1355))
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /60:00/ })).toBeDefined()
    await ui.unmount()
  })

  test('explicit cacheTtl=5m overrides 1h detection', { options: { warnMinutes: 60, cacheTtl: '5m' } }, async ($, on) => {
    const { turn } = await start($, on)
    await turn(response(0, 1355))  // would show 60:00 if auto
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /5:0/ })).toBeDefined()
    await ui.unmount()
  })

  test('explicit cacheTtl=1h overrides 5m detection', { options: { warnMinutes: 60, cacheTtl: '1h' } }, async ($, on) => {
    const { turn } = await start($, on)
    await turn(response(400, 0))  // would show 5:00 if auto
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /60:00/ })).toBeDefined()
    await ui.unmount()
  })
})
