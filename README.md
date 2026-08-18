# pi-voice-telegram

A Telegram voice/text companion extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono) and the [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) bridge.

The extension provides three capabilities. The bridge's `telegram.json` decides when and how the first two fire; the companion's own `~/.pi/agent/pi-voice-telegram.json` opts in to the third.

1. **Outbound TTS** — registers a voice synthesis provider on the bridge. The bridge calls it when `voice.replyMode` says so. The provider returns `{ audioPath, transcriptText }` when `voice.sendTranscript: true` (voice bubble with caption) or just the `oggPath` when `false` (voice bubble only).
2. **Inbound echo** — registers a raw update handler that detects voice / audio messages, runs the configured STT client (`whisper-stt.ts` → `whisper-server`), and sends the user a `🎙️ "<i>transcript</i>"` reply. A programmatic inbound handler feeds the same transcript into the agent prompt. On by default; turn off via `inbound.echoEnabled: false` in the companion settings file.
3. **LLM tool surface (v0.6.0+, opt-in)** — when `tools.enabled: true` in the companion settings file, registers four additional tools the agent can call explicitly:
   - `synthesize_voice` — wraps `voice-reply.ts` + `mm-tts.ts`. Writes a Telegram-ready OGG/Opus file and returns the path. The agent delivers it to the bound chat using the bridge's `telegram_attach` tool. Useful when `voice.replyMode` is `hidden` and the user has asked for a voice reply, or for ad-hoc voice (e.g. reading a file aloud).
   - `transcribe_audio` — wraps `whisper-stt.transcribe()`. Transcribes a local audio file via `whisper-server` and returns the transcript text.
   - `pi_voice_telegram_schema` (v0.10.0+) — returns the companion settings JSON Schema as text. The LLM can call it to discover what knobs exist, their types, defaults, and valid values, before suggesting edits. Always registered when `tools.enabled` is true (it's documentation, not capability — no side effects). Pass the `key` parameter to fetch a specific section (e.g. `tts.voice`, `inbound.echoEnabled`); omit it for the full schema.
   - `pi_voice_telegram_config_read` / `pi_voice_telegram_config_write` / `pi_voice_telegram_config_reset` (v0.11.0+ tools, refined v0.12.0+, schema-driven v0.13.0+) — let the LLM read the current settings, modify them via schema-validated atomic writes, and migrate the file to the current schema. The write tool refuses to modify `$schema`, `_hint`, or any key not in the schema. The reset tool is **schema-driven** (v0.13.0+): it walks the JSON Schema, fills in any MISSING fields with the schema's `default` value, and preserves the operator's existing values. The schema is the source of truth for "what fields exist and what their defaults are" — new fields added in future schema versions are auto-applied to existing files when reset is called. All three tools are registered whenever `tools.enabled` is true (no double opt-in). The promptGuidelines instruct the LLM to read first then write, and to evolve the config based on observed usage (e.g., when the operator keeps asking for English voice and the config is `Chinese,Yue`, propose or apply a change).

The extension does not impose any UX policy of its own. Whatever the operator sets in `telegram.json` (or via the bridge's settings UI) is what the user gets.

Both pipelines are **in-process**:

- **TTS (synthesis, outbound):** `mm-tts.ts` (MiniMax T2A HTTP client) + `voice-reply.ts` (orchestrator) + `ffmpeg` (libopus encode via spawn). No host-side scripts.
- **STT (transcription, inbound):** `whisper-stt.ts` (pure-TypeScript HTTPS client for `whisper-server`'s `/inference` endpoint). No shell wrapper, no nested Node.

The only process boundary the extension crosses is the `ffmpeg` spawn. The agent host needs `ffmpeg` on `PATH` and a reachable `whisper-server` (see below).

## Install

The extension is a single Pi extension package — 6 TypeScript files plus `package.json`. The agent's auto-discovery loader reads `package.json` to find the entry, loads the source directly (no build step), and that's it.

### Per-agent install (the canonical way)

The `pi-voice-telegram` extension is intended to be installed into the agent's npm tree, alongside the other standard Pi agent extensions. The agent's own `pi install` flow can do this, but the recommended approach is to bake the standard extension set into the image at build time (see the `pi-cluster` deploy for an example).

Once installed, the extension lives at `~/.pi/agent/npm/node_modules/pi-voice-telegram/` and is registered in `~/.pi/agent/settings.json`'s `packages` list. The extension's `package.json` `pi.extensions: ["./index.ts"]` field tells the agent's `jiti` loader what to import.

### Quick install (no image rebuild)

If you just want to drop the extension into a running agent's npm tree:

```bash
# In a fresh agent dir, create the npm tree and install the registry-side deps
mkdir -p ~/.pi/agent/npm
cd ~/.pi/agent/npm
npm init -y
# `--legacy-peer-deps`: pi-minimax-m3-caching-fix@0.2.0 pins the agent
# to v0.79.1; the cluster is on v0.84.2. The peer-dep ranges are
# stricter than reality (no real conflict), so we use npm's legacy
# resolution to install them side-by-side.
npm install --legacy-peer-deps \
    @llblab/pi-telegram@0.28.0 \
    pi-mcp-adapter@2.26.0 \
    pi-minimax-m3-caching-fix@0.2.0 \
    pi-voice-telegram

# Register the package in the agent's settings.json
node -e "
const fs = require('node:fs');
const path = process.env.HOME + '/.pi/agent/settings.json';
const settings = JSON.parse(fs.readFileSync(path, 'utf8'));
const packages = settings.packages ?? [];
const entry = 'npm:pi-voice-telegram@' + require('pi-voice-telegram/package.json').version;
if (!packages.includes(entry)) {
  packages.push(entry);
  settings.packages = packages;
  fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}
"
```

The `*.ts` files are loaded directly by the runtime (no build step). The extension's peer deps (`@llblab/pi-telegram`, `@earendil-works/pi-coding-agent`) are resolved by Node from the parent `npm/node_modules/` tree — same instance as the official extensions, no version drift.

## Required host-side runtime

- **`ffmpeg`** on `PATH` (system binary; the only non-Node dep). The synthesis pipeline uses it to encode WAV → OGG/Opus for the Telegram voice bubble.
- **`whisper-server`** (system binary or systemd service) — the STT HTTP endpoint. See below.
- **`MINIMAX_CN_API_KEY`** env var (or one of the other auth sources: `$MINIMAX_API_KEY`, `auth.json`, `~/.mmx/config.json`) — the MiniMax T2A API key for outbound TTS.
- **`WHISPER_SERVER_URL`** env var (default `http://127.0.0.1:8080`) — where to find the STT service.

## `whisper-server` setup

The inbound voice-echo pipeline calls a [`whisper-server`](https://github.com/ggerganov/whisper.cpp/tree/master/examples/server) HTTP endpoint. The reference install is the [whisper.cpp](https://github.com/ggerganov/whisper.cpp) C++ port, built with CUDA support and running as a user-level systemd service on the agent host.

### What whisper-server is

`whisper-server` is a small HTTP wrapper around the [whisper.cpp](https://github.com/ggerganov/whisper.cpp) inference engine. It loads the model once at startup and serves transcriptions on a single port — no per-call model load, just network + inference. The extension POSTs the user's voice file (OGG/Opus) to `/inference` as `multipart/form-data` and gets the transcript back on stdout.

Two endpoints exist in upstream:
- `whisper-asr-webservice` (Python, https://github.com/ahmetoner/whisper-asr-webservice) — what the extension's `whisper-stt.ts` was originally written against.
- `whisper-server` (C++, ships with whisper.cpp) — the recommended one, faster startup and lower memory.

Both speak the same HTTP contract (multipart upload to `/inference` with `language` and `response_format` fields), so the extension works with either. The C++ `whisper-server` is what we ship with here.

### Install (Arch Linux, AUR — recommended)

The AUR package [`whisper.cpp-cuda-bin`](https://github.com/OneNoted/whisper.cpp-cuda-bin) provides a prebuilt CUDA-enabled `whisper-server` binary for x86_64.

```bash
# Using yay (or any AUR helper)
yay -S whisper.cpp-cuda-bin

# This installs:
#   /usr/bin/whisper-server      (and friends: whisper-cli, whisper-bench, ...)
#   /usr/lib/libwhisper.so.*
#   /usr/lib/libggml-cuda.so.*
#   /usr/include/whisper.h
```

The prebuilt binary uses CUDA arch 89 (RTX 4090). For other GPUs, you'll need to build from source (see below).

### Install (build from source)

For non-Arch distros, or if you need a different CUDA arch:

```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_CUDA_ARCHITECTURES=89-real \
    -DWHISPER_BUILD_SERVER=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_SDL2=OFF
cmake --build build --config Release -j
# Optionally: sudo cmake --install build
# Or: keep the build/ dir and reference it directly
```

If you don't have an NVIDIA GPU, drop the CUDA flags and use the CPU build — the model will just be slower.

### Download the model

The model is a separate download (not packaged with the binary). The reference install uses `ggml-large-v3.bin` (~3.1 GB).

```bash
# Default model location
mkdir -p ~/.local/share/whisper-cuda/models
cd ~/.local/share/whisper-cuda/models

# Either download directly from Hugging Face
curl -L -o ggml-large-v3.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin

# Or use the whisper.cpp helper
sh ~/.local/share/whisper-cuda/models/../../../whisper.cpp/models/download-ggml-model.sh large-v3
```

Smaller models are available if you don't need large-v3 quality: `large-v3-turbo`, `medium`, `small`, `base`, `tiny`. The smaller the model, the faster the inference but the worse the Cantonese (or any non-English) accuracy.

### The systemd user service

A user-level systemd service keeps `whisper-server` running across reboots and restarts on crash. User services (under `~/.config/systemd/user/`) don't need sudo and run with your user's permissions.

Create `~/.config/systemd/user/whisper-server.service`:

```ini
[Unit]
Description=Whisper.cpp STT Server (GPU, persistent model)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/<your-user>/.local/whisper-cuda
Environment="LD_LIBRARY_PATH=/home/<your-user>/.local/whisper-cuda/lib"
ExecStart=/home/<your-user>/.local/whisper-cuda/bin/whisper-server \
  --model /home/<your-user>/.local/share/whisper-cuda/models/ggml-large-v3.bin \
  --host 127.0.0.1 \
  --port 8080 \
  --convert \
  --language yue \
  --no-timestamps
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Replace `<your-user>` with your actual username. Key flags:
- `--convert` — let whisper-server decode the audio format internally (OGG/Opus, MP3, M4A, etc.) instead of requiring a pre-converted WAV. This is what makes the OGG-Opus voice notes from Telegram work without client-side ffmpeg.
- `--language yue` — Cantonese language boost. The extension's `PI_TELEGRAM_LANG` env var (default `yue`) is forwarded as the `language` form field; the `--language` flag sets the same default on the server side.
- `--no-timestamps` — drop the per-segment timestamps from the response. We only need the text.

Then enable and start it:

```bash
# Make the user systemd instance aware of the new unit
systemctl --user daemon-reload

# Start it now and on every login
systemctl --user enable --now whisper-server.service

# Check it's running
systemctl --user status whisper-server.service
# (should show "active (running)")

# Verify the HTTP endpoint
curl -s -X POST -F "file=@/path/to/some.ogg" -F "language=yue" -F "response_format=text" \
    http://127.0.0.1:8080/inference
```

To make the user service survive logout, enable lingering:

```bash
sudo loginctl enable-linger $USER
```

### Putting the binary in the expected location

The systemd service file above assumes the binary is at `~/.local/whisper-cuda/bin/whisper-server`. If you installed via the AUR, the binary is at `/usr/bin/whisper-server` instead — either update the `ExecStart` line, or symlink it:

```bash
mkdir -p ~/.local/whisper-cuda/{bin,lib,include,share}
ln -s /usr/bin/whisper-server ~/.local/whisper-cuda/bin/whisper-server
# libwhisper.so and libggml-cuda.so are already in /usr/lib, so the LD_LIBRARY_PATH
# override is optional; remove it from the service file if so.
```

### Verifying the extension can reach whisper-server

After the service is running and the extension is installed, send a voice message to the agent in Telegram. You should see a `🎙️ "<i>transcript</i>"` echo within ~1-2 seconds (large-v3 on a modern GPU is fast — typically 0.5–2s for a 10s voice note). If nothing arrives, check:

- `journalctl --user -u whisper-server` for STT errors.
- `/telegram-status` in the agent for runtime events with category `pi-voice-telegram/echo`.
- The extension's `WHISPER_SERVER_URL` env var points at the right host/port.

## Required `telegram.json`

The extension is fully config-driven. Two voice keys matter:

```json
{
  "voice": {
    "replyMode": "mirror",
    "sendTranscript": true
  }
}
```

- `voice.replyMode: "mirror"` — voice reply only when the user sent voice. Use `"always"` for every turn, `"hidden"` to disable synthesis.
- `voice.sendTranscript: true` — voice bubble carries the LLM's reply text as a caption. Use `false` for voice-only.

You can also set the legacy `outboundHandlers[type: "voice"]` block to provide per-handler voice/lang defaults. The provider falls back to those when no bridge-supplied options are present.

## Optional `pi-voice-telegram.json`

The companion extension has its own settings file. It lives at:

```
~/.pi/agent/pi-voice-telegram.json
```

where `~` is the agent's data dir (whatever `getAgentDir()` returns at runtime, or `$PI_CODING_AGENT_DIR` if set). This matches the agent dir's "one JSON per concern" convention — `telegram.json`, `settings.json`, `mcp.json`, etc. The companion file is a sibling of `telegram.json`.

The file is **self-describing** (v0.9.0+): it includes a `$schema` field pointing to a JSON Schema at <https://raw.githubusercontent.com/johnlam1968/pi-voice-telegram/main/pi-voice-telegram.schema.json>, so editors (VS Code, IntelliJ) will surface inline descriptions, allowed values, and defaults while you edit. A `_hint` field at the top of the file is the at-a-glance pointer to the schema for humans inspecting the file with `cat`. The schema file also lives in the npm package at `node_modules/pi-voice-telegram/pi-voice-telegram.schema.json` for offline access.

**Per-agent, not global.** If you run multiple agent instances (e.g. `pi-cluster`'s `agent-john` and `agent-jane`), each one has its own `pi-voice-telegram.json` in its own runtime dir. For the `pi-cluster` deploy, that's:

- `agent-john` → `/home/john/pi-cluster/runtimes/agent-john/.pi/agent/pi-voice-telegram.json`
- `agent-jane` → `/home/john/pi-cluster/runtimes/agent-jane/.pi/agent/pi-voice-telegram.json`

**v0.7.0+: auto-seeded on first run.** When the file is missing, the extension writes a safe default (echo on, tools off — same as v0.5.0 behavior) on `session_start`. The seed is logged once to the agent's stdout:

```
[pi-voice-telegram] Seeded default config at /home/pi/.pi/agent/pi-voice-telegram.json (echo: on, tools: off). Edit and restart to enable tools.
```

The seed is **idempotent and safe**:
- Only fires when the file is absent (ENOENT). Existing files are never overwritten.
- If the write fails (read-only FS, permission denied), the extension's in-memory defaults still apply — no behavior change.
- A malformed JSON file is kept intact, not silently overwritten. The extension's defaults apply; the operator sees the same content they had before.

To enable tools after the seed, edit the file (flip `tools.enabled` to `true`) and restart the session. See [`examples/pi-voice-telegram.json`](./examples/pi-voice-telegram.json) for a copy-paste-ready file with tools enabled.

The auto-seeded file includes the same fields as `examples/pi-voice-telegram.json` (modulo the `tools.enabled` value). The two should be byte-equal; a sync-drift bug is recorded in PLAN.md as a v0.8.0 maintenance lesson.

```json
{
  "inbound": { "echoEnabled": true },
  "tools": {
    "enabled": false,
    "tts":  { "enabled": true, "name": "synthesize_voice" },
    "stt":  { "enabled": true, "name": "transcribe_audio" }
  },
  "tts": {
    "voice":     "Cantonese_PlayfulMan",
    "lang":      "Chinese,Yue",
    "model":     "speech-2.8-hd",
    "timeoutMs": 30000
  },
  "stt": {
    "lang":      "yue",
    "baseUrl":   "http://127.0.0.1:8080",
    "timeoutMs": 60000
  }
}
```

| Key | Default | What it does |
|---|---|---|
| `inbound.echoEnabled` | `true` | When `false`, skip the inbound echo + transcript-injection handlers entirely. The bridge still receives the voice message, but the agent never sees a transcript and the user never sees the `🎙️` confirmation. |
| `tools.enabled` | `false` | Master switch for LLM tool registration. When `false`, none of the 7 LLM tools (synthesize_voice, transcribe_audio, pi_voice_telegram_schema, pi_voice_telegram_config_read / _write / _reset, pi_voice_telegram_list_voices) are registered. When `true`, they're all available. |
| `tools.tts.enabled` | `true` | Register `synthesize_voice`. Honored only when `tools.enabled` is `true`. |
| `tools.tts.name` | `synthesize_voice` | Override the tool name (rare; for namespace collision avoidance). The description / promptSnippet / promptGuidelines text is templated against the resolved name (v0.8.0+). |
| `tools.stt.enabled` | `true` | Register `transcribe_audio`. Honored only when `tools.enabled` is `true`. |
| `tools.stt.name` | `transcribe_audio` | Override the tool name. Templated like `tools.tts.name`. |
| `tts.voice` | `Cantonese_PlayfulMan` | Default voice ID for both the bridge-driven TTS path and the `synthesize_voice` tool. Resolution: JSON > `$PI_MM_TTS_VOICE` > hardcoded. v0.8.0+. For valid voice IDs, see `pi_voice_telegram_list_voices` (v0.15.0+) — the catalog ships 327 voices across 24 languages. |
| `tts.lang` | `Chinese,Yue` | Default language boost. JSON > `$PI_MM_TTS_LANG` > hardcoded. v0.8.0+. Independent of `tts.voice`: voice is the speaker identity, lang is the pronunciation. Cross-language voice+lang is the "boost" effect. |
| `tts.model` | `speech-2.8-hd` | Default TTS model. JSON > `$PI_MM_TTS_MODEL` > hardcoded. v0.8.0+. |
| `tts.timeoutMs` | `30000` | Per-call synthesis timeout (covers mm-tts + ffmpeg). JSON > `$PI_MM_TTS_VOICE_REPLY_TIMEOUT_MS` > hardcoded. v0.8.0+. |
| `tts.verifyAfterSynthesize` | `true` | When `true`, run whisper-stt language detection on every synthesized OGG and log the result under `category: "pi-voice-telegram/tts-verify"`. Catches the cross-language "boost" misfires and gives the operator a per-call signal in the event log. Adds ~500ms–1s per synthesis. v0.16.0+. |
| `stt.lang` | `yue` | Default language code for both the inbound echo STT and the `transcribe_audio` tool. JSON > `$PI_TELEGRAM_LANG` > hardcoded. v0.8.0+. |
| `stt.baseUrl` | `http://127.0.0.1:8080` | whisper-server base URL. JSON > `$WHISPER_SERVER_URL` > hardcoded. v0.8.0+. |
| `stt.timeoutMs` | `60000` | Per-call STT timeout. JSON > `$PI_TELEGRAM_STT_TIMEOUT_MS` > hardcoded. v0.8.0+. |

The `synthesize_voice` tool only writes the OGG/Opus file — the agent delivers it using the bridge's `telegram_attach` tool (`@llblab/pi-telegram` registers this; no companion-side wiring needed). The two-step pattern keeps chat-target resolution, captioning, and multipart-upload concerns in the bridge.

The `tts.*` and `stt.*` fields (v0.8.0+) move the per-extension TTS/STT defaults out of env vars. Layering is **JSON > env var > hardcoded** — an operator who sets `tts.voice` in the JSON overrides `$PI_MM_TTS_VOICE`, which overrides the hardcoded `Cantonese_PlayfulMan`. Env vars are preserved as fallbacks so the cluster's `docker-compose.yaml` doesn't need to change to upgrade. The synthesis provider reads these on every call (v0.5.0+patch backport for the cluster, v0.8.0+ in this package), so changing voice/lang in JSON takes effect on the next bridge-driven voice reply, with no session restart. The `telegram.json` bridge file still wins for the bridge-owned `outboundHandlers[voice].defaults.{voice,lang,rate}` keys.

**v0.14.0+:** the companion settings file is now **hot-reloadable**. The extension watches the directory containing `pi-voice-telegram.json` (200ms debounce); any external edit (operator `vi`/editor, the LLM's own `pi_voice_telegram_config_write` call, an MCP-driven automation) triggers a debounced reconfigure — the previous registration set is disposed and a fresh one is built from the new file contents. The synthesis provider is re-created (so new TTS defaults apply on the next bridge event), the echo handlers are re-registered per the new `inbound.echoEnabled`, and the 7 LLM tools are re-registered per the new `tools.*` flags. Hot-reload is best-effort: if `fs.watch` fails (sandboxed env, no inotify handles, etc.) the extension logs a warning and falls back to the `session_start`-only behavior.

**v0.16.0+:** every synthesis is followed by a whisper-stt language-detection self-check (when `tts.verifyAfterSynthesize: true`, the default). The result is logged under `category: "pi-voice-telegram/tts-verify"` in `~/.pi/agent/tmp/telegram/logs.jsonl` with the requested `tts.lang`, whisper's `detected_language`, the confidence, and a `match` boolean. Use this to spot the cross-language "boost" misfires — e.g. `voice=Japanese_OptimisticYouth + lang=Korean` may produce English audio (the boost effect), and the verification will catch it. Verification is best-effort: if whisper fails, the synthesis still succeeds and the error is logged separately.

### LLM tools (registered when `tools.enabled: true`)

When `tools.enabled` is `true`, the agent gets **seven** tools. All are read-only or schema-validated-write; none bypass the JSON file the operator owns.

| Tool | What it does | v |
|---|---|---|
| `synthesize_voice` | TTS: write an OGG/Opus file via mm-tts + ffmpeg. Returns the path. Pair with the bridge's `telegram_attach` to deliver. | 0.6.0 |
| `transcribe_audio` | STT: transcribe a local audio file via the local whisper-server. Returns the transcript text. | 0.6.0 |
| `pi_voice_telegram_schema` | Introspection: return the JSON Schema (or a per-key slice) for the companion settings file. Same schema as the `$schema` field in the file. | 0.10.0 |
| `pi_voice_telegram_config_read` | Read: return the current settings (full or per-key). | 0.11.0 |
| `pi_voice_telegram_config_write` | Write: schema-validated atomic write of a single key. Refuses `$schema`, `_hint`, and unknown keys. Returns old → new diff. | 0.11.0 |
| `pi_voice_telegram_config_reset` | Reset: schema-driven migration — fills MISSING fields with schema defaults, preserves operator's existing values. Backs up the previous file to `.bak.<unix-ms>`. | 0.12.0 + 0.13.0 |
| `pi_voice_telegram_list_voices` | Discovery: return valid MiniMax TTS voice IDs from the embedded 327-voice catalog. Filter by `language` (e.g. 'Japanese', 'Cantonese') or `voiceName` (substring). | 0.15.0 |

The first two wrap the in-process TTS/STT pipelines; the next four give the LLM end-to-end control of the companion settings file; the last is a discovery primitive for voice IDs (so the agent doesn't guess a wrong ID and get 2054). All seven are registered whenever `tools.enabled` is `true` — no per-tool sub-gate beyond `tools.tts.enabled` / `tools.stt.enabled` for the first two.

The `pi_voice_telegram_list_voices` tool ships a 327-entry catalog (`voices.json`, ~58KB) extracted from the official MiniMax system-voice page. The agent can call it to find a valid voice before writing `tts.voice` or before passing a per-call `voice` arg to `synthesize_voice`. Substring filter on either the English label or the original Chinese label — e.g. `language="japan"` resolves to "Japanese", `language="cantonese"` to the 6 Cantonese voices. The 15 Japanese voices are all-ASCII and safe (verified against the catalog as of 2026-08-17); prefer ASCII forms to avoid the §2a byte-trap documented in `patches/v0.5.0/README.md`.

See [`PLAN.md`](./PLAN.md) for the design discussion, open questions, and roadmap.

## Public API surface

| Hook | What pi-voice-telegram registers |
|---|---|
| `registerTelegramVoiceSynthesisProvider` (from `@llblab/pi-telegram/voice`) | mm-tts-backed TTS provider. ID: `pi-voice-telegram/tts`. Returns either `oggPath` (string) or `{ audioPath, transcriptText }` depending on `voice.sendTranscript`. |
| `registerTelegramUpdateHandler` (from `@llblab/pi-telegram/updates`) | Echo handler. Detects incoming voice / audio, runs STT, sends the `🎙️` reply, caches the transcript by file name. |
| `registerTelegramInboundHandler` (from `@llblab/pi-telegram/inbound`) | Reads the cached transcript and returns it so the agent prompt sees the same text the user saw in the echo. |
| `pi.registerTool` (from `@earendil-works/pi-coding-agent`) — `synthesize_voice` (v0.6.0+, opt-in) | Wraps `voice-reply.ts`. Writes an OGG/Opus file and returns the path. Pair with the bridge's `telegram_attach` to deliver. |
| `pi.registerTool` (from `@earendil-works/pi-coding-agent`) — `transcribe_audio` (v0.6.0+, opt-in) | Wraps `whisper-stt.transcribe()`. Returns the transcript text for a local audio file. |
| `pi.registerTool` (from `@earendil-works/pi-coding-agent`) — `pi_voice_telegram_schema` (v0.10.0+, opt-in) | Returns the companion settings JSON Schema as text. Lets the LLM discover knobs/types/defaults/valid values before suggesting edits. Optional `key` param for a single section. |
| `pi.registerTool` (from `@earendil-works/pi-coding-agent`) — `pi_voice_telegram_config_read` (v0.11.0+) | Reads the current companion settings (full file or per-key via dotted path). Refuses nothing — read is non-destructive. |
| `pi.registerTool` (from `@earendil-works/pi-coding-agent`) — `pi_voice_telegram_config_write` (v0.11.0+) | Schema-validated atomic write of a single key. Refuses `$schema`, `_hint`, and any unknown key. Returns old → new diff. The LLM is told to remind the operator to restart the session. |
| `pi.registerTool` (from `@earendil-works/pi-coding-agent`) — `pi_voice_telegram_config_reset` (v0.12.0+, schema-driven in v0.13.0+) | Schema-driven migration: fills in MISSING fields with the schema's `default` value, preserves the operator's existing values, backups the previous file to a timestamped `.bak.<unix-ms>`. Use to migrate a stale file to a newer schema version. |

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PI_MM_TTS_VOICE_REPLY_TIMEOUT_MS` | `30000` | Per-call synthesis timeout in ms (covers mm-tts + ffmpeg) |
| `PI_MM_TTS_VOICE` | `Cantonese_PlayfulMan` | Default voice ID (overridden by `telegram.json` `outboundHandlers[voice].defaults.voice`) |
| `PI_MM_TTS_LANG` | `Chinese,Yue` | Default language boost (overridden by `telegram.json` `outboundHandlers[voice].defaults.lang`) |
| `PI_MM_TTS_MODEL` | `speech-2.8-hd` | Default TTS model |
| `PI_TELEGRAM_STT_TIMEOUT_MS` | `60000` | Per-call STT timeout in ms |
| `WHISPER_SERVER_URL` | `http://127.0.0.1:8080` | whisper-server base URL (STT) |
| `PI_TELEGRAM_LANG` | `yue` | Default language code passed to whisper-server |
| `MINIMAX_CN_API_KEY` | (env) | Required by `mm-tts` for the MiniMax T2A API |

## Layered default resolution (TTS)

The TTS provider reads `telegram.json` on every call and resolves the synthesis language, voice, and model via this priority:

1. Bridge-supplied options (from `<!-- telegram_voice lang=… -->` markup or an upstream programmatic handler)
2. `telegram.json` `outboundHandlers[voice].defaults.{voice,lang,rate}`
3. Provider-level defaults from env vars (`PI_MM_TTS_VOICE`, `PI_MM_TTS_LANG`, `PI_MM_TTS_MODEL`)
4. Hard-coded provider constants

Settings-UI edits to `telegram.json` take effect on the next call (no session restart required).

## Auth sources for `mm-tts`

`mm-tts` resolves the MiniMax T2A API key in this order:

1. Explicit `apiKey` argument (not used by this extension)
2. `$MINIMAX_API_KEY` env var
3. Explicit `keyFile` path (not used by this extension)
4. `~/.mmx/config.json` `key` field
5. `auth.json` `minimax-cn` or `minimax-cn-m3-clean` key (in `PI_CODING_AGENT_DIR`)

Set `$MINIMAX_CN_API_KEY` in the agent's environment.

## Development

```bash
# Lint
npm install
npm run lint

# Typecheck
npx tsc --noEmit

# Test
npm test
```

## License

MIT.
