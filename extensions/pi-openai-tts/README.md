# pi-openai-tts

TTS provider for any OpenAI-compatible API gateway. Companion to [`pi-telegram-tts-minimax`](../pi-telegram-tts-minimax/README.md). Parallel to [`pi-openai-stt`](../pi-openai-stt/README.md) on the STT side.

Implements the `TtsProvider` contract from `pi-telegram-tts-minimax` and registers itself with id `"pi-openai-tts"` at module load. The orchestrator selects it via `extensions["pi-telegram-tts-minimax"].tts_provider: "pi-openai-tts"` in `telegram.json`.

## Backends

| Backend | `base_url` | Notes |
| --- | --- | --- |
| OpenAI's actual API | `https://api.openai.com/v1` | 6 voices (`alloy` `echo` `fable` `onyx` `nova` `shimmer`); 2 models (`tts-1`, `tts-1-hd`); 6 output formats. Requires `api_key=sk-...`. |
| Any future OpenAI-compatible TTS gateway | varies | Per the gateway's docs. The convention is `POST /v1/audio/speech` (json body, binary audio response). |

## Install

On-host dev loader (one-liner re-export shim):

```bash
cat > ~/.pi/agent/extensions/pi-openai-tts.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-openai-tts/index.ts";
EOF
```

`pi-telegram-tts-minimax` and `pi-openai-tts` must both be loaded by the agent. Order doesn't matter — the provider is looked up at synthesis call time.

## Configure

`extensions["pi-openai-tts"]` in `telegram.json` is the recommended config source:

```json
{
  "extensions": {
    "pi-telegram-tts-minimax": { "tts_provider": "pi-openai-tts" },
    "pi-openai-tts": {
      "base_url": "https://api.openai.com/v1",
      "voice": "alloy",
      "model": "tts-1"
    }
  }
}
```

### Config resolution

First non-empty wins for each field:

| Field | Sources (in order) |
| --- | --- |
| `voice` | `TtsRequest.voice` > `extensions["pi-openai-tts"].voice` > `OPENAI_TTS_VOICE` env > default `alloy` |
| `model` | `TtsRequest.model` > `extensions["pi-openai-tts"].model` > `OPENAI_TTS_MODEL` env > default `tts-1` |
| `response_format` | `TtsRequest.responseFormat` > `OPENAI_TTS_FORMAT` env > default `opus` (Telegram's `sendVoice` wants OGG/Opus) |
| `speed` | `TtsRequest.speed` > default `1.0` (no env / no telegram.json — usually a per-call value) |
| `api_key` | `extensions["pi-openai-tts"].api_key` > `OPENAI_API_KEY` env > `~/.pi/agent/auth.json` → `openai.key` > unset |
| `base_url` | `extensions["pi-openai-tts"].base_url` > `OPENAI_TTS_BASE_URL` env > default `https://api.openai.com/v1` |

Out-of-range values throw `OpenAiTtsError` with `code: 1` (usage).

## Protocol

`POST ${base_url}/audio/speech` with `application/json`:

```json
{
  "model": "tts-1",
  "input": "你好,世界。",
  "voice": "alloy",
  "response_format": "opus"
}
```

Headers: `Authorization: Bearer ${api_key}` (sent only when the key is set; OpenAI's API requires it, future gateways may not).

Response: binary audio. We default to `response_format: "opus"` — OpenAI returns Opus-in-OGG (`Content-Type: audio/ogg`), which Telegram's `sendVoice` accepts natively. No ffmpeg rewrap.

## On-host setup (cloud-only)

For the OpenAI cloud path, no host infrastructure is required beyond the standard `~/.pi/agent/auth.json` key (or `OPENAI_API_KEY` env). Save the result to a temp file and return the path — the orchestrator hands it to the bridge's `delivery` module.

## Errors

Thrown as `OpenAiTtsError` with `code: 1|2|3|4`:
- `1` usage / validation (bad voice, model, format, speed, missing key on a gateway that requires it)
- `2` network (timeout, DNS, connection refused)
- `3` API client (HTTP 4xx, or malformed response)
- `4` API server (HTTP 5xx)

The provider in `index.ts` re-wraps `OpenAiTtsError` as `TtsProviderError` to keep the registry's `code: 1|2|3|4` taxonomy consistent across all TTS providers (parallel to the STT side).

## License

MIT
