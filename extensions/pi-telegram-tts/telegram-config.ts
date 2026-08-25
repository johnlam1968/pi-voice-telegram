/**
 * telegram-config.ts — read this extension's key in telegram.json.
 *
 * Persistence: `telegram.json` under `extensions["pi-telegram-tts"]`.
 *
 * v0.1.0 shape: `disabled` + `provider` + `voice` + `model`
 * v0.3.0 shape: + `minimax` / `openai` per-provider sub-blocks
 * v0.4.0 shape: + `composeWithText` ("off" | "auto")
 *
 * If `extensions["pi-telegram-tts"]` is absent, `loadSynthConfig()`
 * returns `DEFAULTS` — which has `provider: undefined`. The provider
 * checks for `provider` in `synthesizeOgg` and returns `undefined`
 * (the bridge falls through to `outboundHandlers[0].template`).
 *
 * **v0.6.0:** the in-package writer (`saveSynthConfig`) and the
 * `loadTelegramConfig` helper (which read the full `telegram.json`
 * for the section's read-only display) were both dropped. The
 * operator or agent edits `telegram.json` directly via filesystem
 * tools; the 200ms hot-reload watcher picks up the change. The
 * in-package readers stay because they're the extension's own
 * config interface at call time — the agent's `read` tool is the
 * surface for operator / agent inspection, not the extension's
 * runtime path.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ProviderId = "minimax" | "openai";

/** v0.3.0 per-provider sub-block. Every key is `unknown` from a
 *  TypeScript perspective — the script is the source of truth for
 *  what each field means. */
export interface ProviderConfig {
	[field: string]: unknown;
}

export interface SynthConfig {
	/** If true, the provider returns `undefined` from `synthesizeOgg`
	 * even when `provider` is configured. Set by the v0.2.0 section UI
	 * toggle. */
	disabled: boolean;
	/** TTS provider id. `undefined` = fall through to template. */
	provider: ProviderId | undefined;
	/** Voice id for the chosen provider. v0.1.0 top-level. v0.3.0
	 * falls back to this when the per-provider sub-block is absent. */
	voice: string | undefined;
	/** Model name for the chosen provider. v0.1.0 top-level. v0.3.0
	 * falls back to this when the per-provider sub-block is absent. */
	model: string | undefined;
	/** v0.3.0 per-provider sub-block. The script is the runtime
	 * validator. */
	minimax: ProviderConfig | undefined;
	/** v0.3.0 per-provider sub-block for OpenAI. */
	openai: ProviderConfig | undefined;
	/**
	 * v0.4.0: text+voice composition. `"off"` (default) sends voice
	 * only. `"auto"` sends a text message with the same content as
	 * the voice, then the voice follows. This is the v0.1.0
	 * `voice.sendTranscript: true` behavior, reimplemented at the
	 * extension level because upstream `@llblab/pi-telegram@0.38.0`
	 * removed the bridge-owned `sendTranscript` config + the
	 * `getTelegramVoiceSendTranscript()` helper + the provider-
	 * returned `transcriptText` field. The text is sent via
	 * `sendTelegramView({ text, parseMode: "html" }, { scope: { kind:
	 * "active-turn" } })` so the user sees text first, then voice.
	 * Best-effort: a `sendTelegramView` failure is logged + recorded
	 * as a runtime event, and the voice is still delivered.
	 */
	composeWithText?: "off" | "auto";
}

export const DEFAULTS: SynthConfig = {
	disabled: false,
	provider: undefined,
	voice: undefined,
	model: undefined,
	minimax: undefined,
	openai: undefined,
	composeWithText: undefined,
};

const KEY = "pi-telegram-tts";

function configPath(): string {
	return join(getAgentDir(), "telegram.json");
}

/** Type-guard for a per-provider sub-block. The script's own
 *  `validateBody()` is the runtime validator. */
function isProviderConfig(value: unknown): value is ProviderConfig {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value)
	);
}

export function loadSynthConfig(): SynthConfig {
	const path = configPath();
	if (!existsSync(path)) return structuredClone(DEFAULTS);
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as {
			extensions?: Record<string, unknown>;
		};
		const block = (parsed.extensions ?? {})[KEY] as
			| Partial<SynthConfig>
			| undefined;
		if (!block) return structuredClone(DEFAULTS);
		return {
			disabled:
				typeof block.disabled === "boolean"
					? block.disabled
					: DEFAULTS.disabled,
			provider:
				block.provider === "minimax" || block.provider === "openai"
					? block.provider
					: DEFAULTS.provider,
			voice:
				typeof block.voice === "string" && block.voice
					? block.voice
					: DEFAULTS.voice,
			model:
				typeof block.model === "string" && block.model
					? block.model
					: DEFAULTS.model,
			minimax: isProviderConfig(block.minimax)
				? block.minimax
				: DEFAULTS.minimax,
			openai: isProviderConfig(block.openai)
				? block.openai
				: DEFAULTS.openai,
			composeWithText:
				block.composeWithText === "auto" || block.composeWithText === "off"
					? block.composeWithText
					: DEFAULTS.composeWithText,
		};
	} catch {
		return structuredClone(DEFAULTS);
	}
}
