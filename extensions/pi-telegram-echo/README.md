# pi-telegram-echo

Voice echo extension for the Pi coding agent + [@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge. Adds the 🎙️ reply showing the STT transcript of inbound voice/audio messages.

**STT is hardcoded to whisper-server** (the in-process `./whisper-stt.ts` client). The operator configures the server via env vars; there is no STT command in the config.

## Install

On-host dev loader (one-liner re-export shim):

```bash
cat > ~/.pi/agent/extensions/pi-telegram-echo.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-telegram-echo/index.ts";
EOF
```

The absolute path import is intentional: `pi -e` resolves relative imports against the loader file's directory, not against the dev source. An absolute path keeps the source's relative imports (`./echo-handler.js`, `./echo-section.js`, `./telegram-config.js`, `./whisper-stt.js`) resolvable from the source dir.

For the cluster install path, use `npm install file:/path/to/this/dir` from `~/.pi/agent/npm/`.

## Configure

Edit `~/.pi/agent/telegram.json` under `extensions["pi-telegram-echo"]`:

```json
{
  "extensions": {
    "pi-telegram-echo": {
      "echoEnabled": true
    }
  }
}
```

Tune the STT via env vars on the agent process:

| Env var | Default | Purpose |
| --- | --- | --- |
| `WHISPER_SERVER_URL` | `http://127.0.0.1:8080` | whisper-server base URL. POST goes to `${url}/inference`. |
| `PI_TELEGRAM_LANG` | `yue` | BCP-47 / ISO-639-1 language code passed to whisper-server. |

**Make sure `telegram.json.inboundHandlers` is empty (or absent)** so this extension is the only STT path; otherwise the bridge's stronger handler will run first and bypass the echo.

## Section UI

`/telegram-settings` → 🎙️ Echo → toggle on/off. The section writes to `telegram.json`, the hot-reload watcher (200ms debounce) picks up the change, and the next inbound voice message uses the new setting.

## License

MIT
