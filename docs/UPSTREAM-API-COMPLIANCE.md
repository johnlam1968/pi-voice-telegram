# Upstream API compliance audit

Periodic compliance check: do the local extensions use the **stable public
APIs** of the upstream `@llblab/pi-telegram` bridge and the
`@earendil-works/pi-coding-agent` runtime, and follow the design
principles those upstreams document? This doc records the findings.

The upstreams are moving targets. Re-run this audit when any of:

- `@llblab/pi-telegram` ships a new public API membrane (currently under
  `api/{voice,outbound,inbound,updates,sections,status,delivery,commands,keyboard,activity}.ts`).
- `@llendil-works/pi-coding-agent` ships a new `ExtensionAPI` method or
  event (`docs/extensions.md` is the canonical reference).
- The operator upgrades the bridge or runtime and the local extension
  stops loading or starts emitting `provider-missing` runtime events.

The audit is purely about *which surface* is used, not about runtime
behavior — the smoke tests
(`scripts/mmx-tts-smoke-test.sh`, `scripts/dev-status.sh`) cover the
latter.

## Scope

| Local artifact | Upstream surface it depends on | Authority |
|---|---|---|
| `extensions/pi-telegram-stt/index.ts` | `ExtensionAPI` (factory shape) | `extensions.md` |
| `extensions/pi-telegram-stt/echo-handler.ts` | `@llblab/pi-telegram/{voice,updates,outbound,delivery}` | `docs/voice.md` |
| `extensions/pi-telegram-stt/echo-section.ts` | `@llblab/pi-telegram/sections` | `docs/sections.md` |
| `extensions/pi-telegram-stt/telegram-config.ts` | `getAgentDir` from `@earendil-works/pi-coding-agent` | `dist/config.js` |
| `extensions/pi-telegram-stt/stt-provider.ts` | (local contract; not a public API) | n/a |
| `extensions/pi-openai-stt/index.ts` | `ExtensionAPI` (factory shape) | `extensions.md` |
| `extensions/pi-openai-stt/openai-stt.ts` | `getAgentDir` from `@earendil-works/pi-coding-agent` | `dist/config.js` |
| `extensions/pi-voice-telegram-scripts/*` | (CLI scripts; not Pi extensions) | n/a |

The `pi-voice-telegram-scripts` package is **not** a Pi extension — it
ships CLI scripts (`tts-minimax.mjs`, `tts-openai.mjs`,
`fw-openai-sts.ts`) that the bridge's
`telegram.json#outboundHandlers[0].template` invokes by absolute path
per `docs/TTS-VIA-OUTBOUND-HANDLERS.md`. They are not subject to the
extension-API audit; their contract is the bridge's command-template
placeholder surface, documented in
`docs/TTS-VIA-OUTBOUND-HANDLERS.md`.

## Findings — 2026-08-23 audit

Upstream versions checked against:
- `@llblab/pi-telegram` v0.35.2 (`/home/john/.pi/agent/npm/node_modules/@llblab/pi-telegram/package.json`)
- `@earendil-works/pi-coding-agent` (v0.80.6+ family, `dist/config.js`)

### 1. Public API surface usage — `pi-telegram-stt`

| Bridge API | Used as | Compliance |
|---|---|---|
| `registerTelegramSection` from `@llblab/pi-telegram/sections` | One-time section registration; `id: "pi-telegram-stt/echo"`; reads `loadEchoConfig()` live on every render | ✅ matches `docs/sections.md` §3–§4 |
| `registerTelegramUpdateHandler` from `@llblab/pi-telegram/updates` | Chat-ID stasher (low-level handler bus, no id) | ✅ matches `docs/public-api.md` (low-level bus, id-less by design) |
| `registerTelegramVoiceTranscriptionProvider` from `@llblab/pi-telegram/voice` | Stable provider with `{ id: "pi-telegram-stt/stt" }` | ✅ matches `docs/voice.md` "Stable provider registrations pass a durable `id` in options" |
| `recordTelegramRuntimeEvent` from `@llblab/pi-telegram/outbound` | Surface diagnostics | ✅ matches `docs/voice.md` example + upstream `TelegramRuntimeEventRecorder` signature |
| `sendTelegramView` from `@llblbl/pi-telegram/delivery` | Send 🎙️ echo | ✅ matches `docs/public-api.md` Programmatic API Matrix |

Pattern compliance:
- ✅ **Module-load provider registration** — `pi-openai-stt/index.ts` registers the STT provider at the top level (synchronous side effect during jiti load), avoiding the load-order race documented in `pi-telegram-stt/index.ts` v0.3.1 history. This is the same pattern `docs/voice.md:42` documents.
- ✅ **`globalThis`-backed registry** — the in-process STT provider registry lives on `globalThis.__piTelegramSttProviderRegistry__`, matching the bridge's own pattern in `lib/sections.ts:267-271`.
- ✅ **Section id shape** — `"pi-telegram-stt/echo"` uses npm-style package identity per `docs/sections.md` §3 (the package name is the owner identity).
- ✅ **Error taxonomy** — `ProviderError.code: 1|2|3|4` (1=usage, 2=network, 3=4xx, 4=5xx) matches the bridge's existing `WhisperSttError` shape and the upstream `recordTelegramRuntimeEvent` consumers' expectations.

