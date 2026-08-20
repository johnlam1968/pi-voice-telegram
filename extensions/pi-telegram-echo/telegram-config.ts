/**
 * telegram-config.ts — read/write this extension's key in telegram.json.
 *
 * Persistence: `telegram.json` under `extensions["pi-telegram-echo"]`.
 * The bridge's `registerTelegramSection` reads the values for rendering
 * and writes them back when the operator toggles a setting or picks a
 * preset. This module is the read/write primitive.
 *
 * Shape:
 *   {
 *     "echoEnabled": boolean,         // whether to send the 🎙️ reply
 *     "stt": {
 *       "command": string[]           // argv; the operator configures
 *     }
 *   }
 *
 * Defaults are returned for missing keys (schema-light; the section UI
 * is the schema source of truth for the operator).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface EchoConfig {
	echoEnabled: boolean;
	stt: {
		command: string[];
	};
}

export const DEFAULTS: EchoConfig = {
	echoEnabled: true,
	stt: {
		// Empty by default — the operator must configure this before
		// the extension can transcribe. The section UI offers a
		// "whisper-server" preset and a "local script" preset.
		command: [],
	},
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
		const parsed = JSON.parse(raw) as { extensions?: Record<string, unknown> };
		const block = (parsed.extensions ?? {})[KEY] as
			| Partial<EchoConfig>
			| undefined;
		if (!block) return structuredClone(DEFAULTS);
		return {
			echoEnabled: block.echoEnabled ?? DEFAULTS.echoEnabled,
			stt: {
				command: Array.isArray(block.stt?.command)
					? (block.stt!.command as unknown[]).map((s) => String(s))
					: DEFAULTS.stt.command,
			},
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
		stt: { command: cfg.stt.command },
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

/** Known STT command presets the section UI offers. */
export const STT_PRESETS: Record<string, string[]> = {
	whisper: [
		"curl",
		"-s",
		"-X",
		"POST",
		"-F",
		"file=@{file}",
		"-F",
		"response_format=text",
		"http://127.0.0.1:8080/inference",
	],
	"local-script": ["/usr/local/bin/my-stt.sh", "{file}"],
};
