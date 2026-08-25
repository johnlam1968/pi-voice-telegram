# pi-voice-telegram

Two companion extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) + [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) bridge.

## Why these extensions

The upstream `@llblab/pi-telegram` bridge provides the basic voice pipeline: transcribe inbound voice messages for the agent, and deliver the agent's voice replies back to the user. It doesn't ship with the user-facing features that make the pipeline feel like a real conversation — so this repo provides two companion extensions that fill those gaps:

- **STT transcript echo** — when the user sends a voice note, the bridge transcribes it for the agent, but the user has no confirmation that their voice was understood. The STT extension adds a 🎙️ echo reply showing the user what was transcribed.
- **Text-before-voice composition** — when the agent replies with a voice message, the user has to wait for the TTS synthesis to complete before seeing anything. The TTS extension adds the option to send the agent's text reply first, then the voice follows when the synthesis finishes.

These extensions don't replace any upstream functionality. They augment the existing voice pipeline with the user-facing features the bridge leaves to the operator.

## The two extensions

### [`pi-telegram-stt`](extensions/pi-telegram-stt/) — voice transcript echo

The bridge transcribes inbound voice and audio messages for the agent. This extension adds a 🎙️ echo reply to the user showing the transcript, so they get instant feedback that their voice was understood. The transcript is also fed into the agent's prompt (the upstream behavior); the echo is the addition.

The bundled STT provider talks to any OpenAI-compatible `/v1/audio/transcriptions` gateway (OpenAI, a local `whisper-server`, `faster-whisper-server`, `whisper-asr-webservice`, etc.) with a fallback chain. Future backends can be added by implementing the `SttProvider` interface.

### [`pi-telegram-tts`](extensions/pi-telegram-tts/) — text-before-voice composition

When the agent replies with a voice message, the user has to wait for the TTS synthesis to complete before seeing anything — for longer replies this delay is noticeable. This extension adds the option to send the agent's text reply to Telegram first, then the voice follows when the synthesis finishes. The user sees the text immediately and hears the voice a moment later (same content, no perceptible delay).

The provider does a direct `fetch` to MiniMax's T2A API or OpenAI's `/v1/audio/speech` endpoint. Voice / speed / style are configurable per-provider via `telegram.json`; the rare fields are hardcoded in `synth.ts` (the agent edits the file to tune).

## Install

```bash
pi install npm:pi-telegram-stt
pi install npm:pi-telegram-tts
```

Configure via `telegram.json#extensions["pi-telegram-stt"]` and `telegram.json#extensions["pi-telegram-tts"]`. Edits are picked up live by the 200ms hot-reload watcher — no agent restart needed.

## Release

Tagged releases (`v*`) trigger the OIDC publish workflow in `.github/workflows/publish.yml`, which publishes both packages to npm.

## License

MIT. See each package's `package.json` for the per-package license declaration.
