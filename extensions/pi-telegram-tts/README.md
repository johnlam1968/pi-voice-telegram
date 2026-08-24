# pi-telegram-tts

Voice **synthesis** provider for the Pi coding agent +
[@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge.
Unlocks `getVoicePromptContribution` for voice-tagged turns and
provides a registered synthesis provider tier in the bridge's
voice-delivery pipeline (`lib/outbound-voice.ts`).

**As of v0.2.0, the `tts-minimax.mjs` and `tts-openai.mjs` scripts are
bundled inside this package** (previously a separate
`pi-voice-telegram-scripts` npm package, now deprecated). The package's
`bin` field exposes both scripts on PATH after `npm install`. Same
scripts, same auth resolution, same ffmpeg output; the only delta vs
the v0.1.0 provider is the bundled scripts.

**STT is delegated to [`pi-telegram-stt`](../pi-telegram-stt/README.md)**
and its provider extensions. This package only does TTS.

## Install

From npm (once published):

```bash
pi install npm:pi-telegram-tts
```

The bundled scripts are exposed on PATH after install:
- `tts-minimax` — MiniMax T2A HTTP client (CLI)
- `tts-openai` — OpenAI `/v1/audio/speech` client (CLI)

Test with:
```bash
tts-minimax --help
tts-openai --help
```

On-host dev loader (one-liner re-export shim), assuming the operator
runs from the source repo:

```bash
cat > ~/.pi/agent/extensions/pi-telegram-tts.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-telegram-tts/index.ts";
EOF
```

The bundled scripts are at `extensions/pi-telegram-tts/tts-{minimax,openai}.mjs`
in the source repo. The `synth.ts` `resolveScriptPath` finds them in the
same dir (dev) or on PATH (npm install) — no separate peer-dep package
needed.

## Configure (v0.1.0)

Edit `~/.pi/agent/telegram.json`:

```json
{
	"voice": {
		"replyMode": "mirror"
	},
	"extensions": {
		"pi-telegram-tts": {
			"provider": "minimax",
			"voice": "Cantonese_PlayfulMan",
			"model": "speech-2.8-hd"
		}
	}
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `provider` | `"minimax"` \| `"openai"` | required for the provider to fire |
| `voice` | string | passed as `--voice` to the TTS script (v0.1.0 top-level; v0.3.0 sub-block `minimax.voice` / `openai.voice` supersedes) |
| `model` | string | passed as `--model` to the TTS script (v0.1.0 top-level; v0.3.0 sub-block `minimax.model` / `openai.model` supersedes) |
| `disabled` | boolean | (v0.2.0) master switch — `true` falls through to the bridge's `outboundHandlers[0].template` |
| `minimax` | object | (v0.3.0) per-provider sub-block — every CLI arg the script supports |
| `openai` | object | (v0.3.0) per-provider sub-block — every CLI arg the script supports |

Live edits take effect on the next voice-tagged turn (the provider
re-reads config on every call).

## v0.3.0 — Per-provider sub-block (full parameter surface)

The v0.1.0 config above covers `voice` + `model`. v0.3.0 expands to
**per-provider sub-blocks** that make every CLI arg the bundled
`tts-*.mjs` scripts support reachable from `telegram.json` — no
template editing required.

> 📋 **`schema.json`** ships with the package (Draft 2020-12). Add `"$schema": "..."` to your `telegram.json` to get inline editor validation for every field, including the enums (`emotion`, `sound_effects`, `format`, `sample_rate`, `bitrate`, `output_format`, `response_format`), ranges (`speed`, `vol`, `pitch`, `channel`), and pattern constraints (`pronunciation_dict.tone` must be slash-separated `word/pronunciation` pairs). See `extensions/pi-telegram-tts/schema.json` for the canonical reference.

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

`synth.ts` writes the sub-block (with the v0.1.0 top-level `voice` /
`model` as fallbacks) to a tempfile inside the same tempdir it
already creates for the OGG, and passes `--config <path>` to the
script. The script's own merge pipeline
(`DEFAULTS ← --config deep-merge ← --config path-mapping ← CLI flags`)
applies the `CLI_TO_PATH` remap so flat names like `voice` /
`speed` / `lang` land at the nested API paths
(`voice_setting.voice_id` / `voice_setting.speed` /
`language_boost`). See `tts-minimax.mjs:315-380` and
`tts-openai.mjs:200-235` for the path-mapping block. **A small
script-side change was needed after all** — the v0.3.0 plan
originally said no script changes, but the script's `--config`
flag is a raw body deep-merge and does not run the `CLI_TO_PATH`
remap on its own; without the remap, a flat-name sub-block
lands at the top level of the request body and the API silently
ignores it. The fix is small (~25 lines per script) and the
script's own `CLI_TO_PATH` is the source of truth for the path
map.

### Precedence

For each field the sub-block wins over the top-level. The merge is
per-key, not wholesale:

- `extensions["pi-telegram-tts"].voice` + `minimax.voice` both set →
  `minimax.voice` wins.
- `extensions["pi-telegram-tts"].voice` set, no `minimax.voice` →
  top-level `voice` is used (sub-block inherits).
- `minimax: { speed: 1.2 }` only → script sees `{ speed: 1.2 }` and
  the rest of the body comes from the script's built-in defaults.

### Top-level `voice` / `model` are still supported

Existing v0.1.0 / v0.2.0 configs keep working unchanged. v0.3.0
adds the sub-block; the top-level `voice` / `model` keep working as
fallback. v0.4.0 will mark them as `> Deprecated: use the
per-provider sub-block instead`; they remain supported through
v0.5.0 and will be removed in v1.0.

### Available sub-block fields

The sub-block is type-checked as `{ [field: string]: unknown }`
from the TypeScript side; the script is the runtime validator (it
runs `validateBody()` and exits 2 on invalid values; the provider
returns `undefined` and the bridge falls through to the template).
The field list per provider:

- **MiniMax** (`tts-minimax.mjs:198-217` + `:262-272`): `model`,
  `voice`, `speed`, `vol`, `pitch`, `emotion`, `text_normalization`,
  `latex_read`, `lang`, `sample_rate`, `bitrate`, `format`,
  `channel`, `modify_pitch`, `modify_intensity`, `modify_timbre`,
  `sound_effects`, `subtitle_type`, `output_format`, `force_cbr`,
  `subtitle_enable`, `emoji_event`, `aigc_watermark`,
  `apply_text_filter`, `pronunciation_dict.tone` (array),
  `timbre_weights` (array of objects). MiniMax-only nested fields
  the CLI doesn't cover cleanly are best set as nested objects in
  the sub-block (e.g. `pronunciation_dict: { tone: [...] }`).
- **OpenAI** (`tts-openai.mjs:127-138` + `:223-229`): `model`,
  `voice`, `response_format`, `speed`, `instructions`.

The sub-block for the wrong provider is silently ignored (the
script reads its own schema only — an `openai: { instructions: "…" }`
in a MiniMax sub-block is ignored because the MiniMax script has
no `instructions` key in its DEFAULTS / CLI).

## Migration from 0.1.2

The v0.2.0 release moves the `tts-*.mjs` scripts from the separate
`pi-voice-telegram-scripts` npm package into `pi-telegram-tts`. The
scripts are unchanged (same CLI args, same auth, same ffmpeg output);
the only delta is the dispatch (now bundled, no separate package
install).

If you have an existing `outboundHandlers[0].template` pointing at the
old `pi-voice-telegram-scripts` package, update the path:

```diff
 "outboundHandlers": [
   {
     "type": "voice",
     "template": [
-      "/path/to/extensions/pi-voice-telegram-scripts/tts-minimax.mjs --out {mp3} ..."
+      "/path/to/extensions/pi-telegram-tts/tts-minimax.mjs --out {mp3} ..."
       "ffmpeg -y -i {mp3} ..."
     ]
   }
 ]
```

Or, since `pi-telegram-tts@0.2.0` exposes the bins:

```diff
 "template": [
-  "/path/to/extensions/pi-voice-telegram-scripts/tts-minimax.mjs --out {mp3} ..."
+  "tts-minimax --out {mp3} ..."   # the bin field exposes this on PATH
   "ffmpeg -y -i {mp3} ..."
 ]
```

(Both paths work; the absolute path is a 1-line change for the v0.19.0
default path, the bin name is the npm-install idiom.)

The `pi-voice-telegram-scripts` npm package is deprecated — `npm install
pi-voice-telegram-scripts` will print a deprecation warning. The new
install path is just `npm install pi-telegram-tts@latest`.

## Migration from the existing template

If you already have `outboundHandlers[0].template` configured (the
v0.19.0 default path), three options:

1. **Replace** — clear `outboundHandlers[0]` so the provider is the
   sole TTS path. **Recommended** for the sub-block + form-driven
   config in v0.4.0.
2. **Keep template as primary, provider as fallback** — leave
   `outboundHandlers[0]` in place. The template fires first; the
   provider only runs if the template fails.
3. **Don't install** — nothing changes. The existing template keeps
   working exactly as before. The package is opt-in.

After v0.2.0 is in place, the upstream voice reply pipeline
(`lib/outbound-voice.ts:185-276`) iterates: configured
`outboundHandlers[0]` → programmatic voice handlers → registered
synthesis providers. Our provider is tier 3.

> **Upstream note (v0.39.0+):** the `voice.sendTranscript` config,
> the `getTelegramVoiceSendTranscript()` helper, and the
> provider-returned `transcriptText` field were all removed. Synthesis
> providers now return only the OGG path; text-plus-voice is the
> agent's explicit composition (compose the text reply + the voice
> reply), not an automatic policy. The v0.4.0 stage 1 work
> re-implements the v0.1.0 `sendTranscript: true` behavior at the
> extension level via the new `composeWithText` config (see below).

## v0.2.0 / v0.4.0 capabilities

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
(voice only). The toggle UI for this field is v0.4.0 stage 2.
- Bundled `tts-minimax.mjs` + `tts-openai.mjs` scripts on PATH via
  the package's `bin` field.

## What's not yet shipped

- **Form-driven UI** — voice / model / speed / composeWithText
  editable from Telegram. **Deferred indefinitely** (the
  telegram.json-driven config is sufficient for single-operator
  setups; the v0.2.0 + v0.4.0 section work was dropped on
  2026-08-24).
- **Top-level `voice` / `model` deprecation** — they keep working
  through v0.5.0; v0.4.0 will mark them `> Deprecated: use the
  per-provider sub-block instead`. Removal is targeted for v1.0.
- **Temp-file cleanup** — the OGG produced by the provider lingers
  in `<tmp>/` after upload. v0.5.0 schedules `unlink` 30s after
  upload.

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
  (from the repo root) replays all 14 v0.2.0 acceptance stages in
  ~5s without needing the agent, the bridge, or Telegram. Use
  `--no-network` to skip the live TTS round-trip in CI / offline.
  See `scripts/pi-telegram-tts-smoke-test.sh` for the full
  recipe.

## License

MIT
