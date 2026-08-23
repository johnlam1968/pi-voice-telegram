# AGENTS.md

Repo for the Telegram voice/text companion to the [Pi coding agent](https://github.com/earendil-works/pi-mono) + the [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) bridge.

**This repo has no "main" package.** The runtime surface is:

1. **Three sister extensions** under `extensions/`:
   - **`pi-telegram-stt`** (was `pi-telegram-echo` before v0.18.1) — STT orchestrator: registers the voice transcription provider, looks up the configured STT provider in the in-process registry, sends the 🎙️ echo to the user, feeds the transcript into the agent prompt.
   - **`pi-openai-stt`** — STT provider that talks to any OpenAI-compatible API gateway (the on-host CUDA `whisper-server` via the `fw-openai-sts` shim, OpenAI's actual API, `faster-whisper-server`, etc.).
   - **`pi-telegram-tts`** (v0.1.0, shipped 2026-08-23) — TTS synthesis provider: closes the `voice.sendTranscript: true` gap by registering a synthesis provider against the bridge's public voice API. Spawns the same `tts-*.mjs` scripts and reuses the same `ffmpeg` wrap; the only delta is the dispatch path (synthesis provider instead of `outboundHandlers[0].template`). Section UI, per-provider config schema, and UI-driven config are deferred to v0.2.0 → v0.4.0.
2. **Runtime scripts** under `extensions/pi-voice-telegram-scripts/`:
   - **`tts-minimax.mjs`** — MiniMax T2A HTTP client (CLI).
   - **`tts-openai.mjs`** — OpenAI `/v1/audio/speech` client (CLI).
   - **`fw-openai-sts.ts`** — host-side OpenAI-compatible shim for the local `whisper-server` (install to `~/.pi/agent/bin/fw-openai-sts`).
3. **Dev tools** (also under `scripts/`):
   - **`dev-status.sh`**, **`dev-watch.sh`** — daily debug kit.
   - **`mmx-tts-smoke-test.sh`** — 3-stage pipeline verification for the raw `tts-*.mjs` + `ffmpeg` + STT round-trip.
   - **`pi-telegram-tts-smoke-test.sh`** — 6-stage v0.1.0 acceptance test for the `pi-telegram-tts` sister extension (jiti load + idempotency + 3 fall-through paths + optional live TTS round-trip).
4. **Docs** under `docs/` (`DEBUGGING.md`, `DESIGN-INTENT.md`, `TTS-VIA-OUTBOUND-HANDLERS.md`, `UPSTREAM-API-COMPLIANCE.md`, `PI-TELEGRAM-TTS-PLAN.md`, `PI-TELEGRAM-TTS-DESIGN.md`).
5. **Archive** under `archive/` (historical investigation findings, superseded test scripts, design history, and bug filings — see `archive/README.md` for the index).

The TTS pipeline has **three** sub-paths in priority order (per the bridge's `lib/outbound-voice.ts:185-276`):

1. `telegram.json#outboundHandlers[0].template` — the v0.19.0 default; the bridge calls `tts-*.mjs` + `ffmpeg` directly. Returns only a file path, so `voice.sendTranscript: true` is silently a no-op here.
2. Programmatic voice handlers — return `Promise<string>`; also just a file path. (Not used by this repo.)
3. **Synthesis providers** (registered via `registerTelegramVoiceSynthesisProvider` from `@llblab/pi-telegram/voice`) — the only path that returns `{ audioPath, transcriptText? }`. **`pi-telegram-tts` v0.1.0 plugs in here.** Closing the `sendTranscript` gap requires this path; clear `outboundHandlers[0]` or set `disabled: true` to make the provider the sole TTS path.

When `pi-telegram-tts` is not installed, the operator's `outboundHandlers[0].template` continues to work exactly as it did in v0.19.0 — the package is opt-in.

The host agent also needs `ffmpeg` on `PATH` (libopus encode) and a reachable `whisper-server` for STT.

## Setup commands

**Clean install** (recommended for a fresh host agent):
1. `git clone https://github.com/johnlam1968/pi-voice-telegram.git` into the location the host agent's `pi -e` shims already point to (or wherever the operator wants the source to live).
2. The three sister extensions are loaded by the bridge via dev shims at `~/.pi/agent/extensions/{pi-telegram-stt,pi-openai-stt,pi-telegram-tts}.ts` — these re-export from the local source. The shims are not part of this repo; they live in the operator's `~/.pi/agent/extensions/` directory and look like:
   ```ts
   // ~/.pi/agent/extensions/pi-telegram-tts.ts
   export { default } from "/home/john/CodingProjects/pi-voice-telegram/extensions/pi-telegram-tts/index.ts";
   ```
3. The runtime scripts are referenced **by absolute path** from `telegram.json#outboundHandlers[0].template`, e.g.:
   ```json
   "outboundHandlers": [{
     "type": "voice",
     "template": [
       "/home/john/CodingProjects/pi-voice-telegram/extensions/pi-voice-telegram-scripts/tts-openai.mjs --out {mp3} --instructions 'Speak in Cantonese.'",
       "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 48000 -ac 1 -application voip -vbr on -compression_level 10 -f ogg {ogg}"
     ],
     "output": "ogg"
   }]
   ```
   Note the path is now under `extensions/pi-voice-telegram-scripts/` (the scripts moved out of `scripts/` in the v0.19.0 split; the previous `scripts/tts-*.mjs` paths are gone from the canonical install).

   When `pi-telegram-tts` is installed AND the operator clears `outboundHandlers[0]`, the provider becomes the sole TTS path. Same `tts-*.mjs` scripts, different dispatch.

**Peer deps**: each sister extension declares its peer deps in its own `package.json` (`@earendil-works/pi-coding-agent`, `@llblab/pi-telegram`, plus the cross-extension peers — `pi-telegram-stt` ↔ `pi-openai-stt`, and `pi-telegram-tts` → `pi-voice-telegram-scripts`). The host agent resolves them from its own `node_modules/`. This repo's own `node_modules/` is only for editor IntelliSense (e.g. `jiti` types) and for the smoke test scripts.

## Branch workflow

- **`master`** — the current stable release. Three sister extensions + runtime scripts + docs. The operator's running `pi` should pin to this.
- **`dev/pi-telegram-stt`** — future work: the LLM tool surface (`synthesize_voice`, `transcribe_audio`, `pi_voice_telegram_*` config tools), the voice-catalog tool, the `pi-voice-telegram-settings` extension (UI section for editing `telegram.json` on the fly), and the v0.2.0 → v0.4.0 `pi-telegram-tts` work (section UI + per-provider config schema + UI-driven config). The LLM tools + companion-config schema are on this branch — they don't belong on master (per the v0.19.0 split).

When a release is cut on master, tag it (e.g. `v0.19.0`) and let `dev/pi-telegram-stt` continue to diverge. Merge back to master only after the extension work is verified end-to-end.

## Project layout

- `extensions/pi-telegram-stt/` — sister extension: inbound STT + 🎙️ echo (renamed from `pi-telegram-echo` in v0.18.1). v0.7.0. Self-contained (bundles its own `_logger.ts` since v0.7.0). Publishable as `pi-telegram-stt` to the npm registry.
- `extensions/pi-openai-stt/` — sister extension: STT provider that talks to any OpenAI-compatible API gateway. v0.3.0. Self-contained (bundles its own `_logger.ts` since v0.3.0). Publishable as `pi-openai-stt` to the npm registry.
- `extensions/pi-telegram-tts/` — sister extension: TTS synthesis provider (v0.1.0, shipped 2026-08-23). Closes the `voice.sendTranscript: true` gap by registering against `registerTelegramVoiceSynthesisProvider`. Self-contained (bundles its own `_logger.ts`). Publishable as `pi-telegram-tts` to the npm registry. See `docs/PI-TELEGRAM-TTS-PLAN.md` for the v0.2.0 → v0.4.0 roadmap (section UI + per-provider config schema + UI-driven config).
- `extensions/pi-voice-telegram-scripts/` — runtime shell scripts (v0.1.0). Publishable as `pi-voice-telegram-scripts` to the npm registry; the `bin` field makes them available as `tts-minimax`, `tts-openai`, and `fw-openai-sts` after `npm install`:
  - `tts-minimax.mjs` — MiniMax T2A CLI
  - `tts-openai.mjs` — OpenAI `/v1/audio/speech` CLI
  - `fw-openai-sts.ts` — host-side OpenAI-compatible shim for the local `whisper-server` (the `bin/fw-openai-sts` bash wrapper invokes `node --experimental-strip-types` on the .ts source)
- `scripts/publish.sh` — local CLI publish for the 4 sister packages. The **preferred path is GitHub Actions** (`.github/workflows/publish.yml`, triggered by a `v*` tag push, using OIDC Trusted Publishing — no 2FA prompt, no stored secret). `publish.sh` is kept for `--dry-run` verification and emergency local publishes. See `docs/PUBLISHING.md` for the full setup walkthrough.
- `.github/workflows/publish.yml` — the canonical release path. Tag-based trigger, OIDC provenance, dependency-ordered publish, GitHub Release creation.
- `docs/PUBLISHING.md` — full setup walkthrough: OIDC trusted-publisher configuration, first-publish bootstrap (chicken-and-egg), 2FA OTP fallback, references to npm's deprecation timeline.
- `scripts/mmx-tts-smoke-test.sh` — 3-stage pipeline verification in ~5s (TTS → OGG/Opus → STT round-trip).
- `scripts/pi-telegram-tts-smoke-test.sh` — 6-stage v0.1.0 acceptance test for the `pi-telegram-tts` sister extension (jiti load + idempotency + 3 fall-through paths + optional live TTS round-trip; `--no-network` skips the network stage for CI).
- `scripts/dev-status.sh`, `scripts/dev-watch.sh` — daily debug kit.
- `docs/DEBUGGING.md` — log surface map + `dev-status.sh` / `dev-watch.sh` usage.
- `docs/DESIGN-INTENT.md` — the "we said no to X because Y" record.
- `docs/TTS-VIA-OUTBOUND-HANDLERS.md` — `telegram.json#outboundHandlers[0].template` integration (MiniMax + OpenAI examples).
- `docs/UPSTREAM-API-COMPLIANCE.md` — periodic audit: which stable public APIs of `@llblab/pi-telegram` and `@earendil-works/pi-coding-agent` the extensions use, and where local code diverges. Re-run when an upstream ships a new public API membrane.
- `docs/PI-TELEGRAM-TTS-PLAN.md` — forward-looking build plan for the `pi-telegram-tts` sister extension (v0.1.0 → v0.4.0), and the inventory of upstream surfaces available for future expansion.
- `docs/PI-TELEGRAM-TTS-DESIGN.md` — companion to the plan: design rationale, the 4 patterns to copy from `pi-telegram-extension-demo`, the 3 things the demo doesn't show, the v0.1.0 implementation sketch, the migration story, the gotchas. Read this when starting v0.1.0.
- `archive/` — investigation findings, superseded test scripts, design history, and bug filings. See `archive/README.md` for the full index.

## Publishing the 4 sister packages to npm

The cluster image (`pi-sandbox`) installs the 4 sister packages at `@latest` from the npm registry — every rebuild picks up the newest published version.

**Preferred path: GitHub Actions with OIDC Trusted Publishing** (no 2FA prompt, no stored secret):

```bash
# 1. Bump the version in each package (leaves first)
cd extensions/pi-voice-telegram-scripts && npm version patch
cd ../pi-openai-stt && npm version patch
cd ../pi-telegram-stt && npm version patch
cd ../pi-telegram-tts && npm version patch
cd ../..

# 2. Commit + tag + push (the tag triggers the workflow)
git add -A
git commit -m "chore(release): v0.7.1"
git tag v0.7.1
git push --follow-tags

# 3. Watch the workflow run
#    https://github.com/<owner>/<repo>/actions/workflows/publish.yml
#    On success, all 4 packages are on npm and a GitHub Release is created.
```

The workflow (`.github/workflows/publish.yml`) verifies the version match across all 4 packages, publishes them in dependency order (leaves first), and creates a GitHub Release. OIDC provenance is enabled.

**Fallback path: local CLI** (`scripts/publish.sh`) — for the very first publish (chicken-and-egg with trusted publishing) and for emergencies. Uses `--otp <code>` or `NPM_CONFIG_OTP=<code>` for 2FA.

See `docs/PUBLISHING.md` for the full setup walkthrough, including the one-time npmjs.com trusted-publisher configuration and the first-publish bootstrap.

## Code style

- ESM TypeScript (`"type": "module"`); strict mode expected. Imports use explicit `.ts` extensions where required by the host loader.
- No linter or formatter is configured in the repo. Match the surrounding file: 2-space indent, single quotes, trailing commas, semicolons. Re-read the file you are editing before deciding on style.

## Testing instructions

There is no formal test runner. The repo uses two layers of testing:

### Layer 1 — Controlled test (no agent, no bridge, no Telegram)

Pure scripts in `scripts/`. Fast (~3-5s), CI-friendly, exit non-zero on failure. Run these in any working directory:

- `scripts/mmx-tts-smoke-test.sh` — 3-stage pipeline verification in ~5s (TTS → OGG/Opus → STT round-trip via `fw-openai-sts`). Run this after any change to `extensions/pi-voice-telegram-scripts/tts-*.mjs`, `extensions/pi-voice-telegram-scripts/fw-openai-sts.ts`, or the underlying provider configs. CI-friendly; use `--no-shim` for the pure-pipeline variant.
- `scripts/pi-telegram-tts-smoke-test.sh` — 6-stage v0.1.0 acceptance test for the `pi-telegram-tts` sister extension (jiti load + idempotency + 3 fall-through paths + optional live TTS round-trip). Run this after any change to `extensions/pi-telegram-tts/*.ts`. Use `--no-network` for CI / offline runs (skips stage 6 only).
- `scripts/dev-status.sh` — one-shot status snapshot (process, lock state, polling, runtime events, stderr)
- `scripts/dev-watch.sh` — refresh every 2s (or `tail` of bridge + session + stderr)

The `pi-telegram-tts-smoke-test.sh` invocation also serves as the unit-test pattern: jiti-load the package, reach into `globalThis.__piTelegramVoiceSynthesisProviders__`, drive the registered provider with controlled `telegram.json` configs. Stages 3-5 are fall-through-only (no network), stage 6 is the live round-trip.

### Layer 2 — Live test (with the agent + bridge + Telegram)

The controlled tests exercise the in-process provider; live tests exercise the full stack. **Live testing is the only way to validate the bridge's voice-delivery pipeline end-to-end.**

Pre-flight (one-time):
1. Install all three sister extensions:
   ```bash
   cat > ~/.pi/agent/extensions/pi-telegram-stt.ts <<'EOF'
   export { default } from "/home/john/CodingProjects/pi-voice-telegram/extensions/pi-telegram-stt/index.ts";
   EOF
   cat > ~/.pi/agent/extensions/pi-openai-stt.ts <<'EOF'
   export { default } from "/home/john/CodingProjects/pi-voice-telegram/extensions/pi-openai-stt/index.ts";
   EOF
   cat > ~/.pi/agent/extensions/pi-telegram-tts.ts <<'EOF'
   export { default } from "/home/john/CodingProjects/pi-voice-telegram/extensions/pi-telegram-tts/index.ts";
   EOF
   ```
2. Configure `~/.pi/agent/telegram.json` (one of three modes — see the `pi-telegram-tts` README for the full matrix):
   - **Provider as sole TTS path** (recommended; required for `sendTranscript: true` to work): clear `outboundHandlers[0]`, set `extensions["pi-telegram-tts"]`.
   - **Template as primary, provider as fallback**: leave `outboundHandlers[0]` in place. The template fires first; the provider only runs if the template fails. `sendTranscript: true` is a no-op for the template path.
   - **Don't install**: nothing changes.
3. Confirm host prerequisites: `ffmpeg` on `PATH` (libopus encode) and either `~/.mmx/config.json` (MiniMax) or `OPENAI_API_KEY` (OpenAI) for stage 6.

Run the live test:
1. **Start the agent with captured stderr** so the structured `[pi-telegram-tts]` log lines land in a file the dev tools can tail:
   ```bash
   pi 2>/tmp/pi.stderr.log
   ```
   Add `PI_VOICE_TELEGRAM_DEBUG=1` to the same line to enable DEBUG-level logging from every extension's `_logger.ts` and from the `tts-*.mjs` scripts.
2. **In a second terminal, snapshot the live state** (one of the 4 dev recipes — full reference in `docs/DEBUGGING.md`):
   ```bash
   # 1. One-shot state + stderr tail — what's happening right now
   scripts/dev-status.sh

   # 2. Live tail — refresh every 2s across process / bridge / session / stderr
   scripts/dev-watch.sh

   # 3. In-Telegram diagnostics — voice provider registry, recent runtime events
   /telegram-status   # type in the bot chat

   # 4. TUI snapshot — what was on screen + last LLM call (write to pi-debug.log)
   /debug             # type in the pi REPL
   ```
3. **Send a voice message** to the bot from Telegram. Within ~5s the bot should reply with a synthesized voice note. The voice message's caption (when `voice.sendTranscript: true` + provider mode) is the agent's reply text.
4. **Verify the live flow**:
   - The OGG the bot sends is in `/tmp/pi-telegram-tts-XXXXXX/<uuid>.ogg` for ~60s after the call; `ffprobe` it to confirm Opus / 48kHz / mono.
   - The `[pi-telegram-tts]` log lines in `/tmp/pi.stderr.log` show: `registered at module load`, `tts spawn provider=… voice=… model=… chars=N`, `tts ok audioPath=… chars=N` (or `tts failed error=…` on failure).
   - The bridge's `/telegram-status` shows the recent voice runtime event with `category: pi-telegram-tts/synth` if anything was recorded via `recordTelegramRuntimeEvent`.

Live-test troubleshooting:
- **Voice not synthesizing, no log lines from the package** — the extension isn't loaded. Check `ls ~/.pi/agent/extensions/` for the shim and `tail /tmp/pi.stderr.log` for `[pi-telegram-tts] registered at module load` on agent start.
- **Voice synthesizing but no caption** — `voice.sendTranscript` is unset (default false), OR the operator is still on the template path (clear `outboundHandlers[0]` or set `disabled: true` per the package README).
- **Voice synthesizing, caption is right, but audio is wrong** — `ffmpeg` failure or wrong codec. Check `/tmp/pi.stderr.log` for the `[pi-telegram-tts/synth] tts failed error=…` line; the cause is in the stderr.
- **Operator wants to know which path fired (template vs provider)** — `/telegram-status` shows the recent voice runtime event with the `category` field (`pi-telegram-tts/synth` = provider fired; no entry = template path).
- **Logs frozen** — known bridge-side bug (last seen 2026-08-21). Use stderr (`tail /tmp/pi.stderr.log`) as the canonical source; the bridge's `tmp/telegram/logs.jsonl` may be stale. Full note in `docs/DEBUGGING.md`.

For historical live-test scripts (`live-test.sh`, `test-v0.16.7-provider.ts`, `build-voice-catalog.py`), see `archive/scripts/`.

## Development methodology — checklist/matrix discipline

The repo's house style for new versions: **every plan bullet maps to a smoke stage or an explicit deferral note.** This is the discipline that prevents the "I implemented the visible files but missed a runtime-flow step" class of gap (which the v0.1.0 cut of `pi-telegram-tts` hit on 2026-08-23 — the first cut omitted the `getTelegramVoiceSendTranscript` call because it wasn't on the implementation checklist; the in-session fix landed the same day once the gap was visible in the matrix).

### How to add a new version

1. **Read the plan doc first.** Each version section in `docs/PI-TELEGRAM-TTS-PLAN.md` (e.g. `### v0.2.0 — Section UI`) has a "Files added", "Config shape", "Upstream APIs added" block, and (for shipped versions) an Acceptance matrix.
2. **Build the Acceptance matrix for the new version before writing code.** It is a table with one row per plan bullet, four columns: `Plan reference` | `What it requires` | `Smoke stage` | `Defer?`. The `Defer?` cell must say either "covered" (with a stage number) or a future version. **A blank cell is a bug.** Use the existing `### v0.1.0 — Acceptance matrix` (in the v0.1.0 section of the plan doc) as the template shape.
3. **Run through the pre-flight checklist** in the plan doc's `## How to use this plan` section (7 items: each public API has a stage, each config field has 3 cases, each bridge-owned field has all reachable decoded combinations, smoke stage count ≥ plan's runtime flow step count, every `Returns { ... }` asserts presence AND absence, every deferral is explicit). Each item is a class of gap that already happened; the checklist is the discipline that would have caught it.
4. **Implement against the matrix.** Each row in the matrix is a TODO. The smoke test grows in lockstep with the implementation — never after.
5. **Run the full smoke (not `--no-network`) before declaring done.** The network stages are the ones that catch "looks right in code, breaks in the real API" issues.
6. **Update the Progress section's status row** for the version: ✅ SHIPPED + date + 1-line summary. Link the Acceptance matrix in the row.

### Reference: the new tests shipped with v0.1.0

`scripts/pi-telegram-tts-smoke-test.sh` is the canonical example of the methodology in action. 12 stages mapping 1:1 to the v0.1.0 Acceptance matrix (the matrix is the spec; the smoke is the proof). The script:

- 6 stages for the in-process surface (jiti load, idempotency, fall-through × 3) — pure, no network, runs in `--no-network` mode.
- 3 stages for the live TTS round-trip (with `sendTranscript: true`, with `sendTranscript: false`, and a positive end-to-end check) — needs network + an API key.
- 4 stages for `getVoicePromptContribution(view)` across the 3 reachable `replyMode × hasVoiceInput` combinations (mirror+voice, always+text, always+voice) plus the unreachable-but-pinned hidden case.

The Acceptance matrix for v0.1.0 has 31 rows; 26 map to a smoke stage, 5 are explicit deferrals to v0.2.0 / v0.3.0 / v0.4.0 / v0.5.0. See `### v0.1.0 — Acceptance matrix` in the plan doc for the full table.

When v0.2.0 starts, it gets its own `### v0.2.0 — Acceptance matrix` with rows for the section UI, the `ctx.callbackData()` rule, the `saveSynthConfig` atomic-write pattern, etc. — the discipline scales; the file structure doesn't.

## PR & commit conventions

- Default branch: `master`. Branch from `master`; do not push to it directly.
- No enforced commit-message convention in the repo — use Conventional Commits (`feat:` / `fix:` / `docs:` / `refactor:`) to match the surrounding history.
- No CI is configured. Before opening a PR: run the relevant smoke test (Layer 1 above) AND, for any change that touches the bridge or agent surface, exercise the change end-to-end against the live Telegram stack (Layer 2 above).

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

## v0.20.0 changelog (the TTS provider extension)

What was added to master:
- `extensions/pi-telegram-tts/` — the 3rd sister extension (v0.1.0). Registers a synthesis provider against the bridge's public `registerTelegramVoiceSynthesisProvider` API so `voice.sendTranscript: true` and `getVoicePromptContribution` both work. Spawns the same `tts-*.mjs` scripts and reuses the same `ffmpeg` wrap as the v0.19.0 template path; the only delta is the dispatch (synthesis provider instead of `outboundHandlers[0].template`).
- `scripts/pi-telegram-tts-smoke-test.sh` — 6-stage v0.1.0 acceptance test (jiti load + idempotency + 3 fall-through paths + optional live TTS round-trip; `--no-network` for offline / CI).
- The publishing workflow now publishes 4 sister packages (the new `pi-telegram-tts` joins `pi-telegram-stt`, `pi-openai-stt`, `pi-voice-telegram-scripts`).
- AGENTS.md — the runtime surface intro, TTS-pipeline description, setup commands, project layout, and testing instructions all reflect the 3rd extension. A new "Live test" section under "Testing instructions" covers the live-test recipe.

What was deferred (per `docs/PI-TELEGRAM-TTS-PLAN.md`):
- **v0.2.0** — section UI (`/telegram-settings` → 🎙️ TTS provider) + enable/disable toggle.
- **v0.3.0** — per-provider config schema (sub-blocks for `minimax` and `openai` so every CLI arg is reachable from `telegram.json`).
- **v0.4.0** — UI-driven config (form-based edits from the Telegram section).
- **v0.5.0** — temp-file cleanup + in-Telegram commands (`/tts_status`, `/tts_test`) + status line.

What this means for the operator's running pi:
- **No change needed if `pi-telegram-tts` is not installed.** The v0.19.0 template path continues to work exactly as before; the package is opt-in.
- **To make `sendTranscript: true` actually produce a voice caption:** install `pi-telegram-tts` (dev shim or `pi install npm:pi-telegram-tts`), set `extensions["pi-telegram-tts"]` in `telegram.json`, and either clear `outboundHandlers[0]` (provider as sole path) or leave it in place (provider as fallback for template failures; `sendTranscript` still a no-op on the template path).
- **The `tts-*.mjs` scripts are unchanged** — same CLI args, same auth resolution, same ffmpeg output. The provider is a different dispatch, not a different implementation.

## v0.21.0 changelog (the consolidation, phase 1)

This is a pure **deprecation** change. No code change for operators. No tag, no commit against the 4 active packages.

What changed:
- `pi-voice-telegram@0.16.12` is now deprecated on the npm registry. The deprecation message points operators at `pi-telegram-stt` and `pi-telegram-tts`.
- The deprecation is applied via the `deprecate` job in `.github/workflows/publish.yml`. The job uses OIDC trusted publishing (the deprecated package has a trusted publisher configured on npmjs.com pointing at this workflow) and runs on `workflow_dispatch`. Subsequent runs are no-ops (idempotent message re-apply).
- `AGENTS.md` — added this v0.21.0 changelog section.

How the deprecate job is triggered (operator flow):
```bash
unset GITHUB_TOKEN
gh workflow run publish.yml
# Watch the run
gh run watch
```
The job idempotently re-applies all 3 deprecation messages (pi-voice-telegram, pi-openai-stt, pi-voice-telegram-scripts). Each phase triggers this once; subsequent runs are no-ops.

What this means for the operator's running pi:
- **No change needed.** The shim at `~/.pi/agent/extensions/pi-telegram-stt.ts` still works. The `telegram.json#outboundHandlers[0].template` still works. The 3 active sister extensions are unchanged.
- **`npm install pi-voice-telegram@0.16.12` will now print a deprecation warning.** Existing installs continue to work — the deprecation is purely a heads-up for new installs.

What comes next (the remaining 2 phases of the consolidation):
- **v0.22.0 (Phase 2)**: subsume `pi-openai-stt` into `pi-telegram-stt` → 2 active packages, deprecate `pi-openai-stt`.
- **v0.23.0 (Phase 3)**: merge `pi-voice-telegram-scripts` into `pi-telegram-tts` → `tts-minimax` / `tts-openai` exposed via the package's `bin` field, deprecate `pi-voice-telegram-scripts`.

See `docs/CONSOLIDATION-PLAN.md` for the full plan, the file-by-file change list (Appendix C), and the exact deprecation messages (Appendix B).
