# cache-expiry-notifier

A Claude Code mod that alerts you **X minutes before your prompt cache expires**, so you can send a turn before paying the full re-cache cost.

## What it does

- Shows a yellow **`⚠ Cache expires in M:SS — send a turn to refresh`** band above the prompt when you're inside the warning window.
- Shows a red **`❄ Cache cold — next turn re-caches`** band after expiry.
- Fires an **in-app toast** and a **macOS system notification** the moment you enter the warning window.
- Detects whether your instance uses 5-minute or 1-hour prompt caching automatically (no manual setup needed once you're on `ENABLE_PROMPT_CACHING_1H`).
- **`/keepwarm`** — opt-in keep-warm mode that automatically sends `·` before the cache expires, resetting the clock without you having to do anything.

## Installation

1. Clone or copy this folder somewhere on disk.
2. Add it to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/cache-expiry-notifier"
     }
   }
   ```

   Multiple mods: separate paths with `:`.

3. Start a new Claude Code session. Run `/config` to confirm the mod is active — you should see `cache-expiry-notifier.warnMinutes` and `cache-expiry-notifier.cacheTtl` in the list.

## Configuration

Each developer can configure independently via `/config` inside Claude Code:

| Setting | Default | Description |
|---------|---------|-------------|
| `cache-expiry-notifier.warnMinutes` | `10` | Minutes before expiry to fire the alert (min 1) |
| `cache-expiry-notifier.cacheTtl` | `auto` | Override TTL detection: `auto`, `5m`, or `1h` |
| `cache-expiry-notifier.minTokens` | `50000` | Only warn when the session holds at least this many tokens |

**Examples:**

```
/config cache-expiry-notifier.warnMinutes=5
/config cache-expiry-notifier.cacheTtl=1h
/config cache-expiry-notifier.minTokens=10000
```

## Keep-warm mode

Run `/keepwarm` inside any Claude Code session to toggle automatic cache keep-warm on or off. When enabled:

- The mod sends `·` (a single middle dot) before the cache expires, resetting the clock
- The status bar shows `🔥 keepwarm` while active
- The normal warning notification still fires so you know it happened
- If you're in the middle of a turn, the `·` is queued and sent when the turn finishes
- **Session-specific** — resets to off on `/clear` or when you start a new session

```
/keepwarm        # enable for this session
/keepwarm        # run again to disable
```

> **Keep-warm is opt-in for a reason.** It's designed for when you're actively working and step away briefly. Don't use it to keep a session alive overnight or through a long break — close the laptop and let the cache expire. Re-caching tomorrow is cheap. Your evenings are not.

## How it works

The mod hooks into three Claude Code plugin events:

- **`turn.step`** — records `lastRequestAt` each time a main-thread model response finishes. This is the moment the prompt cache is refreshed.
- **`turn.complete`** — scans the session transcript tail to detect whether the active cache TTL is 5 minutes or 1 hour, and persists it for the next session.
- **`ui.render` (AbovePrompt)** — renders the warning/cold band based on elapsed time since the last request.

A `$.clock.after` timer fires at `lastRequestAt + TTL − warnMinutes`, triggers the toast and system notification, then drives cascading redraws (every 30 s when > 10 min remain, every 15 s between 2–10 min, every 1 s in the final 2 minutes).

## Requirements

- Claude Code with plugin support (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` for tests)
- macOS for system notifications via `osascript` (toast works on all platforms)

## Development

Run the unit tests:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test /path/to/cache-expiry-notifier
```

Expected output: 40 tests, 0 failures across `ttl-detection`, `timer-notifications`, `above-prompt`, and `keepwarm` suites.
