# pi-telegram-tts

Voice synthesis provider for the Pi coding agent + [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) bridge. Adds the text-before-voice composition: when the agent replies with a voice message, this extension can send the agent's text reply to Telegram first, then the voice follows when the synthesis finishes. The user sees the text immediately and hears the voice a moment later (same content, no perceptible delay).

The provider does a direct `fetch` to MiniMax's T2A API or OpenAI's `/v1/audio/speech` endpoint. The 200ms hot-reload watcher picks up `telegram.json` edits; no agent restart needed.

## Install

```bash
pi install npm:pi-telegram-tts
```

Configure via `telegram.json#extensions["pi-telegram-tts"]`. The 200ms hot-reload watcher picks up edits; no agent restart needed.

## Configure

```json
{
  "extensions": {
    "pi-telegram-tts": {
      "disabled": false,
      "provider": "minimax",
      "composeWithText": "auto",
      "voice": "Cantonese_CuteGirl",
      "speed": 0.95,
      "instructions": "Speak in a calm, professional tone"
    }
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `disabled` | boolean | master switch — `true` returns `undefined` and the bridge falls through |
| `provider` | `"minimax"` \| `"openai"` | required for the provider to fire |
| `composeWithText` | `"off"` \| `"auto"` | `"auto"` sends a text message with the same content as the voice, then the voice follows; `"off"` (default) sends voice only |
| `voice` | string | provider-specific voice id (overrides the hardcoded default). MiniMax: `Cantonese_CuteGirl` / `male-qn-qingse` / etc. OpenAI: `alloy` / `shimmer` / etc. |
| `speed` | number | speech rate. OpenAI: 0.25–4.0; MiniMax: 0.5–2.0. |
| `instructions` | string | OpenAI style hint ("Speak in a calm, professional tone"). Silently ignored for MiniMax. |

The hardcoded defaults in `synth.ts:MINIMAX_BODY` (Cantonese_CuteGirl / speed 0.95 / emotion happy / language_boost `Chinese,Yue`) and `synth.ts:OPENAI_BODY` (`gpt-4o-mini-tts` / `alloy` / speed 1.0) carry the rare fields. The agent edits `synth.ts` to tune them.

The `composeWithText: "auto"` text-before-voice composition uses the upstream bridge's `sendTelegramView` with the `instance` delivery scope (the active-turn scope is locked during the voice outbound pipeline; the `instance` scope is the right alternative for single-Telegram-user setups).

## License

MIT
