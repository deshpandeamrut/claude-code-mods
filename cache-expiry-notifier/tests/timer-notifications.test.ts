import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

async function start($: Engine, on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start',  (_$, e) => ({ sessionId: 's', cwd: (e as any).cwd }) as any)
  on('session.usage',  () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 60_000, window: 200_000, percent: 3 } } }) as any)
  on('turn.step',      async function* (_$, e) { return { turnId: (e as any).turnId, index: (e as any).index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any })
  on('turn.complete',  () => ({ text: '' }) as any)
  on('session.end',    (_$, e) => ({ sessionId: (e as any).sessionId }) as any)
  on('fs.stat',        () => ({ deny: 'no such file' }) as any)
  on('ui.render',      ($, e) => { const { Text } = ($ as any).ui.resolve(e); return Text({ children: 'engine' }) as any })
  mock.env(on, { HOME: '/home/me' })
  on('session.root',   () => ({ value: '/work/app' }) as any)
  on('session.id',     () => ({ value: 'abc' }) as any)
  mock.store(on, {})
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

  async function step(agentId?: string) {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) } as any)
    for await (const _ of stream) { /* drain */ }
    await stream.result
  }
  return { clock, step }
}

describe('cache-expiry-notifier: hot-reload re-arm', () => {
  test('session.start re-arms the countdown when lastRequestAt is already set', { options: { warnMinutes: 60, cacheTtl: '5m' } }, async ($, on) => {
    // Simulate a hot reload: step() sets lastRequestAt, then session.start fires again.
    // The countdown band must still be visible after the second session.start.
    on('ui.toast',    () => ({ value: undefined }) as any)
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    const BAND = { plugin: 'cache-expiry-notifier', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } }
    const { step } = await start($, on)

    await step()  // sets lastRequestAt; 5m TTL with 60m warn → warnAt = now - 55m → immediate warn

    // Simulate hot reload: session.start fires again while lastRequestAt is in the atom
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    // Countdown band must still appear — session.start re-armed it from the atom
    expect(await ui.find({ type: 'Text', text: /Cache expires in|Cache cold/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('cache-expiry-notifier: turn tracking', () => {
  test('turn.step with stopReason=null does not advance lastRequestAt', { options: { warnMinutes: 5, cacheTtl: '1h' } }, async ($, on) => {
    // A streaming turn that is interrupted (stopReason=null) must not update the cache clock.
    const toasts: string[] = []
    on('ui.toast',    (_$, e) => { toasts.push((e as any).text); return { value: undefined } as any })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)

    // Override turn.step to return stopReason: null
    const clock = mock.clock(on, { now: 1_000_000 })
    on('session.start',  (_$, e) => ({ sessionId: 's', cwd: (e as any).cwd }) as any)
    on('session.usage',  () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 60_000, window: 200_000, percent: 3 } } }) as any)
    on('turn.step',      async function* (_$, e) { return { turnId: (e as any).turnId, index: (e as any).index, answer: '', toolUses: [], stopReason: null, usage: null } as any })
    on('turn.complete',  () => ({ text: '' }) as any)
    on('session.end',    (_$, e) => ({ sessionId: (e as any).sessionId }) as any)
    on('fs.stat',        () => ({ deny: 'no such file' }) as any)
    on('ui.render',      ($, e) => { const { Text } = ($ as any).ui.resolve(e); return Text({ children: 'engine' }) as any })
    mock.env(on, { HOME: '/home/me' })
    on('session.root',   () => ({ value: '/work/app' }) as any)
    on('session.id',     () => ({ value: 'abc' }) as any)
    mock.store(on, {})
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    // Fire a turn with stopReason: null (interrupted/streaming incomplete)
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as any)
    for await (const _ of stream) { /* drain */ }
    await stream.result

    // 1h TTL, 5m warn → warnAt = now + 55m; if lastRequestAt was set, toast would fire at 55m
    // If lastRequestAt was NOT set (correct), no toast fires even after advancing 55m
    await clock.advance(55 * 60_000 + 100)
    expect(toasts).toHaveLength(0)  // no toast = lastRequestAt was never set
  })

  test('subagent turn.step does not reset the countdown', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', (_$, e) => { toasts.push((e as any).text); return { value: undefined } as any })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    const { step } = await start($, on)

    await step()               // main thread — fires toast (warnAt = now for 5m TTL, 5m warn)
    const before = toasts.length

    await step('agent-99')     // subagent — must NOT reset cycle or re-fire
    expect(toasts.length).toBe(before)  // no additional toast
  })

  test('/clear resets lastRequestAt so band disappears', { options: { warnMinutes: 60, cacheTtl: '5m' } }, async ($, on) => {
    on('ui.toast',    () => ({ value: undefined }) as any)
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    const BAND = { plugin: 'cache-expiry-notifier', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } }
    const { step } = await start($, on)

    await step()
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)

    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    await ui.unmount()
  })

  test('/resume resets lastRequestAt so band disappears', { options: { warnMinutes: 60, cacheTtl: '5m' } }, async ($, on) => {
    on('ui.toast',    () => ({ value: undefined }) as any)
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    const BAND = { plugin: 'cache-expiry-notifier', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } }
    const { step } = await start($, on)

    await step()
    await $.session.end({ reason: 'resume', sessionId: 's' } as any)

    const ui = await $.ui.mount({ surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('cache-expiry-notifier: notifications', () => {
  test('toast fires when warn threshold is crossed', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast',    (_$, e) => { toasts.push((e as any).text); return { value: undefined } as any })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    const { step } = await start($, on)

    await step()  // 5m TTL, 5m warn → warnAt = now → fires immediately
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('5m')
  })

  test('osascript called with correct text', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const runs: string[][] = []
    on('ui.toast',    () => ({ value: undefined }) as any)
    on('process.run', (_$, e) => { runs.push((e as any).argv); return { value: { exitCode: 0, stdout: '', stderr: '' } } as any })
    const { step } = await start($, on)

    await step()
    const osaCall = runs.find(r => r[0] === 'osascript')
    expect(osaCall).toBeDefined()
    expect(osaCall?.[2]).toContain('5 minutes')
  })

  test('toast does not fire before warn threshold', { options: { warnMinutes: 5, cacheTtl: '1h' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast',    (_$, e) => { toasts.push((e as any).text); return { value: undefined } as any })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    const { clock, step } = await start($, on)

    await step()                   // 1h TTL, 5m warn → warnAt = now + 55m
    await clock.advance(10 * 60_000)  // advance 10m — still 45m before warnAt
    expect(toasts).toHaveLength(0)
  })

  test('toast fires once when clock reaches warnAt', { options: { warnMinutes: 5, cacheTtl: '1h' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast',    (_$, e) => { toasts.push((e as any).text); return { value: undefined } as any })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    const { clock, step } = await start($, on)

    await step()                    // warnAt = now + 55m
    await clock.advance(55 * 60_000)  // reach warnAt exactly
    expect(toasts).toHaveLength(1)
  })

  test('notifiedAt guard prevents double-fire in the same cycle', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast',    (_$, e) => { toasts.push((e as any).text); return { value: undefined } as any })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    const { clock, step } = await start($, on)

    await step()        // fires immediately (warnAt = now)
    expect(toasts).toHaveLength(1)
    await clock.advance(1_000)   // advance 1s — still same cycle
    expect(toasts).toHaveLength(1)  // no second toast
  })

  test('notifiedAt resets on new turn — fires again on next approach', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast',    (_$, e) => { toasts.push((e as any).text); return { value: undefined } as any })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    const { clock, step } = await start($, on)

    await step()  // cycle 1 — fires immediately (since = notifiedAt = 1_000_000)
    expect(toasts).toHaveLength(1)

    await clock.advance(1)  // 1 ms: ensures new turn's since (1_000_001) > notifiedAt (1_000_000)
    await step()  // cycle 2 — notifiedAt < since → fires again
    expect(toasts).toHaveLength(2)
  })

  test('osascript failure does not crash — toast still fires', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast',    (_$, e) => { toasts.push((e as any).text); return { value: undefined } as any })
    on('process.run', () => { throw new Error('osascript: command not found') })
    const { step } = await start($, on)

    await step()
    expect(toasts).toHaveLength(1)
  })

  test('no notification when cache is already cold on resume', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast',    (_$, e) => { toasts.push((e as any).text); return { value: undefined } as any })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    const { clock, step } = await start($, on)

    await step()               // fires immediately — warnAt = now for 5m/5m
    toasts.length = 0          // reset — we only care about what fires after expiry
    await clock.advance(5 * 60_000 + 500)  // advance past expiry (5m TTL expired)

    expect(toasts).toHaveLength(0)  // arm() stops at expiry; no second onWarn
  })
})
