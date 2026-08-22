# pi-voice-telegram-scripts

Runtime shell scripts for the [pi-voice-telegram](https://github.com/johnlam1968/pi-voice-telegram) stack. The Pi agent + `@llblab/pi-telegram` bridge call these from `telegram.json#outboundHandlers[0].template` to synthesize voice replies.

## Install

```bash
npm install -g pi-voice-telegram-scripts
# or, for a project-local install:
npm install pi-voice-telegram-scripts
```

After install, three commands are on `PATH` (or in `node_modules/.bin/` for a local install):

| Command | Source | Purpose |
|---|---|---|
| `tts-minimax` | `tts-minimax.mjs` | MiniMax T2A HTTP client. Reads `MINIMAX_CN_API_KEY` or `~/.mmx/config.json`. |
| `tts-openai` | `tts-openai.mjs` | OpenAI `/v1/audio/speech` client. Reads `OPENAI_API_KEY` or `~/.pi/agent/auth.json`. |
| `fw-openai-sts` | `bin/fw-openai-sts` (bash wrapper) | OpenAI-compatible STT shim for the local `whisper-server`. Listens on `:8081` by default. |

## What this is NOT

- Not a publishable agent extension. The Pi agent discovers extensions via `package.json#pi.extensions`, which lives in `pi-telegram-stt` and `pi-openai-stt` (the two sister extensions). This package is just CLIs.
- Not a wrapper around the provider SDKs. Each script is a thin HTTP client (a few hundred lines) that hits the provider's REST API directly. No SDK, no build step, no dependencies.

## Usage from `telegram.json#outboundHandlers[0].template`

The bridge substitutes `{mp3}` and `{ogg}` placeholders. The template is an array of shell commands; each is run in order, with stdout piped to stdin of the next. The first command is expected to write the MP3 to `{mp3}`; the second encodes to OGG/Opus at `{ogg}` (the format the bridge accepts).

```json
{
  "type": "voice",
  "template": [
    "tts-minimax --out {mp3} --voice Cantonese_PlayfulMan --model speech-2.8-hd",
    "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 48000 -ac 1 -application voip -vbr on -compression_level 10 -f ogg {ogg}"
  ],
  "output": "ogg"
}
```

(`tts-minimax` and `tts-openai` are on PATH inside the container if the package was installed globally, or you can use the absolute path to `node_modules/.bin/tts-minimax`.)

## Scripts

### `tts-minimax` — `tts-minimax.mjs`

Pure-Node CLI for the MiniMax T2A HTTP endpoint. 100% CLI coverage of the OpenAPI schema — every field is reachable via either a flag (`--voice`, `--model`, `--speed`, `--emotion`, `--volume`, `--pitch`) or `--config <json>` for the request body.

Reference: `https://platform.minimax.io/docs/api-reference/speech-t2a-http` (the source repo's `archive/docs/MINIMAX-T2A-OPENAPI.md` has the verbatim spec).

### `tts-openai` — `tts-openai.mjs`

Pure-Node CLI for OpenAI's `/v1/audio/speech` endpoint. Supports `gpt-4o-mini-tts` (default), `tts-1`, `tts-1-hd`, the 6 voice presets, and the `instructions` field for language bias (Cantonese via `instructions: "Speak in Cantonese."`).

The script has built-in auto-retry on the 2000-token input cap (halves the input and retries up to `--max-attempts` times).

### `fw-openai-sts` — `bin/fw-openai-sts` (bash wrapper) + `fw-openai-sts.ts`

A small Node server that exposes the local `whisper-server` (which speaks a custom `/inference` multipart endpoint) as an OpenAI-compatible `/v1/audio/transcriptions` endpoint. This is what `pi-openai-stt` talks to.

Requires Node >= 22.6 (for native `--experimental-strip-types`; no build, no jiti). Bash wrapper invokes `node --experimental-strip-types` on the .ts source.

```bash
fw-openai-sts &  # start in the background
# Listens on http://127.0.0.1:8081, forwards to http://127.0.0.1:8080 by default
```

## License

MIT
