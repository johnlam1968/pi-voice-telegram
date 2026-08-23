/**
 * telegram-config.ts — read/write this extension's key in telegram.json.
 *
 * Persistence: `telegram.json` under `extensions["pi-telegram-stt"]`.
 *
 * ## v0.8.0 — flat config: `pi-openai-stt` subsumed
 *
 * The OpenAI-compatible STT provider (`openai-stt.ts`) was
 * subsumed from the separate `pi-openai-stt` npm package into
 * this package. The provider's `base_url` and `apiKey` config
 * fields moved from a separate `extensions["pi-openai-stt"]`
 * block to top-level keys under `extensions["pi-telegram-stt"]`.
 * The migration is a 5-line edit in `telegram.json` — see
 * `README.md`'s "Migration from 0.7.2" section.
 *
 * The `SttProvider` interface stays as an in-package seam
 * (`./stt-provider.ts`) for future backends. The `stt_provider`
 * config field stays too (default: `"pi-openai-stt"`).
 *
 * ## v0.7.2 — `echoEnabled` → `showTranscript` rename
 *
 * The field was renamed for naming symmetry with the bridge's
 * `voice.sendTranscript` (which gates the *outbound* TTS caption).
 * `showTranscript` is the symmetric inbound name: "show the
 * transcribed voice to the user as a separate message". The two
 * are now visually parallel and conceptually distinguishable
 * (in vs. out).
 *
 * Backward-compat: the reader accepts the old `echoEnabled` key
 * as a fallback when `showTranscript` is absent. `saveEchoConfig`
 * always writes the new key, so the config file migrates itself
 * the first time the operator toggles the setting in the section
 * UI or hot-reload re-runs.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface EchoConfig {
	/** Whether to send the transcribed voice back to the user as
	 *  a 🎙️ "show transcript" reply. The transcript is always
	 *  returned to the bridge (so the LLM always gets text);
	 *  this only gates the user-facing reply. */
	showTranscript: boolean;
	/** The id of the STT provider to use. The default
	 *  `"pi-openai-stt"` is bundled inside this package as of
	 *  v0.8.0. The seam stays for future backends. */
	stt_provider: string;
	/** v0.8.0: OpenAI-compatible STT provider's `base_url`.
	 *  Either a single URL string or a fallback chain (string[]).
	 *  Empty/undefined = use the env / auth.json / smart default. */
	base_url?: string | string[];
	/** v0.8.0: OpenAI-compatible STT provider's API key. */
	apiKey?: string;
}

export const DEFAULTS: EchoConfig = {
	showTranscript: true,
	stt_provider: "pi-openai-stt",
};

const KEY = "pi-telegram-stt";

function configPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	return join(agentDir, "telegram.json");
}

/**
 * Read the showTranscript flag from the config block. Accepts
 * `showTranscript` (new) and `echoEnabled` (deprecated v0.7.1
 * and earlier). `showTranscript` wins when both are set.
 */
function readShowTranscriptFlag(
	block: Record<string, unknown>,
): boolean | undefined {
	const next = block.showTranscript;
	if (typeof next === "boolean") return next;
	const legacy = block.echoEnabled;
	if (typeof legacy === "boolean") return legacy;
	return undefined;
}

/** Read the OpenAI STT config (`base_url` + `apiKey`) from the
 *  `extensions["pi-telegram-stt"]` block. The `base_url` may be a
 *  single URL (string) or a fallback chain (string[]). Returns
 *  an empty object when the block is absent or the keys are
 *  unset / wrong type. Used by the in-package `openai-stt.ts`
 *  client (which was previously in a separate `pi-openai-stt`
 *  package before v0.8.0).
 *
 *  Backward-compat: if the operator's old `extensions["pi-openai-stt"]`
 *  block is still present, also read from there (read-only; not
 *  written by `saveEchoConfig`). The old block is from a separate
 *  npm package that is now deprecated. */
function readOpenAiSttConfig(
	block: Record<string, unknown> | undefined,
): { baseUrl?: string | string[]; apiKey?: string } {
	if (!block) return {};
	let baseUrl: string | string[] | undefined;
	if (typeof block.base_url === "string" && block.base_url) {
		baseUrl = block.base_url;
	} else if (
		Array.isArray(block.base_url) &&
		block.base_url.every((v) => typeof v === "string" && v)
	) {
		baseUrl = block.base_url as string[];
	}
	return {
		baseUrl,
		apiKey:
			typeof block.apiKey === "string" && block.apiKey
				? block.apiKey
				: undefined,
	};
}

export function loadEchoConfig(): EchoConfig {
	const path = configPath();
	const base: EchoConfig = structuredClone(DEFAULTS);
	if (!existsSync(path)) return base;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as {
			extensions?: Record<string, unknown>;
		};
		const block = (parsed.extensions ?? {})[KEY] as
			| (Partial<EchoConfig> & { echoEnabled?: unknown })
			| undefined;
		if (block) {
			base.showTranscript =
				readShowTranscriptFlag(block) ?? DEFAULTS.showTranscript;
			base.stt_provider =
				typeof block.stt_provider === "string" && block.stt_provider
					? block.stt_provider
					: DEFAULTS.stt_provider;
			const stt = readOpenAiSttConfig(block);
			base.base_url = stt.baseUrl;
			base.apiKey = stt.apiKey;
		}
		// Backward-compat: also read from the legacy
		// `extensions["pi-openai-stt"]` block if it has values
		// that the new flat block doesn't.
		const legacyBlock = (parsed.extensions ?? {})["pi-openai-stt"] as
			| { base_url?: unknown; api_key?: unknown }
			| undefined;
		if (legacyBlock && (!base.base_url || !base.apiKey)) {
			if (!base.base_url) {
				if (typeof legacyBlock.base_url === "string" && legacyBlock.base_url) {
					base.base_url = legacyBlock.base_url;
				} else if (
					Array.isArray(legacyBlock.base_url) &&
					legacyBlock.base_url.every((v) => typeof v === "string" && v)
				) {
					base.base_url = legacyBlock.base_url as string[];
				}
			}
			if (!base.apiKey) {
				if (
					typeof legacyBlock.api_key === "string" &&
					legacyBlock.api_key
				) {
					base.apiKey = legacyBlock.api_key;
				}
			}
		}
		return base;
	} catch {
		return base;
	}
}

export function saveEchoConfig(cfg: EchoConfig): void {
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
		showTranscript: cfg.showTranscript,
		stt_provider: cfg.stt_provider,
	};
	if (cfg.base_url !== undefined) out.base_url = cfg.base_url;
	if (cfg.apiKey !== undefined) out.apiKey = cfg.apiKey;
	extensions[KEY] = out;
	parsed.extensions = extensions;
	// Atomic write: temp + rename.
	const tempPath = path + ".tmp";
	writeFileSync(tempPath, JSON.stringify(parsed, null, 2) + "\n", {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(tempPath, path);
}
