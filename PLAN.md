# Plan: `pi-voice-telegram`

**Status:** v0.16.2 shipped. v0.6.0 added companion settings + LLM tool surface. v0.7.0 made the settings file auto-seed on first run. v0.8.0 moved per-extension TTS/STT defaults into the JSON and templated prompt text against the resolved tool name. v0.9.0 made the settings file self-describing via a JSON Schema. v0.10.0 added the `pi_voice_telegram_schema` tool. v0.11.0 added the agent-modifies-config opt-in (config_read + config_write). v0.12.0 dropped the fake-security `tools.writable` flag and added a config_reset tool. v0.13.0 made the reset tool schema-driven (fills missing fields with schema defaults) and updated the config tool promptGuidelines to encourage proactive evolution. v0.14.0 added hot-reload of the companion settings file via `fs.watch` on the containing directory (with 200ms debounce). v0.15.0 added the seventh LLM tool, `pi_voice_telegram_list_voices`, backed by an embedded `voices.json` catalog (327 MiniMax TTS voices × 24 languages). v0.16.0 added inline TTS self-check via whisper-stt language detection — every synthesis is verified, result logged under `pi-voice-telegram/tts-verify`. v0.16.1 fixed the config_reset prompt so "reset config" maps directly to the tool without clarifying, and removed a stale "restart required" line from the description. v0.16.2 fixed the echo STT path: (1) echo.ts now consumes the JSON's `stt.lang` / `stt.baseUrl` / `stt.timeoutMs` via a new `setSttDefaults()` hook called by `index.ts`'s reconfigure (was reading `PI_TELEGRAM_STT_TIMEOUT_MS` from env directly — the v0.8.0+ design is "JSON > env > hardcoded" but v0.16.1's echo.ts skipped the JSON layer), and (2) a one-shot fallback retry when the primary STT result is empty, <2 chars, or punctuation-only — retries without the lang hint so whisper auto-detects, which produces verbatim Cantonese consistently per the 2026-08-17 probes.

## What this is

A Telegram voice/text companion extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono) and the [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) bridge. Sits in the agent's npm tree next to the bridge, registers a TTS synthesis provider (mm-tts-backed), and an inbound voice echo pipeline (whisper-server-backed). In v0.6.0, optionally exposes `synthesize_voice` and `transcribe_audio` as agent-callable tools.

## Current state (v0.6.0)

```
index.ts                 — entrypoint. Reads companion config, registers
                           TTS provider + (optionally) inbound echo + (optionally) tools.
synthesis-provider.ts    — bridge-side TTS provider. Reads telegram.json
                           on every call for layered voice/lang/model defaults.
                           Returns oggPath or { audioPath, transcriptText }.
echo.ts                  — inbound STT + echo pipeline. Per-session
                           transcript cache; single-STT design.
voice-reply.ts           — in-process TTS orchestrator: mm-tts (WAV) →
                           ffmpeg (libopus) → oggPath.
mm-tts.ts                — MiniMax T2A HTTP client (in-process, was a
                           Node CLI in v0.1.0, bash in earlier versions).
whisper-stt.ts           — whisper-server STT HTTP client (in-process,
                           was a bash wrapper `fw-cuda-stdout`).
config.ts                — companion settings loader. Reads
                           ~/.pi/agent/pi-voice-telegram.json with
                           graceful fallback. v0.7.0+: auto-seeds a
                           safe default when the file is missing.
tools.ts                 — synthesize_voice + transcribe_audio tool
                           registrations. v0.6.0. Opt-in.
PLAN.md                  — this file.
```

## Decisions (locked)

1. **Package name:** `pi-voice-telegram`
2. **Bridge owns `voice.replyMode` and `voice.sendTranscript`.** The companion extension reads these (via `synthesis-provider.ts`) but does not own them. The companion owns its own settings file: `~/.pi/agent/pi-voice-telegram.json`.
3. **TTS delivery for the LLM tool is a two-step pattern.** `synthesize_voice` writes an OGG/Opus file and returns the path. The agent then calls the bridge's `telegram_attach` tool to deliver. This keeps chat-target resolution, captioning, and multipart-upload concerns in the bridge, where they belong.
4. **Companion settings file is opt-in.** Absent or malformed file = current default behavior (echo on, tools off). No migration needed.
5. **Tool surface is gated on `tools.enabled`, not on `voice.replyMode`.** A user might want `synthesize_voice` available even when the bridge is doing auto-voice (`replyMode: "always"`) for ad-hoc voice (e.g. reading a file aloud). Gating on `replyMode` would make the tool mysteriously disappear when the operator flips a bridge setting they may not associate with the LLM tool.

## Important discoveries

### 2026-08-15: the "text + voice as two messages" is what the bridge does

`lib/delivery.ts` (in the bridge) shows `TelegramDeliveryView` is text-only. The bridge's `assistant.proactivePush` projects the final assistant text as one Telegram message; the bridge's voice flow (driven by `telegram_voice` markup or `voice.replyMode = "always"`) calls the registered synthesis provider, then sends the voice as a **separate** Telegram message. With `voice.sendTranscript = false`, the voice message has no caption.

So the original design intent — text + voice as two messages — is achieved by the **existing bridge behavior** with this config:

```json
{
  "voice": { "replyMode": "always", "sendTranscript": false },
  "assistant": { "proactivePush": true }
}
```

No custom code is needed for the core "text + voice as two messages" feature. The extension just registers the synthesis and transcription providers. This was a significant simplification of v0.1.0.

### 2026-08-16: the bridge already exposes `telegram_attach`

`@llblab/pi-telegram/lib/outbound-attachments.ts:439` registers a `telegram_attach` tool that handles `sendVoice` / `sendAudio` / `sendDocument` multipart uploads with chat-target resolution. This is the right delivery primitive for the `synthesize_voice` tool's output. Two-step (synthesize → attach) is the MVP pattern; later we may collapse to one-step if the bridge exposes a `sendTelegramVoice(filePath, chatId?)` directly.

### 2026-08-17: companion extension should have its own settings file

The agent's `~/.pi/agent/` follows a "one JSON per concern at the root" convention: `telegram.json`, `settings.json`, `mcp.json`, `auth.json`, `models-store.json`, etc. The companion extension follows suit: `~/.pi/agent/pi-voice-telegram.json`. Putting it inside `telegram.json` would conflate concerns; putting it inside `settings.json` (the agent's own) would conflate ownership.

## v0.6.0 — companion settings + LLM tool surface (this commit)

**Why:** the user (operator) wanted the LLM to be able to call TTS explicitly when `voice.replyMode = "hidden"` (so the LLM can decide to voice-synthesize, or do so when the user asks). They also wanted a kill switch for the inbound echo (currently deterministic, on by default). Both knobs live in a companion settings file rather than env vars because the operator-facing dial is JSON-shaped, not env-shaped.

**What shipped:**

- `config.ts` — `loadCompanionConfig()` reads `~/.pi/agent/pi-voice-telegram.json`; absent/invalid = empty config.
- `tools.ts` — two new tools, each registered when its corresponding config flag is on:
  - `synthesize_voice` — wraps `voice-reply.ts`. Returns ogg path. Prompt guidelines tell the agent to pair with `telegram_attach` and warn against using it as the turn-reply voice (the bridge handles that).
  - `transcribe_audio` — wraps `whisper-stt.transcribe()`. Returns transcript text.
- `index.ts` — extended to load the config and conditionally register the inbound echo handlers + the two tools.
- `package.json` — bumped to v0.6.0, added `@sinclair/typebox` as a peer dep (optional in `peerDependenciesMeta` since the agent bundles it transitively).

**Settings file shape (v0.6.0):**

```json
{
  "inbound": { "echoEnabled": true },
  "tools": {
    "enabled": false,
    "tts":  { "enabled": true, "name": "synthesize_voice" },
    "stt":  { "enabled": true, "name": "transcribe_audio" }
  }
}
```

Defaults: `inbound.echoEnabled = true`, `tools.enabled = false`. Anything not present = current behavior.

## v0.7.0 — auto-seed the companion settings file (shipped)

**Why:** the v0.6.0 install was opaque — operators upgrading from v0.5.0 had no way to discover the new settings file or the tool surface unless they read the README. v0.7.0 makes the file discoverable by writing a default on first run.

**What shipped:**

- `config.ts` extended: on `session_start`, if the file is absent (`ENOENT`), write a safe default (echo on, tools off) to disk and log a single notice to stdout. Idempotent — only fires when the file is missing; existing files (operator-edited or hand-placed) are never overwritten. Malformed JSON is left intact (no silent overwrite; the extension's in-memory defaults apply). A failed write (read-only FS, permission denied) is silently absorbed — the extension's defaults still apply, no behavior change.
- `package.json` — bumped to v0.7.0.
- `README.md` — "Optional `pi-voice-telegram.json`" section updated to document the auto-seed.

**Operational semantics:**

| Pre-restart state | After restart |
|---|---|
| File missing | File written with default content. One log line. |
| File present (any content) | Untouched. No log line. |
| File present but malformed JSON | Untouched. Extension's in-memory defaults apply. |
| File present, FS read-only | Extension's in-memory defaults apply. |

The auto-seed is a UX improvement, not a behavior change: operators who don't touch the new file get the same experience as v0.5.0 (echo on, tools off). Operators who want tools edit the file and restart.

## v0.8.0 — per-extension TTS/STT defaults + templated prompt text (shipped)

**Why:** (a) per-extension TTS defaults lived in env vars only (`PI_MM_TTS_VOICE`, `PI_MM_TTS_LANG`, etc.) — the operator-facing dial for "what does the agent sound like" was scattered across shell env, not the JSON. (b) The v0.6.0 tool prompt text was hardcoded to mention "synthesize_voice" / "transcribe_audio" by name; when the operator renamed the tool, the LLM saw inconsistent references (function name vs prose). v0.8.0 fixes both.

**What shipped:**

- `config.ts` extended with `tts.{voice,lang,model,timeoutMs}` and `stt.{lang,baseUrl,timeoutMs}` fields. Two new exported functions: `resolveTtsDefaults(cfg)` and `resolveSttDefaults(cfg)`, both layering JSON > env > hardcoded default.
- `synthesis-provider.ts` refactored from a bare `export const` to a `createMmTtsSynthesisProvider({ tts })` factory + a `mmTtsSynthesisProvider` default export for backwards compat. The factory takes the resolved TTS defaults; the bridge-owned `telegram.json` is still re-read on every call for `outboundHandlers[voice].defaults.{voice,lang,rate}` layering.
- `tools.ts` rewritten: takes the resolved defaults as an argument, templates the description / promptSnippet / promptGuidelines text against the configured tool name. Two new helpers `buildTtsPrompt(name)` / `buildSttPrompt(name)` make the templating explicit.
- `index.ts` updated: resolves the defaults once per `session_start`, passes them to both the synthesis provider factory and the tool registrations. The `sttDefaults` resolution is still triggered even when tools are off, so the JSON > env layering is exercised at startup.
- `package.json` — bumped to v0.8.0.

**Knob resolution precedence (v0.8.0+):**

| Source | Priority | Example for `tts.voice` |
|---|---|---|
| `pi-voice-telegram.json` `tts.voice` | 1 (highest) | `"Cantonese_PlayfulMan"` from JSON wins |
| `$PI_MM_TTS_VOICE` env var | 2 | falls back to env when JSON is absent |
| Hardcoded constant | 3 (lowest) | `"Cantonese_PlayfulMan"` always wins for absent JSON + absent env |

The env-var layer is preserved as a fallback so the cluster's `docker-compose.yaml` doesn't need to change to upgrade.

**Verified against `pi-agent-john` on 2026-08-17:**

| Test | Config | Result |
|---|---|---|
| 1. Env-var fallback | No `tts.*` / `stt.*` in JSON, no env vars set | Pass — agent reports hardcoded defaults (`Cantonese_PlayfulMan`, `Chinese,Yue`, `speech-2.8-hd`, `yue`, `http://127.0.0.1:8080`) |
| 2. JSON overrides hardcoded | `tts.lang: "Japanese"`, `stt.lang: "en"` | Pass — agent reports `Default lang: Japanese` for `synthesize_voice` |
| 3. Name templating | `tools.tts.name: "tts_yue"` + `tts.lang: "ja"` | Pass — agent's response uses `tts_yue` throughout, zero `synthesize_voice` references (v0.6.0/v0.7.0 round-5/6 bug fixed) |

## v0.9.0 — self-describing settings file (shipped)

**Why:** the v0.6.0–v0.8.0 settings file was a flat blob of values — humans editing it had no in-file documentation, editors offered no inline hints, and LLMs inspecting the file had to guess what the keys meant. v0.9.0 makes the file self-describing via two complementary mechanisms.

**What shipped:**

- `pi-voice-telegram.schema.json` (new file in the repo). Full JSON Schema (draft-07) with `description`, `default`, and `examples` for every key, every level of nesting. This is the canonical machine-readable spec — both the operator's editor and the LLM can read it.
- `_hint` and `$schema` fields at the top of the seeded `pi-voice-telegram.json`. The `$schema` is the HTTP URL of the schema on GitHub raw content, so editors (VS Code, IntelliJ) use it for inline validation + autocomplete. The `_hint` is a free-form string that the extension ignores but humans see at the top of `cat` output.
- `CompanionConfig` interface extended with optional `$schema?: string` and `_hint?: string` fields. The extension never reads them; they pass through the JSON parser but the typed config in TS doesn't reference them.
- `DEFAULT_CONFIG` updated to include the same `$schema` + `_hint` so the auto-seeded file matches the example byte-for-byte.
- `examples/pi-voice-telegram.json` updated with the new fields.
- `package.json` — bumped to v0.9.0.

**Verified on `pi-agent-john`:**

| Check | Result |
|---|---|
| Auto-seeded file is byte-equal to `examples/pi-voice-telegram.json` | ✓ Pass — `diff` returned no differences |
| Editor would pick up the schema (tested by checking the URL is in the file) | ✓ Pass — `$schema` field is a valid HTTP URL |
| Agent still loads cleanly with the new fields present | ✓ Pass — no parse errors; bridge connected; agent responding to probes |

**Why not put the docs in `_hint` per-field instead of using JSON Schema?** JSON Schema is the standard for documenting JSON files; editors and tools (jq, ajv, IDEs, LLMs) already understand it. Inlining long descriptions into the JSON would make the file ~5× larger and force every consumer to parse comments. The `$schema` + `_hint` split keeps the data minimal and the documentation external. The `_hint` is just a one-line pointer to the schema for `cat`-ing the file.

## v0.10.0 — `pi_voice_telegram_schema` tool (shipped)

**Why:** v0.9.0 shipped the schema for editor + human consumption, but the LLM still couldn't read it directly (the schema lives in the npm package, not the agent's working dir `/workspace`). The LLM could see the tool descriptions (which were templated against the resolved name) but couldn't introspect available knobs on demand — e.g. before suggesting an edit to the companion file. v0.10.0 closes that gap by registering a third tool that returns the schema as text.

