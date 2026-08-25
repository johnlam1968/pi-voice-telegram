# pi-telegram-stt

Voice echo extension for the Pi coding agent + [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) bridge. Adds the 🎙️ reply showing the STT transcript of inbound voice/audio messages, so the user gets instant feedback that their voice was understood.

The bridge transcribes inbound voice for the agent. This extension adds the user-facing echo on top of that — the transcript is also fed into the agent's prompt (the upstream behavior); the echo is the addition.

The OpenAI-compatible STT provider is bundled inside the package (no separate install). It talks to any OpenAI-compatible `/v1/audio/transcriptions` gateway:

- OpenAI's actual API (`base_url="https://api.openai.com/v1"`, `apiKey=sk-...`)
- A local `whisper-server` (e.g. via `fw-openai-sts` or `faster-whisper-server --enable-openai-api`)
- Any other OpenAI-compatible gateway

`base_url` accepts a string (single URL) or a string[] (fallback chain — local first, cloud second is the natural on-host shape).

## Install

```bash
pi install npm:pi-telegram-stt
```

Configure via `telegram.json#extensions["pi-telegram-stt"]`. The 200ms hot-reload watcher picks up edits; no agent restart needed.

## Configure

```json
{
  "extensions": {
    "pi-telegram-stt": {
      "showTranscript": true,
      "stt_provider": "pi-openai-stt",
      "base_url": ["http://127.0.0.1:8081/v1", "https://api.openai.com/v1"]
    }
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `showTranscript` | boolean | master switch — `true` sends the 🎙️ echo reply, `false` disables the echo (the bridge still feeds the transcript to the agent) |
| `stt_provider` | string | which registered provider to use. The only bundled provider is `pi-openai-stt`. |
| `base_url` | string \| string[] | the OpenAI-compatible gateway URL(s). A string[] is tried in order. |

For an API key, set `OPENAI_API_KEY` in the env, or write it to `~/.pi/agent/auth.json` under `openai.key`, or include it in `telegram.json` (the package reads the same key as the LLM provider).

**Make sure `telegram.json.inboundHandlers` is empty (or absent)** so this extension is the only STT path; otherwise the bridge's stronger handler will run first and bypass the echo.

## Provider contract (for future backends)

The `SttProvider` interface in `./stt-provider.ts` is a private in-package seam. For a new backend (e.g. a non-OpenAI speech model), add a `stt-<backend>.ts` file in this package and register it at module load in `index.ts`:

```typescript
import { registerSttProvider, unregisterSttProvider, type SttProvider } from "./stt-provider.js";

const provider: SttProvider = {
  id: "my-stt",
  label: "My STT backend",
  async transcribe(req) {
    // req.inputPath, req.lang
    return transcriptText;
  },
};

unregisterSttProvider("my-stt");
registerSttProvider(provider);
```

Errors are `ProviderError` with `code: 1|2|3|4` (1=usage, 2=network, 3=4xx, 4=5xx) — the same taxonomy the bridge's `telegram-status` view expects, so the operator's diagnostics are consistent across providers.

## License

MIT
