# pi-openai-stt

STT provider for any OpenAI-compatible API gateway. Companion to [`pi-telegram-stt`](../pi-telegram-stt/README.md).

Implements the `SttProvider` contract from `pi-telegram-stt` and registers itself with id `"pi-openai-stt"` at module load. The operator selects it via `extensions["pi-telegram-stt"].stt_provider: "pi-openai-stt"` in `telegram.json`.

The same provider code talks to many backends by changing `base_url` (or `OPENAI_STT_BASE_URL`):

| Backend | `base_url` | Notes |
| --- | --- | --- |
| OpenAI's actual API | `https://api.openai.com/v1` | Requires `api_key=sk-...` (env, auth.json, or `telegram.json`). |
| Local `whisper-server` (CUDA, large-v3 in VRAM) via the `fw-openai-sts` shim | `http://127.0.0.1:8081/v1` | Preserves the existing on-host setup. Run `fw-openai-sts` on the host (see [`scripts/fw-openai-sts.ts`](../../../scripts/fw-openai-sts.ts)). No `api_key` needed. |
| `faster-whisper-server` with `--enable-openai-api` | `http://<host>:8000/v1` | Python-based; competitive with whisper.cpp on GPU. |
| `whisper-asr-webservice` | `http://<host>:9000/v1` | Python/FastAPI. |
| Any other OpenAI-compatible gateway | varies | Per the gateway's docs. |

## Fallback chain (v0.4.5)

`base_url` accepts a single URL **or** a fallback chain — a `string[]` of gateway URLs tried in order:

```json
"pi-openai-stt": {
  "base_url": [
    "http://127.0.0.1:8081/v1",
    "https://api.openai.com/v1"
  ]
}
```

The first non-empty transcript wins; empty results and `OpenAiSttError`s both fall through to the next URL. The last error in the chain is re-thrown (with the chain context attached) if every URL fails.

**Natural on-host shape:** local CUDA whisper-server runs free / low-latency until it dies, then OpenAI takes over for the same call. Same code path, same contract, no new dependency.

**Free "which path fired" indicator:** the local `fw-openai-sts` shim forwards to whisper.cpp which produces space-separated transcripts (e.g. `"在金融方面 刺身股是什麼意思?"`). OpenAI's `whisper-1` produces comma-separated transcripts (e.g. `"在金融方面,刺身股是什麼意思?"`). Punctuation in the returned transcript tells you which URL served the call without needing log events.

## Install

On-host dev loader (one-liner re-export shim):

```bash
cat > ~/.pi/agent/extensions/pi-openai-stt.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-openai-stt/index.ts";
EOF
```

`pi-telegram-stt` and `pi-openai-stt` must both be loaded by the agent. Order doesn't matter — the provider is looked up at STT call time, not at registration time (v0.3.1 load-order race fix).

For the cluster install path, `npm install file:/path/to/this/dir` for each of `pi-telegram-stt` and `pi-openai-stt` from `~/.pi/agent/npm/`.

## Configure

`extensions["pi-openai-stt"]` in `telegram.json` is the recommended config source. Set `stt_provider` on the echo extension and the `base_url` / `api_key` for the provider:

```json
{
  "extensions": {
    "pi-telegram-stt": {
      "echoEnabled": true,
      "stt_provider": "pi-openai-stt"
    },
    "pi-openai-stt": {
      "base_url": ["http://127.0.0.1:8081/v1", "https://api.openai.com/v1"]
    }
  }
}
```

### `base_url` resolution

First non-empty list wins. Each source accepts a string (single URL) or a string[] (fallback chain):

| Priority | Source | Notes |
| --- | --- | --- |
| 1 | `OpenAiSttArgs.baseUrl` (test path) | Programmatic override. |
| 2 | `extensions["pi-openai-stt"].base_url` in `telegram.json` | **Recommended for live config.** |
| 3 | `OPENAI_STT_BASE_URL` env var | CI / container overrides. |
| 4 | Smart default | `https://api.openai.com/v1` if an `api_key` is resolvable (any source), else `http://127.0.0.1:8081/v1`. |

### `api_key` resolution

