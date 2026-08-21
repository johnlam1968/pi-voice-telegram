# Debugging the Pi + Telegram stack

A map of every log the system produces, where it lives, what it
contains, and how to read it for daily development. Pair this with
`scripts/dev-status.sh` (one-shot snapshot) and `scripts/dev-watch.sh`
(continuous tail across all streams).

All paths are relative to `~/.pi/agent/` unless noted. Override the
agent dir with `$PI_CODING_AGENT_DIR`.

## TL;DR — when something goes wrong, run these in order

```bash
# 1. Is pi alive? What's the bridge doing?
scripts/dev-status.sh

# 2. Watch all streams live
scripts/dev-watch.sh

# 3. Capture a TUI snapshot (TUI rendered state + last messages)
#    Type `/debug` in the pi REPL. Writes to pi-debug.log.
```

## Log surface

| File | Producer | Captures | When to look |
|---|---|---|---|
| `tmp/telegram/logs.jsonl` | bridge (via `recordTelegramRuntimeEvent`) | structured runtime events: voice, delivery, lock, bus, polling, api | "what did the bridge just do" |
| `tmp/telegram/state.json` | bridge (snapshot) | lock state, polling phase, recent runtime events, roster, sync state | "is the bridge alive and polling" |
| `tmp/telegram/owners.json` | bridge (lock) | the active leader's pid, cwd, instanceId, heartbeat | "who is the current pi" |
| `tmp/telegram/inbox.json` | bridge | pending unprocessed updates | "is a message stuck in the queue" |
| `tmp/telegram/inbox.json.segments/` | bridge | per-update journal segments | "what's been processed" |
| `sessions/<cwd-hash>/*.jsonl` | agent (via `recordTelegramRuntimeEvent` for session_start/shutdown; also message log) | every message between user and agent, tool calls, tool results, model changes, runtime events | "what did the agent think / call" |
| `pi-crash.log` | agent (on crash) | full TUI state at the moment of a fatal error | "why did pi die" |
| `pi-debug.log` | agent (via `/debug` slash command) | rendered TUI lines + last messages sent to the LLM | "what is the user looking at + what was the last LLM call" |
| `tmp/<extension>/<run-id>.json` | various extensions | tool results, downloaded attachments | "did the extension produce any output" |
| `tmp/cantonese-lyrics/`, `tmp/<your-extension>/` | ad-hoc extension output dirs | whatever the agent/extension wrote | "what did this last run produce" |
| stderr of the `pi` process | agent + every extension + every spawned command | everything you `console.log`/`console.error`, plus agent internals on debug | "what is the live stream of what's happening" |
| stderr of the `tts-minimax.mjs` script (this repo) | the script itself, via our `_logger.ts` extensions' logger | per-step trace of the TTS request/response, with `--verbose`/`PI_VOICE_TELEGRAM_DEBUG=1` for DEBUG | "did my TTS request reach the API, what came back" |

## What each bridge log event means

`logs.jsonl` events have a `kind` and a `category`. The categories the
operator cares about:

- **`lock`** — bridge lock state changes (auto-start, leader election). Almost always informational.
- **`bus`** — leader/follower bus events (topic mode, reconnections). Errors here = the bridge can't talk to itself.
- **`polling`** — `getUpdates` long-poll timeouts. Periodic; ignore.
- **`api`** — Telegram API call errors. Look at `details.method` + `details.status`.
- **`voice`** — outbound voice synthesis events. Tells you which provider was tried, which step failed.
- **`delivery`** — final delivery events. `phase: "voice-artifacts"` is the actual `sendVoice` call.
- **`echo`** — STT echo (when the bot replies to your voice with a transcript before the agent processes it).
- **`text`** — final text delivery events.

The runtime event log has been observed to **freeze** (last seen:
2026-08-21 17:00 EDT, where the log was last modified at 14:44 but
the bridge was still synthesizing and sending voice messages). When
that happens:

1. `state.json.recentRuntimeEvents` may also be stale (it's a
   in-memory ring + a periodic snapshot).
2. The bridge IS doing work — just not logging it. Verify with
   `dev-status.sh` (checks the live process and file mtimes) and
   `state.json.runtime.polling`.
