# Plan: `pi-voice-telegram`

**Status:** v0.15.0 shipped. v0.6.0 added companion settings + LLM tool surface. v0.7.0 made the settings file auto-seed on first run. v0.8.0 moved per-extension TTS/STT defaults into the JSON and templated prompt text against the resolved tool name. v0.9.0 made the settings file self-describing via a JSON Schema. v0.10.0 added the `pi_voice_telegram_schema` tool. v0.11.0 added the agent-modifies-config opt-in (config_read + config_write). v0.12.0 dropped the fake-security `tools.writable` flag and added a config_reset tool. v0.13.0 made the reset tool schema-driven (fills missing fields with schema defaults) and updated the config tool promptGuidelines to encourage proactive evolution. v0.14.0 added hot-reload of the companion settings file via `fs.watch` on the containing directory (with 200ms debounce). v0.15.0 added the seventh LLM tool, `pi_voice_telegram_list_voices`, backed by an embedded `voices.json` catalog (327 MiniMax TTS voices × 24 languages).

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
