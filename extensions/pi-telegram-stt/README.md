# pi-telegram-stt

Voice echo extension for the Pi coding agent + [@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge. Adds the 🎙️ reply showing the STT transcript of inbound voice/audio messages.

**As of v0.8.0, the OpenAI-compatible STT provider is bundled inside this package.** Previously it lived in a separate `pi-openai-stt` npm package (now deprecated). The bundled provider is registered at module load with id `"pi-openai-stt"` (same id, so existing `stt_provider: "pi-openai-stt"` configs keep working without change). The `SttProvider` interface stays as a private in-package seam (`./stt-provider.ts`) for future backends.

The bundled provider talks to any OpenAI-compatible API gateway:
- OpenAI's actual API (`base_url="https://api.openai.com/v1"`, `apiKey=sk-...`)
- The local `fw-openai-sts` shim (the on-host CUDA `whisper-server` exposed as OpenAI-compatible)
- `faster-whisper-server` with `--enable-openai-api`
- `whisper-asr-webservice`
- Any other OpenAI-compatible gateway

`base_url` accepts a string (single URL) or a string[] (fallback chain — local first, cloud second is the natural on-host shape).

## Install

On-host dev loader (one-liner re-export shim) for `pi-telegram-stt`:

```bash
cat > ~/.pi/agent/extensions/pi-telegram-stt.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-telegram-stt/index.ts";
EOF
```

That's it — the OpenAI STT provider is bundled, no separate shim install needed.

The absolute path import is intentional: `pi -e` resolves relative imports against the loader file's directory, not against the dev source.

For the cluster install path, `npm install file:/path/to/this/dir` for `pi-telegram-stt` from `~/.pi/agent/npm/`.

## Configure

Edit `~/.pi/agent/telegram.json`:

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

> **v0.7.2 rename:** the field was renamed from `echoEnabled` to
> `showTranscript` (semantic symmetry with the bridge's
> `voice.sendTranscript` — show the user's voice as text vs. send
> the agent's voice as a caption). The reader still accepts
> `echoEnabled` as a fallback for back-compat; just edit
> `telegram.json` to switch.

> **v0.8.0 flat config:** `base_url` and `apiKey` moved from
> `extensions["pi-openai-stt"]` to top-level keys under
> `extensions["pi-telegram-stt"]`. The reader still accepts the
> legacy `extensions["pi-openai-stt"]` block for backward
> compatibility (read-only). See the migration section below.

`stt_provider` defaults to `"pi-openai-stt"` (the only bundled provider; the seam is kept for future backends). The bundled provider's `base_url` is a string (single gateway) or a string[] (fallback chain).

The on-host CUDA `whisper-server` runs behind the `fw-openai-sts` shim — same VRAM, same model, ~1ms of HTTP overhead. To run only the cloud path, set `base_url: "https://api.openai.com/v1"` and provide a key via env / `auth.json` / `telegram.json`.

**Make sure `telegram.json.inboundHandlers` is empty (or absent)** so this extension is the only STT path; otherwise the bridge's stronger handler will run first and bypass the echo.

## Migration from 0.7.2

If you have an existing `telegram.json` with the old `pi-openai-stt` block:

```diff
 "extensions": {
   "pi-telegram-stt": {
     "showTranscript": true,
-    "stt_provider": "pi-openai-stt"
+    "stt_provider": "pi-openai-stt",
+    "base_url": ["http://127.0.0.1:8081/v1", "https://api.openai.com/v1"]
   },
-  "pi-openai-stt": {
-    "base_url": ["http://127.0.0.1:8081/v1", "https://api.openai.com/v1"]
-  }
+  // remove the pi-openai-stt block (the provider is now bundled)
 }
```

The reader still accepts the legacy `extensions["pi-openai-stt"]` block, so your existing config will keep working even if you don't migrate. The hot-reload watcher (200ms debounce) picks up any change to `telegram.json` and the next inbound voice message uses the new setting.

The npm package `pi-openai-stt` is deprecated; `npm install pi-openai-stt` will print a deprecation warning. The new install path is just `npm install pi-telegram-stt@latest`.

> **v0.10.0:** the `/telegram-settings` → 🎙️ STT section UI was
> removed (per the operator's 2026-08-24 directive). The same
> directive removed the matching `pi-telegram-tts` section. For
> single-operator setups, `telegram.json` is sufficient — the
> agent can edit it on the fly via the existing `read`/`write`
> tool calls. The hot-reload watcher still picks up edits in
> ~200ms; just edit and save.

> **v0.11.0:** the in-package `saveEchoConfig` writer was
> dropped. Same design rule as v0.10.0: `telegram.json` is the
> single source of truth, edited by the operator or the agent
> via filesystem tools, picked up live by the 200ms hot-reload
> watcher. The `loadEchoConfig` reader stays because it's the
> extension's own config interface at call time.

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

// Register at module load (synchronous top-level side effect, same
// pattern the bundled OpenAI provider uses). The provider is in
// the registry before any session_start fires, before any message
// is processed. The unregister-then-register pattern is idempotent:
// it handles both cold-start (nothing to unregister) and hot-reload
// (clears the stale entry from a previous load).
unregisterSttProvider("my-stt");
registerSttProvider(provider);
```

Errors are `ProviderError` with `code: 1|2|3|4` (1=usage, 2=network, 3=4xx, 4=5xx) — the same taxonomy the old monolithic used, so the operator's `telegram-status` view is consistent across providers.

## License

MIT