`api_key` is independent of `base_url` (one key can authorize any URL). First non-empty wins:

| Priority | Source | Notes |
| --- | --- | --- |
| 1 | `OpenAiSttArgs.apiKey` (test path) | Programmatic override. |
| 2 | `extensions["pi-openai-stt"].api_key` in `telegram.json` | Per-profile key. |
| 3 | `OPENAI_API_KEY` env var | CI / container overrides. |
| 4 | `~/.pi/agent/auth.json` → `openai.key` | Same file the LLM provider reads. |
| 5 | unset | The local shim ignores the `Authorization` header; OpenAI's API requires it (returns 401). |

### Other env vars (no `telegram.json` equivalent — kept env-only)

| Env var | Default | Purpose |
| --- | --- | --- |
| `OPENAI_STT_MODEL` | `whisper-1` | The `model` form field. OpenAI's `whisper-1`; some gateways accept vendor-specific names. |
| `PI_TELEGRAM_LANG` | `yue` | BCP-47 code passed as the `language` form field. |

## Protocol

`POST ${base_url}/audio/transcriptions` with `multipart/form-data`:
- `file`: the audio file (any format the gateway accepts; the local shim forwards to whisper-server which has `--convert` for ffmpeg-side decoding).
- `model`: model id (default `whisper-1`).
- `language`: BCP-47 / ISO-639-1 code (default `yue`). Stripped for `api.openai.com` (OpenAI's Whisper rejects `yue` with HTTP 400 even though it's valid ISO 639-1; auto-detect handles Cantonese correctly). The local shim and other gateways keep `language`.
- `response_format`: `text` (we request text directly to skip the JSON unwrap).

Authorization: `Bearer ${api_key}` header — sent only when the key is set. The local shim ignores the header; OpenAI's API requires it.

## On-host setup with the local `whisper-server`

The on-host CUDA `whisper-server` is unchanged. Add the `fw-openai-sts` shim and a one-line `telegram.json` config:

```sh
# 1. Install the shim
cp scripts/fw-openai-sts.ts ~/.pi/agent/bin/fw-openai-sts
chmod +x ~/.pi/agent/bin/fw-openai-sts

# 2. Start the shim (one-time, on host startup)
fw-openai-sts &  # listens on 8081, forwards to 127.0.0.1:8080/inference

# 3. Update telegram.json
#    "extensions": {
#      "pi-telegram-stt": { "echoEnabled": true, "stt_provider": "pi-openai-stt" },
#      "pi-openai-stt":     { "base_url": "http://127.0.0.1:8081/v1" }
#    }
#    (No env vars needed; the local shim doesn't check api_key.)

# 4. Restart pi
```

Inference latency: unchanged (the local CUDA `whisper-server` does the inference; the shim adds ~1ms of HTTP overhead). VRAM: unchanged (the model stays in the existing process). Network: the agent talks OpenAI's `/v1/audio/transcriptions` to the shim on localhost, and the shim forwards to the existing `whisper-server` on localhost.

## Switching to OpenAI's actual API (cloud mode)

One-line change in `telegram.json`:

```json
"pi-openai-stt": { "base_url": "https://api.openai.com/v1" }
```

Plus a key in any of the standard sources (`extensions["pi-openai-stt"].api_key`, `OPENAI_API_KEY` env, or `~/.pi/agent/auth.json` → `openai.key`).

For "local first, cloud fallback" (recommended on-host), use the array form:

```json
"pi-openai-stt": {
  "base_url": ["http://127.0.0.1:8081/v1", "https://api.openai.com/v1"]
}
```

The chain tries the local shim first; if it dies or returns an empty transcript, the same call goes to `api.openai.com` and the cloud fills in.

## Errors

Thrown as `OpenAiSttError` with `code: 1|2|3|4`:
- `1` usage / validation
- `2` network (timeout, DNS, connection refused)
- `3` API client (HTTP 4xx, or malformed response)
- `4` API server (HTTP 5xx)

The provider in `index.ts` re-wraps `OpenAiSttError` as `ProviderError` to keep the registry's `code: 1|2|3|4` taxonomy consistent across all STT providers.

## License

MIT