### 2. Public API surface usage — `pi-openai-stt`

| Runtime API | Used as | Compliance |
|---|---|---|
| `ExtensionAPI` from `@earendil-works/pi-coding-agent` | Default factory function `(pi) => { ... }` | ✅ matches `docs/extensions.md` "Extension Styles" |
| `pi.on("session_start")`, `pi.on("session_shutdown")` | Session lifecycle hooks | ✅ matches `docs/extensions.md` Session Events |
| `getAgentDir` from `@earendil-works/pi-coding-agent` | Resolves `~/.pi/agent` honoring `PI_CODING_AGENT_DIR` | ✅ matches `dist/config.js:412-418` |

### 3. Path-resolution helper consistency

The two extensions used to resolve `~/.pi/agent` differently:

- `extensions/pi-telegram-stt/telegram-config.ts:40` —
  `process.env.PI_CODING_AGENT_DIR ?? getAgentDir()`.
- `extensions/pi-openai-stt/openai-stt.ts:149,190` —
  `process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")`.

This was a **deviation** flagged in the 2026-08-23 audit. The two
implementations are behavior-equivalent (`getAgentDir()` honors
`PI_CODING_AGENT_DIR` internally at `dist/config.js:413-416`), but the
duplication is a design smell — two ways to spell the same thing in
the same repo is a future drift hazard.

**Resolution applied** (commit e041931 follow-up):
`extensions/pi-openai-stt/openai-stt.ts` now uses `getAgentDir()`
directly, matching the sibling file. The redundant
`process.env.PI_CODING_AGENT_DIR` env-var check in
`telegram-config.ts:40` could be simplified in a follow-up, but is
left as-is to keep this audit's diff scope minimal.

**Behavioral equivalence proof** (verification log):

```text
default getAgentDir():           /home/john/.pi/agent
with PI_CODING_AGENT_DIR=/tmp:   /tmp
old impl:                        /tmp
new impl:                        /tmp
equivalent:                      true
```

### 4. No other deviations found

The following upstream-canonical patterns are observed correctly:

- **Hot-reload strategy** — `pi-telegram-stt/index.ts` watches the
  agent dir on `telegram.json` changes (200ms debounce, sibling-write
  guard via `filename === baseName`) and re-registers the handlers
  only, leaving the section registration alone (the bridge mints a
  fresh token on each `registerTelegramSection` call, so re-registering
  would stale the in-Telegram menu buttons — `docs/sections.md` §5).
- **Self-contained packages** — every extension bundles its own
  `_logger.ts` rather than sharing one at the repo root, so each
  npm-published package is plain-`npm install`-able (the README
  documents this as a v0.7.0 / v0.3.0 design decision).
- **Outbound template fidelity** — the scripts are invoked by absolute
  path with `{text}`, `{mp3}`, `{ogg}` placeholders per
  `docs/TTS-VIA-OUTBOUND-HANDLERS.md` and the bridge's
  `command-templates.ts` substitution surface.
- **Error exit-code model** — the scripts exit 2 (caller config), 3
  (API/HTTP), 4 (write failed) so `recordTelegramRuntimeEvent`
  consumers can correlate the failure mode from stderr.

### 5. Pre-existing unrelated issues (NOT addressed by this audit)

- `scripts/mmx-tts-smoke-test.sh:213` references
  `$(dirname "$0")/tts-minimax.mjs`, which resolves to
  `scripts/tts-minimax.mjs` (does not exist since the v0.19.0 split
  moved the script to `extensions/pi-voice-telegram-scripts/`). The
  smoke test was already broken before this audit. Fixing the path
  reference is a separate, non-audit task.

## Re-running this audit

```bash
# Confirm the bridge is alive and the extensions are loaded.
bash scripts/dev-status.sh | head -20

# Confirm the public API imports still resolve.
node -e "
import('/home/john/.pi/agent/npm/node_modules/@llblab/pi-telegram/api/voice.ts')
  .then(m => console.log('voice ok:', Object.keys(m).sort().join(',')))
  .catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"

# Confirm the extension modules load (validates all the imports).
node -e "
import { createJiti } from './node_modules/jiti/lib/jiti.mjs';
const jiti = createJiti(import.meta.url, { interopDefault: true, esmResolve: true });
for (const p of [
  './extensions/pi-telegram-stt/index.ts',
  './extensions/pi-telegram-stt/echo-handler.ts',
  './extensions/pi-telegram-stt/echo-section.ts',
  './extensions/pi-telegram-stt/stt-provider.ts',
  './extensions/pi-telegram-stt/telegram-config.ts',
  './extensions/pi-openai-stt/index.ts',
  './extensions/pi-openai-stt/openai-stt.ts',
]) {
  await jiti.import(p);
  console.log('ok:', p);
}
"
```

When an upstream public API membrane is added, renamed, or deprecated,
update the **Findings** table above with the new symbol name and the
revision date.

## Related docs

- `archive/docs/PI-TELEGRAM-BRIDGE-NOTES.md` — historical bridge
  integration notes (untracked, agent-john workspace reflections).
- `docs/DESIGN-INTENT.md` — the package's own design decisions (the
  "we said no to X because Y" record), distinct from this upstream-
  compliance audit.
- `docs/DEBUGGING.md` — runtime log surface, for daily operation.
