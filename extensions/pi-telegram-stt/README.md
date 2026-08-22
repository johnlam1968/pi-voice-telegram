# pi-telegram-stt

Voice echo extension for the Pi coding agent + [@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge. Adds the 🎙️ reply showing the STT transcript of inbound voice/audio messages.

**STT is delegated to a peer-dep provider extension**. The default is [`pi-openai-stt`](../pi-openai-stt/README.md) — a single provider that talks to any OpenAI-compatible gateway (OpenAI's actual API, the local `fw-openai-sts` shim, `faster-whisper-server`, etc.) with a fallback-chain config. The provider is selected via `extensions["pi-telegram-stt"].stt_provider` in `telegram.json`. The provider contract lives in `./stt-provider.ts`; any extension that implements it can plug in.

## Install

On-host dev loader (one-liner re-export shim) for `pi-telegram-stt`:

```bash
cat > ~/.pi/agent/extensions/pi-telegram-stt.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-telegram-stt/index.ts";
EOF
```

And for the default STT provider (`pi-openai-stt`):

```bash
cat > ~/.pi/agent/extensions/pi-openai-stt.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-openai-stt/index.ts";
EOF
```

The absolute path import is intentional: `pi -e` resolves relative imports against the loader file's directory, not against the dev source. An absolute path keeps the source's relative imports (`../pi-telegram-stt/stt-provider.js` to reach the contract) resolvable from the source dir.

For the cluster install path, `npm install file:/path/to/this/dir` for each of `pi-telegram-stt` and `pi-openai-stt` from `~/.pi/agent/npm/`.

## Configure

Edit `~/.pi/agent/telegram.json`:

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

`stt_provider` defaults to `"pi-openai-stt"`. `pi-openai-stt`'s `base_url` is a string (single gateway) or a string[] (fallback chain — local first, cloud second is the natural on-host shape). See [`pi-openai-stt`](../pi-openai-stt/README.md) for the full config matrix.

The on-host CUDA `whisper-server` runs behind the `fw-openai-sts` shim — same VRAM, same model, ~1ms of HTTP overhead. To run only the cloud path, set `base_url: "https://api.openai.com/v1"` and provide a key via env / `auth.json` / `telegram.json`.

**Make sure `telegram.json.inboundHandlers` is empty (or absent)** so this extension is the only STT path; otherwise the bridge's stronger handler will run first and bypass the echo.

## Section UI

`/telegram-settings` → 🎙️ Echo → toggle on/off + pick the STT provider from the installed list. The section writes to `telegram.json`, the hot-reload watcher (200ms debounce) picks up the change, and the next inbound voice message uses the new setting.

## Provider contract

A provider is a Pi extension that calls `registerSttProvider(provider)` at module load with an `SttProvider` instance:

```typescript
import { registerSttProvider, unregisterSttProvider, type SttProvider } from "pi-telegram-stt/stt-provider";

const provider: SttProvider = {
  id: "my-stt",
  label: "My STT backend",
  async transcribe(req) {
    // req.inputPath, req.lang
    return transcriptText;
  },
};

// Register at module load (synchronous top-level side effect, same
// pattern as pi-openai-stt v0.3.1). The provider is in the registry
// before any session_start fires, before any message is processed.
try {
  registerSttProvider(provider);
} catch {
  unregisterSttProvider("my-stt");
  registerSttProvider(provider);
}

export default function myStt(pi) {
  pi.on("session_start", () => {
    try { registerSttProvider(provider); } catch { /* already registered */ }
  });
  pi.on("session_shutdown", () => {
    unregisterSttProvider("my-stt");
  });
}
```

Errors are `ProviderError` with `code: 1|2|3|4` (1=usage, 2=network, 3=4xx, 4=5xx) — the same taxonomy the old monolithic used, so the operator's `telegram-status` view is consistent across providers.

## License

MIT
