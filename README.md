# pi-voice-telegram

Two sister extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) + [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) bridge:

- **`extensions/pi-telegram-stt/`** — STT orchestrator. Bundles the OpenAI-compatible STT provider. Installed as [`pi-telegram-stt`](https://www.npmjs.com/package/pi-telegram-stt).
- **`extensions/pi-telegram-tts/`** — TTS synthesis provider. Direct `fetch` to MiniMax or OpenAI; hardcoded `MINIMAX_BODY` / `OPENAI_BODY` constants. Installed as [`pi-telegram-tts`](https://www.npmjs.com/package/pi-telegram-tts).

## Install

```bash
pi install npm:pi-telegram-stt
pi install npm:pi-telegram-tts
```

Configure via `telegram.json#extensions["pi-telegram-stt"]` and `telegram.json#extensions["pi-telegram-tts"]` (the 200ms hot-reload watcher picks up edits; no agent restart needed).

## Release

Tagged releases (`v0.X.Y`) trigger the OIDC publish workflow in `.github/workflows/publish.yml`, which publishes both packages to npm.

## License

MIT. See each package's `package.json` for the per-package license declaration.
