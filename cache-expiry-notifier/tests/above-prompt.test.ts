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
  on('session.start',  (_$, e) => ({ sessionId: 's', cwd: (e as any).cwd }) as any)
  on('session.usage',  () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 60_000, window: 200_000, percent: 3 } } }) as any)
  on('turn.step',      async function* (_$, e) { return { turnId: (e as any).turnId, index: (e as any).index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any })
  on('turn.complete',  () => ({ text: '' }) as any)
  on('session.end',    (_$, e) => ({ sessionId: (e as any).sessionId }) as any)
  on('fs.stat',        () => ({ deny: 'no such file' }) as any)
  on('ui.toast',       () => ({ value: undefined }) as any)
  on('process.run',    () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
  on('ui.render',      ($, e) => { const { Text } = ($ as any).ui.resolve(e); return Text({ children: 'engine' }) as any })
  mock.env(on, { HOME: '/home/me' })
  on('session.root',   () => ({ value: '/work/app' }) as any)
  on('session.id',     () => ({ value: 'abc' }) as any)
  mock.store(on, {})
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

  async function step() {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as any)
    for await (const _ of stream) { /* drain */ }
    await stream.result
  }
  return { clock, step }
}

describe('cache-expiry-notifier: AbovePrompt UI', () => {
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
    // 1h TTL, 5m warn → warnAt = now + 55m; advance only 10m
    await clock.advance(10 * 60_000)
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    await ui.unmount()
  })

  test('shows yellow warning when within warnMinutes of expiry', { options: { warnMinutes: 10, cacheTtl: '5m' } }, async ($, on) => {
    // 5m TTL, 10m warn → warnMs > ttlMs so warnAt = now - 5m (past) → immediate warning
    const { step } = await start($, on)
    await step()
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    const warn = await ui.find({ type: 'Text', text: /⚠ Cache expires in/ })
    expect(warn).toBeDefined()
    expect((warn as any)?.props?.color).toBe('yellow')
    await ui.unmount()
  })

  test('warning text shows M:SS countdown format', { options: { warnMinutes: 10, cacheTtl: '5m' } }, async ($, on) => {
    const { step } = await start($, on)
    await step()
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    // 5m = 300s remaining → "5:00"
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
    expect((cold as any)?.props?.color).toBe('red')
    await ui.unmount()
  })

  test('warning updates every second in the last 2 minutes', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    // 5m TTL, 5m warn → fires immediately with 5:00 left; advance 3m to reach 2:00 left (1s zone)
    const { clock, step } = await start($, on)
    await step()
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    await clock.advance(3 * 60_000)  // 3m elapsed → 2m left → enters 1s-step zone
    expect(await ui.find({ type: 'Text', text: /2:00/ })).toBeDefined()
    await clock.advance(1_000)
    expect(await ui.find({ type: 'Text', text: /1:59/ })).toBeDefined()
    await clock.advance(1_000)
    expect(await ui.find({ type: 'Text', text: /1:58/ })).toBeDefined()
    await ui.unmount()
  })

  test('warning updates every 15 s between 2 and 10 minutes left', { options: { warnMinutes: 8, cacheTtl: '1h' } }, async ($, on) => {
    // 1h TTL, 8m warn → warnAt = now + 52m; at warnAt 8m left (480s) → 15s steps
    // (12m would be > SLOWER_ABOVE_MS = 10m → 30s steps, not 15s)
    const { clock, step } = await start($, on)
    await step()
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    await clock.advance(52 * 60_000)      // reach warnAt → onWarn fires, shows 8:00
    expect(await ui.find({ type: 'Text', text: /8:00/ })).toBeDefined()
    await clock.advance(14_000)            // 14s < 15s step — no update yet
    expect(await ui.find({ type: 'Text', text: /8:00/ })).toBeDefined()
    await clock.advance(1_000)             // 15s elapsed → step fires → 7:45
    expect(await ui.find({ type: 'Text', text: /7:45/ })).toBeDefined()
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

  test('respects warnMinutes — band hidden at 4m left with 5m warn', { options: { warnMinutes: 5, cacheTtl: '1h' } }, async ($, on) => {
    // 1h TTL, 5m warn → warnAt = now + 55m
    const { clock, step } = await start($, on)
    await step()
    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    await clock.advance(54 * 60_000)      // 54m elapsed — 6m remain, warnAt not yet reached
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    await clock.advance(60_000 + 100)     // 55m+ elapsed — past warnAt → shows warning
    expect(await ui.find({ type: 'Text', text: /⚠ Cache expires in/ })).toBeDefined()
    await ui.unmount()
  })
})
