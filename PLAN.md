# Plan: `pi-voice-telegram`

**Status:** v0.7.0 shipped. v0.6.0 added companion settings + LLM tool surface. v0.7.0 makes the settings file auto-seed on first run.

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

## Open design questions (deferred from v0.6.0)

1. **Tool description should adapt to `voice.replyMode`.** When the bridge is in `hidden` mode, the tool's `promptGuidelines` should say: *"voice replies are not automatic in this session — use synthesize_voice when the user asks for an audio reply."* When in `mirror`/`always`, it should say: *"synthesize_voice is for ad-hoc voice (e.g. reading a file aloud), not for the turn reply — the bridge handles that."* The `ExtensionAPI` doesn't expose a "read telegram.json from inside promptGuidelines" hook, so the phrasing has to be baked in at `session_start` time (read once, choose one of two guideline sets). v0.6.0 ships a single guideline set that handles both cases; v0.7.0 can split it.

2. **TTS auto-send mode.** v0.6.0 uses the two-step pattern (synthesize → `telegram_attach`). A future `tools.tts.delivery: "telegram" | "file" | "auto"` could collapse to one-step when the bridge exposes a `sendTelegramVoice(filePath, chatId?)` directly. Defer until the bridge adds that primitive.

3. **Per-extension TTS defaults** (model / voiceId / format) currently live as `PI_MM_TTS_*` env vars. Could move into `pi-voice-telegram.json` as `tts.{model,voiceId,format}`. Not blocking.

4. **Echo template** is currently hard-coded `🎙️ "<i>{transcript}</i>"`. Could be made configurable via `inbound.echoTemplate: string | null`. Low priority.

5. **STT language default** is `PI_TELEGRAM_LANG` env or `"yue"`. Could move into the settings file as `stt.lang`. Low priority.

6. **`inbound.echoTemplate: null` semantics** — does "no echo" mean "still inject the transcript into the agent prompt" or "skip the entire pipeline"? v0.6.0 treats the kill switch as binary (`echoEnabled: false` skips the whole pipeline). A finer-grained "silent mode" (transcript yes, echo no) could be a v0.7.0 addition.

## v0.7.0+ candidates

- Adaptive `promptGuidelines` based on `voice.replyMode` (item 1).
- One-step TTS delivery if the bridge exposes a `sendTelegramVoice` primitive (item 2).
- `inbound.echoTemplate` (item 4).
- `stt.lang` and `tts.*` defaults in the settings file (items 3, 5).
- A `/voice-status` slash command that prints the resolved config (echo on/off, tools on/off, active tool names, current voice/lang defaults). Useful for debugging without a restart.
- A test scaffold for the tool wrappers. The current test coverage (if any) is integration-level only.

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
- **v0.7.0** — auto-seed `pi-voice-telegram.json` on first run (when missing). Operator-facing discoverability for the new settings file.
