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
