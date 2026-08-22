# AGENTS.md

Telegram voice/text companion extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono) and the [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) bridge. Registers a TTS synthesis provider (mm-tts-backed by default) for outbound voice replies. The inbound STT + 🎙️ echo pipeline lives in the sister extension `pi-telegram-stt` (was `pi-telegram-echo` before v0.18.1; renamed so the package name matches its scope). Opt-in LLM tools for synthesis, transcription, schema discovery, and config read/write/reset.

## Setup commands

**Clean install** (recommended for a fresh host agent):
```bash
# 1. Clone the repo
git clone https://github.com/johnlam1968/pi-voice-telegram.git
cd pi-voice-telegram

# 2. Run the install script — symlinks the runtime scripts to
#    ~/.pi/agent/bin/, runs npm install for peer deps, prints the
#    recommended telegram.json#outboundHandlers template
./install.sh
```

**Development install** (if you're working on the package):
```bash
# Clone anywhere; the host agent loads it from this path
git clone https://github.com/johnlam1968/pi-voice-telegram.git ~/path/to/repo
cd ~/path/to/repo
npm install   # pulls jiti for IntelliSense; peer deps live in the host agent
```

The package ships ESM TypeScript and is **jiti-loaded** by the host
agent directly from `index.ts` — no build, no transpile, no bundle.
All runtime deps are **peer dependencies** (`@earendil-works/pi-coding-agent`,
`@llblab/pi-telegram`, optional `@sinclair/typebox`). They must
resolve inside the host agent's `node_modules`; this repo's own
`node_modules/` only exists for editor IntelliSense.

The host agent also needs `ffmpeg` on `PATH` (libopus encode) and a
reachable `whisper-server` for STT.

## Branch workflow

- **`master`** — the current stable release. Template-based TTS via
  `telegram.json#outboundHandlers[0].template`. This is what the
  operator's running `pi` should pin to.
- **`dev/pi-telegram-stt`** — future work: a `pi-telegram-stt`
  extension with the synthesis-candies layer, the `voice.synthesis`
  discriminated-union config, and the fallback-chain runtime. The
  design tensions around per-provider params live here. Don't
  break the running setup.

When a release is cut, tag the master commit (e.g. `v0.18.0`) and
let `dev/pi-telegram-stt` continue to diverge. Merge back to master
only after the extension work is verified end-to-end.

## Project layout

- `index.ts` — extension entrypoint, registered via `package.json#pi.extensions`
- `config.ts`, `config-io.ts` — companion settings load/validate/migrate (schema-driven since v0.13.0)
- `synthesis-provider.ts` — outbound TTS provider registration
- `voice-reply.ts` — voice-reply orchestrator (provider call + ffmpeg encode + caption assembly)
- `mm-tts.ts` — MiniMax T2A HTTP client
- `whisper-stt.ts` — pure-TypeScript HTTPS client for `whisper-server /inference`
- `tools.ts` — opt-in LLM tool surface (`synthesize_voice`, `transcribe_audio`, schema, config read/write/reset)
- `voices-catalog.ts`, `voices.json` — voice catalog (built by `archive/scripts/build-voice-catalog.py`)
- `pi-voice-telegram.schema.json` — JSON Schema for the companion settings file; source of truth for field names, types, and defaults
- `extensions/pi-telegram-stt/` — sister extension: inbound STT + 🎙️ echo (renamed from `pi-telegram-echo` in v0.18.1)
- `extensions/pi-openai-stt/` — sister extension: STT provider that talks to any OpenAI-compatible API gateway
- `extensions/_logger.ts` — shared stderr logger for both sister extensions
- `install.sh` — clean-install one-command script (symlinks runtime scripts, runs `npm install`, prints the recommended `telegram.json#outboundHandlers` template)
- `archive/` — investigation findings, superseded test scripts, design history, and bug filings. Excluded from `npm install`. See `archive/README.md` for the full index.
- `docs/` — operator-facing long-form notes (`DEBUGGING.md`, `DESIGN-INTENT.md`, `TTS-VIA-OUTBOUND-HANDLERS.md`)
- `scripts/` — runtime scripts only (`tts-minimax.mjs`, `tts-openai.mjs`, `fw-openai-sts.ts` — all referenced by `telegram.json#outboundHandlers[0].template` or installed to `~/.pi/agent/bin/`). The dev tools (`dev-status.sh`, `dev-watch.sh`) live in `scripts/` too — they're the daily debug kit.

## Code style

- ESM TypeScript (`"type": "module"`); strict mode expected. Imports use explicit `.ts` extensions where required by the host loader.
- No linter or formatter is configured in the repo. Match the surrounding file: 2-space indent, single quotes, trailing commas, semicolons. Re-read the file you are editing before deciding on style.
- The JSON Schema (`pi-voice-telegram.schema.json`) is the source of truth for config field names, defaults, and validation. New config keys go in the schema first; `config-io.ts` migration must handle older files missing the new field.
- The `tools.ts` LLM tool surface is gated per-tool by `llm_tools.tools.<name>` (since v0.16.12). New tools follow the same pattern: add to schema, gate with a per-tool flag, default behavior unchanged.

## Testing instructions

- There is no automated test runner. The dev tools are in `scripts/`:
  - `scripts/dev-status.sh` — one-shot status snapshot (process, lock state, polling, runtime events, stderr)
  - `scripts/dev-watch.sh` — refresh every 2s (or `tail` of bridge + session + stderr)
- When changing `mm-tts.ts` or `voice-reply.ts`, test against a real provider (MiniMax or OpenAI) before considering the change done.
- When changing `pi-voice-telegram.schema.json` or `config-io.ts`, verify an older settings file round-trips through the new schema.
- For historical tests (`live-test.sh`, `test-v0.16.7-provider.ts`, `build-voice-catalog.py`), see `archive/scripts/`.

## PR & commit conventions

- Default branch: `master`. Branch from `master`; do not push to it directly.
- No enforced commit-message convention in the repo — use Conventional Commits (`feat:` / `fix:` / `docs:` / `refactor:`) to match the surrounding history.
- No CI is configured. Before opening a PR: run `scripts/live-test.sh` if the change touches the synthesis / voice-reply path, otherwise the change is type-checked at load time by the host agent.

## Security

- Never commit credentials. TTS provider keys, Telegram bot tokens, and `whisper-server` endpoints live in the host agent's settings, not in this repo.
- `LICENSE` is MIT. Keep the header on new files only if the surrounding file already carries one; this repo does not enforce per-file license headers.
- The `config_write` LLM tool refuses to touch `$schema`, `_hint`, or any key not in `pi-voice-telegram.schema.json`. Do not relax that gate when refactoring.
