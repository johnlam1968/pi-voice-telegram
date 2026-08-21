/**
 * tts-section.ts — the Telegram Extension Section for /telegram-settings.
 *
 * Registered ONCE per session via `index.ts::registerSectionOnce`.
 * The section's `getLabel` / `render` / `settings.open` all read
 * the current config live (via `loadTtsOrchestratorConfig` +
 * `loadTtsProviderConfig`), so the section reflects the current
 * state without re-registration. Re-registering would mint a new
 * token and stale the in-Telegram menu buttons (same constraint
 * as `pi-telegram-echo/echo-section.ts`).
 *
 * The section exposes three operator-facing knobs (Phase 1):
 *   1. `tts_provider` — switch between installed TTS providers.
 *   2. `voice` — pick from the active provider's `listVoices()`.
 *   3. (Phase 2) `model`, `region`, `instructions`, etc.
 *
 * Flow (Telegram callback routing):
 *
 *   /telegram-settings → 🎙️ TTS (main view)
 *     → tap "⚙️ Settings" → provider picker
 *       → tap a provider → voice picker (re-rendered in place)
 *         → tap a voice → settings menu (voice marked ✓)
 *           → tap a provider → ... (repeat)
 *
 * The voice picker calls `listVoices()` on the active provider
 * (lazy — only on `open`, not on every render) to avoid hitting
 * the MiniMax upstream on every callback. Static OpenAI voices
 * are returned from a constant in the provider, so the call is
 * free.
 *
 * Per upstream `voice.md`:
 *   - Reply mode (`voice.replyMode` in `telegram.json`) is owned
 *     by the bridge's built-in Settings menu, not duplicated here.
 *   - Provider-specific knobs (voice, language, speech style,
 *     etc.) ARE the extension's surface.
 *   - The section reads its own config (no shared state) and
 *     persists to `telegram.json` atomically.
 */

import type { TelegramSectionContext } from "@llblab/pi-telegram/sections";
import { registerTelegramSection } from "@llblab/pi-telegram/sections";
import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import { getTtsProvider, listTtsProviders, type TtsVoice } from "./tts-provider.js";
import {
	loadTtsOrchestratorConfig,
	loadTtsProviderConfig,
	saveTtsOrchestratorConfig,
	saveTtsProviderField,
} from "./tts-config.js";

/** One-liner trace helper. Every button press in the section UI
 *  records a runtime event under the "pi-telegram-tts-minimax/section"
 *  category with the action + payload + the post-state. The events
 *  are visible in /telegram-status --debug and in the bridge log
 *  (logs.jsonl), so the operator can trace which button was
 *  pressed and what changed. Keeps the section's existing
 *  "pi-telegram-tts-minimax/tts" runtime events (synthesis
 *  errors) separate from UI events ("pi-telegram-tts-minimax/section")
 *  so they're easy to filter. */
function trace(
	action: string,
	payload: string | undefined,
	post: { tts_provider: string; voice?: string; model?: string },
): void {
	try {
		recordTelegramRuntimeEvent(
			"pi-telegram-tts-minimax/section",
			new Error(`section.${action}`), // error slot holds the "what"
			{ action, payload: payload ?? null, ...post },
		);
	} catch {
		// Don't let a tracing failure break the section.
	}
}

/** Section id (must be stable; re-registration under the same id
 *  updates the in-Telegram menu without minting a new token). */
const SECTION_ID = "pi-telegram-tts-minimax/tts";

/** Inline-keyboard cap from Telegram. Each button row ≤ 8 bytes of
 *  callback_data, total callback_data ≤ 64 bytes. Voice ids like
 *  `Cantonese_ProfessionalHost（M）` are 28 chars — leaves ~30
 *  bytes for the section token + the `action|payload` prefix
 *  encoded by `ctx.callbackData()`. The bridge handles the token
 *  prefix; we only encode `action|payload`. Voice ids fit. */
const VOICES_PER_PAGE = 6;

/** Section callbacks:
 *   - `select-provider|<provider-id>` — switch the active provider
 *   - `select-voice|<voice-id>` — set the voice on the active provider
 *   - `pick-voice` — re-render the voice picker for the current provider
 *   - `back` — re-render the settings menu (provider picker)
 *   - `noop` — visible button without action (used as a separator row) */
type CallbackAction =
	| "select-provider"
	| "select-voice"
	| "pick-voice"
	| "back"
	| "noop";

/** Register the TTS section. Returns a disposer for cleanup
 *  (used on `session_shutdown` to keep the section lifecycle
 *  tidy). */
