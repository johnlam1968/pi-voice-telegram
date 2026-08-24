/**
 * section.ts — the Telegram Extension Section for /telegram-settings.
 *
 * The `pi-telegram-stt` package owns exactly one section (this one),
 * so the section file is named `section.ts` and the section's `id`
 * is the package name verbatim (per `@llblab/pi-telegram/docs/
 * sections.md` §3). The default-export factory is the canonical
 * lifecycle shape (§4) — the actual `registerTelegramSection` call
 * is deferred to `session_start` because the bridge's section
 * registry isn't populated at jiti-load time (the v0.2.0 plan's
 * "Module-load safety" section).
 *
 * Full design + upstream pattern compliance lives in
 * `docs/STT-PACKAGE.md`. The runtime-event category
 * `"pi-telegram-stt/echo"` (in `echo-handler.ts:219`) is a
 * separate namespace and is unchanged from the pre-v0.2.1
 * "sub-path id" era.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	TelegramSectionContext,
	TelegramSectionCallbackContext,
} from "@llblab/pi-telegram/sections";
import { registerTelegramSection } from "@llblab/pi-telegram/sections";

import { listSttProviders } from "./stt-provider.js";
import {
	loadEchoConfig,
	saveEchoConfig,
	type EchoConfig,
} from "./telegram-config.js";

/** Compose the dynamic menu label from the current config.
 *  Exported for the smoke test. The prefix is "STT" (matching the
 *  package name); the "echo" feature is a sub-knob inside the
 *  STT section, not the section's own label. */
export function echoSectionLabel(cfg: EchoConfig): string {
	return `${cfg.showTranscript ? "🟢" : "⚫️"} STT · ${cfg.stt_provider}`;
}

function renderSettingsText(cfg: EchoConfig): string {
	const providers = listSttProviders();
	const providerLines = providers.length === 0
		? "<i>(no providers installed — install e.g. pi-openai-stt and reload)</i>"
		: providers
				.map((p) =>
					`<code>${p.id}</code> — ${p.label}${p.id === cfg.stt_provider ? " ✓" : ""}`,
				)
				.join("\n");

	return [
		"<b>🎙️ STT settings</b>",
		"",
		`Show transcript: <b>${cfg.showTranscript ? "🟢 on" : "⚫️ off"}</b>`,
		`STT provider: <code>${cfg.stt_provider}</code>`,
		"",
		"<b>Installed STT providers:</b>",
		providerLines,
		"",
		"<i>Add a new provider by installing its package and reloading the agent. Set <code>OPENAI_STT_BASE_URL</code> for OpenAI-compatible backends.</i>",
	].join("\n");
}

function renderSettingsKeyboard(
	ctx: TelegramSectionContext,
	cfg: EchoConfig,
): Array<Array<{ text: string; callback_data: string }>> {
	const rows: Array<Array<{ text: string; callback_data: string }>> = [
		[
			{
				text: cfg.showTranscript ? "Turn echo OFF" : "Turn echo ON",
				callback_data: ctx.callbackData("toggle-echo"),
			},
		],
	];
	for (const p of listSttProviders()) {
		rows.push([
			{
				text: `${p.id === cfg.stt_provider ? "✓ " : ""}${p.label}`,
				callback_data: ctx.callbackData("select-provider", p.id),
			},
		]);
	}
	return rows;
}

function registerSttSection(): () => void {
	return registerTelegramSection({
		id: "pi-telegram-stt",
		label: "🎙️ STT",
		order: 10,
		getLabel: () => echoSectionLabel(loadEchoConfig()),
		// Main render: 1-button ⚙️ Settings picker. No manual
		// Back row — the bridge auto-prepends it (§8).
		render: async () => {
			const cfg = loadEchoConfig();
			return {
				text: `<b>🎙️ STT</b>\n\n${
					cfg.showTranscript
						? "Status: 🟢 on — voice/audio messages get a 🎙️ reply with the STT transcript."
						: "Status: ⚫️ off — voice/audio messages are not echoed (transcript still reaches the agent)."
				}\n\nEdit settings in /telegram-settings → 🎙️ STT.`,
				parseMode: "html",
				replyMarkup: {
					inline_keyboard: [
						[{ text: "⚙️ Settings", callback_data: "menu:settings" }],
					],
				},
			};
		},
		// Section-root callbacks pass through to the settings
		// handler (§7 routing fallback chain).
		handleCallback: async () => "pass",
		settings: {
			label: "🎙️ STT settings",
			order: 10,
			getLabel: () => echoSectionLabel(loadEchoConfig()),
			open: async (ctx: TelegramSectionContext) => {
				const cfg = loadEchoConfig();
				return {
					text: renderSettingsText(cfg),
					parseMode: "html",
					replyMarkup: { inline_keyboard: renderSettingsKeyboard(ctx, cfg) },
				};
			},
			handleCallback: async (ctx: TelegramSectionCallbackContext) => {
				if (ctx.action === "toggle-echo") {
					const updated = loadEchoConfig();
					updated.showTranscript = !updated.showTranscript;
					saveEchoConfig(updated);
					await ctx.answerCallback(
						`Echo is now ${updated.showTranscript ? "ON" : "OFF"}.`,
					);
					// `ctx.edit()` re-renders the settings card so
					// the toggle button label + dynamic getLabel
					// reflect the new state without nav round-trip.
					const refreshed = loadEchoConfig();
					await ctx.edit({
						text: renderSettingsText(refreshed),
						parseMode: "html",
						replyMarkup: {
							inline_keyboard: renderSettingsKeyboard(ctx, refreshed),
						},
					});
					return "handled";
				}
				if (ctx.action === "select-provider" && ctx.payload) {
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
					const refreshed = loadEchoConfig();
					await ctx.edit({
						text: renderSettingsText(refreshed),
						parseMode: "html",
						replyMarkup: {
							inline_keyboard: renderSettingsKeyboard(ctx, refreshed),
						},
					});
					return "handled";
				}
				return "pass";
			},
		},
	});
}

/** Default-export factory (§4). The `registerTelegramSection` call
 *  is deferred to `session_start` (the bridge's section registry
 *  is only populated after the bridge has initialized; calling
 *  `registerTelegramSection` at jiti-load time throws
 *  "Telegram section registry not available"). */
export default function piTelegramSttSection(pi: ExtensionAPI): void {
	let unregister: (() => void) | null = null;
	pi.on("session_start", () => {
		unregister = registerSttSection();
	});
	pi.on("session_shutdown", () => {
		if (unregister) {
			unregister();
			unregister = null;
		}
	});
}
