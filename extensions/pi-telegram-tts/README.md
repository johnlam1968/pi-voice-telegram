# pi-telegram-tts

Voice **synthesis** provider for the Pi coding agent +
[@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge.
Unlocks `getVoicePromptContribution` for voice-tagged turns and
provides a registered synthesis provider tier in the bridge's
voice-delivery pipeline (`lib/outbound-voice.ts`).

**v0.7.0** — direct `fetch` to the provider. No bundled scripts, no
`bin` field, no per-provider sub-block. The LLM's reply is the only
field interpolated at call time; all other API params (voice, model,
speed, emotion, sample_rate, etc.) are hardcoded as constants in
`synth.ts` (`MINIMAX_BODY` / `OPENAI_BODY`). The operator's current
Cantonese voice settings are baked into `MINIMAX_BODY`. To adjust a
rare flag, edit `synth.ts` (the agent can do it via its `edit`
tool). `telegram.json` only carries the 3 essentials:
`disabled` + `provider` + `composeWithText`.

**STT is delegated to [`pi-telegram-stt`](../pi-telegram-stt/README.md)**
and its provider extensions. This package only does TTS.

## Install

From npm (once published):

```bash
pi install npm:pi-telegram-tts
```

(No `bin` field since v0.7.0 — the scripts are gone. The provider is
the only TTS path; no separate CLI tool is exposed.)

On-host dev loader (one-liner re-export shim), assuming the operator
runs from the source repo:

```bash
cat > ~/.pi/agent/extensions/pi-telegram-tts.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-telegram-tts/index.ts";
EOF
```

The provider body constants live in `extensions/pi-telegram-tts/synth.ts`.

## Configure (v0.7.0)

Edit `~/.pi/agent/telegram.json`:

```json
{
	"voice": {
		"replyMode": "mirror"
	},
	"extensions": {
		"pi-telegram-tts": {
			"disabled": false,
			"provider": "minimax",
			"composeWithText": "auto"
		}
	}
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `disabled` | boolean | master switch — `true` returns `undefined` and the bridge falls through |
| `provider` | `"minimax"` \| `"openai"` | required for the provider to fire |
| `composeWithText` | `"off"` \| `"auto"` | (v0.4.0) `"auto"` sends a text message with the same content as the voice, then the voice follows; `"off"` (default) sends voice only |

Live edits take effect on the next voice-tagged turn (the provider
re-reads config on every call; the 200ms hot-reload watcher picks
up the change).

**Adjusting voice settings (e.g. `speed`, `emotion`, `lang`):** the
v0.3.0 / v0.6.0 per-provider sub-block pattern is gone. The
constants are in `synth.ts:MINIMAX_BODY` (and `OPENAI_BODY`).
Edit the file directly; the agent can do it via its `edit` tool.

```json
{
  "voice": { "replyMode": "mirror" },
  "extensions": {
    "pi-telegram-tts": {
      "provider": "minimax",
      "minimax": {
        "voice": "Cantonese_PlayfulMan",
        "model": "speech-2.8-hd",
        "lang": "Chinese,Yue",
        "speed": 1.0,
        "emotion": "neutral",
        "sample_rate": 32000,
        "bitrate": 128000,
        "format": "mp3",
        "pronunciation_dict": { "tone": ["example/pronunciation"] },
        "timbre_weights": []
      },
      "openai": {
        "voice": "coral",
        "model": "gpt-4o-mini-tts",
        "instructions": "Speak in Cantonese.",
        "speed": 1.0,
        "response_format": "mp3"
      }
    }
  }
}
```

### How it works

`synth.ts` has two `fetch` adapters — one per provider — and a
5-line dispatcher. Each adapter:

1. Resolves the API key (env var → `~/.mmx/config.json` for
   MiniMax, or `~/.pi/agent/auth.json` for OpenAI).
2. POSTs the hardcoded provider body (with `text` interpolated from
   the LLM's reply) to the provider's endpoint.
3. Writes the response (MP3 for both providers by default) to a
   tempdir, runs ffmpeg to convert to OGG/Opus, returns the OGG path.
4. Schedules a 60s tempdir cleanup timer.

The provider body constants live at the top of `synth.ts`:

- `MINIMAX_BODY` — operator's current Cantonese voice settings
  (`voice_id: "Cantonese_CuteGirl"`, `speed: 0.95`, `emotion:
  "happy"`, `language_boost: "Chinese,Yue"`, `modify_intensity: 0`,
  `modify_timbre: 10`, etc.). Edit this file to adjust.
- `OPENAI_BODY` — API defaults (`model: "gpt-4o-mini-tts"`, `voice:
  "alloy"`, `response_format: "mp3"`, `speed: 1.0`).

The 3-field `SynthConfig` (`disabled`, `provider`, `composeWithText`)
is read from `telegram.json#extensions["pi-telegram-tts"]` on every
call. The 200ms hot-reload watcher picks up changes; the next
voice-tagged turn uses the new config.

**Why this is simpler than v0.3.0 / v0.6.0:** the per-provider
sub-block pattern (`minimax: { voice, model, speed, ... }`) is
gone. No more schema validation, no more per-key merge, no more
`--config` tempfile + subprocess. The LLM's reply is the only
dynamic field. Adjusting a rare voice flag is an edit to
`synth.ts:MINIMAX_BODY` — the agent can do this via its `edit`
tool, which is the "operator or agent can change these flags"
mechanism.

## Migration from v0.6.0

v0.7.0 drops the bundled `tts-*.mjs` scripts. The on-host
`telegram.json` `outboundHandlers[0].template` paths (if any) become
dead references — clear `outboundHandlers[0]` (set it to `[]` or
delete the key) so the synthesis provider is the sole TTS path.
The provider now does a direct `fetch` to the configured provider;
no subprocess is spawned.

If you previously used the per-provider sub-block
(`minimax: { voice, model, speed, ... }`): those fields are now
hardcoded in `synth.ts:MINIMAX_BODY`. The operator's current
values were preserved in the cut (Cantonese_CuteGirl / speed 0.95 /
emotion happy / Chinese,Yue lang / etc.). If you want a different
voice or a different speed, edit the constants in `synth.ts`. The
agent can do it via its `edit` tool.

If you previously set `voice` + `model` at the top level of
`extensions["pi-telegram-tts"]`: those fields are no longer read.
The provider now uses the hardcoded `MINIMAX_BODY` (or
`OPENAI_BODY`) constants.

## Migration from the existing template

If you already have `outboundHandlers[0].template` configured (the
v0.19.0 default path): clear it. The v0.7.0 provider is a direct
`fetch` — there's no subprocess to fall back to. The operator's
`outboundHandlers[0]` (if any) is now dead weight; setting it to
`[]` makes the provider the sole TTS path.

## v0.2.0 / v0.4.0 / v0.6.0 / v0.7.0 capabilities

- `getVoicePromptContribution(view)` adds `[tts] Reply briefly; this
  turn will be spoken aloud via the configured TTS provider.` to
  voice-tagged prompts.
- Module-load + session_start dual registration, idempotent on
  hot-reload.
- **The v0.2.0 `/telegram-settings` section UI was DROPPED on
  2026-08-24** (per the operator's request) — the form-driven UI
  was more trouble than the `telegram.json`-driven config. All
  config is via `telegram.json`. The v0.2.0/v0.4.0 section work is
  preserved in git history for reference.
- **v0.6.0:** the in-package `saveSynthConfig` writer and
  `loadTelegramConfig` reader were both dropped. Per the
  operator's design rule: every config knob lives in
  `telegram.json`, edited by the operator or the agent via
  filesystem tools, picked up live by the 200ms hot-reload
  watcher. The in-package `loadSynthConfig` reader stays because
  it's the extension's own config interface at call time — the
  agent's `read` tool is the surface for operator / agent
  inspection, not the extension's runtime path.
- **v0.7.0:** the bundled `tts-{minimax,openai}.mjs` scripts (1215
  lines combined) + the per-provider sub-block pattern
  (`minimax: { voice, model, speed, ... }`) + the `schema.json`
  Draft 2020-12 schema (271 lines) + the `bin` field in
  `package.json` are all **deleted**. The provider does a direct
  `fetch` to the configured provider; the body is a hardcoded
  constant per provider (the operator's current Cantonese voice
  settings are baked into `MINIMAX_BODY`). The LLM's reply is
  the only field interpolated at call time. `telegram.json`
  carries just 3 fields: `disabled`, `provider`,
  `composeWithText`. To adjust a rare voice flag, edit
  `synth.ts:MINIMAX_BODY` — the agent can do it via its `edit`
  tool.

## v0.4.0 stage 1 — text+voice composition

Set `composeWithText: "auto"` in `telegram.json` to bring back the
v0.1.0 "voice with text caption" UX — but as **two adjacent
messages** (text first, then voice), not as a single voice message
with a caption. The v0.1.0 "same frame" UX is no longer achievable
via the public upstream API (upstream removed the caption path
entirely in v0.38.0; the public `sendTelegramView` is text-only).

```json
{
  "extensions": {
    "pi-telegram-tts": {
      "provider": "minimax",
      "voice": "Cantonese_PlayfulMan",
      "model": "speech-2.8-hd",
      "composeWithText": "auto"
    }
  }
}
```

When set to `"auto"`, the provider:
1. Spawns the TTS script + ffmpeg → OGG.
2. Sends a text message with the LLM's reply to the current turn's
   chat via `sendTelegramView({ text, parseMode: "html" }, { scope:
   { kind: "active-turn" } })` (best-effort; a failure is logged +
   recorded as a runtime event, the voice is still delivered).
3. Returns the OGG path; the bridge uploads the voice.

The user sees: **text message** (immediately) → **voice message** (a
moment later, after the TTS script + ffmpeg). Default is `"off"`
(voice only). Edit `telegram.json` directly to switch — the
200ms hot-reload watcher picks up the change on the next
voice-tagged turn.
- Bundled `tts-minimax.mjs` + `tts-openai.mjs` scripts on PATH via
  the package's `bin` field.

## What's not yet shipped

- **Form-driven UI** — voice / model / speed / composeWithText
  editable from Telegram. **Deferred indefinitely** (the
  telegram.json-driven config is sufficient for single-operator
  setups; the v0.2.0 + v0.4.0 section work was dropped on
  2026-08-24).
- **Top-level `voice` / `model` removal** — they no longer work
  (the v0.7.0 reader ignores them; the runtime uses
  `synth.ts:MINIMAX_BODY` directly). The v0.6.0 schema.json
  description (now deleted) noted the deprecation. Operators
  with a v0.6.0 config that set `voice` / `model` at the top
  level should drop those keys (they're silently ignored
  anyway).
- **Temp-file cleanup** — the OGG produced by the provider lingers
  in `<tmp>/` after upload. v0.8.0 schedules `unlink` 30s after
  upload (was reserved as v0.7.0 in the plan; renumbered when
  v0.7.0 became the script-drop release).

## Diagnostics

- **Stderr** — every action logs to stderr with the `[pi-telegram-tts]`
  tag. Set `PI_VOICE_TELEGRAM_DEBUG=1` for DEBUG-level output.
- **Telegram runtime events** — spawn failures are recorded via
  `recordTelegramRuntimeEvent("pi-telegram-tts/synth", ...)` and
  visible in `/telegram-status`.
- **Provider registry** — the provider is registered with stable id
  `pi-telegram-tts/synth`. Visible in the bridge's `telegram-status`
  if a voice message fires while mis-configured.
- **Smoke test** — `bash scripts/pi-telegram-tts-smoke-test.sh`
  (from the repo root) replays all 16 v0.4.0/v0.6.0 acceptance
  stages in ~5s without needing the agent, the bridge, or
  Telegram. Use `--no-network` to skip the live TTS round-trip in
  CI / offline. See `scripts/pi-telegram-tts-smoke-test.sh` for
  the full recipe.

## License

MIT
