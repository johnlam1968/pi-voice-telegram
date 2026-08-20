# pi-telegram-tts-minimax

TTS orchestrator for the Pi coding agent + [@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge. Parallel to [`pi-telegram-echo`](../pi-telegram-echo/README.md) (the STT orchestrator).

Registers a `TelegramVoiceSynthesisProvider` with the bridge (id `pi-telegram-tts-minimax/tts`). The provider closure delegates to a peer-dep `TtsProvider` looked up in [`./tts-provider.ts`](./tts-provider.ts) at synthesis call time. The provider packages ([`pi-openai-tts`](../pi-openai-tts/README.md), [`pi-minimax-tts`](../pi-minimax-tts/README.md)) implement the `TtsProvider` interface and register themselves at module load.

## Architecture

```
extensions/
├── pi-telegram-tts-minimax/   this package (orchestrator)
│   ├── tts-provider.ts        TtsProvider contract + globalThis registry
│   └── index.ts               registers TelegramVoiceSynthesisProvider with the bridge
├── pi-openai-tts/             OpenAI-compatible provider (/v1/audio/speech)
└── pi-minimax-tts/            MiniMax T2A provider (speech-2.x / speech-01/02)
```

```
bridge → TelegramVoiceSynthesisProvider (this file)
  → TtsProvider registry (./tts-provider.ts)
    → pi-openai-tts (OpenAI /v1/audio/speech)
    → pi-minimax-tts (MiniMax T2A + ffmpeg libopus rewrap)
    → future providers (any package implementing TtsProvider)
```

## Install

On-host dev loader (one-liner re-export shim):

```bash
cat > ~/.pi/agent/extensions/pi-telegram-tts-minimax.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-telegram-tts-minimax/index.ts";
EOF
```

Plus the provider(s) you want to use. Order doesn't matter — providers register at module load, the orchestrator looks them up at synthesis call time.

```bash
cat > ~/.pi/agent/extensions/pi-minimax-tts.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-minimax-tts/index.ts";
EOF
```

For the cluster install path, `npm install file:/path/to/this/dir` for each of `pi-telegram-tts-minimax`, `pi-minimax-tts`, and `pi-openai-tts` from `~/.pi/agent/npm/`.

## Configure

Edit `~/.pi/agent/telegram.json`:

```json
{
  "extensions": {
    "pi-telegram-tts-minimax": {
      "tts_provider": "pi-minimax-tts"
    },
    "pi-minimax-tts": {
      "voice": "Cantonese_PlayfulMan",
      "model": "speech-2.8-hd",
      "lang": "Chinese,Yue",
      "region": "cn"
    }
  }
}
```

`tts_provider` defaults to `"pi-minimax-tts"`. Switch to `"pi-openai-tts"` for OpenAI's TTS API. Other provider-specific settings (voice, model, region, emotion, etc.) are read by the provider itself from `extensions["pi-<provider>-tts"]` in `telegram.json` — see the provider's README for the field list.

Hot-reload: the orchestrator watches `telegram.json` and re-registers the bridge TTS provider on change (200ms debounce, same pattern as the STT side).

**`voice.replyMode: "mirror"` is the trigger** — when the bridge's voice pipeline wants to synthesize a reply (because the user's input was a voice message), it calls the configured TTS provider.

## Provider contract

A provider is a Pi extension that calls `registerTtsProvider(provider)` at module load with a `TtsProvider` instance:

```typescript
import { registerTtsProvider, unregisterTtsProvider, type TtsProvider } from "pi-telegram-tts-minimax/tts-provider";

const provider: TtsProvider = {
  id: "my-tts",
  label: "My TTS backend",
  async synthesize(req) {
    // req.text, req.lang, req.voice, req.model, req.speed,
    // req.responseFormat, req.extras
    // → return { audioPath, transcriptText?, language?, durationMs? }
  },
};

// Register at module load (synchronous top-level side effect).
try {
  registerTtsProvider(provider);
} catch {
  unregisterTtsProvider("my-tts");
  registerTtsProvider(provider);
}

export default function myTts(pi) {
  pi.on("session_start", () => {
    try { registerTtsProvider(provider); } catch { /* already registered */ }
  });
  pi.on("session_shutdown", () => unregisterTtsProvider("my-tts"));
}
```

Errors are `TtsProviderError` with `code: 1|2|3|4` (1=usage, 2=network, 3=4xx, 4=5xx) — the same taxonomy the STT side uses, so the operator's `telegram-status` view is consistent across providers.

## License

MIT
