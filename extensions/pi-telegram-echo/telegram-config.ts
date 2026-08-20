/**
 * telegram-config.ts — read/write this extension's key in telegram.json.
 *
 * Persistence: `telegram.json` under `extensions["pi-telegram-echo"]`.
 *
 * Schema-light: the operator-facing knobs are `echoEnabled` and
 * `stt_provider`. The STT provider is looked up in the in-process
 * registry (see `./stt-provider.ts`) at STT call time — the
 * provider extension (e.g., `pi-whisper-stt`, `pi-openai-stt`)
 * registers itself on `session_start`. For STT backends that
 * speak the OpenAI-compatible API gateway convention, install
 * `pi-openai-stt` and set `OPENAI_STT_BASE_URL` (no new
 * `pi-<backend>-stt` package needed).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface EchoConfig {
	/** Whether to send the 🎙️ reply to the user. The transcript
	 *  is always returned to the bridge (so the LLM always gets
	 *  text); this only gates the user-facing echo. */
	echoEnabled: boolean;
	/** The id of the STT provider to use. The provider must be
	 *  installed and registered (default: `"pi-whisper-stt"`). */
	stt_provider: string;
}

export const DEFAULTS: EchoConfig = {
	echoEnabled: true,
	stt_provider: "pi-whisper-stt",
};

const KEY = "pi-telegram-echo";

function configPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	return join(agentDir, "telegram.json");
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
			| Partial<EchoConfig>
			| undefined;
		if (!block) return structuredClone(DEFAULTS);
		return {
			echoEnabled:
				typeof block.echoEnabled === "boolean"
					? block.echoEnabled
					: DEFAULTS.echoEnabled,
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
		echoEnabled: cfg.echoEnabled,
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
