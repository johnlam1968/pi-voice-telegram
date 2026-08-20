# pi-telegram-settings (STUB)

LLM-callable tools for editing any `telegram.json` key on the Pi coding agent + [@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge. Not voice-specific — covers voice, non-voice, and any extension's settings.

**Status:** scaffolded only. Full implementation deferred to a subsequent session.

## What goes here (next session)

Port the LLM-callable tools from the current `pi-voice-telegram/tools.ts` and make them general:

- `pi_telegram_settings_read(key)` — read any `telegram.json` key (dotted path)
- `pi_telegram_settings_write(key, value)` — atomic write with schema-light validation
- `pi_telegram_settings_reset(key)` — restore a key to its default

The user explicitly said: "I want the agent to be able to change settings, even including pi-telegram's other settings." So this is a general tool surface, not voice-specific. It can be reused by future non-voice extensions.

## License

MIT
