# pi-telegram-tts-minimax (STUB)

TTS synthesis provider for the Pi coding agent + [@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge. MiniMax T2A → ffmpeg libopus → OGG/Opus.

**Status:** scaffolded only. Full implementation deferred to a subsequent session — the current plan is to port the relevant code from the existing `pi-voice-telegram` (`synthesis-provider.ts`, `voice-reply.ts`, `mm-tts.ts`) into this package, and add a settings section in `/telegram-settings`.

## What goes here (next session)

- `registerTelegramVoiceSynthesisProvider` with a stable id (`pi-telegram-tts-minimax/tts`)
- Settings: voice, lang, model, verify, timeoutMs
- Section: 🎙️ TTS (mirror) with 4 setting groups (TTS controls)
- `getVoicePromptContribution` for voice-tagged turns (spoken-style prompt nudge)
- Schema-validated writes via the `extensions["pi-telegram-tts-minimax"]` key in `telegram.json`

## License

MIT
