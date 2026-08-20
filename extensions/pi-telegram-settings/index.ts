/**
 * pi-telegram-settings — STUB.
 *
 * TODO (next session): port the LLM-callable tools from
 * `pi-voice-telegram/tools.ts` (`pi_voice_telegram_config_read`,
 * `_write`, `_reset`, `_schema`, `_list_voices`) and make them GENERAL —
 * not voice-specific. They should be able to read/write any
 * `telegram.json` key, not just `extensions["pi-telegram-..."]`.
 *
 * The user explicitly said: "I want the agent to be able to change
 * settings, even including pi-telegram's other settings." So the
 * tools here are the general settings-management surface, not a
 * voice-specific one.
 *
 * Tool surface (planned):
 *   - `pi_telegram_settings_read(key)` — read any telegram.json key
 *     (dotted path: `voice.replyMode`, `extensions.pi-telegram-echo.echoEnabled`)
 *   - `pi_telegram_settings_write(key, value)` — atomic write with
 *     schema-light validation (don't write unknown top-level keys)
 *   - `pi_telegram_settings_reset(key)` — restore a key to its default
 *     (per the bridge's own defaults for bridge-owned keys; per the
 *     extension's defaults for extension-owned keys)
 *
 * Gated on a master switch (per-extension, e.g. via
 * `extensions["pi-telegram-settings"].exposed = true`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piTelegramSettings(pi: ExtensionAPI): void {
	// TODO: implement
	void pi;
}
