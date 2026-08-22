# AGENTS.md

Repo for the Telegram voice/text companion to the [Pi coding agent](https://github.com/earendil-works/pi-mono) + the [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) bridge.

**This repo has no "main" package.** The runtime surface is:

1. **Two sister extensions** under `extensions/`:
   - **`pi-telegram-stt`** (was `pi-telegram-echo` before v0.18.1) — STT orchestrator: registers the voice transcription provider, looks up the configured STT provider in the in-process registry, sends the 🎙️ echo to the user, feeds the transcript into the agent prompt.
   - **`pi-openai-stt`** — STT provider that talks to any OpenAI-compatible API gateway (the on-host CUDA `whisper-server` via the `fw-openai-sts` shim, OpenAI's actual API, `faster-whisper-server`, etc.).
2. **Runtime scripts** under `scripts/`:
   - **`tts-minimax.mjs`** — MiniMax T2A HTTP client (CLI).
   - **`tts-openai.mjs`** — OpenAI `/v1/audio/speech` client (CLI).
   - **`fw-openai-sts.ts`** — host-side OpenAI-compatible shim for the local `whisper-server` (install to `~/.pi/agent/bin/fw-openai-sts`).
3. **Dev tools** (also under `scripts/`):
   - **`dev-status.sh`**, **`dev-watch.sh`** — daily debug kit.
4. **Docs** under `docs/` (`DEBUGGING.md`, `DESIGN-INTENT.md`, `TTS-VIA-OUTBOUND-HANDLERS.md`).
5. **Archive** under `archive/` (historical investigation findings, superseded test scripts, design history, and bug filings — see `archive/README.md` for the index).

The TTS pipeline is **template-based** via `telegram.json#outboundHandlers[0].template` — the bridge calls the shell scripts directly. There is no in-process TTS provider in the main package (it was removed in v0.19.0; the LLM-callable synthesis tool lives on the `dev/pi-telegram-stt` branch).

The host agent also needs `ffmpeg` on `PATH` (libopus encode) and a reachable `whisper-server` for STT.

## Setup commands

**Clean install** (recommended for a fresh host agent):
1. `git clone https://github.com/johnlam1968/pi-voice-telegram.git` into the location the host agent's `pi -e` shims already point to (or wherever the operator wants the source to live).
2. The two sister extensions are loaded by the bridge via dev shims at `~/.pi/agent/extensions/{pi-telegram-stt,pi-openai-stt}.ts` — these re-export from the local source. The shims are not part of this repo; they live in the operator's `~/.pi/agent/extensions/` directory and look like:
   ```ts
   // ~/.pi/agent/extensions/pi-telegram-stt.ts
   export { default } from "/home/john/CodingProjects/pi-voice-telegram/extensions/pi-telegram-stt/index.ts";
   ```
3. The runtime scripts are referenced **by absolute path** from `telegram.json#outboundHandlers[0].template`, e.g.:
   ```json
   "outboundHandlers": [{
     "type": "voice",
     "template": [
       "/home/john/CodingProjects/pi-voice-telegram/scripts/tts-openai.mjs --out {mp3} --instructions 'Speak in Cantonese.'",
       "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 48000 -ac 1 -application voip -vbr on -compression_level 10 -f ogg {ogg}"
     ],
     "output": "ogg"
   }]
   ```

**Peer deps**: each sister extension declares its peer deps in its own `package.json` (`@earendil-works/pi-coding-agent`, `@llblab/pi-telegram`, `pi-openai-stt`/`pi-telegram-stt`). The host agent resolves them from its own `node_modules/`. This repo's own `node_modules/` is only for editor IntelliSense (e.g. `jiti` types).

## Branch workflow

- **`master`** — the current stable release. Two sister extensions + runtime scripts + docs. The operator's running `pi` should pin to this.
- **`dev/pi-telegram-stt`** — future work: the synthesis-candies layer (per-provider config schema, fallback-chain runtime), the `pi-voice-telegram-settings` extension (UI section for editing `telegram.json` on the fly), the LLM tool surface (`synthesize_voice`, `transcribe_audio`, `pi_voice_telegram_*` config tools), and the voice-catalog tool. The LLM tools + companion-config schema are on this branch — they don't belong on master (per the v0.19.0 split).

When a release is cut on master, tag it (e.g. `v0.19.0`) and let `dev/pi-telegram-stt` continue to diverge. Merge back to master only after the extension work is verified end-to-end.

## Project layout

- `extensions/pi-telegram-stt/` — sister extension: inbound STT + 🎙️ echo (renamed from `pi-telegram-echo` in v0.18.1). v0.7.0. Self-contained (bundles its own `_logger.ts` since v0.7.0). Publishable as `pi-telegram-stt` to the npm registry.
- `extensions/pi-openai-stt/` — sister extension: STT provider that talks to any OpenAI-compatible API gateway. v0.3.0. Self-contained (bundles its own `_logger.ts` since v0.3.0). Publishable as `pi-openai-stt` to the npm registry.
- `extensions/pi-voice-telegram-scripts/` — runtime shell scripts (v0.1.0). Publishable as `pi-voice-telegram-scripts` to the npm registry; the `bin` field makes them available as `tts-minimax`, `tts-openai`, and `fw-openai-sts` after `npm install`:
  - `tts-minimax.mjs` — MiniMax T2A CLI
  - `tts-openai.mjs` — OpenAI `/v1/audio/speech` CLI
  - `fw-openai-sts.ts` — host-side OpenAI-compatible shim for the local `whisper-server` (the `bin/fw-openai-sts` bash wrapper invokes `node --experimental-strip-types` on the .ts source)
- `scripts/publish.sh` — publishes the 3 sister packages to the npm registry in dependency order; refuses to overwrite existing versions; auto-creates a git tag on success.
- `scripts/mmx-tts-smoke-test.sh` — 3-stage pipeline verification in ~5s (TTS → OGG/Opus → STT round-trip).
- `scripts/dev-status.sh`, `scripts/dev-watch.sh` — daily debug kit.
- `docs/DEBUGGING.md` — log surface map + `dev-status.sh` / `dev-watch.sh` usage.
- `docs/DESIGN-INTENT.md` — the "we said no to X because Y" record.
- `docs/TTS-VIA-OUTBOUND-HANDLERS.md` — `telegram.json#outboundHandlers[0].template` integration (MiniMax + OpenAI examples).
- `archive/` — investigation findings, superseded test scripts, design history, and bug filings. See `archive/README.md` for the full index.

## Publishing the 3 sister packages to npm

The cluster image (`pi-sandbox`) installs the 3 sister packages at `@latest` from the npm registry — every rebuild picks up the newest published version. The release flow is:

```bash
# 1. Bump versions in each package (manual or `npm version patch` in each)
cd extensions/pi-voice-telegram-scripts && npm version patch && cd ../..
cd extensions/pi-openai-stt && npm version patch && cd ../..
cd extensions/pi-telegram-stt && npm version patch && cd ../..

# 2. Publish (publish.sh handles the order, refuses to overwrite, tags)
./scripts/publish.sh            # or with --dry-run first to verify

# 3. Push the tag
git push --follow-tags
```

After this, every `docker build` of `pi-sandbox` will pull the new versions.

## Code style

- ESM TypeScript (`"type": "module"`); strict mode expected. Imports use explicit `.ts` extensions where required by the host loader.
- No linter or formatter is configured in the repo. Match the surrounding file: 2-space indent, single quotes, trailing commas, semicolons. Re-read the file you are editing before deciding on style.

## Testing instructions

- There is no automated test runner. The dev tools are in `scripts/`:
  - `scripts/dev-status.sh` — one-shot status snapshot (process, lock state, polling, runtime events, stderr)
  - `scripts/dev-watch.sh` — refresh every 2s (or `tail` of bridge + session + stderr)
  - `scripts/mmx-tts-smoke-test.sh` — 3-stage pipeline verification in ~5s (TTS → OGG/Opus → STT round-trip via fw-openai-sts). Run this after any change to `scripts/tts-*.mjs`, `scripts/fw-openai-sts.ts`, or the underlying provider configs. Exits 0 on success, non-zero on any failure. CI-friendly.
- When changing `scripts/tts-*.mjs`, also run `scripts/mmx-tts-smoke-test.sh` before considering the change done.
- For historical tests (`live-test.sh`, `test-v0.16.7-provider.ts`, `build-voice-catalog.py`), see `archive/scripts/`.

## PR & commit conventions

- Default branch: `master`. Branch from `master`; do not push to it directly.
- No enforced commit-message convention in the repo — use Conventional Commits (`feat:` / `fix:` / `docs:` / `refactor:`) to match the surrounding history.
- No CI is configured. Before opening a PR: run the relevant dev tool and exercise the change end-to-end.

## Security

- Never commit credentials. TTS provider keys, Telegram bot tokens, and `whisper-server` endpoints live in the host agent's settings, not in this repo.
- `LICENSE` is MIT. Keep the header on new files only if the surrounding file already carries one; this repo does not enforce per-file license headers.

## v0.19.0 changelog (the dead-weight split)

What was removed from master:
- `index.ts` (the main package's extension entrypoint)
- `package.json` (the main package's manifest)
- `install.sh` (the clean-install one-command helper — the operator uses the dev shim + absolute-path approach instead)
- `mm-tts.ts`, `voice-reply.ts`, `synthesis-provider.ts` (the in-process TTS pipeline; superseded by the template handler that calls `scripts/tts-*.mjs`)
- `whisper-stt.ts` (the in-process whisper client; superseded by `pi-openai-stt` + the `fw-openai-sts` shim)
- `tools.ts` (the LLM-callable tool surface; moved to `dev/pi-telegram-stt` branch)
- `voices-catalog.ts`, `voices.json` (the voice catalog for the `list_voices` tool; moved to `dev/pi-telegram-stt`)
- `config.ts`, `config-io.ts`, `pi-voice-telegram.schema.json` (the companion config + schema; moved to `dev/pi-telegram-stt` because the LLM tools that read/write it are on the dev branch)
- `.npmignore` (no main package = no need)

What this means for the operator's running pi:
- **No change needed.** The shim at `~/.pi/agent/extensions/pi-telegram-stt.ts` still works (the sister extension is unchanged). The `telegram.json#outboundHandlers[0].template` still works (the runtime scripts are unchanged).
- The companion config file at `~/.pi/agent/pi-voice-telegram.json` is no longer read. Safe to delete or leave as-is.
- The TTS defaults that were in the companion config (`tts.lang`, `tts.voice`, `tts.model`) can be moved to env vars (`PI_MM_TTS_LANG`, `PI_MM_TTS_VOICE`, `PI_MM_TTS_MODEL`) or to the template's `--instructions` / script args. The runtime scripts read env vars and CLI args.
