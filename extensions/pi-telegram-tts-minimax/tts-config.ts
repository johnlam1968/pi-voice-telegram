/**
 * tts-config.ts — load/save the TTS orchestrator + per-provider config
 * blocks from `telegram.json`.
 *
 * The orchestrator's own block is
 *   `extensions["pi-telegram-tts-minimax"]`
 * and contains just the active-provider pointer (`tts_provider`).
 *
 * Each provider's block is
 *   `extensions["pi-<provider>-tts"]`
 * and contains provider-specific knobs (voice, model, region,
 * emotion, base_url, etc.). The provider reads these on every
 * synthesize() call, so voice changes take effect on the next
 * inbound voice message without re-registering anything.
 *
 * Mirrors the STT side's `telegram-config.ts` (loadEchoConfig /
 * saveEchoConfig) but split into two pairs because the TTS side
 * has two namespaces (orchestrator + N provider configs).
 *
 * The section UI in `./tts-section.ts` uses loadTtsOrchestratorConfig
 * + saveTtsOrchestratorConfig to switch the active provider, and
 * loadTtsProviderConfig + saveTtsProviderConfig to set the voice
 * / model / etc. for that provider. Both writers are atomic
 * (temp file + rename, mode 0o600) to survive a `pi` crash
 * mid-write.
 */

import {
	existsSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Settings persisted in `telegram.json` under
 *  `extensions["pi-telegram-tts-minimax"]`. The block is small —
 *  just the active provider pointer. Per-provider settings live in
 *  the provider's own block. */
export interface TtsOrchestratorConfig {
	/** Id of the TtsProvider to use. Must match a registered
	 *  TtsProvider (e.g., "pi-minimax-tts", "pi-openai-tts").
	 *  Default: "pi-minimax-tts". */
	tts_provider: string;
}

/** Settings persisted in `telegram.json` under
 *  `extensions["<provider-id>"]` (e.g.,
 *  `extensions["pi-minimax-tts"]` or `extensions["pi-openai-tts"]`).
 *  The shape is provider-agnostic — the provider knows its own
 *  fields. The section UI currently edits `voice` and `model`
 *  for both providers; provider-specific extras (region, emotion,
 *  base_url, instructions) can be added in future revisions. */
export interface TtsProviderConfig {
	/** Voice id (e.g., "alloy", "Cantonese_PlayfulMan"). */
	voice?: string;
	/** Model name (e.g., "tts-1", "speech-2.8-hd"). */
	model?: string;
	/** Provider-specific extras (e.g., region, emotion, base_url,
	 *  instructions, lang, etc.). The section UI currently
	 *  ignores these; the provider reads them on every
	 *  synthesize() call. */
	[key: string]: unknown;
}

export const ORCHESTRATOR_DEFAULTS: TtsOrchestratorConfig = {
	tts_provider: "pi-minimax-tts",
};

const ORCHESTRATOR_KEY = "pi-telegram-tts-minimax";

/** Resolve the path to `telegram.json`. `PI_CODING_AGENT_DIR` is
 *  honored (matches the bridge and the STT side). */
function configPath(): string {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(dir, "telegram.json");
}

/** Atomic write: temp file + rename. Same scheme as
 *  `pi-telegram-echo/telegram-config.ts` (which the user has been
 *  relying on for the STT side since v0.2.1). */
function atomicWriteJson(path: string, value: unknown): void {
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
	extensions[ORCHESTRATOR_KEY] = value;
	parsed.extensions = extensions;
	const tempPath = path + ".tmp";
	writeFileSync(tempPath, JSON.stringify(parsed, null, 2) + "\n", {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(tempPath, path);
}

function atomicPatchProviderBlock(
	providerId: string,
	patch: (existing: TtsProviderConfig) => TtsProviderConfig,
): TtsProviderConfig {
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
	const existing = (extensions[providerId] ?? {}) as TtsProviderConfig;
	const updated = patch(existing);
	// Strip undefined values so we don't write `voice: undefined`
	// to disk.
	const cleaned: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(updated)) {
		if (v !== undefined) cleaned[k] = v;
	}
	extensions[providerId] = cleaned;
	parsed.extensions = extensions;
	const tempPath = path + ".tmp";
	writeFileSync(tempPath, JSON.stringify(parsed, null, 2) + "\n", {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(tempPath, path);
	return updated;
}

/** Read the orchestrator's config block. Returns the defaults if
 *  the file is missing, unreadable, malformed, or doesn't have
 *  the block. */
export function loadTtsOrchestratorConfig(): TtsOrchestratorConfig {
	const path = configPath();
	if (!existsSync(path)) return structuredClone(ORCHESTRATOR_DEFAULTS);
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as {
			extensions?: Record<string, { tts_provider?: unknown } | undefined>;
		};
		const block = (parsed.extensions ?? {})[ORCHESTRATOR_KEY] as
			| Partial<TtsOrchestratorConfig>
			| undefined;
		if (!block) return structuredClone(ORCHESTRATOR_DEFAULTS);
		return {
			tts_provider:
				typeof block.tts_provider === "string" && block.tts_provider
					? block.tts_provider
					: ORCHESTRATOR_DEFAULTS.tts_provider,
		};
	} catch {
		return structuredClone(ORCHESTRATOR_DEFAULTS);
	}
}

/** Persist the orchestrator's config block. The hot-reload
 *  watcher in `./index.ts` picks up the change within 200ms and
 *  re-registers the bridge's TTS provider. */
export function saveTtsOrchestratorConfig(cfg: TtsOrchestratorConfig): void {
	atomicWriteJson(configPath(), cfg);
}

/** Read the provider's config block. The provider reads this on
 *  every synthesize() call, so voice changes take effect on the
 *  next inbound voice message without re-registering. */
export function loadTtsProviderConfig(
	providerId: string,
): TtsProviderConfig {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as {
			extensions?: Record<string, unknown>;
		};
		const block = (parsed.extensions ?? {})[providerId];
		if (!block || typeof block !== "object") return {};
		return block as TtsProviderConfig;
	} catch {
		return {};
	}
}

/** Persist a single field on the provider's config block. Used
 *  by the section UI for "change voice", "change model", etc.
 *  Strips undefined values. */
export function saveTtsProviderField(
	providerId: string,
	field: keyof TtsProviderConfig,
	value: unknown,
): TtsProviderConfig {
	return atomicPatchProviderBlock(providerId, (existing) => ({
		...existing,
		[field]: value,
	}));
}
