# cache-expiry-notifier — Design Spec

**Date:** 2026-10-08  
**Status:** Approved for implementation

---

## Purpose

A Claude Code mod that fires a proactive alert — both an in-app toast and a macOS system
notification — when the developer is within X configurable minutes of their prompt-cache
going cold. Prevents surprise re-cache costs from sessions left idle too long.

Complements `token-weather` (which shows a live countdown) but is independently useful:
it alerts users who don't watch the status band.

---

## Files

```
cache-expiry-notifier/
  .claude-plugin/plugin.json     ← metadata + userConfig
  hooks/register.tsx             ← all logic (single file)
  hooks/hooks.json               ← { "modules": ["./register.tsx"] }
  types/index.d.ts               ← CacheTtl type alias
  tsconfig.json                  ← extends .claude-plugin/types/tsconfig.json
  .claude-plugin/types/          ← copied from laya-call-counter (claude-code typedefs)
```

The `.claude-plugin/types/` subtree is copied verbatim from an existing mod at setup time
(identical across mods; not regenerated during build).

---

## Configuration (`plugin.json` → `userConfig`)

| Key | Type | Default | Constraint | Description |
|-----|------|---------|-----------|-------------|
| `warnMinutes` | `number` | `10` | `min: 1` | Minutes before cache expiry to fire the alert |
| `cacheTtl` | `string` | `"auto"` | options: `auto`, `5m`, `1h` | Override TTL detection; `auto` reads from transcript |

Accessible via `/config cache-expiry-notifier.warnMinutes=5` per developer.

---

## State (atoms — survive hot reload)

| Atom key | Type | Purpose |
|----------|------|---------|
| `lastRequestAt` | `number \| null` | `$.clock.now()` timestamp of the last cache-writing turn |
| `detectedTtl` | `'5m' \| '1h' \| null` | TTL inferred from transcript; persisted to `$.store` |
| `notifiedAt` | `number \| null` | When notification last fired; guards against repeat per cycle |

---

## Cache TTL Detection

On `turn.complete` (main thread only, `!e.agentId`):
1. Read the last ~1 MB of the session transcript via `$.fs`.
2. Scan backwards for the most recent `assistant` message with `message.usage.cache_creation`.
3. If `ephemeral_1h_input_tokens > 0` → detected `'1h'`; if `ephemeral_5m_input_tokens > 0` → `'5m'`.
4. On new detection: update `detectedTtl` atom + `$.store.set('detectedTtl', ttl)` (persists for next session).

TTL resolution order (highest wins):
1. `cacheTtl` userConfig override (`5m` or `1h`)
2. `detectedTtl` atom
3. `'5m'` safe default

Transcript path formula (matching `token-weather`):
```
${CLAUDE_CONFIG_DIR ?? HOME/.claude}/projects/${sessionRoot.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl
```

---

## Timer Logic

Module-level state (not atoms — lost on hot reload, re-armed on `session.start`):
```ts
let tick: Timer | undefined
let armedFor: number | null = null   // the lastRequestAt value this timer is for
```

**Timing values:**
```
warnAt   = lastRequestAt + ttlMs - (warnMinutes × 60_000)
expiryAt = lastRequestAt + ttlMs
```

**Lifecycle:**

| Event | Action |
|-------|--------|
| `session.start` | Restore `detectedTtl` from `$.store`; if `lastRequestAt` exists, re-arm from that point |
| `turn.step` (main thread, `stopReason !== null`) | `lastRequestAt = now`; restart timer toward `warnAt` |
| `session.end` (reason `clear` or `resume`) | `tick?.cancel()`; clear `lastRequestAt` and `notifiedAt` |

**Timer sequence after each `turn.step`:**

1. Cancel previous timer (`tick?.cancel()`), set `armedFor = lastRequestAt`.
2. If `now < warnAt`: schedule `$.clock.after(warnAt - now, () => onWarn(...))`.
3. Else if `now < expiryAt` (past warn threshold but cache still warm): call `onWarn()` immediately, which starts the redraw loop.
4. Else (`now >= expiryAt`, cache already cold on resume): just `$.ui.invalidate('ui.render')` to show cold state — no notification, no loop.

**`onWarn()` → starts redraw loop:**
- Fires notifications (guarded by `notifiedAt`).
- Calls `arm($, lastRequestAt, now, ttlMs)` to begin the countdown redraw loop.

**`arm()` — cascading redraw loop** (mirrors `token-weather`):
- Computes `left = lastRequestAt + ttlMs - now`.
- If `left ≤ 0`: `$.ui.invalidate('ui.render')` once (flip to cold state) and return.
- Else: pick step size based on `left`, schedule `$.clock.after(step, () => { invalidate; arm() })`.

Step size:
- `left > 10 min`: 30 s steps
- `2 min < left ≤ 10 min`: 15 s steps
- `left ≤ 2 min`: 1 s steps

Each step: `$.ui.invalidate('ui.render')` then re-arm via `arm()` — continues until `left ≤ 0`.

---

## Notifications

Fires once per cache cycle, guarded by `notifiedAt`:

```ts
async function onWarn($, lastRequestAt, warnMinutes) {
  const now = await $.clock.now()
  if (notifiedAt !== null && notifiedAt >= lastRequestAt) return   // already fired this cycle
  notifiedAt = now

  $.ui.toast(`⚠ Cache expires in ${warnMinutes}m — send a turn to stay warm`)

  await $.process.run([
    'osascript', '-e',
    `display notification "Cache expires in ${warnMinutes} minutes — send a turn to refresh" ` +
    `with title "Claude Code" subtitle "Prompt cache expiring soon"`
  ]).catch(() => {})   // non-fatal if osascript unavailable
}
```

The `notifiedAt >= lastRequestAt` guard means: if the user sends a turn (new cycle begins)
and then goes idle again, they get re-notified on the next approach.

---

## AbovePrompt UI

Three states:

| State | Condition | Rendered output |
|-------|-----------|----------------|
| **Hidden** | `lastRequestAt` is null, or `left > warnMinutes × 60_000` | `return next(e)` (renders nothing for this mod) |
| **Warning** | `0 < left ≤ warnMinutes × 60_000` | Yellow `⚠ Cache expires in M:SS — send a turn to refresh` |
| **Cold** | `left ≤ 0` | Red `❄ Cache cold — next turn re-caches` |

The warning and cold bands render above any output from `next(e)` (other mods/Claude Code),
so they appear at the top of the AbovePrompt area.

---

## Error Handling

- `osascript` failure: caught and ignored (non-fatal; toast still fires).
- Transcript unreadable: keep last `detectedTtl` value; never crash.
- `$.store` unavailable: fall back to atom-only detection (no cross-session persistence).
- Timer fired after a newer `turn.step`: guarded by `armedFor !== lastRequestAt` check.

---

## Not in scope

- Windows/Linux OS notifications (future: use `notify-send` on Linux, skip gracefully on Windows).
- Slack/email notifications.
- Surfacing estimated re-cache cost (could be a future enhancement).
- Full context-window forecast (that's `token-weather`'s job).
