# pi-telegram-echo

Voice echo extension for the Pi coding agent + [@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge. Adds the 🎙️ reply showing the STT transcript of inbound voice/audio messages.

**STT-agnostic**: the operator configures any STT command (curl, python, local script). Default is empty — the operator must configure.

## Install

Add to the agent's `~/.pi/agent/npm/package.json`:

```json
{
  "dependencies": {
    "pi-telegram-echo": "file:/path/to/extensions/pi-telegram-echo"
  }
}
```

Then `npm install` in that dir, and add `"npm:pi-telegram-echo@0.1.0"` to `pi-cluster/docker-entrypoint.sh` `REQUIRED_PACKAGES` (or the host's package list).

## Configure

Edit `~/.pi/agent/telegram.json` under `extensions["pi-telegram-echo"]`:

```json
{
  "extensions": {
    "pi-telegram-echo": {
      "echoEnabled": true,
      "stt": {
        "command": [
          "curl", "-s", "-X", "POST",
          "-F", "file=@{file}",
          "-F", "response_format=text",
          "http://127.0.0.1:8080/inference"
        ]
      }
    }
  }
}
```

The `{file}` placeholder is replaced with the downloaded voice file's absolute path. The STT command's stdout is the transcript.

Or use the Telegram Settings UI: `/telegram-settings` → 🎙️ Echo → 📋 Preset.

## License

MIT
