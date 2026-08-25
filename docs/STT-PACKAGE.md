# `pi-telegram-stt` package — design + version history

> **Scope.** The repo's user-facing STT orchestrator. Bundles the
> `pi-openai-stt` provider (since v0.8.0). All configuration is
> via `telegram.json#extensions["pi-telegram-stt"]` (the section
> UI was removed in v0.10.0; see the version history below).
>
> This file is the design + history record. The implementation
> lives in `extensions/pi-telegram-stt/*.ts`; the source files
> themselves are intentionally terse (header + code, no inline
> docstring-as-design-record).

---

## 1. What the package does

Voice/audio messages arrive in Telegram. The bridge's inbound
pipeline downloads the file to a deterministic
`voice-<id>.ogg` / `audio-<id>.<ext>` path. This package does three
things:

1. **Stashes the chat ID** keyed by that filename (the
   transcription-provider API doesn't pass it, but the echo reply
   needs it).
2. **Transcribes the audio** via the configured STT provider
   (currently `pi-openai-stt`, the OpenAI-compatible gateway
   client). Returns the transcript text to the bridge.
3. **Sends a 🎙️ "show transcript" reply** to the user (when
   `showTranscript: true`), so they see the text the agent saw.

> **v0.10.0:** the `/telegram-settings` → 🎙️ STT section UI was
> removed (per the operator's 2026-08-24 directive). Both knobs
> (`showTranscript` + `stt_provider` / `base_url`) are now
> configured by editing `telegram.json` directly. The hot-reload
> watcher (200ms debounce) still picks up the change. The matching
> `pi-telegram-tts` section UI was also removed.

---

## 2. Files (6 source files, ~1200 lines total)

| File | Lines | Purpose |
|---|---:|---|
| `index.ts` | 118 | Entry point. Wires the STT handlers, the config watcher, and the module-load provider registration. |
| `echo-handler.ts` | 237 | The two extension points: `registerTelegramUpdateHandler` (chat-ID stash) + `registerTelegramVoiceTranscriptionProvider` (transcribe + echo). |
| `openai-stt.ts` | 363 | The OpenAI `/v1/audio/transcriptions` HTTP client + the bundled `pi-openai-stt` provider registration. |
| `telegram-config.ts` | 117 | `telegram.json#extensions["pi-telegram-stt"]` reader + atomic writer. |
| `stt-provider.ts` | 76 | The `SttProvider` contract + `globalThis`-backed registry. |
| `_logger.ts` | 92 | stderr logger, shared with `pi-telegram-tts`. |

`README.md` (~5.8 KB) is the operator-facing doc. `package.json`
declares the npm metadata.

---

## 3. Version history

### v0.11.0 (2026-08-24) — drop the in-package config writer
- **`saveEchoConfig` deleted.** Per the operator's design rule
  (every config knob lives in `telegram.json`, edited by the
  operator or agent via filesystem tools, picked up live by
  the 200ms hot-reload watcher): the in-package atomic-write
  helper is no longer needed. The agent's own `read`/`write`
  tools are the canonical surface. The sister tts package made
  the same call in its v0.6.0 release
- `telegram-config.ts` shrunk to a pure reader: `loadEchoConfig()`
  + the `EchoConfig` interface + the `DEFAULTS` constant. The
  `writeFileSync` + `renameSync` imports were dropped
- **Smoke unchanged** (7 stages, 0 → 7). The writer was never
  exercised by the smoke (it was section-UI code)
- The `EchoConfig` type stays exported; it's the package's
  internal config interface at call time
- The drop is internal: `saveEchoConfig` was an internal export
  not advertised in the README. No public API surface change
- The pre-v0.11.0 `saveEchoConfig` body (atomic temp+rename,
  preserving other `extensions` blocks + the bridge-owned
  `voice` block) is preserved in git history for reference

### v0.10.0 (2026-08-24) — drop the section UI
- **`section.ts` deleted.** The `/telegram-settings` → 🎙️ STT
  section was removed per the operator's 2026-08-24 directive
  (the same directive removed the matching `pi-telegram-tts`
  section). The form-driven UI was more trouble than the
  `telegram.json`-driven config for a single-operator setup —
  the agent can edit `telegram.json` on the fly via its existing
  `read`/`write` tool calls, and the hot-reload watcher picks up
  the change in ~200ms
- **`index.ts` simplified**: dropped the `piTelegramSttSection(pi)`
  import + call. The package is now section-less (matches
  `pi-telegram-tts` post-v0.4.0). The provider registration
  remains module-lifetime (no per-session state to reset; no
  `session_shutdown` unregister)
- **Smoke test grew 6 → 7 stages**: stage 7 verifies `section.ts`
  + `section.js` are gone and `index.ts` does not import them
  (mirrors the tts smoke's stage 16)
- **Package size**: 1196 → ~1121 lines (-6%, mainly the deleted
  `section.ts`)

### v0.9.0 (2026-08-24) — section rename + dead code removal + flow refactor
> **Note (added in v0.10.0):** the section work here was a
> 1-day experiment; the operator found the form UI cumbersome
> and reverted the whole section UI in v0.10.0. The dead-code
> removal + flow refactor + comments-to-docs work is preserved.
- **Section id + label renamed**: `id: "pi-telegram-stt/echo"` →
  `id: "pi-telegram-stt"`, label `"🎙️ Echo"` → `"🎙️ STT"`,
  dynamic menu label `"🟢 Echo · <provider>"` → `"🟢 STT · <provider>"`.
  Per `docs/sections.md` §3 (package name verbatim, no sub-path
  for single-section packages). **Breaking change** for any
  operator with a bookmarked button on the old id — the bridge
  surfaces "This section is no longer available" and the
  operator just re-opens `/telegram-settings`
- The "Echo" verb is kept on the **toggle button** + answerCallback
  (the action is the echo sub-feature inside the STT section)
- **Default-export factory** in the section file with
  `pi.on("session_shutdown", () => unregister())` cleanup
  colocated, per `docs/sections.md` §4
- **`ctx.edit(...)` re-renders** the settings card + toggle button
  label in place (per `docs/sections.md` §8). Fixes the
  pre-existing stale-UI bug where the menu label changed but
  the toggle button text didn't until the user navigated back
  and re-entered
- The default-export factory defers the `registerTelegramSection`
  call to `session_start` because the bridge's section registry
  isn't populated at jiti-load time (the v0.2.0 plan's "Module-
  load safety" section; the live test on 2026-08-24 surfaced
  this exact error before the fix)
- **Dead code removed**: the legacy `echoEnabled` reader
  (v0.7.1→v0.7.2 migration window closed), the legacy
  `extensions["pi-openai-stt"]` block reader (v0.7.x→v0.8.0
  migration window closed), the dead exported
  `handleTelegramVoiceTranscription` test entry, and 7 of 9
  unreachable mime types in `guessExtensionFromMime`
- **Comments moved to docs** (`docs/STT-PACKAGE.md`): 150-line
  version history, 54-line Design + Public APIs section, the
  84-line `openai-stt.ts` file header, the 34-line
  `telegram-config.ts` file header, the 52-line
  `stt-provider.ts` file header, the 58-line `section.ts` file
  header. Source files are now header + code, no inline
  docstring-as-design-record
- **Flow optimization** (3 lifecycles): the STT provider is
  module-lifetime (the `globalThis`-backed registry keeps it
  visible for the agent's whole lifetime; module-load
  registration with an unregister-then-register idempotent
  pattern handles both cold-start and hot-reload). The section
  + handlers + config watcher remain session-lifetime (the
  section token is session-scoped; the handler closures capture
  per-session config). The `chatIdByFileName` map is
  per-transcription
- Dropped the `session_start` re-registration defensive block
  (was dead — module-load + hot-reload already handle it) and
  the `session_shutdown` unregistration of the STT provider
  (was unnecessary — provider is stateless, no per-session
  reset needed)
- **Package size**: 1839 → 1196 lines (-35%)

### v0.8.0 — subsume `pi-openai-stt` into this package
- The OpenAI-compatible STT provider (previously in a separate
  `pi-openai-stt` npm package) is now bundled. The
  `extensions["pi-telegram-stt"]` block gained flat `base_url`
  and `apiKey` keys (the legacy `extensions["pi-openai-stt"]`
  block was a read-only fallback for the migration window; the
  user was the only operator and migrated, so the fallback is
  removed in v0.8.1)
- The `SttProvider` interface in `stt-provider.ts` stays as a
  private in-package seam for future backends

### v0.7.2 — `echoEnabled` → `showTranscript` rename
- The field was renamed for naming symmetry with the bridge's
  `voice.sendTranscript` (which gates the *outbound* TTS caption)
- The reader accepted the old `echoEnabled` key as a fallback
  during the migration window; the fallback is removed in v0.8.1
  (the user is the only operator and migrated)

### v0.6.0 — retire `pi-whisper-stt`
- The default `stt_provider` flipped from `"pi-whisper-stt"` to
  `"pi-openai-stt"`
- `pi-whisper-stt` covered every backend via the
  `fw-openai-sts` shim; new backends became "another
  `base_url` value", not "another `pi-<backend>-stt` package"

### v0.4.5 — fallback chain for `base_url`
- `base_url` accepts a `string[]` of gateway URLs tried in
  order. The first non-empty transcript wins; empty results and
  `OpenAiSttError`s both fall through. The natural on-host
  shape is `["http://127.0.0.1:8081/v1",
  "https://api.openai.com/v1"]` — local first, cloud second

### v0.4.4 — `telegram.json` as the primary config source
- `base_url` and `apiKey` are read from
  `telegram.json#extensions["pi-telegram-stt"]` before env vars
  and `auth.json` fallback. Recommended way to switch between
  local and cloud is a one-line `telegram.json` edit

### v0.4.3 — strip `language` for OpenAI's actual API
- OpenAI's Whisper API rejects `yue` (Cantonese) with HTTP 400
  even though it's a valid ISO 639-1 code; auto-detect handles
  Cantonese correctly. The local shim and other gateways keep
  `language`
- The check is host-based: only `api.openai.com` strips
  `language`. Custom gateways on a different host keep it

### v0.4.2 — `auth.json` fallback for the API key
- Read `OPENAI_API_KEY` from `~/.pi/agent/auth.json` as a
  fallback. Operators who already have the key in `auth.json`
  (the LLM provider reads the same file) don't need a separate
  env var for STT

### v0.4.0 — `pi-openai-stt` as a peer-dep provider
- The same STT contract (`SttProvider`, looked up at call time
  from a `globalThis`-backed registry) now works against
  OpenAI-compatible API gateways: the on-host CUDA
  `whisper-server` (via the `fw-openai-sts` shim), OpenAI's
  actual API, `faster-whisper-server`, `whisper-asr-webservice`,
  any other OpenAI-compatible gateway

### v0.3.1 — fix the v0.3.0 load-order race
- v0.3.0 registered the provider on `session_start`. The on-host
  test surfaced a race: `pi-telegram-stt` session_start fired
  first (registering the echo handler), the bridge processed a
  voice message, and the STT provider's session_start fired
  LATER
- v0.3.1 moves the provider registration to module load
  (top-level side effect); jiti evaluates the file synchronously,
  so the provider is in the registry before any `session_start`
  fires
- The registry moved from a per-jiti-instance `Map` to a
  `globalThis`-backed registry (mirroring the bridge's
  `lib/sections.ts:267-271` pattern), so the provider is visible
  across all jiti instances in the same Node process

### v0.3.0 — STT provider standardization
- The hardcoded `whisper-stt.ts` is replaced with a registry
  lookup: the configured `stt_provider` is looked up at STT
  call time in the in-process registry
- The section UI (later removed in v0.10.0) gained a "STT
  provider" picker that lists installed providers
- Adding a new STT backend = a new `pi-<backend>-stt` package
  that implements `SttProvider`, OR a new `base_url` value if
  the backend already speaks the OpenAI gateway convention

### v0.2.0 — port from the v0.1.0 scaffold to a working STT path
- The configurable `stt.command` indirection was replaced with a
  hardcoded call to the STT provider's `transcribe()`
- The section UI (later removed in v0.10.0) was simplified to a
  single `showTranscript` toggle (STT command presets removed)

### v0.1.0 — initial scaffold
- Configurable `stt.command` (argv spawn) + STT command presets
  in the section UI (later removed in v0.10.0)

---

## 4. Public APIs used (all stable per `@llblab/pi-telegram`)

| API | Source | Role |
|---|---|---|
| `registerTelegramVoiceTranscriptionProvider` | `@llblab/pi-telegram/voice` | The STT seam |
| `registerTelegramUpdateHandler` | `@llblab/pi-telegram/updates` | Chat-ID stash |
| `sendTelegramView` | `@llblab/pi-telegram/delivery` | Echo reply |
| `recordTelegramRuntimeEvent` | `@llblab/pi-telegram/outbound` | Diagnostics |
| `ExtensionAPI`, `getAgentDir` | `@earendil-works/pi-coding-agent` | Extension lifecycle + path resolution |

---

## 5. Config resolution (OpenAI STT)

**Resolution order (first non-empty wins):**

1. Explicit `OpenAiSttArgs.baseUrl` / `apiKey` (test path)
2. `extensions["pi-telegram-stt"].base_url` / `.apiKey` in
   `telegram.json` (recommended for live config)
3. `OPENAI_STT_BASE_URL` / `OPENAI_API_KEY` env vars
4. `auth.json` → `openai.key` (only for the API key; the base
   URL has no auth.json equivalent)
5. Smart default: `https://api.openai.com/v1` if a key is
   resolvable from any of the above, else the local shim
   `http://127.0.0.1:8081/v1`

**Other env vars (no `telegram.json` equivalent — env-only):**
- `OPENAI_STT_MODEL` (default `whisper-1`)
- `PI_TELEGRAM_LANG` (default `yue`)

---

## 6. Error taxonomy

`OpenAiSttError` carries a `code: 1|2|3|4`:
- `1` usage / validation
- `2` network (timeout, DNS, connection refused)
- `3` API client (HTTP 4xx, or malformed response)
- `4` API server (HTTP 5xx)

The provider in `openai-stt.ts` re-wraps `OpenAiSttError` as
`ProviderError` to keep the registry's `code: 1|2|3|4` taxonomy
consistent across all STT providers and the old monolithic's
`WhisperSttError`. The bridge's `recordTelegramRuntimeEvent`
receives the error with the same code taxonomy, so the
operator's `telegram-status` view is consistent across
providers.

---

## 7. Runtime-event categories (separate namespace from `id`)

- `pi-telegram-stt/stt` — `provider-missing`, `run` (transcribe
  failure)
- `pi-telegram-stt/echo` — `send` (echo reply failure)

These are independent of the now-removed section UI. They were
the runtime-event categories when the section existed (renamed
in v0.9.0 from `pi-telegram-stt/echo` to `pi-telegram-stt`); the
section was removed in v0.10.0 but the runtime-event categories
are a separate namespace defined in the bridge's outbound
pipeline, so the `pi-telegram-stt/stt` and `pi-telegram-stt/echo`
strings stay.

---

## 8. Lifecycle

Three lifecycles, each with its own scope:

| Resource | Scope | Why |
|---|---|---|
| `pi-openai-stt` provider registration | **Module lifetime** | Stateless; `transcribe()` reads config live; the `globalThis`-backed registry persists for the agent's whole lifetime. Module-load registers it once; hot-reload re-runs the module and re-registers. No per-session re-register or unregister. |
| Handlers + config watcher | **Session lifetime** | The handlers' closure captures `cfg.showTranscript` + `cfg.stt_provider` which the watcher refreshes on `telegram.json` change. `session_start` binds them; `session_shutdown` disposes them. |
| `chatIdByFileName` map | **Per-transcription** | Populated by the update handler, consumed by the STT provider, deleted in the provider's `finally`. Bounded by in-flight transcriptions. |

```
agent start (jiti load)
  └─ registerOpenAiSttProvider()  [module-lifetime; idempotent]
  └─ piTelegramStt(pi)  [default export]
session_start
  ├─ reconfigureHandlers()  [bind the echo + STT provider closures]
  └─ startConfigWatcher()  [fs.watch telegram.json (200ms debounce)]
voice message
  └─ handleTelegramUpdateForEcho  [stash chat ID]
  └─ transcribeAndMaybeEcho  [provider.transcribe() + 🎙️ echo reply]
telegram.json change
  └─ reloadTimer (200ms debounce) → reconfigureHandlers()
session_shutdown
  ├─ dispose handlers + close watcher
  └─ (STT provider STAYS registered; no per-session reset needed)
```

---

## 9. Required host-side runtime (NOT bundled)

- `ffmpeg` is not required for STT (only TTS). The bridge
  downloads voice/audio files directly.
- A reachable STT endpoint. Defaults:
  - `https://api.openai.com/v1` if a key is resolvable
  - `http://127.0.0.1:8081/v1` (the local `fw-openai-sts` shim)
    otherwise
- The bridge's `telegram.json#inboundHandlers` should be empty
  so this extension is the only STT path.
