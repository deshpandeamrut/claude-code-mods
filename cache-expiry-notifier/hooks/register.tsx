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
