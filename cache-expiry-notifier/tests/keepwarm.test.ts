import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

async function start($: Engine, on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start',    (_$, e) => ({ sessionId: 's', cwd: (e as any).cwd }) as any)
  on('session.usage',    () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 60_000, window: 200_000, percent: 30 } } }) as any)
  on('turn.step',        async function* (_$, e) { return { turnId: (e as any).turnId, index: (e as any).index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any })
  on('turn.complete',    () => ({ text: '' }) as any)
  on('session.end',      (_$, e) => ({ sessionId: (e as any).sessionId }) as any)
  on('fs.stat',          () => ({ deny: 'no such file' }) as any)
  on('ui.render',        ($, e) => { const { Text } = ($ as any).ui.resolve(e); return Text({ children: 'engine' }) as any })
  on('command.describe', () => ({}) as any)
  mock.env(on, { HOME: '/home/me' })
  on('session.root',     () => ({ value: '/work/app' }) as any)
  on('session.id',       () => ({ value: 'abc' }) as any)
  mock.store(on, {})
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

  async function step() {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as any)
    for await (const _ of stream) { /* drain */ }
    await stream.result
  }
  return { clock, step }
}

describe('cache-expiry-notifier: keepwarm', () => {
  test('/keepwarm command toggles keepWarmEnabled on', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    on('ui.toast',       () => ({ value: undefined }) as any)
    on('process.run',    () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    on('prompt.submit',  () => ({}) as any)
    await start($, on)

    const result = await $.command.run({ command: 'keepwarm', args: '', source: 'prompt' } as any)
    expect((result as any).text).toContain('Keep-warm enabled')
  })

  test('/keepwarm toggles off on second call', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    on('ui.toast',       () => ({ value: undefined }) as any)
    on('process.run',    () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    on('prompt.submit',  () => ({}) as any)
    await start($, on)

    await $.command.run({ command: 'keepwarm', args: '', source: 'prompt' } as any)
    const result = await $.command.run({ command: 'keepwarm', args: '', source: 'prompt' } as any)
    expect((result as any).text).toBe('Keep-warm off.')
  })

  test('sends · instead of notifying when keepwarm is on', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const toasts: string[] = []
    const submits: string[] = []
    on('ui.toast',       (_$, e) => { toasts.push((e as any).text); return { value: undefined } as any })
    on('process.run',    () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    on('prompt.submit',  (_$, e) => { submits.push((e as any).text); return {} as any })
    const { step } = await start($, on)

    // Enable keepwarm
    await $.command.run({ command: 'keepwarm', args: '', source: 'prompt' } as any)

    // Fire a turn — warnAt = now (5m TTL, 5m warn) → onWarn fires immediately
    await step()

    expect(submits).toContain('·')
    expect(toasts[toasts.length - 1]).toContain('🔥')
  })

  test('does not send · when keepwarm is off', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const submits: string[] = []
    on('ui.toast',       () => ({ value: undefined }) as any)
    on('process.run',    () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    on('prompt.submit',  (_$, e) => { submits.push((e as any).text); return {} as any })
    const { step } = await start($, on)

    await step()

    expect(submits).toHaveLength(0)
  })

  test('/clear resets keepwarm to off', { options: { warnMinutes: 5, cacheTtl: '5m' } }, async ($, on) => {
    const submits: string[] = []
    on('ui.toast',       () => ({ value: undefined }) as any)
    on('process.run',    () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
    on('prompt.submit',  (_$, e) => { submits.push((e as any).text); return {} as any })
    const { step } = await start($, on)

    await $.command.run({ command: 'keepwarm', args: '', source: 'prompt' } as any)
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)

    // After clear, keepwarm should be off — step should not submit ·
    await step()
    expect(submits).toHaveLength(0)
  })
})