3. **The agent's stderr is the canonical observability channel**
   when `logs.jsonl` is frozen. Run with `PI_VOICE_TELEGRAM_DEBUG=1`
   in the environment to get DEBUG-level structured stderr from
   every extension.

## Session log

The agent's session is the single most useful log for "what did the
agent think". It's a JSONL with the full message history.

The session file is keyed by `cwd` and `sessionId`. To find the
current session:

```bash
ls -lt sessions/--home-john--/  # sorted by modification time
```

The first column is `type` (`session`, `model_change`, `thinking_level_change`, `message`).
For `message` entries, the second is the role (`user`, `assistant`).
For assistant messages, look for:
- `content[].type === "text"` — the actual response
- `content[].type === "thinking"` — internal reasoning
- `content[].type === "toolUse"` — tool call (input, name)
- `content[].type === "toolResult"` — tool result (the agent's `bash`/`read`/`edit` outputs)

To trace a single turn end-to-end:
1. Find the user's voice turn in the session (look for `[voice] delivery: automatic voice` in the user message)
2. Walk forward through the assistant's `toolUse`/`toolResult` chain
3. The final `text` is what the agent decided to send
4. The bridge's `voice` / `delivery` events for that chat_id tell you whether the TTS pipeline ran

## `/debug` output

`/debug` in the TUI writes `pi-debug.log`. The file is OVERWRITTEN on
each invocation. To capture a snapshot before something interesting
happens, copy it elsewhere first.

The file contains:
- A header with timestamp and terminal dimensions
- Every rendered TUI line as `[idx] (w=N) "<line content>"`
- Every agent message as raw JSONL (one per line, no header)
- A blank line at the end as a separator

`/debug` is hidden (not in the help). The user has to know to type
it. This is by design — `/debug` is a development tool, not a
production tool.

## When things go silent

Symptom: bridge log is frozen, but you expect events.

1. `scripts/dev-status.sh` — checks process, lock state, polling
2. `state.json.runtime.polling.lastSuccessfulResponseUpdateCount` — if
   0 for hours, the bridge isn't seeing Telegram updates
3. The bridge's `bus.sock` — if missing, the leader/follower IPC is
   broken (the bridge can't actually send messages, only queue them)
4. The agent's stderr — set `PI_VOICE_TELEGRAM_DEBUG=1` to get
   extension lifecycle events

## Correlating events across logs

A single turn produces events in:
1. `inbox.json` (admission)
2. `sessions/<cwd>/<session>.jsonl` (the message itself)
3. The agent's stderr (extension events, our `log.*` calls)
4. `tmp/telegram/logs.jsonl` (bridge runtime events, when not frozen)
5. `tmp/<bridge>/<file>.ogg` or `.mp3` (TTS output, if voice reply)

To find a specific chat_id across all of these:
```bash
chat_id="8242625420"
grep -l "$chat_id" tmp/telegram/logs.jsonl sessions/--home-john--/*.jsonl 2>/dev/null
```

## Extending the log surface

When adding observability to a new module:

- **TypeScript extensions** — use the `makeLogger(tag)` helper from
  `extensions/_logger.ts`. The log goes to stderr, which the agent
  captures and surfaces in the terminal. Set
  `PI_VOICE_TELEGRAM_DEBUG=1` to enable DEBUG level. Levels: DEBUG,
  INFO, WARN, ERROR.
- **Shell / Node scripts** — the `tts-minimax.mjs` script has an
  inline logger at the top. Use `--verbose` or
  `PI_VOICE_TELEGRAM_DEBUG=1` for DEBUG. Same format.
- **Bridge-level events** — call
  `recordTelegramRuntimeEvent(category, error, details)` from
  `@llblab/pi-telegram/outbound`. Goes to `logs.jsonl` (when not
  frozen) AND `state.json.recentRuntimeEvents` (the in-memory ring).

The bridge's runtime event log (`logs.jsonl`) is NOT a substitute for
your own stderr logging — it's been observed to freeze. The canonical
channel is stderr; the bridge's own log is a secondary signal that
should be debugged separately when it's missing.
