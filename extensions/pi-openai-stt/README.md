# pi-openai-stt

STT provider for any OpenAI-compatible API gateway. Companion to [`pi-telegram-echo`](../pi-telegram-echo/README.md).

Implements the `SttProvider` contract from `pi-telegram-echo` and registers itself with id `"pi-openai-stt"` at module load. The operator selects it via `extensions["pi-telegram-echo"].stt_provider: "pi-openai-stt"` in `telegram.json`.

The same provider code talks to many backends by changing `OPENAI_STT_BASE_URL`:

| Backend | `OPENAI_STT_BASE_URL` | Notes |
| --- | --- | --- |
| OpenAI's actual API | `https://api.openai.com/v1` | Requires `OPENAI_API_KEY=sk-...`. |
| Local `whisper-server` (CUDA, large-v3 in VRAM) via the `fw-openai-sts` shim | `http://127.0.0.1:8081/v1` | Preserves the existing on-host setup. Run `fw-openai-sts` on the host (see [`scripts/fw-openai-sts.ts`](../../../scripts/fw-openai-sts.ts)). No `OPENAI_API_KEY` needed. |
| `faster-whisper-server` with `--enable-openai-api` | `http://<host>:8000/v1` | Python-based; competitive with whisper.cpp on GPU. |
| `whisper-asr-webservice` | `http://<host>:9000/v1` | Python/FastAPI. |
| Any other OpenAI-compatible gateway | varies | Per the gateway's docs. |

## Install

On-host dev loader (one-liner re-export shim):

```bash
cat > ~/.pi/agent/extensions/pi-openai-stt.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-openai-stt/index.ts";
EOF
```

`pi-telegram-echo` and `pi-openai-stt` must both be loaded by the agent. Order doesn't matter — the provider is looked up at STT call time, not at registration time (v0.3.1 load-order race fix).

## Configure

Set `stt_provider` in `telegram.json`:

```json
{
  "extensions": {
    "pi-telegram-echo": {
      "echoEnabled": true,
      "stt_provider": "pi-openai-stt"
    }
  }
}
```

Tune via env vars on the agent process:

| Env var | Default | Purpose |
| --- | --- | --- |
| `OPENAI_STT_BASE_URL` | **Smart default**: `https://api.openai.com/v1` if `OPENAI_API_KEY` is set, else `http://127.0.0.1:8081/v1` (the local `fw-openai-sts` shim). | Any OpenAI-compatible API gateway. Override with this env var. |
| `OPENAI_API_KEY` | (none — optional) | Bearer token. Only sent when set (the local shim ignores the header). |
| `OPENAI_STT_MODEL` | `whisper-1` | The `model` form field. OpenAI's `whisper-1`; some gateways accept vendor-specific names. |
| `PI_TELEGRAM_LANG` | `yue` | BCP-47 code passed as the `language` form field. |

The smart default is the on-host default from PLAN.md §v0.4.0:
- **No `OPENAI_API_KEY` set** → defaults to the local shim (`http://127.0.0.1:8081/v1`). Run `fw-openai-sts &` once on the host and the STT path "just works".
- **`OPENAI_API_KEY=sk-...` set** → defaults to OpenAI's actual API (`https://api.openai.com/v1`). Set `OPENAI_STT_BASE_URL` to a different gateway if you want a custom one with a key.

## Protocol

`POST ${OPENAI_STT_BASE_URL}/audio/transcriptions` with `multipart/form-data`:
- `file`: the audio file (any format the gateway accepts; the local shim forwards to whisper-server which has `--convert` for ffmpeg-side decoding).
- `model`: model id (default `whisper-1`).
- `language`: BCP-47 / ISO-639-1 code (default `yue`).
- `response_format`: `text` (we request text directly to skip the JSON unwrap).

Authorization: `Bearer ${OPENAI_API_KEY}` header — sent only when the key is set.

## On-host setup with the local `whisper-server`

The on-host CUDA `whisper-server` (PID 704, `ggml-large-v3.bin` in VRAM) is unchanged. Add the `fw-openai-sts` shim:

```sh
# 1. Install the shim
cp scripts/fw-openai-sts.ts ~/.pi/agent/bin/fw-openai-sts
chmod +x ~/.pi/agent/bin/fw-openai-sts

# 2. Start the shim (one-time, on host startup)
fw-openai-sts &  # listens on 8081, forwards to 127.0.0.1:8080/inference

# 3. Set env
export OPENAI_STT_BASE_URL=http://127.0.0.1:8081/v1
# OPENAI_API_KEY not required (the shim doesn't check it)

# 4. Update telegram.json: set stt_provider to "pi-openai-stt"

# 5. Restart pi
```

Inference latency: unchanged (the local CUDA `whisper-server` does the inference; the shim adds ~1ms of HTTP overhead). VRAM: unchanged (the model stays in the existing process). Network: the agent talks OpenAI's `/v1/audio/transcriptions` to the shim on localhost, and the shim forwards to the existing `whisper-server` on localhost.

## Deprecation plan

`pi-whisper-stt` is kept for one release (v0.4.0 → v0.5.0) for back-compat. v0.5.0 flips the default `stt_provider` from `pi-whisper-stt` to `pi-openai-stt` (with a one-time migration that rewrites the config). v0.6.0 removes `pi-whisper-stt` from the repo.

## License

MIT