**What shipped:**

- `registerPiVoiceTelegramSchemaTool(pi)` in `tools.ts`. Loads `pi-voice-telegram.schema.json` from the extension's npm package directory at module load (via `import.meta.url` + `readFileSync`). Returns the full schema by default; with a `key` parameter, returns just one section.
- Per-key lookup walks dotted paths like `tts.voice` and falls back from `obj[seg]` to `obj.properties[seg]` so the agent can use either short form (`tts.voice`) or explicit form (`properties.tts.properties.voice`).
- `index.ts` registers the schema tool whenever `tools.enabled` is true, regardless of the per-tool TTS/STT flags. Schema is documentation, not capability — it has no side effects, so it's safe to always register.
- `package.json` `files` whitelist now includes `pi-voice-telegram.schema.json` so the schema ships with the npm package.
- `package.json` — bumped to v0.10.0.

**Tested on `pi-agent-john` on 2026-08-17:**

| # | Probe | Result |
|---|---|---|
| 1 | "what voice tools do you have?" | Pass — agent lists all three tools including `pi_voice_telegram_schema` |
| 2 | "what is the default language for tts?" | Pass — agent calls `pi_voice_telegram_schema` with `key: "tts"`, gets the `tts` schema section, reports `Chinese,Yue` as the default. No fallback call needed. |

**Bug fixed during testing:** the first version of the walker only did `obj[seg]`, so the agent's first attempt with `key: "tts"` failed with "key path 'tts' not found". Added the `obj.properties[seg]` fallback so short form works as the agent expected. Fixed and re-deployed in the same commit cycle.

## v0.11.0 — agent-modifies-config opt-in (shipped, superseded by v0.12.0)

**Why:** the v0.10.0 schema tool gave the LLM a way to discover what knobs exist, but no way to actually modify them. Operators who wanted the LLM to manage the file end-to-end (e.g. "set tts.lang to ja") had to make the edit themselves. v0.11.0 closes the loop with a double opt-in: the operator must set `tools.writable: true` in addition to `tools.enabled: true`. The LLM then gets two more tools, one to read current state and one to make schema-validated atomic writes.

**What shipped:**

- New module `config-io.ts` (5,914 bytes) with the read/write primitives:
  - `readSettings()` / `readSettingsRaw()` — load + parse the JSON
  - `lookupKey(obj, dotted)` — read a single value (with the same `properties.` fallback as the schema tool)
  - `writeKey(key, value)` — schema-validated, atomic write
  - `settingsMetadata()` — mtime/size snapshot for change detection
  - `splitKey()` — the safety guard. Refuses:
    - `$schema` and `_hint` (reserved, managed by the extension)
    - Any top-level key not in `{inbound, tools, tts, stt}` (refuse to invent new keys)
- New tools in `tools.ts`:
  - `registerConfigReadTool(pi)` — `pi_voice_telegram_config_read`. Returns the full file or a per-key value.
  - `registerConfigWriteTool(pi)` — `pi_voice_telegram_config_write`. Sets one key, returns old → new diff, tells the operator to restart.
- `index.ts` registers both tools only when `cfg.tools.writable === true`. The schema tool stays registered when only `tools.enabled` is true.
- `pi-voice-telegram.schema.json` updated with the new `tools.writable` field, plus a `_hint`-style description explaining the safety model.
- `CompanionConfig` interface extended with `tools.writable?: boolean`.
- `DEFAULT_CONFIG` and `examples/pi-voice-telegram.json` updated to include `writable: false`.
- `package.json` — bumped to v0.11.0.

**Tested on `pi-agent-john` on 2026-08-17:**

| # | Config | Probe | Result |
|---|---|---|---|
| 1 | `tools.writable` absent | "what voice tools do you have?" | Pass — agent lists 3 tools (synthesize_voice, transcribe_audio, pi_voice_telegram_schema). The two config tools are NOT in the list. **Opt-in gate works.** |
| 2 | `tools.writable: true` | "what is the current tts.lang?" | Pass — agent calls `pi_voice_telegram_config_read` with `key: "tts.lang"`, gets back `"Chinese,Yue"`, reports it. |
| 3 | `tools.writable: true` | "set tts.lang to ja" | Pass (with a real bug found and fixed mid-test) — agent called read first (per the promptGuidelines), then schema, then write. File's `tts.lang` was updated, no stray top-level `lang` key. The LLM mapped "ja" → "Japanese" based on the schema's `examples` list — a feature, not a bug. |

**Bug found and fixed during testing:** the first version of `writeKey` called `setNestedPath(current, remainder, value)` — passing the top-level object, not the root's child. This created the new key at the wrong level (top-level `lang` instead of `tts.lang`). Caught by the live test when I `cat`-ed the file and saw a stray `"lang": "ja"` at the top level. Fixed by descending into the root before calling `setNestedPath`. Re-deployed in the same commit cycle.

## v0.12.0 — drop fake-security `writable` flag, add recovery primitive (shipped)

**Why:** the v0.11.0 `tools.writable` flag was operator-preference dressed up as a security boundary. A sufficiently capable LLM with `bash` + `write` can edit the file regardless of what a JSON flag says. The real security boundary is the container's filesystem permissions, the bridge's role-based access, and the operator's review of LLM outputs — not a flag in a config file the LLM can also see. v0.12.0:

1. Removes the `tools.writable` opt-in. The config-read / config-write tools are now registered whenever `tools.enabled` is true (no double opt-in).
2. Adds a recovery primitive: `pi_voice_telegram_config_reset`. Backs up the current file to a timestamped `.bak.<unix-ms>` and writes the bundled `DEFAULT_CONFIG` over it.

**What shipped:**

- Removed `tools.writable` from `CompanionConfig`, `pi-voice-telegram.schema.json`, `DEFAULT_CONFIG`, and `examples/pi-voice-telegram.json`.
- New tool `registerConfigResetTool(pi)` in `tools.ts`. Parameter-less. Returns the backup path + a success message.
- `config-io.ts` `resetConfig(defaultContent)` — atomic write + backup.
- `index.ts` registers config-read / config-write / config-reset together when `tools.enabled` is true.
- `package.json` — bumped to v0.12.0.

**Note:** v0.12.0's reset tool used a hardcoded `DEFAULT_CONFIG` JSON in source. That's the wrong design — the schema is the source of truth for "what fields exist and what their defaults are". v0.13.0 refactors the reset to be schema-driven.

## v0.13.0 — schema-driven reset + proactive evolution (shipped)

**Why:** v0.12.0's reset overwrote the file with a hardcoded JSON in source. That has two problems:

1. The hardcoded JSON can drift from the schema (the canonical source of truth for "what fields exist and what their defaults are"). When the schema adds a new field, the hardcoded JSON doesn't know about it.
2. The reset is destructive — it overwrites the operator's values, not just fills in missing ones. The user pointed out: "resetconfig means spawn setting using the schema default" — the reset should be additive, not destructive.

v0.13.0 redesigns the reset to walk the JSON Schema, fill in MISSING fields with the schema's `default` value, and preserve the operator's existing values. The schema is the source of truth; the hardcoded JSON is for first-install auto-seed only.

Also: the user pointed out that the LLM should be able to **evolve the config from observed usage** — when the operator keeps asking for English voice and the config is `Chinese,Yue`, the LLM should propose or apply a change. v0.13.0 updates the config tool `promptGuidelines` to encourage this workflow.

**What shipped:**

- `config-io.ts` extended with `mergeWithSchemaDefaults(schema, current)` — recursive walk of the schema. Three cases for a missing key:
  1. Schema has a top-level `default` value → use it.
  2. Schema defines an object with nested properties that have defaults → recurse with empty current, build the nested object from sub-defaults.
  3. Neither → skip (no schema info).
- `resetConfig()` now takes no args, reads the schema from the npm package, calls `mergeWithSchemaDefaults`, and writes the result atomically with backup.
- `tools.ts` `registerConfigResetTool` updated to call the new `resetConfig()` and report the list of added paths to the LLM (for the agent to relay to the user).
- Config tool `promptGuidelines` updated: "Use pi_voice_telegram_config_write when (a) the operator asks you to change a setting, or (b) you observe a clear mismatch between the current config and the operator's actual usage. In case (b), propose the change first and ask before writing."
- `package.json` — bumped to v0.13.0.

**Bug found and fixed during testing:** the first version of `mergeWithSchemaDefaults` only added missing fields when the schema had a top-level `default` value. It skipped object properties (like `inbound` and top-level `stt`) because they don't have a top-level default in the schema — they have NESTED defaults. The first test run only added `tools.stt.name`; `inbound` and the per-extension `stt` were still missing. Fixed by adding Case 2 (recurse into object properties even when current is undefined) to the merge function. Re-deployed in the same commit cycle.

**Tested on `pi-agent-john` on 2026-08-17:**

