# pi-telegram-echo

Voice echo extension for the Pi coding agent + [@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge. Adds the 🎙️ reply showing the STT transcript of inbound voice/audio messages.

**STT is delegated to a peer-dep provider extension** ([`pi-whisper-stt`](../pi-whisper-stt/README.md) by default). The provider is selected via `extensions["pi-telegram-echo"].stt_provider` in `telegram.json`. The provider contract lives in `./stt-provider.ts`; any extension that implements it can plug in.

## Install

On-host dev loader (one-liner re-export shim) for `pi-telegram-echo`:

```bash
cat > ~/.pi/agent/extensions/pi-telegram-echo.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-telegram-echo/index.ts";
EOF
```

And for the default STT provider (`pi-whisper-stt`):

```bash
cat > ~/.pi/agent/extensions/pi-whisper-stt.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-whisper-stt/index.ts";
EOF
```

The absolute path import is intentional: `pi -e` resolves relative imports against the loader file's directory, not against the dev source. An absolute path keeps the source's relative imports (`./whisper-stt.js` in `pi-whisper-stt`; `../pi-telegram-echo/stt-provider.js` to reach the contract) resolvable from the source dir.

For the cluster install path, `npm install file:/path/to/this/dir` for each of `pi-telegram-echo` and `pi-whisper-stt` from `~/.pi/agent/npm/`.

## Configure

Edit `~/.pi/agent/telegram.json` under `extensions["pi-telegram-echo"]`:

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

`stt_provider` defaults to `"pi-whisper-stt"`. Switch to a different provider by setting the id and installing the corresponding extension (e.g., `pi-openai-stt` for OpenAI-compatible backends, planned for v0.4.0+).

Tune the default provider's STT via env vars on the agent process:

| Env var | Default | Purpose |
| --- | --- | --- |
| `WHISPER_SERVER_URL` | `http://127.0.0.1:8080` | whisper-server base URL (used by `pi-whisper-stt`). POST goes to `${url}/inference`. |
| `PI_TELEGRAM_LANG` | `yue` | BCP-47 / ISO-639-1 language code passed to the provider. |

**Make sure `telegram.json.inboundHandlers` is empty (or absent)** so this extension is the only STT path; otherwise the bridge's stronger handler will run first and bypass the echo.

## Section UI

`/telegram-settings` → 🎙️ Echo → toggle on/off + pick the STT provider from the installed list. The section writes to `telegram.json`, the hot-reload watcher (200ms debounce) picks up the change, and the next inbound voice message uses the new setting.

## Provider contract

A provider is a Pi extension that calls `registerSttProvider(provider)` on `session_start` with an `SttProvider` instance:

```typescript
import { registerSttProvider, type SttProvider } from "pi-telegram-echo/stt-provider";

const provider: SttProvider = {
  id: "my-stt",
  label: "My STT backend",
  async transcribe(req) {
    // req.inputPath, req.lang
    return transcriptText;
  },
};

export default function myStt(pi) {
  pi.on("session_start", () => registerSttProvider(provider));
  pi.on("session_shutdown", () => unregisterSttProvider("my-stt"));
}
```

Errors are `ProviderError` with `code: 1|2|3|4` (1=usage, 2=network, 3=4xx, 4=5xx) — the same taxonomy the old monolithic used, so the operator's `telegram-status` view is consistent across providers.

## License

MIT
