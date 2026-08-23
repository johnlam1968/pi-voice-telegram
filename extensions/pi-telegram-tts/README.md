# pi-telegram-tts

Voice **synthesis** provider for the Pi coding agent +
[@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge. Closes
the `voice.sendTranscript: true` gap (which is a silent no-op for the
`outboundHandlers` template path) and unlocks `getVoicePromptContribution`
for voice-tagged turns. Reuses the existing `tts-minimax.mjs` /
`tts-openai.mjs` scripts — no new HTTP client, no native deps.

**STT is delegated to [`pi-telegram-stt`](../pi-telegram-stt/README.md)**
and its provider extensions. This package only does TTS.

## Install

From npm (once published):

```bash
pi install npm:pi-telegram-tts
```

On-host dev loader (one-liner re-export shim), assuming the operator
runs from the source repo:

```bash
cat > ~/.pi/agent/extensions/pi-telegram-tts.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-telegram-tts/index.ts";
EOF
```

Also install the scripts package (peer dep — the runtime scripts the
provider spawns):

```bash
pi install npm:pi-voice-telegram-scripts
```

Or via the dev loader:

```bash
cat > ~/.pi/agent/extensions/pi-voice-telegram-scripts.ts <<'EOF'
export * from "/path/to/this/repo/extensions/pi-voice-telegram-scripts/index.ts";
EOF
```

The `pi-voice-telegram-scripts` package exposes the `tts-minimax` and
`tts-openai` binaries on PATH; the `pi-telegram-tts` provider spawns
them by name when npm-installed, or by absolute path when dev-loaded.

## Configure (v0.1.0)

Edit `~/.pi/agent/telegram.json`:

```json
{
	"voice": {
		"replyMode": "mirror",
		"sendTranscript": true
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
| `voice` | string | passed as `--voice` to the TTS script |
| `model` | string | passed as `--model` to the TTS script |
| `disabled` | boolean | (v0.2.0) set by the section UI toggle |

Live edits take effect on the next voice-tagged turn (the provider
re-reads config on every call).

## Migration from the existing template

If you already have `outboundHandlers[0].template` configured (the
v0.19.0 default path), three options:

1. **Replace** — clear `outboundHandlers[0]` so the provider is the
   sole TTS path. `voice.sendTranscript: true` actually attaches the
   transcript as the voice caption. **Recommended** if you set
   `sendTranscript: true`.
2. **Keep template as primary, provider as fallback** — leave
   `outboundHandlers[0]` in place. The template fires first; the
   provider only runs if the template fails. **Note:** `sendTranscript:
   true` is still a no-op for the template path.
3. **Don't install** — nothing changes. The existing template keeps
   working exactly as before. The package is opt-in.

After v0.1.0 is in place, the upstream voice reply pipeline
(`lib/outbound-voice.ts:185-276`) iterates: configured
`outboundHandlers[0]` → programmatic voice handlers → registered
synthesis providers. Our provider is tier 3; for `sendTranscript: true`
to fire, you must replace (option 1).

## v0.1.0 capabilities

- `voice.sendTranscript: true` produces a real voice caption.
- `getVoicePromptContribution(view)` adds `[tts] Reply briefly; this
  turn will be spoken aloud via the configured TTS provider.` to
  voice-tagged prompts.
- Module-load + session_start dual registration, idempotent on
  hot-reload.

## What's not in v0.1.0

- **Section UI** — the provider is not yet visible in
  `/telegram-settings`. v0.2.0 adds a section (similar to
  `pi-telegram-stt/echo-section.ts`).
- **Per-provider config schema** — `instructions`, `speed`,
  `response_format`, `lang`, etc. are not yet configurable from
  `telegram.json`. v0.3.0 expands to per-provider sub-blocks.
- **UI-driven config** — voice / model editable from Telegram. v0.4.0.
- **Temp-file cleanup** — the OGG produced by the provider lingers
  in `<tmp>/` after upload. v0.5.0 schedules `unlink` 30s after upload.

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
  (from the repo root) replays all 6 v0.1.0 acceptance stages in
  ~5s without needing the agent, the bridge, or Telegram. Use
  `--no-network` to skip the live TTS round-trip in CI / offline.
  See `scripts/pi-telegram-tts-smoke-test.sh` for the full
  recipe.

## License

MIT