| # | Probe | Result |
|---|---|---|
| 1 | "run config_reset" on a partial file (missing inbound, stt.name, tts.lang, tts.model, tts.timeoutMs, stt.lang, stt.baseUrl, stt.timeoutMs) | Pass — all 8 missing fields filled in from schema defaults. Existing values preserved (tts.voice: "Cantonese_PlayfulMan", tools.tts.name: "synthesize_voice", operator's custom _hint). Backup file created. Agent reported all 8 paths to the user in Cantonese. |

## v0.14.0 — hot-reload the companion settings (shipped)

**Why:** through v0.13.0, any change to `pi-voice-telegram.json` required a session restart. The operator had to either bounce the agent or wait until the next session — the JSON file was effectively session-scoped, even though its content (voice/lang/model) is conceptually runtime. The user pointed this out as a real UX gap: "operator edits the file and waits" is worse than "operator edits the file and the next turn picks it up".

**What shipped:**

- `index.ts` refactored: the body of the old `session_start` handler is now a `reconfigure()` closure that tears down all current registrations and re-runs the registration logic against the current contents of `pi-voice-telegram.json`. `session_start` calls `reconfigure()` + `startConfigWatcher()`.
- `startConfigWatcher()` calls `fs.watch(configDir, { persistent: true }, ...)` on the **directory** containing `pi-voice-telegram.json`, not the file itself. File-level `fs.watch` is unreliable on Linux/Docker overlay (stops firing after the first event, especially with editor rename patterns); directory watching catches both in-place writes and rename-style replacements.
- Watcher callback filters for events on our specific filename (the `filename` arg can be `null` on some platforms; in that case we conservatively reload — cost of one false-positive `reconfigure()` is small).
- 200ms debounce on the reload (collapses bursts of writes from editors that save+rename).
- `session_shutdown` closes the watcher and clears the pending timer; no file handles leak.
- `reconfigure()` disposes the previous registration set (each `registerTelegramVoiceSynthesisProvider` / `registerTelegramUpdateHandler` / `registerTelegramInboundHandler` returns a disposer; the new tool registrations in v0.6.0–v0.13.0 are tear-down-able too) before re-registering. The previous in-memory transcript cache is also cleared, so the new `inbound.echoEnabled` flag takes effect on the very next message with a fresh cache.
- Best-effort: if `fs.watch` fails (sandboxed env, no inotify handles, restricted bind mounts), the extension logs a warning and falls back to the `session_start`-only behavior. Hot-reload is a UX nicety, not a correctness requirement.

**Hot-reload scope (what IS and IS NOT re-registered):**

- Re-registered: synthesis provider (with new TTS defaults), echo handlers (per new `inbound.echoEnabled`), all 7 LLM tools (per new `tools.*` flags).
- NOT re-registered: the watcher itself (lives across reconfigures, torn down only on `session_shutdown`), the `_hint` and `$schema` fields of the file (read-only metadata).

**TTS pipeline note:** the v0.5.0+patch backport in `patches/v0.5.0/synthesis-provider.ts` already reads the JSON on every synthesis call (a different layer — the bridge path), so the patched v0.5.0 cluster gets the v0.14.0 hot-reload behavior for the synthesis path without deploying v0.14.0. The v0.14.0 watcher is for the capability-registration layer (echo + tools), which the v0.5.0 patch doesn't cover.

**Tested on `pi-agent-john` on 2026-08-17:**

| # | Probe | Result |
|---|---|---|
| 1 | Initial load (no JSON yet) | Pass — auto-seeded, watcher started, all 7 tools registered |
| 2 | `echoEnabled: true` → `false` via `pi_voice_telegram_config_write` | Pass — next voice message had no `🎙️` echo (handler re-registered with the new flag) |
| 3 | `tools.enabled: true` → `false` via `pi_voice_telegram_config_write` | Pass — agent's tool list no longer includes the 7 voice tools |
| 4 | Edit `tts.voice` via `pi_voice_telegram_config_write` | Pass — next bridge-driven voice reply used the new voice (the synthesis provider in the v0.5.0+patch reads JSON on every call) |

**Bug found and fixed during testing:** the first version watched the FILE (`fs.watch(configPath, ...)`). On Linux/Docker overlay, this detached after the first event — subsequent edits triggered no reload. Fixed by switching to directory-watching with filename filtering, which catches both in-place writes and rename-style replacements.

## v0.15.0 — `pi_voice_telegram_list_voices` + embedded catalog (shipped)

**Why:** the agent had no in-band way to know which MiniMax TTS voice IDs are valid. When the user asked to change the voice (e.g. "switch to Japanese", "give me a more authoritative voice"), the agent had two failure modes:

1. **Guess an ID and fail with 2054.** A wrong ID returns 2054 and the agent can't recover without the operator. The user pointed out that `Japanese_PlayfulMan` was a known-valid ID per their memory but turned out to not exist in the canonical catalog — the 2054 error confirmed the catalog was the ground truth.
2. **Tell the user to read the docs themselves.** Defeats the point of having an LLM as the config interface; the user is using the LLM precisely so they don't have to do the lookup.

v0.15.0 closes this gap with an embedded voice catalog and a discovery tool. The agent now has a complete, in-band source of truth for what voice IDs MiniMax TTS accepts.

**What shipped:**

- **`voices.json`** — new file in the repo + npm package. Embeds the canonical MiniMax system-voice catalog (327 voices × 24 languages, ~58KB). Built from the upstream page `https://platform.minimaxi.com/docs/faq/system-voice-id.md` (the markdown alternate, not the HTML SPA) via `scripts/build-voice-catalog.py`. The script maps the Chinese language labels to normalized English labels (`日文` → `Japanese`, `中文 (粤语)` → `Cantonese`, etc.) and preserves the original `languageKey` for back-compat.
- **`voices-catalog.ts`** — new module: `loadVoicesCatalog()`, `filterVoices(voices, {language?, voiceName?})`, `uniqueLanguages(voices)`. Filter is case-insensitive substring match on either the English label or the original Chinese label — substring is intentional so the agent can pass partial input ("japan" still resolves to "Japanese").
- **`registerListVoicesTool(pi)`** in `tools.ts`. Tool name: `pi_voice_telegram_list_voices`. Parameters: `language?` (string, optional), `voiceName?` (string, optional). Returns `{ count, total, languages, filters, voices: VoiceEntry[] }` where `VoiceEntry = { index, voiceId, voiceName, language, languageKey }`. Registered whenever `tools.enabled` is true; no per-tool sub-gate (it's a discovery primitive, like `pi_voice_telegram_schema`).
- **Prompt nudges on the existing tools.** Added a paragraph to `synthesize_voice`, `pi_voice_telegram_config_write`, and `pi_voice_telegram_schema` `promptGuidelines` pointing at `list_voices` and explaining the three independent TTS parameters:
  - `tts.voice` is the **speaker identity** (a `Japanese_*` ID is a Japanese-language voice, a `Cantonese_*` ID is a Cantonese-language voice).
  - `tts.lang` is the **pronunciation boost** (what language the text should *sound* like, regardless of the voice's native family).
  - The "voice under a language" is just one of the 327 IDs in one of the catalog's 24 language families.
  - Same-language voice+lang gives natural pronunciation; cross-language voice+lang is the "boost" effect (e.g. `Cantonese_PlayfulMan` + `lang=Japanese` speaks in Japanese pronunciation with a Cantonese speaker).
- **Schema updates.** `pi-voice-telegram.schema.json` `tts.voice` description now points at `pi_voice_telegram_list_voices` and warns about the §2a byte-trap (full-width parens in `Cantonese_ProfessionalHost（M）` and `（F）` — present in the catalog, but the 2054 byte-trap is documented in `patches/v0.5.0/README.md`). `tts.lang` description now explicitly notes the cross-language voice+lang "boost" semantics. `tools.enabled` description now lists `pi_voice_telegram_list_voices` as one of the 7 tools.
- `package.json` — bumped to 0.15.0, added `voices.json` to the `files` whitelist, added `scripts/` is NOT whitelisted (the build script is dev-only).
- `config.ts` — `_hint` updated to reference v0.15.0+ and the new tool.

**Why embed the catalog rather than `web_fetch` the docs page?** Three reasons:
1. **No network dependency.** The agent works offline; the catalog is in the npm package.
2. **Speed.** The HTML page is a Mintlify SPA (~116k tokens of rendered HTML); the markdown alternate is lighter but still requires a fetch + parse. The embedded JSON is one `readFileSync` + one `JSON.parse` — microseconds.
3. **Versioned with the package.** If MiniMax changes the catalog, we ship a new `pi-voice-telegram` release. The agent doesn't have to know whether `web_fetch` returns the current or cached version.

**Trade-off accepted:** the catalog can drift from upstream if MiniMax adds voices between releases. Mitigation: the build script (`scripts/build-voice-catalog.py`) is a one-command refresh — `python3 scripts/build-voice-catalog.py <input.md> voices.json` — and the script's `LANGUAGE_MAP` makes the "what's new" check obvious (any unmapped language label is printed as a warning). For v0.15.0, the script ran clean (no unknown labels).

**Out of scope for v0.15.0 (deferred to v0.16+):**
- Audio samples per voice (would need an asset bundle or external hosting — too heavy).
- Style-based search ("authoritative" → suggestions) — needs a manual style taxonomy, can layer over the existing filter when needed.
- Auto-refreshing the embedded catalog from MiniMax — manual for now, build script is the only path.

**Live cluster note:** the cluster is on v0.5.0 + the synthesis patch, so the new tool isn't reachable on `pi-agent-john` until v0.15.0 is published. Same blocker as v0.6.0+ features. The user can verify the catalog quality by browsing `voices.json` directly or by reading the script's `LANGUAGE_MAP` for the canonical English-label list.

## v0.16.0 — TTS self-check via whisper-stt language detection (shipped)

**Why:** TTS synthesis can silently produce audio in the wrong language. The cross-language "boost" effect (`voice=Cantonese_* + lang=Japanese`) is a known weirdness — the operator gets audio, but the audio might be in a third language entirely. The v0.5.0 2054 errors were loud failures; the cross-language miss is a silent failure. v0.16.0 adds a per-synthesis self-check that catches it.

The capability was always in `whisper-server` — verbose_json returns `detected_language` + `detected_language_probability` when no `language` form field is sent. The `whisper-stt.ts` client just never exposed it (it always sent a language hint and used `response_format=text`). v0.16.0 adds the missing client support, then wires it into both synthesis paths.

**What shipped:**

- **`detectLanguage()` in `whisper-stt.ts`** — new function. POSTs to `/inference` with no `language` form field and `response_format=verbose_json`. Returns `{ language, confidence, transcript, languageProbabilities? }`. The `language` is whisper's lowercase English name (e.g. "japanese", "cantonese", "english"). `confidence` is `detected_language_probability` (0-1, > 0.5 usually trustworthy, > 0.85 very reliable).
- **`tts.verifyAfterSynthesize: boolean` setting** — new knob in the companion config, default `true`. Off if you don't want the ~500ms–1s whisper-stt call per synthesis (latency-sensitive paths).
- **Inline verification in `synthesis-provider.ts`** — after `voiceReply` succeeds, the provider calls `detectLanguage` and records the result in the runtime event log under `category: "pi-voice-telegram/tts-verify"`. Verification failure does NOT fail the synthesis — the audio is still valid. The log entry includes `requestedLang`, `detectedLanguage`, `confidence`, and a `match` boolean.
- **Same verification in the `synthesize_voice` LLM tool** — covers the ad-hoc agent-driven path. The tool's per-call `voice`/`lang` overrides feed into the comparison (the effective values, not just the defaults).
- **Loose-match comparison** — `isLanguageMatch(detected, requested)` in both files. Rules:
  1. Direct case-insensitive substring (e.g. "japanese" in "Japanese")
  2. First half of a "Language,Dialect" string (e.g. "Chinese" from "Chinese,Yue" matches "chinese"; "Cantonese" does not match "Chinese,Yue" — the operator asked for Yue, not generic Chinese)
  3. Otherwise: no match
- **Schema + examples + package.json + `_hint` all updated.** CompanionConfig gains `tts.verifyAfterSynthesize`. ResolvedTtsDefaults gains the field. TTS_FALLBACKS default is `true`. Schema description explains the event log category and the latency cost.

**What `match: true` vs `match: false` means:**

- `true` = detected language matches requested `tts.lang` (loose substring/first-half match). The audio is in the language the operator asked for.
- `false` = detected language doesn't match. Common case: the cross-language "boost" effect — the operator asked for Korean but whisper heard English (or whatever the audio actually is). The audio is still valid, just not what was asked for.

**Tested on `pi-agent-john` via `docker exec pi-agent-john pi -e ./index.ts -p "..."`:**

| # | Test | `requestedLang` | `detectedLanguage` | `confidence` | `match` |
|---|---|---|---|---|---|
| 1 | `synthesize_voice` with defaults (voice=Japanese_OptimisticYouth, lang=Japanese) | Japanese | japanese | 0.957 | ✓ true |
| 2 | `synthesize_voice` with `lang=Korean` (cross-language boost) | Korean | english | 0.762 | ✗ false |

Test 2 is the headline result — the operator asked for "Korean pronunciation" and the audio came out as English (the cross-language boost effect). Without verification, this would be silent. The log line is enough for the operator to see the mismatch and either fix the config or accept it as a quirk.

**Bug fix during testing:** the `_hint` field in `DEFAULT_CONFIG` was bumped to v0.15.0+ but didn't mention the new tool; updated to v0.16.0+ and added the `tts.verifyAfterSynthesize` mention so operators see what's happening at the top of `cat`-ed config.

**Trade-off accepted:** verification adds a whisper-stt call per synthesis (~500ms–1s on the local whisper-server, more on remote). The synthesis still succeeds if verification fails (best-effort pattern), so the worst case is a missed log entry, not a broken voice reply. Operators who want the latency back can set `tts.verifyAfterSynthesize: false`.

**What v0.16.0 is NOT:** pitch detection, voice-character analysis, or any other acoustic feature. whisper-stt is a transcription model — it gives language and text confidence, not pitch/prosody. For pitch, you'd need librosa + pyin or pyworld (heavy new deps). The user explicitly asked about pitch; the honest answer is that whisper doesn't do it. v0.17+ if/when pitch detection is wanted.

**Live cluster note:** the cluster is on v0.5.0 + synthesis patch, so v0.16.0's verification isn't reachable on `pi-agent-john` until v0.16.0 is published. Same npm-publish blocker as v0.6.0+ features. The `patches/v0.5.0/` directory would need another backport (extend `synthesis-provider.ts` to call `detectLanguage` and log the result) if the operator wants verification on the cluster before the npm publish.

## v0.16.2 — JSON-driven STT defaults + degenerate-output fallback (shipped)

**Why:** the user reported a recurring bug on 2026-08-17 23:xx — the voice echo would sometimes return just `,` (a single comma) instead of the STT transcript. Probing the same OGG with the same whisper-server returned verbatim Cantonese. The discrepancy was traced to two issues in the v0.16.1 echo pipeline:

1. **The JSON's `stt.*` fields were not consumed.** `echo.ts` read `PI_TELEGRAM_STT_TIMEOUT_MS` from the env and used a hardcoded `DEFAULT_LANG = "yue"`, completely bypassing the JSON. The v0.8.0+ design is "JSON > env > hardcoded" but the echo path was skipped over the JSON layer. Whatever the operator set in `stt.lang`, the actual call used "yue" (or the env var if set).
2. **whisper on Cantonese audio with a forced `lang="yue"` hint is unreliable.** It sometimes returns degenerate outputs (single punctuation, or empty string). The fallback: don't force the lang — let whisper auto-detect. The 2026-08-17 probes confirmed that auto-detect produces verbatim Cantonese consistently.

**What shipped:**

- **`echo.ts` consumes the resolved STT defaults via a module-level state.** A new `ResolvedSttDefaults` interface and a `currentSttDefaults` state, updated by a new `setSttDefaults()` export. The STT call passes `lang` / `baseUrl` / `timeoutMs` from the state. The `PI_TELEGRAM_STT_TIMEOUT_MS` module-level constant is gone; the env var is the JSON fallback via `config.ts::resolveSttDefaults`.
- **One-shot fallback retry when the primary result is degenerate.** If the result is empty, fewer than 2 characters, OR matches the regex `/^[\s,.!?;:\-'"`~(){}\[\]\\/|]+$/` (pure punctuation/whitespace), retry once with no `lang` hint — whisper auto-detects. Single retry, no loop, to bound the cost of a bad model state. The primary result is logged via `recordTelegramRuntimeEvent` with `phase: "stt-fallback"` for visibility into the model's failure mode.
- **`index.ts` calls `setSttDefaults(sttDefaults)` in `reconfigure()`.** Hot-reload flows through automatically with the existing `fs.watch` + dispose/re-register flow. The `sttDefaults` is already computed from `resolveSttDefaults(cfg)` in the existing reconfigure logic — just one extra line to push it to the echo module.

**Tested via `docker exec pi-agent-john pi -e ./index.ts`:**

- All 7 LLM tools still register.
- `synthesize_voice` still works end-to-end (probe text "v0.16.2 smoke test" returned a valid OGG path with the resolved defaults).
- Regex behavior on degenerate inputs: `","` matches (triggers fallback), `"a"` doesn't (no false positive on real text), `"我"` doesn't (real text), `" "` matches (whitespace-only), `"  "` matches, `"a."` doesn't (real text).

**Live cluster note:** the cluster was upgraded from v0.16.1 to v0.16.2 via the standard rebuild + entrypoint re-seed flow. The new image is rebuilt `--no-cache` to avoid the Docker layer cache landmine. `Dockerfile.pi` ARG default bumped to `0.16.2`, `docker-entrypoint.sh` REQUIRED_PACKAGES updated, settings.json cleaned of the leftover v0.16.1 line (which would trigger the package manager to downgrade).

## v0.16.1 — config_reset prompt fix + npm publish (shipped)

**Why:** the operator reported a real UX bug — when they said "reset config" in Telegram, the agent asked "which reset do you want?" instead of just calling the tool. The previous `CONFIG_RESET_PROMPT` told the agent WHEN to use the tool but didn't say "just call it on these phrasings". A separate but related bug: the description still had a stale "changes take effect only after the agent session is restarted" line, which the v0.14.0 hot-reload made wrong (only the promptGuidelines were fixed in v0.14.2).

**What shipped:**

- `CONFIG_RESET_PROMPT` overhaul in `tools.ts`:
  - Marks `config_reset` as the DEFAULT interpretation of "reset config" (and "migrate", "fill in missing fields", "update to current schema", "rebuild from defaults", "I broke the config").
  - Tells the agent "DO NOT ask for clarification on which reset they want" on these phrasings.
  - Disambiguates from `config_write`: single-value resets ("reset tts.voice to X") use `config_write` with the value; `config_reset` is for the WHOLE FILE.
  - Cites the `.bak` safety net explicitly so the agent's cautious-by-default behavior is unblocked.
  - Shorter after-action text (was a long paragraph; the LLM was relaying the whole thing).
- Stale "restart required" line removed from the description.
- Published to npm as `pi-voice-telegram@0.16.1` (the first npm publish via the v0.6.0+ feature set).
- Cluster image build updated: `Dockerfile.pi` `PI_VOICE_TELEGRAM_VERSION` default 0.5.0 → 0.16.1, `docker-entrypoint.sh` `REQUIRED_PACKAGES` pi-voice-telegram line 0.5.0 → 0.16.1.

**Tested via `docker exec pi-agent-john pi -e ./index.ts` (3 phrasings):**

| Prompt | Tool called | Clarification? |
|---|---|---|
| "Reset the config." | `config_reset` | No — direct call |
| "Migrate the pi-voice-telegram settings file to the current schema." | `config_reset` | No — direct call; agent added a helpful post-action note |
| "Reset tts.voice to Cantonese_PlayfulMan." | `config_write` (single-value) | No — correctly disambiguated from `config_reset` |

The disambiguation in test 3 is the part I'm most pleased with — the prompt steers the agent to the RIGHT tool for the request, not just the most defensive one.

**Recurring release + cluster upgrade flow** (the user said "we should do this from time to time"):

1. **Tag the release in the local repo**: `git tag -a v0.X.Y -m "..."`. The tag is the source of truth for what ships.
2. **`npm publish` from the local repo root**. Auth is via `~/.npmrc` (`npm whoami` confirms `jwebster1968`).
3. **Update `/home/john/pi-cluster/Dockerfile.pi`**: change `ARG PI_VOICE_TELEGRAM_VERSION=X.Y.Z` to the new version. (Or override at build time with `--build-arg PI_VOICE_TELEGRAM_VERSION=X.Y.Z` without editing the file.)
4. **Update `/home/john/pi-cluster/docker-entrypoint.sh`**: change `'npm:pi-voice-telegram@X.Y.Z'` in `REQUIRED_PACKAGES`.
5. **Rebuild the image**: `docker build -t pi-sandbox:latest -f /home/john/pi-cluster/Dockerfile.pi /home/john/pi-cluster`.
6. **Stop the cluster, wipe the npm bind-mount dir, restart with the new image**. The entrypoint will re-seed `~/.pi/agent/npm/` from the pre-baked tree at `/opt/pi-defaults/npm/`.
7. **Remove obsolete patches**: any `patches/v0.X.Y/` directory that the new version obsoletes (e.g. the v0.5.0+patch is fully superseded by v0.15.0+, so after the upgrade the cluster doesn't need it).

Caveat: `/home/john/pi-cluster/` is NOT a git repo, so Dockerfile.pi + docker-entrypoint.sh changes are local-only. If you want a version-controlled copy, either `git init` the dir or copy the files into a separate repo. (Recommended: do that before the next upgrade cycle so the cluster's build state has a history.)

## Open design questions (deferred from v0.6.0)

1. **Tool description should adapt to `voice.replyMode`.** When the bridge is in `hidden` mode, the tool's `promptGuidelines` should say: *"voice replies are not automatic in this session — use synthesize_voice when the user asks for an audio reply."* When in `mirror`/`always`, it should say: *"synthesize_voice is for ad-hoc voice (e.g. reading a file aloud), not for the turn reply — the bridge handles that."* The `ExtensionAPI` doesn't expose a "read telegram.json from inside promptGuidelines" hook, so the phrasing has to be baked in at `session_start` time (read once, choose one of two guideline sets). v0.6.0 ships a single guideline set that handles both cases; v0.7.0 can split it.

2. **TTS auto-send mode.** v0.6.0 uses the two-step pattern (synthesize → `telegram_attach`). A future `tools.tts.delivery: "telegram" | "file" | "auto"` could collapse to one-step when the bridge exposes a `sendTelegramVoice(filePath, chatId?)` directly. Defer until the bridge adds that primitive.

3. **Per-extension TTS defaults** (model / voiceId / format) currently live as `PI_MM_TTS_*` env vars. Could move into `pi-voice-telegram.json` as `tts.{model,voiceId,format}`. Not blocking.

4. **Echo template** is currently hard-coded `🎙️ "<i>{transcript}</i>"`. Could be made configurable via `inbound.echoTemplate: string | null`. Low priority.

5. **STT language default** is `PI_TELEGRAM_LANG` env or `"yue"`. Could move into the settings file as `stt.lang`. Low priority.

6. **`inbound.echoTemplate: null` semantics** — does "no echo" mean "still inject the transcript into the agent prompt" or "skip the entire pipeline"? v0.6.0 treats the kill switch as binary (`echoEnabled: false` skips the whole pipeline). A finer-grained "silent mode" (transcript yes, echo no) could be a v0.7.0 addition.

## v0.7.0+ candidates

### From the v0.8.0 test matrix (verified all 3 v0.8.0 tests pass; remaining candidates)

- ~~**Agent-modifies-config opt-in**~~ — **shipped in v0.11.0 + v0.12.0** (`pi_voice_telegram_config_read` / `_write` / `_reset`). The v0.11.0 `writable: true` opt-in was dropped in v0.12.0 (fake security); the tools are now registered whenever `tools.enabled` is true.

- ~~**Hot-reload the config**~~ — **shipped in v0.14.0**. `fs.watch` on the directory containing `pi-voice-telegram.json` (not the file itself — file-level watching detaches on Linux/Docker overlay), 200ms debounce, re-registers capabilities on change. The synthesis provider reads the JSON on every call (via the v0.5.0+patch for the cluster), so TTS defaults also take effect on the next bridge event.

### Other v0.8.0+ candidates (from earlier design discussion)

- Adaptive `promptGuidelines` based on `voice.replyMode` (item 1).
- One-step TTS delivery if the bridge exposes a `sendTelegramVoice` primitive (item 2).
- `inbound.echoTemplate` (item 4).
- A `/voice-status` slash command that prints the resolved config (echo on/off, tools on/off, active tool names, current voice/lang/defaults). Useful for debugging without a restart.
- A test scaffold for the tool wrappers. The current test coverage (if any) is integration-level only.
- Voice-catalog extensions: audio samples per voice, style-based search ("authoritative" → suggestions), auto-refresh from upstream (v0.16+ candidates out of v0.15.0 scope).

## v0.16.7+ candidates (from `docs/CODE-FLOW.md` analysis, 2026-08-18)

Self-critical review of flow #2 (outbound TTS) and flow #3 (inbound
STT + echo) in `docs/CODE-FLOW.md`. Each item is a real issue in the
v0.16.7 code path, not a hypothetical improvement.

### Flow #2 — outbound TTS (`synthesis-provider.ts`)

1. **`rate` layering bug (doc-vs-code drift).** The docstring at the
   top of `synthesis-provider.ts` claims the layered default
   resolution includes `telegram.json.outboundHandlers[voice].defaults.rate`,
   but the code at `synthesis-provider.ts:137` resolves speed as
   `Number(options?.rate ?? 1.0)` — the `defaults.rate` field is
   read off the file but never used. An operator who sets
   `telegram.json.outboundHandlers[voice].defaults.rate = 1.5` gets
   1.0 from the synthesis. **Fix:** either add `defaults.rate` to
   the `speed` resolution (`options?.rate ?? defaults.rate ?? 1.0`),
   or drop `rate` from the docstring's claimed layering. The fix
   is 1 line either way; the docstring change is the safer one
   until a use case for `defaults.rate` is demonstrated.

2. **Silent caption truncation.** When `text.length > 1024` and
   `voice.sendTranscript === true`, the caption is clipped to 1023
   chars + `…` while the audio is the full text. The user sees a
   truncated caption but hears the full narration — a confusing
   mismatch. The truncation is silent (no runtime event). **Fix:**
   record `recordTelegramRuntimeEvent("pi-voice-telegram/tts", null,
   { phase: "caption-truncated", textLength, captionLength: 1024 })`
   so the operator can spot it happening. Consider also rejecting
   the synthesis outright when `text.length > 1024` and forcing the
   LLM to chunk.

3. **TTS verify latency is wasted on success.** With
   `tts.verifyAfterSynthesize: true`, the user gets the audio at
   T+TTSSynth, and the verify fires at T+TTSSynth+~400ms. The
   audio is already sent — the verify is post-hoc reporting only.
   The value is the runtime event log entry, not the synthesis
   outcome. If the verify never changes the behavior (no
   rollback, no retry), consider fire-and-forget (don't await)
   so the synthesis returns to the bridge immediately. Marginal
   optimization; only matters at scale.

4. **`telegram.json` re-read on every call.** The synthesis
   provider does `readFile(agentDir + "/telegram.json")` on every
   synthesis. ~500 bytes, ~50µs with Node's fd cache. Fine at
   current call volumes; cache by mtime if it ever becomes a
   bottleneck.

5. **No retry on transient 5xx / network errors.** A single
   `WhisperSttError code 2 or 4` or MiniMax 5xx kills the
   synthesis. A retry with backoff (1s, 2s, 4s, max 3 retries)
   would improve reliability for the ~1% of calls that hit a
   transient failure. Costs ~7s of extra latency in the worst
   case; negligible in the median. Defer until observed in
   production.

### Flow #3 — inbound STT + echo (`echo.ts`)

6. **File-name-keyed chat-ID lookup is fragile.** The update
   handler stashes the chat ID by `voice-<message_id>.<ext>` (built
   from `fileNameFor(msg.message_id, ext)` at `echo.ts:163-165`).
   The provider looks it up by `file.fileName` (the name the bridge
   actually uses for the downloaded file). If the bridge's naming
   convention differs from the deterministic name the update handler
   assumed, `chatIdByFileName.get(file.fileName)` returns
   `undefined` and the echo is silently dropped (the `if (chatId)`
   block at `echo.ts:269` is skipped). **Verify empirically:**
   does the bridge's `transcribeTelegramVoiceFileWithProviders`
   pass the same `fileName` that `fileNameFor` produces? If not,
   the fallback is to look up by `message_id` (which the provider
   doesn't have) or to thread the chat ID through the bridge's
   options object. The v0.16.7 design moves the silent-failure
   mode from "empty transcript" (v0.16.6) to "name mismatch" — same
   shape, different root cause. If the names don't match, this
   needs to be fixed before the v0.16.7 e2e test is reliable.

7. **Echo send failures are silently caught and dropped.** The
   `try/catch` around `sendTelegramView` at `echo.ts:269-285`
   swallows the error. If Telegram is down or the bot token is
   invalid, the user gets no echo and the operator has no signal.
   **Fix:** record
   `recordTelegramRuntimeEvent("pi-voice-telegram/echo", err, { chatId, transcriptLength })`
   in the catch. The transcript still goes to the LLM via the
   return value (correct behavior), but the operator gets a
   runtime event for diagnostic.

8. **`mimeToExtension` is a guess.** The update handler picks the
   extension from the Telegram `mime_type` field
   (`echo.ts:167-176`). If the actual file extension differs (e.g.
   voice is `audio/ogg; codecs=opus` → `.ogg` per the code, but
   some clients send `audio/mpeg` for voice), the stashed name
   won't match. **Verify:** this is a subset of item 6 (the
   fileName lookup). The fix is the same: don't key the chat ID
   by name; thread it through a different channel.

9. **No STT result caching.** If the same file is re-sent (or the
   bridge retries the provider call on a transient failure), the
   whisper call is repeated. Cache key would be
   `sha256(file.path + file.mtime)`. Low priority at current
   call volumes; matters only at scale.

10. **`telegram.json` re-read on every echo for the bot token.**
    Same minor concern as item 4. The `loadBotToken` call at
    `echo.ts:122-138` reads the file on every voice message.
    Cache by mtime if it ever matters.

## Test matrix (v0.6.0+v0.7.0+v0.8.0 verification)

All 6 original knobs verified against `pi-agent-john` on 2026-08-17:

| # | Knob | Value tested | Probe | Result |
|---|---|---|---|---|
| 1 | `inbound.echoEnabled` | `false` | voice message | Pass — no `🎙️` echo; agent recovered via `transcribe_audio` tool (self-aware, didn't double-transcribe) |
| 2 | `tools.enabled` | `false` | "what voice tools do you have?" | Pass — agent listed no voice tools |
| 3 | `tools.tts.enabled` | `false` | same | Pass — only `transcribe_audio` listed |
| 4 | `tools.stt.enabled` | `false` | same | Pass — only `synthesize_voice` listed |
| 5 | `tools.tts.name` | `tts_cantonese` | same | Pass with caveat (v0.7.0) — function name renamed, but prompt-text strings still said "synthesize_voice" (LLM worked around) |
| 6 | `tools.stt.name` | `transcribe_yue` | same | Pass with caveat (v0.7.0) — same as #5 |

v0.8.0 added 3 tests:

| # | Knob / behavior | Config | Result |
|---|---|---|---|
| 7 | Env-var fallback | No `tts.*` / `stt.*` in JSON, no env vars | Pass — agent reports hardcoded defaults (`Cantonese_PlayfulMan`, `Chinese,Yue`, `speech-2.8-hd`, `yue`, `http://127.0.0.1:8080`) |
| 8 | JSON overrides hardcoded | `tts.lang: "Japanese"`, `stt.lang: "en"` | Pass — agent reports `Default lang: Japanese` for `synthesize_voice` |
| 9 | Name templating (round-5/6 fix) | `tools.tts.name: "tts_yue"` + `tts.lang: "ja"` | Pass — agent's response uses `tts_yue` throughout, zero `synthesize_voice` references |

## Maintenance checklist for adding new knobs

When adding a new knob to `pi-voice-telegram.json`, update **all eight** of the following:

1. **`CompanionConfig` interface** in `config.ts` — add the field to the schema (with JSDoc explaining the env-var fallback, if any).
2. **`TTS_FALLBACKS` / `STT_FALLBACKS` constants** in `config.ts` — if the knob has a hardcoded default. Use these in `DEFAULT_CONFIG` so the auto-seed writes a complete file.
3. **`resolveTtsDefaults` / `resolveSttDefaults`** in `config.ts` — if the knob has an env-var fallback. JSON > env > hardcoded layering.
4. **`DEFAULT_CONFIG`** in `config.ts` — the auto-seed reads this when the file is missing. Keep it in sync so a fresh install produces a complete file (the v0.8.0 oversight: this was stale at v0.7.0 values until 2026-08-17).
5. **`examples/pi-voice-telegram.json`** — the copy-paste example. Must match `DEFAULT_CONFIG` byte-for-byte (verified via `diff`). v0.8.0 used tabs; auto-seed uses 2-space indent. Aligned to 2-space.
6. **README.md settings table** — the `| key | default | description |` rows.
7. **PLAN.md knobs table** — the test-matrix "Open design questions" or "v0.x.x+ candidates" sections.
8. **`pi-voice-telegram.schema.json`** — add the field with `description`, `default`, and `examples`. The schema is the source of truth for both the auto-seed (via `pi_voice_telegram_config_reset`) and the agent's introspection (via `pi_voice_telegram_schema`).

When adding a **new LLM tool**, also update:
- `tools.ts` — `registerXxxTool` function, plus a `XXX_PROMPT` constant with `description` / `promptSnippet` / `promptGuidelines`. The promptGuidelines should cross-reference related tools (e.g. list_voices when the new tool writes/reads `tts.voice`).
- `index.ts` — import the new `registerXxxTool` and call it in the `tools.enabled === true` block.
- `package.json` `files` whitelist — add any new data file (e.g. `voices.json` for v0.15.0) so it ships with the npm package.
- The top-of-file changelog comment in `index.ts` — append a `v0.X.0:` section describing the new tool.

A pre-commit hook could verify (5) byte-equal with the auto-seed output, but that's deferred. For now, when adding a knob, run this to verify:

```bash
# After updating DEFAULT_CONFIG, redeploy and trigger auto-seed in a throwaway dir
rm /tmp/test-pi-voice-telegram.json
node -e "
  const { loadCompanionConfig } = await import('./index.ts');
  // Or just compare the example file with what you'd write
" 2>&1
diff examples/pi-voice-telegram.json /tmp/test-pi-voice-telegram.json && echo "✓ in sync" || echo "✗ OUT OF SYNC"
```

Real verification: trigger a fresh auto-seed on `pi-agent-john` by deleting the file and restarting. The seeded content should be byte-equal with `examples/pi-voice-telegram.json` (modulo `tools.enabled`, which the example sets to `false` for safety).

## What this extension does NOT do

- **Owns `voice.replyMode` / `voice.sendTranscript`.** Bridge owns those, in `telegram.json`. The companion may *read* them (for the adaptive guidelines in v0.7.0) but doesn't write or own them.
- **Owns the bot token or chat ID.** Bridge owns those, in `telegram.json` `profiles.*`.
- **Starts/stops `whisper-server`.** Host-side lifecycle, not the extension's concern.
- **Renders the agent's voice reply UI.** The bridge's `telegram_attach` and the synthesis provider handle delivery; the extension just supplies capabilities.

## Migration notes

- v0.5.0 → v0.6.0: no breaking changes. The companion settings file is opt-in. Existing deployments that don't have `pi-voice-telegram.json` get the same behavior as v0.5.0 (echo on, no tools). To enable tools, add the file with `tools.enabled: true`.
- v0.6.0 → v0.7.0: no breaking changes. On first restart after upgrade, the extension writes a default `pi-voice-telegram.json` to disk if absent (logged once). The default matches v0.5.0 behavior (echo on, tools off), so the seed is a no-op for behavior. Existing operator-edited files are not touched.
- `package.json` peer-deps gain `@sinclair/typebox` (marked `optional: true` in `peerDependenciesMeta` since the agent bundles it transitively; only needed at the extension's build/test time, not at runtime when consumed by the agent).

## File history (high level)

- **v0.1.0** — initial scaffold. Synthesis provider + transcription provider. Bash wrappers.
- **v0.2.0** — `mm-tts.ts` converted from CLI to in-process ESM. `voice-reply.ts` orchestrator. ffmpeg is the only remaining process boundary.
- **v0.3.0** — `whisper-stt.ts` converted from bash wrapper to in-process TypeScript. `fw-cuda-stdout` host script orphaned.
- **v0.4.0** — README + INSTALL docs updated to reflect in-process pipelines.
- **v0.5.0** — `echo.ts` consolidated; `clearTranscriptCache` exports; per-session transcript cache.
- **v0.6.0** — companion settings file + LLM tool surface (`synthesize_voice`, `transcribe_audio`).
- **v0.7.0** — auto-seed `pi-voice-telegram.json` on first run (when missing). Operator-facing discoverability for the new settings file. 6-knob test matrix completed against `pi-agent-john`.
- **v0.8.0** — per-extension TTS/STT defaults in JSON (`tts.*`, `stt.*`) with JSON > env > hardcoded layering. Templated prompt text against resolved tool name. 3 tests passed against `pi-agent-john`. Auto-seeded `DEFAULT_CONFIG` and `examples/pi-voice-telegram.json` brought up to date.
- **v0.9.0** — self-describing settings file. `pi-voice-telegram.schema.json` (JSON Schema with descriptions/examples for every key) shipped in the repo; `$schema` + `_hint` fields added to the seeded file. Editors and LLMs get inline hints; humans get an at-a-glance pointer in `cat` output.
- **v0.10.0** — `pi_voice_telegram_schema` tool. The LLM can now call a tool that returns the companion settings schema as text (full or per-key). Useful for the agent-modifies-config feature (planned v0.11+).
- **v0.11.0** — agent-modifies-config opt-in. New `tools.writable: true` flag enables two more tools (`pi_voice_telegram_config_read` / `_write`). Schema-validated, atomic, refuses `$schema` / `_hint` / unknown keys. 3 tests passed against `pi-agent-john`; one real bug found and fixed mid-test.
- **v0.12.0** — drop fake-security `tools.writable` flag. Add a recovery primitive (`pi_voice_telegram_config_reset`) that backs up the current file and overwrites with a hardcoded `DEFAULT_CONFIG`. The user pointed out the writable flag was operator-preference dressed up as a security boundary; the real boundary is the container's filesystem permissions, not a JSON flag.
- **v0.13.0** — schema-driven reset + proactive evolution. Redesigned `resetConfig` to walk the JSON Schema, fill in MISSING fields with the schema's `default` value, preserve the operator's existing values. Updated the config tool promptGuidelines to encourage the LLM to evolve the config based on observed usage patterns. The schema is now the source of truth for "what fields exist and what their defaults are"; the hardcoded JSON is for first-install auto-seed only.
- **v0.14.0** — hot-reload the companion settings via `fs.watch` on the directory containing `pi-voice-telegram.json` (200ms debounce, file-level watching detached on Linux/Docker overlay so the directory is watched instead). The `reconfigure()` closure tears down + re-registers all capabilities; the synthesis provider reads the JSON on every call (via the v0.5.0+patch for the cluster) so TTS defaults take effect on the next bridge event. Best-effort: if `fs.watch` fails, the extension logs a warning and falls back to session_start-only behavior.
- **v0.15.0** — `pi_voice_telegram_list_voices` tool backed by an embedded `voices.json` catalog (327 MiniMax TTS voices × 24 languages, ~58KB). The agent can now discover valid voice IDs in-band instead of guessing (and getting 2054). The catalog is rebuilt from the upstream page via `scripts/build-voice-catalog.py` and shipped in the npm package. Prompt nudges on `synthesize_voice`, `pi_voice_telegram_config_write`, and `pi_voice_telegram_schema` point at the new tool. The schema's `tts.voice` / `tts.lang` descriptions are updated to note the cross-language voice+lang "boost" semantics.
- **v0.16.0** — inline TTS self-check via whisper-stt language detection. New `detectLanguage()` in `whisper-stt.ts` exposes the verbose_json detection that whisper-server already supports. New `tts.verifyAfterSynthesize` setting (default true) runs the check after every synthesis in both the bridge path (`synthesis-provider.ts`) and the LLM path (`synthesize_voice` tool). Result logged under `category: "pi-voice-telegram/tts-verify"` with `requestedLang`, `detectedLanguage`, `confidence`, and a `match` boolean. Catches the cross-language "boost" misfires that would otherwise silently produce audio in the wrong language. Adds ~500ms–1s per synthesis; opt out via `tts.verifyAfterSynthesize: false`.
- **v0.16.1** — `CONFIG_RESET_PROMPT` overhaul so "reset config" maps directly to `pi_voice_telegram_config_reset` without the agent asking for clarification. The new prompt marks `config_reset` as the default interpretation of "reset config" and explicitly cites the `.bak` safety net to unblock the LLM's cautious-by-default behavior. Also fixed a stale "restart required" line in the description (the v0.14.0 hot-reload obsoleted it; only the promptGuidelines were fixed in v0.14.2). First npm publish via the v0.6.0+ feature set.
- **v0.16.2** — JSON-driven STT defaults + degenerate-output fallback in `echo.ts`. The JSON's `stt.lang` / `stt.baseUrl` / `stt.timeoutMs` are now consumed via a `setSttDefaults()` hook called by `index.ts`'s reconfigure (was reading env + hardcoded directly — the v0.8.0+ design is "JSON > env > hardcoded" but v0.16.1's echo.ts skipped the JSON layer). Plus a one-shot fallback retry when the primary STT result is empty, <2 chars, or punctuation-only — retries without the lang hint so whisper auto-detects, which produces verbatim Cantonese consistently. The primary result is logged via `recordTelegramRuntimeEvent` with `phase: "stt-fallback"` for visibility into the model's failure mode.
- **v0.16.8** — flip the `tts.verifyAfterSynthesize` default from `true` to `false`. The self-check (whisper-stt language detection on every synthesized OGG, logged under `category: "pi-voice-telegram/tts-verify"`) was introduced in v0.16.0 as on-by-default, costing ~500ms–1s per synthesis for observability of cross-language "boost" misfires. v0.16.8 turns it off by default — operators who want the cross-language signal can set `tts.verifyAfterSynthesize: true` explicitly. Backward-compatible: deployments that already have `tts.verifyAfterSynthesize: true` in their `pi-voice-telegram.json` keep it on (their explicit setting wins). Only the fallback in `config.ts:164` (and the schema default in `pi-voice-telegram.schema.json`) flip. Schema description, `_hint` in `DEFAULT_CONFIG` and `examples/pi-voice-telegram.json`, README knobs table, and `docs/CODE-FLOW.md` updated.
- **v0.16.9** — rename the master LLM tool switch from `tools.enabled` to `tools.exposed`. The nested `tools.tts.enabled` and `tools.stt.enabled` are unchanged. The new name is a better fit semantically — the tools are either registered (exposed) or not, not "enabled/disabled" in the runtime sense. The rename is **breaking** for any deployment with the old `tools.enabled` key in their `pi-voice-telegram.json` — those configs will be treated as if the master switch is off (no LLM tools registered). Migration: rename `tools.enabled` to `tools.exposed` in the config file. Changes: `config.ts` type definition (top-level `exposed?: boolean`); `index.ts` runtime check (`cfg.tools?.exposed === true`); `pi-voice-telegram.schema.json` (property renamed, description updated with the migration note); `examples/pi-voice-telegram.json` (line 8: `tools.enabled: false` → `tools.exposed: false`); `tools.ts` (config_read / config_write prompt descriptions reference the new key); `README.md` (knobs table row + descriptive prose); `docs/CODE-FLOW.md` (gitignored, kept in sync).
- **v0.16.10** — namespace rename from `tools` to `llm_tools`. The internal field names are unchanged (`llm_tools.exposed` is the master, `llm_tools.tts.enabled` / `llm_tools.tts.name` and `llm_tools.stt.enabled` / `llm_tools.stt.name` are the sub-tool switches). The `llm_tools.` prefix makes it explicit that these switches gate the LLM tool surface (registration of the 7 LLM-callable tools) — not the TTS/STT extension features, which run unconditionally; only their LLM-tool wrappers (`synthesize_voice` / `transcribe_audio`) are gated here. The TTS provider keeps synthesizing every voice reply (`voice.replyMode: mirror`); the STT client keeps transcribing every voice message for the echo; the user always hears the agent's voice. **Breaking**: any v0.16.9 config with `tools.*` will be treated as if the master switch is off (no LLM tools registered). Migration: rename `tools` to `llm_tools` in the config file. Changes: `config.ts` type definition (`tools?` → `llm_tools?`, all internal fields preserved); `index.ts` runtime check (`cfg.tools?.exposed === true` → `cfg.llm_tools?.exposed === true`); `pi-voice-telegram.schema.json` (top-level property renamed, description includes v0.16.10 migration note); `examples/pi-voice-telegram.json` (top-level key renamed, `_hint` bumped to v0.16.10+); `tools.ts` (config_read / config_write / schema / list_voices descriptions reference the new namespace); `README.md` (knobs table + descriptive prose in 4 places); `docs/CODE-FLOW.md` (gitignored, kept in sync).
- **v0.16.11** — remove `examples/pi-voice-telegram.json`. The example file was a hand-maintained duplicate of `DEFAULT_CONFIG` (the auto-seed source of truth), 95% identical with only the master switch and a couple of `true` overrides differing. The "byte-equal" maintenance lesson in PLAN.md (added at v0.8.0) was supposed to prevent drift, but the file still drifted three times in this session alone (v0.16.8 verify default, v0.16.9 tools.exposed rename, v0.16.10 llm_tools namespace). The convention wasn't working. The auto-seed on first start produces a strictly better source of truth (it's what the extension itself uses) and is hot-reloadable, so there's no need for a separate copy-paste-ready file. The file is also removed from the npm package's `files` array. Changes: `package.json` drops `"examples/"`; `config.ts:234-242` removes item 5 from the MAINTENANCE checklist; the docstring at the end of the checklist notes the v0.16.11 removal; `_hint` in `DEFAULT_CONFIG` bumped to v0.16.11+; `README.md` line 273 (the "see `examples/...`" reference) replaced with a one-liner about flipping the master switch after the auto-seed. Historical PLAN.md references to the example file (v0.5.0 through v0.16.10) are preserved as-is — they describe what was true at past versions.
- **v0.16.12** — per-tool gates under `llm_tools.tools.<name>`. Each of the 7 LLM tools can be individually enabled/disabled, replacing the v0.16.10 `llm_tools.tts.enabled` and `llm_tools.stt.enabled` shortcuts. The reasoning: every tool the LLM sees is added to its prompt, and per-tool gates let operators trim the surface to save tokens + reduce the LLM's decision space (agents get confused by too many tool choices). **All 7 tools default to `true`** (back-compat with v0.16.10's "everything on when exposed: true" behavior). The `tts.name` and `stt.name` sub-objects stay as name overrides only (the `enabled` fields are gone). **Breaking** for any v0.16.10 config that had `llm_tools.tts.enabled: false` or `llm_tools.stt.enabled: false` — the old fields are silently ignored in v0.16.12 (the per-tool gate defaults to `true`). Migration: `llm_tools.tts.enabled: false` → `llm_tools.tools.synthesize_voice: false` (and similarly for STT). Changes: `config.ts` type definition adds `tools?: { [name]: boolean }`; the `tts.enabled` and `stt.enabled` fields are removed from the type; `DEFAULT_CONFIG.llm_tools.tools` lists all 7 with `true`; `_hint` bumped to v0.16.12+; `index.ts` runtime replaces the 2 sub-gate checks with 7 per-tool checks (via a `toolEnabled(name)` helper); `pi-voice-telegram.schema.json` adds the `tools` property with full descriptions for each of the 7 tool gates and a v0.16.12 migration note; `examples/pi-voice-telegram.json` was already deleted in v0.16.11; `README.md` knobs table and the LLM tools section both reflect the per-tool design; `docs/CODE-FLOW.md` (gitignored) kept in sync.
- **v0.17.0** — provider-responsibility fixes per the 2026-08-19 upstream convention audit. (1) Drop the false `rate` claim from the layered-defaults docstring in `synthesis-provider.ts` (the code never read it). (2) Log a runtime event on silent caption truncation at 1024 chars — previously no signal. (3) Mirror the bridge's `voice-`/`audio-` filename contract in `echo.ts` (audio messages were silently dropping the `🎙️` echo because the stash always used `voice-` regardless of the message kind; the bridge uses `audio-` for `message.audio`). No schema or behavior change for unchanged inputs. The v0.16.7+ candidate list (PLAN.md:469-573) is closed by this release. The full upstream-alignment plan (Phase A / B / C) is captured in the §"v0.17.0+ — Align with upstream pi-telegram conventions" section below; Phase B (`getVoicePromptContribution`) and Phase C (`registerTelegramSection`) ship as v0.17.1 and v0.18.0 respectively and require the cluster to be on `@llblab/pi-telegram@0.36.5+`. Changes: `synthesis-provider.ts` (1-2 lines of docstring, 11 lines of runtime-event logging at the truncation site); `echo.ts` (38 lines added, 14 removed — the `mimeToExtension` and `fileNameFor` helpers replaced with a `guessExtensionFromMime` mirror of the bridge's `lib/media.ts:185`); `index.ts` (top-of-file changelog entry); `config.ts` (bumped `_hint` in `DEFAULT_CONFIG` to `v0.17.0+`); `package.json` (version bump); `PLAN.md` (this entry + the v0.17.0+ plan section).
- **v0.17.1** — implement `getVoicePromptContribution(view)` on the synthesis provider. Per `@llblab/pi-telegram/docs/voice.md`, the bridge calls this when a turn is voice-tagged (mirror + voice input, or always mode) and appends the first non-empty contribution to the LLM's prompt. The contribution nudges the LLM toward spoken style — no markdown, no lists, no URLs, no file paths, spell out abbreviations, keep it under ~150 words. Pure addition, no schema or behavior change for non-voice turns. Bridge version requirement: the API is present in `@llblab/pi-telegram@0.28.0+` (verified via `node_modules/@llblab/pi-telegram/lib/voice.ts:64`); no upgrade needed for this release. Closes Phase B / Task B1-B2 of the v0.17.0+ upstream-alignment plan. Changes: `synthesis-provider.ts` (~26 lines added — capture the synthesize function as a named variable, attach `getVoicePromptContribution` with a multi-line spoken-style prompt contribution, return the function; plus a new import for `TelegramVoiceTurnView`); `index.ts` (top-of-file changelog entry); `config.ts` (bumped `_hint` in `DEFAULT_CONFIG` to `v0.17.1+`); `package.json` (version bump); `PLAN.md` (this entry).

---

## v0.17.0+ — Align with upstream pi-telegram conventions

**Status:** PLANNED (not yet shipped). Three independently-releasable phases, ordered by risk: low → medium → high.

**Why:** A 2026-08-19 convention audit against the upstream's [`docs/voice.md`](https://github.com/llblab/pi-telegram/blob/main/docs/voice.md) found ~85% adherence to the runtime contract. The bridge-facing API (provider registration, return shapes, file format, runtime events, session lifecycle, stable IDs, disposers) is used correctly and idiomatically. Three gaps, in priority order:

1. **No `registerTelegramSection`** — the upstream's recommended discoverability surface for provider settings is missing. Operator-facing knobs (voice, lang, model, verify, echo, STT, llm_tools) live in a hidden hand-edited JSON file or env vars instead of the bridge's Telegram UI.
2. **No `getVoicePromptContribution`** — the upstream-provided seam for shaping voice-tagged prompts (e.g. "reply only with the spoken text, no markdown") is unused.
3. **The v0.16.7+ candidate list** (the 2026-08-18 self-critical review) — `rate` layering bug at `synthesis-provider.ts:137`, silent caption truncation at 1024 chars, chat-ID lookup fragility in `echo.ts:163-165`, no retry on transient 5xx, no STT cache, redundant telegram.json re-reads.

**Architecture:** three phases, each shippable as its own release. Each phase has its own PR, its own version bump, its own release/cluster-upgrade pass per PLAN.md:426-436.

- **Phase A (v0.17.0):** recommendation 3 items that are low-risk provider-responsibility fixes. Doc-vs-code drift fix + one runtime event + one verification step (with a possible fix). No behavior change for unchanged inputs.
- **Phase B (v0.17.1):** recommendation 2 — `getVoicePromptContribution` implementation. Pure addition, no behavior change.
- **Phase C (v0.18.0):** recommendation 1 — `registerTelegramSection` migration. The biggest change — moves the 7 settings from a hidden JSON file to the bridge's Telegram UI. Backward-compatible: existing `pi-voice-telegram.json` files are still read as a fallback, with the Telegram UI as the new primary surface.

**Tech Stack:** existing ESM TypeScript (jiti-loaded, no build), JSON Schema (existing), the bridge's public API (`@llblab/pi-telegram/voice`, `/sections`, `/outbound`), `@sinclair/typebox` (existing peer dep).

**Global constraints (apply to every task):** follow existing code style (2-space indent, single quotes, trailing commas); schema-driven config; hot-reload on every reconfigure; each release preserves the previous release's effective behavior for unchanged configs; new features are opt-in; Conventional Commits for commit messages; update `package.json` version, `_hint` in `DEFAULT_CONFIG`, top-of-file changelog in `index.ts`, and the File history bullet when a phase ships.

### Phase A — v0.17.0: Provider-responsibility fixes

#### Task A1: Reconcile the `rate` layering docstring

**Files:**
- Modify: `synthesis-provider.ts:1-30` (top-of-file JSDoc)

**Context:** the JSDoc at the top of `synthesis-provider.ts` claims the layered default resolution includes `telegram.json.outboundHandlers[voice].defaults.rate`, but the code at `synthesis-provider.ts:137` resolves `speed` as `Number(options?.rate ?? 1.0)` — the `defaults.rate` field is read off the file but never used. An operator who sets `defaults.rate = 1.5` gets 1.0. The self-critical review at PLAN.md:476-488 picked the docstring fix as the safer one — don't add `defaults.rate` to the resolution until a real use case is demonstrated.

- [ ] **Step 1:** Read the current docstring at the top of `synthesis-provider.ts` (lines 1-30).
- [ ] **Step 2:** Remove the `rate` claim from the layered-defaults list in the JSDoc. Verify the rest of the docstring still makes sense.
- [ ] **Step 3:** Run `bash scripts/live-test.sh`. Should still pass.
- [ ] **Step 4:** Commit: `git commit -am "fix(synthesis): drop rate from layered-default docstring"`.

#### Task A2: Record a runtime event for silent caption truncation

**Files:**
- Modify: `synthesis-provider.ts` (around line 182, the truncation site)

**Context:** when `text.length > 1024` and `voice.sendTranscript === true`, the caption is clipped to 1023 chars + `…` while the audio is the full text. The user sees a truncated caption but hears the full narration. The truncation is silent — no runtime event, so the operator has no signal. Fix: record `recordTelegramRuntimeEvent("pi-voice-telegram/tts", null, { phase: "caption-truncated", textLength, captionLength: 1024 })` when the truncation happens.

- [ ] **Step 1:** Locate the truncation site in `synthesis-provider.ts` (the path where `getTelegramVoiceSendTranscript` returns true and the text is sliced to 1024 chars).
- [ ] **Step 2:** Add a `recordTelegramRuntimeEvent` call (the import is already at `synthesis-provider.ts:40`) when the truncation happens. Include `textLength` and `captionLength: 1024` in the event details.
- [ ] **Step 3:** Run `bash scripts/live-test.sh`. Should still pass.
- [ ] **Step 4:** Manual probe: send a long text (>1024 chars) through the synthesis path; tail `~/.pi/agent/tmp/telegram/logs.jsonl` for the new `caption-truncated` event.
- [ ] **Step 5:** Commit: `git commit -am "feat(synthesis): log runtime event on caption truncation"`.

#### Task A3: Verify the chat-ID lookup against the bridge's contract

**Files:**
- Investigate: `node_modules/@llblab/pi-telegram/lib/voice.ts` (or wherever `transcribeTelegramVoiceFileWithProviders` is defined; 0.28.0 path)
- Possibly modify: `echo.ts:160-170`

**Context:** the update handler stashes the chat ID by `voice-<message_id>.<ext>` (built from `fileNameFor(msg.message_id, ext)` at `echo.ts:163-165`). The provider looks it up by `file.fileName` (the name the bridge actually uses). If the bridge's naming convention differs from the deterministic name the update handler assumed, the echo is silently dropped (the `if (chatId)` block at `echo.ts:269` is skipped). This is the v0.16.7 silent-failure mode that replaced the v0.16.6 empty-transcript mode (per PLAN.md:527-543).

- [ ] **Step 1:** Read the bridge's `transcribeTelegramVoiceFileWithProviders` (or equivalent) in `node_modules/@llblab/pi-telegram/lib/voice.ts` to see what `fileName` it passes to the provider.
- [ ] **Step 2:** Compare with `fileNameFor` in `echo.ts:160-170`. Document the match/mismatch as a comment in this PLAN section.
- [ ] **Step 3a (names match):** no code change. Add a comment in `echo.ts` explaining the verified contract (e.g. "the bridge's `transcribeTelegramVoiceFileWithProviders` passes the same `fileNameFor(msg.message_id, ext)` name the update handler stashes by — verified against `@llblab/pi-telegram@0.28.0` `lib/voice.ts:NNNN`").
- [ ] **Step 3b (names don't match):** fix the chat-ID lookup. The likely fix is to thread the chat ID through the bridge's options object (if the API supports it) or to look up by `message_id` instead of by `fileName`. Document the chosen approach in this PLAN section.
- [ ] **Step 4:** Run `bash scripts/live-test.sh`. If a fix was made, also send a real voice message via Telegram and verify the `🎙️` echo arrives.
- [ ] **Step 5:** Commit: either `git commit -am "docs(echo): document verified chat-id-by-filename contract"` (3a) or the appropriate fix commit (3b).

#### Phase A ship checklist

- [ ] All three tasks (A1, A2, A3) committed on a feature branch and merged to `master`
- [ ] `scripts/live-test.sh` passes against the cluster
- [ ] `_hint` in `DEFAULT_CONFIG` (`config.ts`) bumped to `v0.17.0+`
- [ ] Top-of-file changelog comment in `index.ts` gets a `v0.17.0:` section
- [ ] `package.json` version bumped to `0.17.0`
- [ ] `npm publish` + cluster upgrade per PLAN.md:426-436
- [ ] File history bullet appended to this PLAN.md's §"File history (high level)"
- [ ] Tag the release: `git tag -a v0.17.0 -m "..."`

### Phase B — v0.17.1: `getVoicePromptContribution`

#### Task B1: Check the bridge's exact API for the contribution seam

**Files:**
- Investigate: `node_modules/@llblab/pi-telegram/lib/voice.ts` (TSDoc on the synthesis-provider factory)
- Reference: `docs/voice.md` (the upstream contract)

**Context:** `voice.md` says providers can implement `getVoicePromptContribution(view)` to inject voice-specific instructions into voice-tagged prompts. The bridge "appends the first non-empty provider contribution when `mirror` or `always` mode tags the turn." Need the exact signature (the `view` type, the return type, the seam name) before implementing.

- [ ] **Step 1:** Read the TSDoc on the synthesis-provider factory in `node_modules/@llblab/pi-telegram/lib/voice.ts`. Search for `getVoicePromptContribution`, `promptContribution`, or similar.
- [ ] **Step 2:** Verify the contract against `docs/voice.md`. Document the exact signature (import path, parameter type, return type) as a comment in this PLAN section.
- [ ] **Step 3:** If the API is missing in the installed 0.28.0 but present in 0.36.5 (likely), note that Phase B depends on the cluster being upgraded to 0.36.5+ first. Either upgrade before Phase B, or defer Phase B until after the upgrade.

#### Task B2: Implement the contribution in `synthesis-provider.ts`

**Files:**
- Modify: `synthesis-provider.ts` (add the contribution function, wire it to the provider factory)

**Context:** pi-voice-telegram currently has no contribution. The default behavior (LLM uses markdown, includes code blocks, etc.) is wrong for spoken voice replies. The contribution should nudge the LLM to use spoken-style formatting.

- [ ] **Step 1:** Add a `getVoicePromptContribution(view)` function in `synthesis-provider.ts`. Initial content: a short string like *"Reply in spoken style — no markdown, no code blocks, no bullet lists, no URLs. Use natural sentences. Keep it under 200 words unless the user asked for detail."* (Final wording tuned against a real test.)
- [ ] **Step 2:** Wire the function into the synthesis provider factory (wherever `createMmTtsSynthesisProvider` accepts the contribution — likely a second-arg options object).
- [ ] **Step 3:** Run `bash scripts/live-test.sh`. Should still pass.
- [ ] **Step 4:** Manual probe: in `mirror` mode, send a voice message that asks the agent a question that would normally produce markdown. Verify the voice reply is in spoken style (no markdown audio artifacts).
- [ ] **Step 5:** Commit: `git commit -am "feat(synthesis): add getVoicePromptContribution for voice-tagged prompts"`.

#### Phase B ship checklist

- [ ] Tasks B1-B2 committed
- [ ] `_hint` bumped to `v0.17.1+`
- [ ] Top-of-file changelog in `index.ts` gets a `v0.17.1:` section
- [ ] `package.json` version bumped to `0.17.1`
- [ ] File history bullet appended
- [ ] Tag the release: `git tag -a v0.17.1 -m "..."`
- [ ] Cluster upgrade per PLAN.md:426-436

### Phase C — v0.18.0: Voice Extension Section

**Goal:** move the 7+ provider settings from a hidden JSON file (or env vars) to the bridge's Telegram UI, per `voice.md`'s `registerTelegramSection` recommendation. The companion's settings become discoverable in `/telegram-settings` like the bridge's own settings. The `pi-voice-telegram.json` file becomes a backward-compat fallback and (eventually) documentation only.

#### Task C1: Read the bridge's section API contract

**Files:**
- Investigate: `https://github.com/llblab/pi-telegram/blob/main/docs/sections.md`
- Investigate: `node_modules/@llblab/pi-telegram/lib/sections.ts` (or wherever `registerTelegramSection` is defined)
- Investigate: `node_modules/@llblab/pi-telegram/docs/` for the sections-related TSDoc

**Context:** need the exact signature of `registerTelegramSection`, the section shape (what kinds of controls are supported: text input, dropdown, toggle, etc.), and the section's persistence model (where the values are stored when the operator changes them — `telegram.json` under a known key? a separate file? in the bridge's own state?).

- [ ] **Step 1:** Read `docs/sections.md` from the upstream.
- [ ] **Step 2:** Read the TSDoc on `registerTelegramSection` in the installed bridge package.
- [ ] **Step 3:** Document the API in this PLAN section as a comment block — import path, registration function signature, section shape, persistence model.
- [ ] **Step 4:** If the section's persistence model is "the bridge stores the values in `telegram.json`", then `loadCompanionConfig` in `config.ts` needs to read from `telegram.json` (under the section's key) instead of from `pi-voice-telegram.json`. If the persistence model is "the section gets a callback to read/write wherever it wants" (e.g. `onValueChange: (values) => { ... }`), the migration is simpler. Document the chosen approach.
- [ ] **Step 5:** If the API is missing in 0.28.0 but present in 0.36.5, note the dependency on the cluster upgrade (same as Phase B).

