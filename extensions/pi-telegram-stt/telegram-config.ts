/**
 * telegram-config.ts — read this extension's key in `telegram.json`.
 *
 * **v0.11.0:** the in-package writer (`saveEchoConfig`) was
 * dropped. The operator or agent edits `telegram.json` directly
 * via filesystem tools; the 200ms hot-reload watcher picks up
 * the change. There is no longer a need for an atomic-write
 * helper in this package — the agent's own `read`/`write` tools
 * are the canonical surface.
 *
 * The full shape, the v0.8.0 subsumption note, and the v0.7.2
 * rename note live in `docs/STT-PACKAGE.md` (this file is the
 * reader, not the design record).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const KEY = "pi-telegram-stt";

/** The on-disk shape. `base_url` and `apiKey` are the v0.8.0 flat
 *  fields (the v0.7.x `pi-openai-stt` block was a separate
 *  package; it's now subsumed). */
export interface EchoConfig {
	/** Whether to send the transcribed voice back to the user as
	 *  a 🎙️ "show transcript" reply. The transcript is always
	 *  returned to the bridge (so the LLM always gets text);
	 *  this only gates the user-facing reply. */
	showTranscript: boolean;
	/** The id of the STT provider to use. The default
	 *  `"pi-openai-stt"` is bundled inside this package. The
	 *  `SttProvider` seam stays for future backends. */
	stt_provider: string;
	/** v0.8.0: OpenAI-compatible STT provider's `base_url`.
	 *  Either a single URL string or a fallback chain (string[]).
	 *  Empty/undefined = use the env / auth.json / smart default. */
	base_url?: string | string[];
	/** v0.8.0: OpenAI-compatible STT provider's API key. */
	apiKey?: string;
}

const DEFAULTS: EchoConfig = {
	showTranscript: true,
	stt_provider: "pi-openai-stt",
};

function configPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? getAgentDir(), "telegram.json");
}

function readBaseUrl(value: unknown): string | string[] | undefined {
	if (typeof value === "string" && value) return value;
	if (
		Array.isArray(value) &&
		value.every((v) => typeof v === "string" && Boolean(v))
	) {
		return value as string[];
	}
	return undefined;
}

function readApiKey(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

export function loadEchoConfig(): EchoConfig {
	const base: EchoConfig = structuredClone(DEFAULTS);
	const path = configPath();
	if (!existsSync(path)) return base;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as {
			extensions?: Record<string, unknown>;
		};
		const block = (parsed.extensions ?? {})[KEY] as
			| Partial<EchoConfig>
			| undefined;
		if (!block) return base;
		if (typeof block.showTranscript === "boolean") {
			base.showTranscript = block.showTranscript;
		}
		if (typeof block.stt_provider === "string" && block.stt_provider) {
			base.stt_provider = block.stt_provider;
		}
		base.base_url = readBaseUrl(block.base_url);
		base.apiKey = readApiKey(block.apiKey);
		return base;
	} catch {
		return base;
	}
}
