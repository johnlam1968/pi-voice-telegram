# pi-whisper-stt

STT provider for the on-host [whisper-server](https://github.com/ggerganov/whisper.cpp/tree/master/examples/server) (whisper.cpp's example server). Companion to [`pi-telegram-echo`](../pi-telegram-echo/README.md).

Implements the `SttProvider` contract from `pi-telegram-echo` and registers itself with id `"pi-whisper-stt"` on `session_start`. The operator selects it via `extensions["pi-telegram-echo"].stt_provider: "pi-whisper-stt"` in `telegram.json`.

## Install

On-host dev loader (one-liner re-export shim):

```bash
cat > ~/.pi/agent/extensions/pi-whisper-stt.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-whisper-stt/index.ts";
EOF
```

Both `pi-telegram-echo` and `pi-whisper-stt` must be loaded by the agent. The order doesn't matter — the provider is looked up at STT call time.

## Configure

Set `stt_provider` in `telegram.json`:

```json
{
  "extensions": {
    "pi-telegram-echo": {
      "echoEnabled": true,
      "stt_provider": "pi-whisper-stt"
    }
  }
}
```

Tune the STT via env vars on the agent process:

| Env var | Default | Purpose |
| --- | --- | --- |
| `WHISPER_SERVER_URL` | `http://127.0.0.1:8080` | whisper-server base URL. POST goes to `${url}/inference`. |
| `PI_TELEGRAM_LANG` | `yue` | BCP-47 / ISO-639-1 language code passed to whisper-server. |

## Protocol

`POST ${WHISPER_SERVER_URL}/inference` with `multipart/form-data`:
- `file`: the audio file (any format whisper-server's `--convert` flag handles)
- `language`: BCP-47 / ISO-639-1 code
- `response_format`: `"text"` (only this format is currently used)

The response body is the transcript (plain text).

## Deprecation plan

Deprecated by `pi-openai-stt` (v0.4.0+ in PLAN.md) once the local whisper-server is shimmed to speak the OpenAI-compatible API gateway convention (`POST /v1/audio/transcriptions`). The shim is a host-side Node script (no upstream whisper.cpp change needed). After the shim is running, `pi-openai-stt` is the only STT provider the operator needs — the same code talks to OpenAI's API, faster-whisper-server, the local whisper-server (via the shim), and any other OpenAI-compatible backend.

## License

MIT