#### Task C2: Design the section shape

**Files:**
- Modify: `pi-voice-telegram.schema.json` (extend the schema with the section's shape, or create a section-specific schema)
- New: `docs/superpowers/plans/2026-08-19-voice-section.md` (the detailed Phase C design doc, after C1 clarifies the API)

**Context:** the upstream says provider settings (voice, language, speech style, transcript behavior, STT/TTS enablement) belong in the section. pi-voice-telegram has all of these. The section needs a clean shape that maps 1:1 to the existing settings, with logical grouping.

- [ ] **Step 1:** Map each existing setting to a section control (using the API surface documented in C1):
  - `tts.voice` — text input + a "list voices" affordance (calls `pi_voice_telegram_list_voices`)
  - `tts.lang` — text input or dropdown
  - `tts.model` — text input or dropdown
  - `tts.verifyAfterSynthesize` — toggle
  - `inbound.echoEnabled` — toggle
  - `stt.lang` — text input
  - `stt.baseUrl` — text input
  - `llm_tools.exposed` — toggle (master)
  - `llm_tools.tools.<name>` — 7 toggles
- [ ] **Step 2:** Decide grouping: four groups — **TTS** (voice, lang, model, verify), **STT** (lang, baseUrl), **Inbound echo** (echoEnabled), **LLM tools** (exposed, the 7 tool gates).
- [ ] **Step 3:** Write the section shape into the schema. If the section uses the same `pi-voice-telegram.schema.json` schema (most likely), extend it. Otherwise create a section-specific schema file.
- [ ] **Step 4:** **Get user sign-off on the section shape before implementing** — present the design in the chat and wait for approval.

#### Task C3: Implement the section registration in `index.ts`

**Files:**
- Modify: `index.ts` (add `registerTelegramSection` call in `reconfigure()`)
- Modify: `config.ts` (read from the section's stored values first, fall back to `pi-voice-telegram.json` for backward compat)
- Modify: `pi-voice-telegram.schema.json` (extend the description and `_hint` to mention the new primary surface)

- [ ] **Step 1:** Import `registerTelegramSection` from `@llblab/pi-telegram/sections`.
- [ ] **Step 2:** Build the section shape from the resolved config (using the Task C2 design).
- [ ] **Step 3:** Call `registerTelegramSection(...)` in `reconfigure()` and add the disposer to the `disposers` array (the existing hot-reload pattern at `index.ts:248-249`).
- [ ] **Step 4:** Update `loadCompanionConfig` in `config.ts` to read the section's stored values first, then fall back to `pi-voice-telegram.json` (so existing deployments don't break). Decide what happens when both are present: section wins (recommended), with a runtime event warning the operator that the JSON file is being ignored.
- [ ] **Step 5:** Update the docstring at `config.ts:282` to point operators to the Telegram UI as the primary surface, with the JSON as a documented fallback. The current text "TTS/STT settings (tts.lang, tts.voice, tts.model, stt.lang, stt.baseUrl, etc.) live in THIS file" becomes "TTS/STT settings now live in the Telegram Settings UI (Voice Extension Section). This file is a fallback for deployments that haven't yet adopted the UI."
- [ ] **Step 6:** Update `pi-voice-telegram.schema.json`'s top-level description to reflect the new primary surface.
- [ ] **Step 7:** Run `bash scripts/live-test.sh`. Should still pass.
- [ ] **Step 8:** Manual probe: open `/telegram-settings` in Telegram, navigate to the new "Voice (pi-voice-telegram)" section, change `tts.voice`, save, verify the change takes effect on the next synthesis.
- [ ] **Step 9:** Commit: `git commit -am "feat: register Voice Extension Section for provider settings"`.

#### Task C4: Update docs and docstrings

**Files:**
- Modify: `README.md` (Settings section, knobs table)
- Modify: `docs/DESIGN-INTENT.md` (§6 "Self-describing config + LLM-friendly ergonomics" — note the new UI surface)
- Modify: `docs/CODE-FLOW.md` (gitignored; keep in sync)

- [ ] **Step 1:** Update the README's Settings section to point at the Telegram UI as the primary surface, with the JSON as a fallback.
- [ ] **Step 2:** Update the README's knobs table to note the UI surface for each setting (one column or footnote).
- [ ] **Step 3:** Update `docs/DESIGN-INTENT.md` §6 to note the section.
- [ ] **Step 4:** Update `docs/CODE-FLOW.md` to reflect the new config flow (section first, JSON fallback).
- [ ] **Step 5:** Commit: `git commit -am "docs: point operators at the new Voice Extension Section"`.

#### Phase C ship checklist

- [ ] Tasks C1-C4 committed on a feature branch and merged to `master`
- [ ] Backward compat: existing `pi-voice-telegram.json` files are still read as a fallback (with a deprecation warning if both are present)
- [ ] Live test passes
- [ ] Manual UI probe passes (set a value in the Telegram UI, verify the change takes effect on the next synthesis)
- [ ] `_hint` bumped to `v0.18.0+`
- [ ] Top-of-file changelog in `index.ts` gets a `v0.18.0:` section
- [ ] `package.json` version bumped to `0.18.0`
- [ ] Migration note added to PLAN.md §"Migration notes"
- [ ] File history bullet appended
- [ ] Tag the release: `git tag -a v0.18.0 -m "..."`
- [ ] Cluster upgrade per PLAN.md:426-436 (and ensure the cluster is on `@llblab/pi-telegram@0.36.5+` for the section API)

## Self-review

1. **Spec coverage:** all three recommendations are covered. Recommendation 1 → Phase C; Recommendation 2 → Phase B; Recommendation 3 → Phase A (with the v0.16.7+ candidates explicitly listed). ✅
2. **Placeholder scan:** no TBDs. Task A3 has a real "3a or 3b" branch (verification first, then conditional fix) — not a placeholder. Task C1 says "document the API" — the implementer must read the bridge's docs before proceeding, this is a real prerequisite step. Task C2 step 4 has an explicit user sign-off checkpoint. ✅
3. **Type consistency:** all modifications are to files that already exist (`synthesis-provider.ts`, `echo.ts`, `index.ts`, `config.ts`, `pi-voice-telegram.schema.json`). The new file `docs/superpowers/plans/2026-08-19-voice-section.md` is a Phase C artifact produced by Task C2, not a forward reference. The `registerTelegramSection` import is from `@llblab/pi-telegram/sections` per the upstream `voice.md`. ✅
4. **Dependency on bridge version:** Phase B (Task B1) and Phase C (Task C1) both require the cluster to be on a bridge version that exposes the new APIs. Per the 2026-08-19 version check, `journal.ts` is byte-identical between 0.28.0 and 0.36.5, but the *new* APIs (sections, prompt contribution) are in the 8 new files added in 0.29.0–0.36.5. **The cluster upgrade to 0.36.5+ must happen before or alongside Phase B/C.** This is called out in B1 step 3 and C1 step 5.

## Migration notes (v0.17.0+ → ...)

- **v0.16.12 → v0.17.0:** no breaking changes. Phase A is docstring + one runtime event + a verification step (and possibly a chat-ID fix if Task A3 finds a mismatch).
- **v0.17.0 → v0.17.1:** no breaking changes. Phase B is a pure addition.
- **v0.17.1 → v0.18.0:** **the cluster must be on `@llblab/pi-telegram@0.36.5+`** for the new APIs to register. Operators with existing `pi-voice-telegram.json` files do nothing — the file is still read as a fallback. Operators who prefer the new UI surface will see the section in `/telegram-settings`; the section's values take precedence over the JSON file. The auto-seed behavior is unchanged (still writes `pi-voice-telegram.json` on first start if missing); whether to keep the auto-seed after the section becomes the primary surface is a Phase C implementation decision (defer to Task C2 step 4 sign-off).
- **Cluster upgrade dependency:** the plan depends on `@llblab/pi-telegram@0.36.5+` being available in the cluster's `REQUIRED_PACKAGES` (currently `0.28.0` per `pi-cluster/docker-entrypoint.sh`). The cluster upgrade is independent of this plan but must happen before Phase B and Phase C ship — see PLAN.md:426-436 for the upgrade recipe.
