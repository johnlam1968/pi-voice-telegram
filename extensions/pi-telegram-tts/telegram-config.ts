/**
 * telegram-config.ts — read/write this extension's key in telegram.json.
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
 * v0.2.0 added `saveSynthConfig` (atomic temp+rename, same pattern
 * as `pi-telegram-stt/telegram-config.ts:174-202`) for the section UI.
 * v0.4.0 extends the same writer with the new `composeWithText` key.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/**
 * Read the full `telegram.json` as a parsed object. Used by the
 * smoke test to verify that `saveSynthConfig` preserves other
 * extension blocks + the bridge-owned `voice` block. Returns
 * `{}` on missing file, parse error, or any failure.
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

/**
 * v0.2.0 — atomic write of the `extensions["pi-telegram-tts"]`
 * block. The section UI's `toggle-disabled` handler calls this on
 * every click. The writer:
 *
 *   1. Reads the full `telegram.json` (preserves the
 *      `extensions["pi-telegram-tt"]` block, the bridge-owned
 *      `voice` block, and any other extension blocks).
 *   2. Replaces ONLY the `extensions["pi-telegram-tts"]` block
 *      with the v0.2.0+v0.3.0+v0.4.0 7-field `SynthConfig` shape.
 *      `undefined` fields are dropped from the serialized output
 *      (so the section toggling `disabled` doesn't also write
 *      `provider: undefined` over an existing provider).
 *   3. Writes to a `.tmp` file with mode 0o600, then renames
 *      atomically. The bridge reads `telegram.json` on every call,
 *      so a partial write would be observed mid-flight.
 */
export function saveSynthConfig(cfg: SynthConfig): void {
	const path = configPath();
	let parsed: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
				string,
				unknown
			>;
		} catch {
			parsed = {};
		}
	}
	const extensions = (parsed.extensions ?? {}) as Record<string, unknown>;
	const out: Record<string, unknown> = {
		disabled: cfg.disabled,
		provider: cfg.provider,
		voice: cfg.voice,
		model: cfg.model,
		minimax: cfg.minimax,
		openai: cfg.openai,
		composeWithText: cfg.composeWithText,
	};
	for (const k of Object.keys(out)) {
		if (out[k] === undefined) delete out[k];
	}
	extensions[KEY] = out;
	parsed.extensions = extensions;
	const tempPath = path + ".tmp";
	writeFileSync(tempPath, JSON.stringify(parsed, null, 2) + "\n", {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(tempPath, path);
}
