# AGENTS.md

Telegram voice/text companion extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono) and the [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) bridge. Registers a TTS synthesis provider (mm-tts-backed by default) and a voice-transcript echo for incoming voice/audio messages; opt-in LLM tools for synthesis, transcription, schema discovery, and config read/write/reset.

## Setup commands

- No install step at the repo level. The package ships ESM TypeScript and is **jiti-loaded** by the host agent directly from `index.ts` — no build, no transpile, no bundle.
- All runtime deps are **peer dependencies** (`@earendil-works/pi-coding-agent`, `@llblab/pi-telegram`, optional `@sinclair/typebox`). They must resolve inside the host agent's `node_modules`; this repo's own `node_modules/` only exists for editor IntelliSense.
- The host agent also needs `ffmpeg` on `PATH` (libopus encode) and a reachable `whisper-server` for STT. See `README.md` for the canonical install path under `~/.pi/agent/npm/`.

## Project layout

- `index.ts` — extension entrypoint, registered via `package.json#pi.extensions`
- `config.ts`, `config-io.ts` — companion settings load/validate/migrate (schema-driven since v0.13.0)
- `synthesis-provider.ts` — outbound TTS provider registration
- `voice-reply.ts` — voice-reply orchestrator (provider call + ffmpeg encode + caption assembly)
- `mm-tts.ts` — MiniMax T2A HTTP client
- `whisper-stt.ts` — pure-TypeScript HTTPS client for `whisper-server /inference`
- `echo.ts` — inbound voice/audio message detection + transcript echo back to the user
- `tools.ts` — opt-in LLM tool surface (`synthesize_voice`, `transcribe_audio`, schema, config read/write/reset)
- `voices-catalog.ts`, `voices.json` — voice catalog (built by `scripts/build-voice-catalog.py`)
- `pi-voice-telegram.schema.json` — JSON Schema for the companion settings file; source of truth for field names, types, and defaults
- `archive/` — investigation findings, superseded test scripts, design history, and bug filings. Excluded from `npm install`. See `archive/README.md` for the full index.
- `docs/` — operator-facing long-form notes (`DEBUGGING.md`, `DESIGN-INTENT.md`, `TTS-VIA-OUTBOUND-HANDLERS.md`)
- `scripts/` — runtime + debug scripts. The runtime ones (`tts-minimax.mjs`, `tts-openai.mjs`, `fw-openai-sts.ts`) are referenced by `telegram.json` or installed to `~/.pi/agent/bin/`; the debug ones (`dev-status.sh`, `dev-watch.sh`) are the daily dev kit.

## Code style

- ESM TypeScript (`"type": "module"`); strict mode expected. Imports use explicit `.ts` extensions where required by the host loader.
- No linter or formatter is configured in the repo. Match the surrounding file: 2-space indent, single quotes, trailing commas, semicolons. Re-read the file you are editing before deciding on style.
- The JSON Schema (`pi-voice-telegram.schema.json`) is the source of truth for config field names, defaults, and validation. New config keys go in the schema first; `config-io.ts` migration must handle older files missing the new field.
- The `tools.ts` LLM tool surface is gated per-tool by `llm_tools.tools.<name>` (since v0.16.12). New tools follow the same pattern: add to schema, gate with a per-tool flag, default behavior unchanged.

## Testing instructions

- There is no automated test runner. Validation is manual via `scripts/`:
  - `scripts/live-test.sh` — end-to-end against a running agent + bridge (requires `ffmpeg`, `whisper-server`, valid TTS creds)
  - `scripts/test-v0.16.7-provider.ts` — provider-shape smoke test
- When changing `mm-tts.ts` or `voice-reply.ts`, run the live test against a real provider before considering the change done.
- When changing `pi-voice-telegram.schema.json` or `config-io.ts`, add a migration note in `PLAN.md` and verify an older settings file round-trips through the new schema.

## PR & commit conventions

- Default branch: `master`. Branch from `master`; do not push to it directly.
- No enforced commit-message convention in the repo — use Conventional Commits (`feat:` / `fix:` / `docs:` / `refactor:`) to match the surrounding history.
- No CI is configured. Before opening a PR: run `scripts/live-test.sh` if the change touches the synthesis / voice-reply path, otherwise the change is type-checked at load time by the host agent.

## Security

- Never commit credentials. TTS provider keys, Telegram bot tokens, and `whisper-server` endpoints live in the host agent's settings, not in this repo.
- `LICENSE` is MIT. Keep the header on new files only if the surrounding file already carries one; this repo does not enforce per-file license headers.
- The `config_write` LLM tool refuses to touch `$schema`, `_hint`, or any key not in `pi-voice-telegram.schema.json`. Do not relax that gate when refactoring.
