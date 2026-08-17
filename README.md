# pi-voice-telegram

A Telegram voice/text companion extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono) and the [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) bridge.

The extension provides two capabilities. The bridge's `telegram.json` decides when and how they fire:

1. **Outbound TTS** — registers a voice synthesis provider on the bridge. The bridge calls it when `voice.replyMode` says so. The provider returns `{ audioPath, transcriptText }` when `voice.sendTranscript: true` (voice bubble with caption) or just the `oggPath` when `false` (voice bubble only).
2. **Inbound echo** — registers a raw update handler that detects voice / audio messages, runs the configured STT client (`whisper-stt.ts` → `whisper-server`), and sends the user a `🎙️ "<i>transcript</i>"` reply. A programmatic inbound handler feeds the same transcript into the agent prompt.

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
npm install --legacy-peer-deps \
    @llblab/pi-telegram@0.28.0 \
    pi-mcp-adapter@2.26.0 \
    pi-minimax-m3-caching-fix@0.2.0

# Clone pi-voice-telegram from this repo into node_modules/
git clone --depth 1 https://github.com/johnlam1968/pi-voice-telegram.git \
    ./node_modules/pi-voice-telegram

# Register the package in the agent's settings.json
node -e "
const fs = require('node:fs');
const path = process.env.HOME + '/.pi/agent/settings.json';
const settings = JSON.parse(fs.readFileSync(path, 'utf8'));
const packages = settings.packages ?? [];
if (!packages.includes('npm:pi-voice-telegram')) {
  packages.push('npm:pi-voice-telegram');
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

## Public API surface

| Hook | What pi-voice-telegram registers |
|---|---|
| `registerTelegramVoiceSynthesisProvider` (from `@llblab/pi-telegram/voice`) | mm-tts-backed TTS provider. ID: `pi-voice-telegram/tts`. Returns either `oggPath` (string) or `{ audioPath, transcriptText }` depending on `voice.sendTranscript`. |
| `registerTelegramUpdateHandler` (from `@llblab/pi-telegram/updates`) | Echo handler. Detects incoming voice / audio, runs STT, sends the `🎙️` reply, caches the transcript by file name. |
| `registerTelegramInboundHandler` (from `@llblab/pi-telegram/inbound`) | Reads the cached transcript and returns it so the agent prompt sees the same text the user saw in the echo. |

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