export function registerTtsSection(): () => void {
	return registerTelegramSection({
		id: SECTION_ID,
		label: "🎙️ TTS",
		order: 20,
		getLabel: () => {
			const cfg = loadTtsOrchestratorConfig();
			const prov = loadTtsProviderConfig(cfg.tts_provider);
			const voiceShort = shortenVoice(prov.voice);
			return `🎙️ TTS · ${voiceShort}`;
		},

		render: async () => {
			const cfg = loadTtsOrchestratorConfig();
			const prov = loadTtsProviderConfig(cfg.tts_provider);
			return {
				text: renderMainText(cfg, prov),
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
			label: "🎙️ TTS settings",
			order: 20,
			getLabel: () => {
				const cfg = loadTtsOrchestratorConfig();
				const prov = loadTtsProviderConfig(cfg.tts_provider);
				return `🎙️ TTS · ${shortenVoice(prov.voice)}`;
			},

			open: async (ctx: TelegramSectionContext) => {
				const cfg = loadTtsOrchestratorConfig();
				const prov = loadTtsProviderConfig(cfg.tts_provider);
				return {
					text: renderSettingsText(cfg, prov),
					parseMode: "html",
					replyMarkup: {
						inline_keyboard: renderProviderKeyboard(ctx, cfg),
					},
				};
			},

			handleCallback: async (ctx) => {
				const action = ctx.action as CallbackAction;

				if (action === "select-provider" && ctx.payload) {
					return await handleSelectProvider(ctx, ctx.payload);
				}
				if (action === "select-voice" && ctx.payload) {
					return await handleSelectVoice(ctx, ctx.payload);
				}
				if (action === "pick-voice") {
					return await handlePickVoice(ctx);
				}
				if (action === "back") {
					return await handleBack(ctx);
				}
				// "noop" rows are decorative; just answer the toast.
				if (action === "noop") {
					await ctx.answerCallback();
					return "handled";
				}
				return "pass";
			},
		},
	});
}

// ---- render helpers --------------------------------------------------------

function shortenVoice(voice: string | undefined): string {
	if (!voice) return "(default)";
	return voice.length > 24 ? voice.slice(0, 22) + "…" : voice;
}

function renderMainText(
	cfg: { tts_provider: string },
	prov: { voice?: string; model?: string },
): string {
	return [
		"<b>🎙️ TTS</b>",
		"",
		`Provider: <code>${cfg.tts_provider}</code>`,
		`Voice: <code>${prov.voice ?? "(default)"}</code>`,
		`Model: <code>${prov.model ?? "(default)"}</code>`,
		"",
		"Edit voice, model, or provider in /telegram-settings → 🎙️ TTS.",
	].join("\n");
}

function renderSettingsText(
	cfg: { tts_provider: string },
	prov: { voice?: string; model?: string },
): string {
	const providers = listTtsProviders();
	const providerLines = providers.length === 0
		? "<i>(no providers installed — install e.g. pi-openai-tts and reload)</i>"
		: providers
				.map((p) =>
					`<code>${p.id}</code> — ${p.label}${p.id === cfg.tts_provider ? " ✓" : ""}`,
				)
				.join("\n");

	return [
		"<b>🎙️ TTS settings</b>",
		"",
		`Provider: <code>${cfg.tts_provider}</code>`,
		`Voice: <code>${prov.voice ?? "(default)"}</code>`,
		`Model: <code>${prov.model ?? "(default)"}</code>`,
		"",
		"<b>Installed TTS providers:</b>",
		providerLines,
		"",
		"Tap a provider to switch, then pick a voice. Back returns here.",
	].join("\n");
}

/** First view: provider picker. After picking, the next callback
 *  re-renders with the voice picker. */
function renderProviderKeyboard(
	ctx: TelegramSectionContext,
	_cfg: { tts_provider: string },
): Array<Array<{ text: string; callback_data: string }>> {
	const providers = listTtsProviders();
	const rows: Array<Array<{ text: string; callback_data: string }>> = [];
	if (providers.length > 0) {
		rows.push([{ text: "──── providers ────", callback_data: "noop" }]);
		for (const p of providers) {
			rows.push([
				{
					text: `${p.id === ctx.tts_provider ? "✓ " : ""}${p.label}`,
					callback_data: ctx.callbackData("select-provider", p.id),
				},
			]);
		}
		rows.push([
			{
				text: "🎙 Pick voice for current provider",
				callback_data: ctx.callbackData("pick-voice"),
			},
		]);
	}
	return rows;
}

// ---- callback handlers -----------------------------------------------------

async function handleSelectProvider(
	ctx: TelegramSectionContext,
	providerId: string,
): Promise<"handled" | "pass"> {
	const providers = listTtsProviders();
	if (!providers.find((p) => p.id === providerId)) {
		await ctx.answerCallback(`Provider "${providerId}" is not installed.`);
		trace("select-provider", providerId, {
			tts_provider: loadTtsOrchestratorConfig().tts_provider,
		});
		return "handled";
	}
	// Update orchestrator config. The hot-reload watcher in
	// `./index.ts` picks this up within 200ms and re-registers the
	// bridge's TTS provider with the new `tts_provider`.
	saveTtsOrchestratorConfig({ tts_provider: providerId });
	trace("select-provider", providerId, { tts_provider: providerId });
	await ctx.answerCallback(`Switched to ${providerId}`);

	// Re-render with the voice picker for the new provider so the
	// operator can pick a voice immediately. The new provider's
	// default voice may not exist on this account (e.g. MiniMax
	// §2b-bis).
	const provCfg = loadTtsProviderConfig(providerId);
	const provider = getTtsProvider(providerId);
	if (!provider?.listVoices) {
		await ctx.edit({
			text: `Switched to <code>${providerId}</code>. This provider has no <code>listVoices()</code>; edit <code>telegram.json</code> directly.`,
			parseMode: "html",
		});
		return "handled";
	}
	const voices = await safeListVoices(provider.listVoices.bind(provider));
	await ctx.edit({
		text: renderVoiceText(providerId, provCfg, voices),
		parseMode: "html",
		replyMarkup: {
			inline_keyboard: renderVoiceKeyboard(ctx, providerId, voices, provCfg.voice),
		},
	});
	return "handled";
}

async function handleSelectVoice(
	ctx: TelegramSectionContext,
	voiceId: string,
): Promise<"handled" | "pass"> {
	const cfg = loadTtsOrchestratorConfig();
	const provider = getTtsProvider(cfg.tts_provider);
	if (!provider?.listVoices) {
		await ctx.answerCallback("Active provider has no voice picker.");
		trace("select-voice", voiceId, {
			tts_provider: cfg.tts_provider,
			voice: loadTtsProviderConfig(cfg.tts_provider).voice,
		});
		return "handled";
	}
	// Validate against the provider's voice list (byte-exact for
	// MiniMax — protects against the §2a parens byte-trap).
	const voices = await safeListVoices(provider.listVoices.bind(provider));
	if (!voices.find((v) => v.id === voiceId)) {
		await ctx.answerCallback(
			`"${voiceId}" is not a valid voice for ${cfg.tts_provider}.`,
		);
		trace("select-voice", voiceId, {
			tts_provider: cfg.tts_provider,
			voice: loadTtsProviderConfig(cfg.tts_provider).voice,
		});
		return "handled";
	}
	// Persist. The provider reads its config on every call, so
	// this takes effect on the next voice reply.
	saveTtsProviderField(cfg.tts_provider, "voice", voiceId);
	const newProv = loadTtsProviderConfig(cfg.tts_provider);
	trace("select-voice", voiceId, {
		tts_provider: cfg.tts_provider,
		voice: newProv.voice,
	});
	await ctx.answerCallback(`Voice: ${voiceId}`);
	// Re-render the settings menu (provider picker) with the
	// new voice marked.
	const newCfg = loadTtsOrchestratorConfig();
	const newProv = loadTtsProviderConfig(cfg.tts_provider);
	await ctx.edit({
		text: renderSettingsText(newCfg, newProv),
		parseMode: "html",
		replyMarkup: {
			inline_keyboard: renderProviderKeyboard(ctx, newCfg),
		},
	});
	return "handled";
}

async function handlePickVoice(
	ctx: TelegramSectionContext,
): Promise<"handled" | "pass"> {
	const cfg = loadTtsOrchestratorConfig();
	const provider = getTtsProvider(cfg.tts_provider);
	if (!provider?.listVoices) {
		await ctx.answerCallback("Active provider has no voice picker.");
		return "handled";
	}
	const provCfg = loadTtsProviderConfig(cfg.tts_provider);
	const voices = await safeListVoices(provider.listVoices.bind(provider));
	await ctx.edit({
		text: renderVoiceText(cfg.tts_provider, provCfg, voices),
		parseMode: "html",
		replyMarkup: {
			inline_keyboard: renderVoiceKeyboard(
				ctx,
				cfg.tts_provider,
				voices,
				provCfg.voice,
			),
		},
	});
	return "handled";
}

async function handleBack(
	ctx: TelegramSectionContext,
): Promise<"handled" | "pass"> {
	const cfg = loadTtsOrchestratorConfig();
	const prov = loadTtsProviderConfig(cfg.tts_provider);
	await ctx.edit({
		text: renderSettingsText(cfg, prov),
		parseMode: "html",
		replyMarkup: {
			inline_keyboard: renderProviderKeyboard(ctx, cfg),
		},
	});
	return "handled";
}

// ---- voice picker --------------------------------------------------------

function renderVoiceText(
	providerId: string,
	prov: { voice?: string },
	voices: readonly TtsVoice[],
): string {
	const lines: string[] = [
		`<b>🎙️ ${providerId} — pick a voice</b>`,
		"",
		`Current: <code>${prov.voice ?? "(default)"}</code>`,
		`Available: ${voices.length} voice(s)`,
		"",
	];
	// Group by language. Cantonese first, then English / Mandarin,
	// then alphabetical. Capped at VOICES_PER_PAGE total button
	// rows; the inline-keyboard has 8-byte callback_data rows
	// and a 64-byte cap.
	const byLang = new Map<string, TtsVoice[]>();
	for (const v of voices) {
		const lang = v.language ?? "?";
		if (!byLang.has(lang)) byLang.set(lang, []);
		byLang.get(lang)!.push(v);
	}
	const langs = [...byLang.keys()].sort((a, b) => {
		const order = (l: string) =>
			l === "Cantonese" ? 0 : l === "English" ? 1 : l === "Mandarin" ? 2 : 3;
		return order(a) - order(b) || a.localeCompare(b);
	});
	let rowsRemaining = VOICES_PER_PAGE - 1; // one row for the Back button
	for (const lang of langs) {
		if (rowsRemaining <= 0) break;
		const langVoices = byLang.get(lang)!;
		// Header row.
		lines.push(`<b>${lang} (${langVoices.length})</b>`);
		rowsRemaining -= 1;
		if (rowsRemaining <= 0) break;
		for (const v of langVoices) {
			if (rowsRemaining <= 0) break;
			const mark = v.id === prov.voice ? " ✓" : "";
			lines.push(`  · <code>${v.id}</code>${v.name ? ` — ${v.name}` : ""}${mark}`);
			rowsRemaining -= 1;
		}
		lines.push("");
	}
	if (voices.length > VOICES_PER_PAGE) {
		lines.push(
			`<i>Showing the first ${VOICES_PER_PAGE} rows. Use the CLI tool to see all: <code>node --experimental-strip-types scripts/list-tts-voices.ts --provider ${providerId}</code></i>`,
		);
	}
	return lines.join("\n");
}

function renderVoiceKeyboard(
	ctx: TelegramSectionContext,
	providerId: string,
	voices: readonly TtsVoice[],
	currentVoice: string | undefined,
): Array<Array<{ text: string; callback_data: string }>> {
	const rows: Array<Array<{ text: string; callback_data: string }>> = [];
	const langs = [...new Set(voices.map((v) => v.language ?? "?"))].sort(
		(a, b) => {
			const order = (l: string) =>
				l === "Cantonese"
					? 0
					: l === "English"
						? 1
						: l === "Mandarin"
							? 2
							: 3;
			return order(a) - order(b) || a.localeCompare(b);
		},
	);
	const sorted = voices
		.slice()
		.sort(
			(a, b) =>
				(a.language ?? "?").localeCompare(b.language ?? "?") ||
				a.id.localeCompare(b.id),
		);
	let budget = VOICES_PER_PAGE - 1; // -1 for the Back button
	for (const lang of langs) {
		if (budget <= 0) break;
		const langVoices = sorted.filter((v) => (v.language ?? "?") === lang);
		if (langVoices.length === 0) continue;
		rows.push([
			{
				text: `──── ${lang} (${langVoices.length}) ────`,
				callback_data: "noop",
			},
		]);
		budget -= 1;
		for (const v of langVoices) {
			if (budget <= 0) break;
			const label = `${v.id === currentVoice ? "✓ " : ""}${v.name ? v.name.slice(0, 18) : v.id.slice(0, 18)}`;
			rows.push([
				{
					text: label,
					callback_data: ctx.callbackData("select-voice", v.id),
				},
			]);
			budget -= 1;
		}
	}
	// Back button to the settings menu.
	rows.push([
		{
			text: "↩ Back to settings",
			callback_data: ctx.callbackData("back"),
		},
	]);
	return rows;
}

// Light wrapper: `listVoices()` is optional; if a provider
// throws or doesn't implement it, return an empty list (the
// section UI degrades gracefully).
async function safeListVoices(
	fn: () => Promise<readonly TtsVoice[]>,
): Promise<readonly TtsVoice[]> {
	try {
		return await fn();
	} catch {
		return [];
	}
}
