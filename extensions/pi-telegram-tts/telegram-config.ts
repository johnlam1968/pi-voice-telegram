/**
 * telegram-config.ts — read this extension's key in telegram.json.
 *
 * Persistence: `telegram.json` under `extensions["pi-telegram-tts"]`.
 *
 * v0.1.0 shape:
 *   { "disabled": boolean, "provider": "minimax"|"openai",
 *     "voice": string, "model": string }
 *
 * If `extensions["pi-telegram-tts"]` is absent, `loadSynthConfig()`
 * returns `DEFAULTS` — which has `provider: undefined`. The provider
 * checks for `provider` in `synthesizeOgg` and returns `undefined`
 * (the bridge falls through to `outboundHandlers[0].template`).
 *
 * v0.2.0 will add `saveSynthConfig` (atomic temp+rename, same pattern
 * as `pi-telegram-stt/telegram-config.ts:71-96`) for the section UI's
 * enable/disable toggle. v0.1.0 only reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ProviderId = "minimax" | "openai";

export interface SynthConfig {
	/**
	 * If true, the provider returns `undefined` from `synthesizeOgg`
	 * even when `provider` is configured. Set by the v0.2.0 section UI
	 * toggle so the operator can disable the provider without
	 * uninstalling. v0.1.0 reads but doesn't write.
	 */
	disabled: boolean;
	/** TTS provider id. `undefined` = fall through to template. */
	provider: ProviderId | undefined;
	/** Voice id for the chosen provider. v0.3.0 moves this to a per-provider sub-block. */
	voice: string | undefined;
	/** Model name for the chosen provider. v0.3.0 moves this to a per-provider sub-block. */
	model: string | undefined;
}

export const DEFAULTS: SynthConfig = {
	disabled: false,
	provider: undefined,
	voice: undefined,
	model: undefined,
};

const KEY = "pi-telegram-tts";

function configPath(): string {
	// getAgentDir() honors PI_CODING_AGENT_DIR (per upstream
	// @earendil-works/pi-coding-agent/dist/config.js:412-418). Same
	// single source of truth as the sister extensions.
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
			voice:
				typeof block.voice === "string" && block.voice
					? block.voice
					: DEFAULTS.voice,
			model:
				typeof block.model === "string" && block.model
					? block.model
					: DEFAULTS.model,
		};
	} catch {
		// Malformed telegram.json (parse error, missing keys, etc.) →
		// fall back to DEFAULTS rather than crashing the extension.
		return structuredClone(DEFAULTS);
	}
}

/**
 * Read the full `telegram.json` as a parsed object. The provider
 * needs the full file (not just the `extensions["pi-telegram-tts"]`
 * block) because the bridge-owned `voice.sendTranscript` flag lives
 * at `telegram.json#voice.sendTranscript`, not under our extension's
 * key. `getTelegramVoiceSendTranscript(config)` reads that path.
 *
 * Returns `{}` on missing file, parse error, or any failure —
 * `getTelegramVoiceSendTranscript({})` safely returns `false`, so
 * the worst case is "no transcript attached", which matches the
 * bridge's own default.
 */
export function loadTelegramConfig(): Record<string, unknown> {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}
