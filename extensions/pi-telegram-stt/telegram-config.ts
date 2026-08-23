/**
 * telegram-config.ts — read/write this extension's key in telegram.json.
 *
 * Persistence: `telegram.json` under `extensions["pi-telegram-stt"]`.
 *
 * Schema-light: the operator-facing knobs are `showTranscript` and
 * `stt_provider`. The STT provider is looked up in the in-process
 * registry (see `./stt-provider.ts`) at STT call time — the
 * `pi-openai-stt` provider extension registers itself at module
 * load. `pi-openai-stt` talks to any OpenAI-compatible API gateway
 * (OpenAI's actual API, the local `fw-openai-sts` shim, faster-
 * whisper-server, etc.) and supports a fallback chain in
 * `extensions["pi-openai-stt"].base_url`. `pi-whisper-stt` was
 * retired in v0.5.0; `pi-openai-stt` covers every backend it ever
 * talked to.
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
	/** The id of the STT provider to use. The provider must be
	 *  installed and registered (default: `"pi-openai-stt"`). */
	stt_provider: string;
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

export function loadEchoConfig(): EchoConfig {
	const path = configPath();
	if (!existsSync(path)) return structuredClone(DEFAULTS);
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as {
			extensions?: Record<string, unknown>;
		};
		const block = (parsed.extensions ?? {})[KEY] as
			| Partial<EchoConfig> & { echoEnabled?: unknown }
			| undefined;
		if (!block) return structuredClone(DEFAULTS);
		return {
			showTranscript:
				readShowTranscriptFlag(block) ?? DEFAULTS.showTranscript,
			stt_provider:
				typeof block.stt_provider === "string" && block.stt_provider
					? block.stt_provider
					: DEFAULTS.stt_provider,
		};
	} catch {
		return structuredClone(DEFAULTS);
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
	extensions[KEY] = {
		showTranscript: cfg.showTranscript,
		stt_provider: cfg.stt_provider,
	};
	parsed.extensions = extensions;
	// Atomic write: temp + rename.
	const tempPath = path + ".tmp";
	writeFileSync(tempPath, JSON.stringify(parsed, null, 2) + "\n", {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(tempPath, path);
}
