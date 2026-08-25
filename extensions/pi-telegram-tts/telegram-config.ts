/**
 * telegram-config.ts — read `telegram.json#extensions["pi-telegram-tts"]`.
 * The surface is 3 fields: `disabled`, `provider`, `composeWithText`.
 * Voice settings (model / speed / emotion / etc.) are hardcoded in
 * `synth.ts:MINIMAX_BODY`. Version history: v0.5.0 dropped the in-package
 * writer; v0.6.0 dropped `loadTelegramConfig`; v0.7.0 dropped the
 * per-provider sub-block.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ProviderId = "minimax" | "openai";

export interface SynthConfig {
	/** If true, `synthesizeOgg` returns `undefined` and the bridge
	 *  falls through. */
	disabled: boolean;
	/** TTS provider id. `undefined` = no provider configured. */
	provider: ProviderId | undefined;
	/**
	 * v0.4.0: text+voice composition. `"off"` (default) sends voice
	 * only. `"auto"` sends a text message with the same content as
	 * the voice, then the voice follows.
	 */
	composeWithText?: "off" | "auto";
}

export const DEFAULTS: SynthConfig = {
	disabled: false,
	provider: undefined,
	composeWithText: undefined,
};

const KEY = "pi-telegram-tts";

function configPath(): string {
	return join(getAgentDir(), "telegram.json");
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
			composeWithText:
				block.composeWithText === "auto" || block.composeWithText === "off"
					? block.composeWithText
					: DEFAULTS.composeWithText,
		};
	} catch {
		return structuredClone(DEFAULTS);
	}
}
