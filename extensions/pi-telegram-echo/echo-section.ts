/**
 * echo-section.ts — the Telegram Extension Section for /telegram-settings.
 *
 * Registered ONCE per session via `index.ts::registerSectionOnce`.
 * The section's `getLabel` / `render` / `settings.open` all read
 * `loadEchoConfig()` live, so the section reflects the current
 * state without re-registration. Re-registering would mint a new
 * token and stale the in-Telegram menu buttons.
 *
 * The section exposes two operator-facing knobs:
 *   1. `echoEnabled` — toggle the 🎙️ echo on/off.
 *   2. `stt_provider` — pick from the installed providers
 *      (registered in the in-process registry by the provider
 *      extensions on their own `session_start`).
 */

import type { TelegramSectionContext } from "@llblab/pi-telegram/sections";
import { registerTelegramSection } from "@llblab/pi-telegram/sections";

import { listSttProviders } from "./stt-provider.js";
import {
	loadEchoConfig,
	saveEchoConfig,
} from "./telegram-config.js";

export function registerEchoSection(): () => void {
	return registerTelegramSection({
		id: "pi-telegram-echo/echo",
		label: "🎙️ Echo",
		order: 10,
		getLabel: () => {
			const cfg = loadEchoConfig();
			return `${cfg.echoEnabled ? "🟢" : "⚫️"} Echo · ${cfg.stt_provider}`;
		},

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
			getLabel: () => {
				const cfg = loadEchoConfig();
				return `${cfg.echoEnabled ? "🟢" : "⚫️"} Echo · ${cfg.stt_provider}`;
			},

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
				const action = ctx.action;

				if (action === "toggle-echo") {
					const updated = loadEchoConfig();
					updated.echoEnabled = !updated.echoEnabled;
					saveEchoConfig(updated);
					await ctx.answerCallback(
						`Echo is now ${updated.echoEnabled ? "ON" : "OFF"}.`,
					);
					return "handled";
				}

				// Provider selection: action is "select-provider",
				// payload is the provider id.
				if (action === "select-provider" && ctx.payload) {
					const providers = listSttProviders();
					if (!providers.find((p) => p.id === ctx.payload)) {
						await ctx.answerCallback(
							`Provider "${ctx.payload}" is not installed.`,
						);
						return "handled";
					}
					const updated = loadEchoConfig();
					updated.stt_provider = ctx.payload;
					saveEchoConfig(updated);
					await ctx.answerCallback(
						`STT provider: ${ctx.payload}. Takes effect on the next inbound voice message.`,
					);
					return "handled";
				}

				return "pass";
			},
		},
	});
}

function renderSettingsText(cfg: { echoEnabled: boolean; stt_provider: string }): string {
	const providers = listSttProviders();
	const providerLines = providers.length === 0
		? "<i>(no providers installed — install e.g. pi-whisper-stt and reload)</i>"
		: providers
				.map((p) =>
					`<code>${p.id}</code> — ${p.label}${p.id === cfg.stt_provider ? " ✓" : ""}`,
				)
				.join("\n");

	return [
		"<b>🎙️ Echo settings</b>",
		"",
		`Echo: <b>${cfg.echoEnabled ? "🟢 on" : "⚫️ off"}</b>`,
		`STT provider: <code>${cfg.stt_provider}</code>`,
		"",
		"<b>Installed STT providers:</b>",
		providerLines,
		"",
		"<i>Add a new provider by installing its package and reloading the agent. Set <code>OPENAI_STT_BASE_URL</code> for OpenAI-compatible backends; <code>WHISPER_SERVER_URL</code> for the local whisper-server.</i>",
	].join("\n");
}

/** `ctx.callbackData(action, payload?)` builds the real
 *  `section:<token>:<action>:<payload>` callback_data. We MUST
 *  use this helper — a hardcoded placeholder would not match
 *  the real token. */
function renderSettingsKeyboard(
	ctx: TelegramSectionContext,
	cfg: { echoEnabled: boolean; stt_provider: string },
): Array<Array<{ text: string; callback_data: string }>> {
	const providers = listSttProviders();
	const rows: Array<Array<{ text: string; callback_data: string }>> = [
		[
			{
				text: cfg.echoEnabled ? "Turn echo OFF" : "Turn echo ON",
				callback_data: ctx.callbackData("toggle-echo"),
			},
		],
	];
	for (const p of providers) {
		rows.push([
			{
				text: `${p.id === cfg.stt_provider ? "✓ " : ""}${p.label}`,
				callback_data: ctx.callbackData("select-provider", p.id),
			},
		]);
	}
	return rows;
}
