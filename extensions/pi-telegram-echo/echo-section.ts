/**
 * echo-section.ts — the Telegram Extension Section for /telegram-settings.
 *
 * Two surfaces:
 *
 *   1. Main-menu row: "🎙️ Echo" with a status dot (🟢 on / ⚫️ off).
 *      Clicking the row opens the section. We don't do anything on the
 *      main-menu `render` except show the status; the section appears
 *      in Settings automatically because we declare a `settings` block.
 *
 *   2. Settings submenu:
 *      - Toggle "Echo on/off" — direct UI (the boolean primitive).
 *      - Three presets for the STT command: "Use whisper-server" (curl
 *        to /inference), "Use local script" (custom shell), "Clear
 *        STT command" (back to empty). Direct UI (pick from a list).
 *      - Free-text editing of the command is NOT in the section UI
 *        (Telegram's inline keyboards don't do free-text input). The
 *        operator can edit `telegram.json` directly, or the agent can
 *        edit it via the future `pi-telegram-settings` package.
 *
 * Persistence: the section reads from `loadEchoConfig()` on every
 * `settings.open()` and writes via `saveEchoConfig()`. The hot-reload
 * in `index.ts` picks up the change on the next `reconfigure()`.
 */

import { registerTelegramSection } from "@llblab/pi-telegram/sections";
import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import {
	loadEchoConfig,
	saveEchoConfig,
	STT_PRESETS,
	type EchoConfig,
} from "./telegram-config.js";

export function registerEchoSection(initial: EchoConfig): () => void {
	return registerTelegramSection({
		id: "pi-telegram-echo/echo",
		label: "🎙️ Echo",
		order: 10,
		getLabel: () => (initial.echoEnabled ? "🟢 Echo" : "⚫️ Echo"),

		// Main-menu render: a small one-liner + a "Settings" link. The
		// Settings submenu is reached via the "⚙️ Settings" row in
		// /telegram-settings, so this is mostly cosmetic.
		render: async () => ({
			text: `<b>🎙️ Echo</b>\n\n${
				initial.echoEnabled
					? "Status: 🟢 on — voice/audio messages get a 🎙️ reply with the STT transcript."
					: "Status: ⚫️ off — voice/audio messages are not echoed."
			}\n\nEdit settings in /telegram-settings → 🎙️ Echo.`,
			parseMode: "html",
			replyMarkup: {
				inline_keyboard: [
					[
						{
							text: "⚙️ Settings",
							// "menu:settings" is a bridge-canonical callback
							// that opens the Settings submenu; not part
							// of the section surface itself.
							callback_data: "menu:settings",
						},
					],
				],
			},
		}),
		handleCallback: async () => "pass",

		settings: {
			label: "🎙️ Echo settings",
			order: 10,
			getLabel: () => (initial.echoEnabled ? "🟢 Echo" : "⚫️ Echo"),

			open: async () => ({
				text: renderSettingsText(loadEchoConfig()),
				parseMode: "html",
				replyMarkup: {
					inline_keyboard: renderSettingsKeyboard(loadEchoConfig()),
				},
			}),

			handleCallback: async (ctx) => {
				const action = ctx.action;
				const payload = ctx.payload;

				// Toggle the echo on/off.
				if (action === "toggle-echo") {
					const updated = loadEchoConfig();
					updated.echoEnabled = !updated.echoEnabled;
					saveEchoConfig(updated);
					await ctx.answerCallback(
						`Echo is now ${updated.echoEnabled ? "ON" : "OFF"}.`,
					);
					// `ctx.edit` would re-render via the bridge, but
					// the hot-reload in index.ts will also pick up the
					// change on the next ~200ms debounce. Either path
					// is fine; we just acknowledge here.
					return "handled";
				}

				// Preset selection.
				if (action === "preset" && payload) {
					const preset = STT_PRESETS[payload];
					if (!preset) {
						await ctx.answerCallback(`Unknown preset: ${payload}`);
						return "handled";
					}
					const updated = loadEchoConfig();
					updated.stt.command =
						payload === "clear" ? [] : preset.slice();
					saveEchoConfig(updated);
					await ctx.answerCallback(
						payload === "clear"
							? "STT command cleared. The extension is a no-op until the operator configures a command."
							: `STT command set to: ${preset.join(" ")}`,
					);
					return "handled";
				}

				return "pass";
			},
		},
	});
}

function renderSettingsText(cfg: EchoConfig): string {
	const cmd = cfg.stt.command.length === 0
		? "<i>(not configured — the operator must pick a preset or edit telegram.json)</i>"
		: `<code>${escapeHtml(cfg.stt.command.join(" "))}</code>`;

	return [
		"<b>🎙️ Echo settings</b>",
		"",
		`Echo: <b>${cfg.echoEnabled ? "🟢 on" : "⚫️ off"}</b>`,
		`STT command: ${cmd}`,
		"",
		"<i>Free-text editing of the STT command isn't supported in the section UI (Telegram's inline keyboards don't do free-text input). Use a preset, or edit <code>telegram.json</code> directly under <code>extensions['pi-telegram-echo'].stt.command</code>.</i>",
	].join("\n");
}

function renderSettingsKeyboard(
	cfg: EchoConfig,
): Array<Array<{ text: string; callback_data: string }>> {
	return [
		[
			{
				text: cfg.echoEnabled ? "Turn echo OFF" : "Turn echo ON",
				callback_data: "section:0:toggle-echo", // resolved by bridge token; the literal "section:N:..." is for documentation
			},
		],
		[{ text: "📋 Preset: whisper-server", callback_data: "section:0:preset:whisper" }],
		[{ text: "📋 Preset: local script (/usr/local/bin/my-stt.sh {file})", callback_data: "section:0:preset:local-script" }],
		[{ text: "🗑 Clear STT command", callback_data: "section:0:preset:clear" }],
	];
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
