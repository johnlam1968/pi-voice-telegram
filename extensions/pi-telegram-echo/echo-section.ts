/**
 * echo-section.ts — the Telegram Extension Section for /telegram-settings.
 *
 * Registered ONCE per session via `index.ts::registerSectionOnce`.
 * The section's `getLabel` / `render` / `settings.open` all read
 * `loadEchoConfig()` live, so the section reflects the current
 * state without re-registration. Re-registering would mint a new
 * token and stale the in-Telegram menu buttons — see PLAN.md
 * §v0.2.1 for the regression we hit when the section was
 * re-registered on every `telegram.json` write.
 *
 * The bridge prepends a "⬆️ Main menu" back row to the rendered
 * view, so the operator can navigate back without us wiring one.
 */

import type { TelegramSectionContext } from "@llblab/pi-telegram/sections";
import { registerTelegramSection } from "@llblab/pi-telegram/sections";

import {
	loadEchoConfig,
	saveEchoConfig,
} from "./telegram-config.js";

export function registerEchoSection(): () => void {
	return registerTelegramSection({
		id: "pi-telegram-echo/echo",
		label: "🎙️ Echo",
		order: 10,
		getLabel: () => (loadEchoConfig().echoEnabled ? "🟢 Echo" : "⚫️ Echo"),

		render: async () => {
			const cfg = loadEchoConfig();
			return {
				text: `<b>🎙️ Echo</b>\n\n${
					cfg.echoEnabled
						? "Status: 🟢 on — voice/audio messages get a 🎙️ reply with the STT transcript."
						: "Status: ⚫️ off — voice/audio messages are not echoed (transcript still reaches the agent)."
				}\n\nEdit settings in /telegram-settings → 🎙️ Echo.`,
				parseMode: "html",
				replyMarkup: {
					inline_keyboard: [
						[
							{
								text: "⚙️ Settings",
								callback_data: "menu:settings",
							},
						],
					],
				},
			};
		},
		handleCallback: async () => "pass",

		settings: {
			label: "🎙️ Echo settings",
			order: 10,
			getLabel: () => (loadEchoConfig().echoEnabled ? "🟢 Echo" : "⚫️ Echo"),

			open: async (ctx: TelegramSectionContext) => {
				const cfg = loadEchoConfig();
				return {
					text: renderSettingsText(cfg),
					parseMode: "html",
					replyMarkup: {
						inline_keyboard: renderSettingsKeyboard(ctx, cfg),
					},
				};
			},

			handleCallback: async (ctx) => {
				if (ctx.action === "toggle-echo") {
					const updated = loadEchoConfig();
					updated.echoEnabled = !updated.echoEnabled;
					saveEchoConfig(updated);
					await ctx.answerCallback(
						`Echo is now ${updated.echoEnabled ? "ON" : "OFF"}.`,
					);
					// The section itself is not re-registered; the
					// provider closure is re-created by the index.ts
					// hot-reload (200ms debounce), so the new
					// `echoEnabled` takes effect on the next
					// inbound voice message.
					return "handled";
				}
				return "pass";
			},
		},
	});
}

function renderSettingsText(cfg: { echoEnabled: boolean }): string {
	return [
		"<b>🎙️ Echo settings</b>",
		"",
		`Echo: <b>${cfg.echoEnabled ? "🟢 on" : "⚫️ off"}</b>`,
		"",
		"<i>STT is hardcoded to whisper-server (POST to <code>WHISPER_SERVER_URL</code>+<code>/inference</code>; default <code>http://127.0.0.1:8080</code>). Tune via the <code>WHISPER_SERVER_URL</code> and <code>PI_TELEGRAM_LANG</code> env vars; restart the agent to pick up changes.</i>",
	].join("\n");
}

/** `ctx.callbackData(action)` builds the real `section:<token>:<action>`
 *  callback_data. We MUST use this helper — a hardcoded placeholder
 *  would not match the real token, and the click would fall through
 *  to the bridge's "no such section" error. */
function renderSettingsKeyboard(
	ctx: TelegramSectionContext,
	cfg: { echoEnabled: boolean },
): Array<Array<{ text: string; callback_data: string }>> {
	return [
		[
			{
				text: cfg.echoEnabled ? "Turn echo OFF" : "Turn echo ON",
				callback_data: ctx.callbackData("toggle-echo"),
			},
		],
	];
}
