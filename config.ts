/**
 * config — load companion settings from `~/.pi/agent/pi-voice-telegram.json`.
 *
 * The bridge owns `telegram.json`; this file is the companion extension's
 * own settings. Convention: one JSON per concern at the agent-dir root,
 * matching `telegram.json`, `settings.json`, `mcp.json`, `auth.json`,
 * `models-store.json`, etc.
 *
 * v0.7.0: auto-seed a default settings file on first run. When the file
 * is missing, write a safe default that matches the v0.5.0 behavior
 * (echo on, tools off) so the file appearing is a no-op for behavior.
 * The operator can then edit it to enable tools or disable the echo.
 * Auto-seed is idempotent — it only fires when the file is absent; an
 * existing file (operator-edited or hand-placed) is never overwritten.
 *
 * Settings are read once per `session_start`. Reload via session restart
 * (or `/reload` if the host agent supports it). The synthesis provider
 * separately re-reads `telegram.json` on every call so the bridge's
 * settings-UI edits take effect mid-session; this file is not in that
 * hot path because it controls capability registration, which is a
 * session-scoped decision.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Raw config shape — every field is optional. */
export interface CompanionConfig {
	/** Inbound voice/audio echo. Default: enabled. */
	inbound?: {
		/**
		 * When false, skip the echo + transcript-injection handlers entirely.
		 * The bridge still receives the voice message, but the agent never
		 * sees a transcript and the user never sees the `🎙️` confirmation.
		 * Default: true.
		 */
		echoEnabled?: boolean;
	};
	/** LLM tool surface. Default: disabled (opt-in). */
	tools?: {
		/** Master switch for tool registration. Default: false. */
		enabled?: boolean;
		/** TTS tool: synthesize_voice. Default: enabled when `tools.enabled` is true. */
		tts?: {
			enabled?: boolean;
			/** Override the tool name. Default: `synthesize_voice`. */
			name?: string;
		};
		/** STT tool: transcribe_audio. Default: enabled when `tools.enabled` is true. */
		stt?: {
			enabled?: boolean;
			/** Override the tool name. Default: `transcribe_audio`. */
			name?: string;
		};
	};
}

/**
 * Default config — matches v0.5.0 behavior (echo on, no tools). Written
 * to disk on first run when the file is missing. Safe: an operator who
 * doesn't edit the file gets the same experience as before the upgrade.
 */
const DEFAULT_CONFIG: CompanionConfig = {
	inbound: { echoEnabled: true },
	tools: {
		enabled: false,
		tts: { enabled: true, name: "synthesize_voice" },
		stt: { enabled: true, name: "transcribe_audio" },
	},
};

/**
 * Read + parse the companion settings file.
 *
 * - File missing → write `DEFAULT_CONFIG` to disk and return it.
 *   Logged once via `console.log` so the operator can see what happened
 *   in `docker logs`. The write is best-effort: if the FS is read-only
 *   or the write fails for any reason, we silently fall through to an
 *   empty config and the extension's in-memory defaults apply.
 * - File exists but malformed → return `{}` (no overrides). The operator
 *   keeps their file; the extension's defaults apply. v0.7.0 deliberately
 *   does NOT overwrite a malformed file — that's a separate problem and
 *   silently overwriting would be hostile.
 * - File exists and parses → return the parsed config.
 */
export function loadCompanionConfig(): CompanionConfig {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const path = join(agentDir, "pi-voice-telegram.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return seedDefaultConfig(path);
		}
		// Permission denied, I/O error, etc. — return empty config.
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as CompanionConfig;
		return parsed ?? {};
	} catch {
		// Malformed JSON — keep the operator's file intact; treat as no
		// overrides. The file is in an explicit "broken" state; do not
		// silently overwrite.
		return {};
	}
}

/**
 * Write the default config to `path` and return it. Best-effort:
 * if the write fails, returns an empty config and the extension's
 * in-memory defaults apply. Logs a single notice on success so the
 * operator can see the seed event in the agent's stdout.
 */
function seedDefaultConfig(path: string): CompanionConfig {
	try {
		writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
		// Use console.log rather than recordTelegramRuntimeEvent: the seed
		// is a normal first-run event, not a runtime error. The operator
		// will see it once on first session_start after install/upgrade.
		console.log(
			`[pi-voice-telegram] Seeded default config at ${path} ` +
				`(echo: on, tools: off). Edit and restart to enable tools.`,
		);
		return DEFAULT_CONFIG;
	} catch {
		// Read-only FS, permission denied, etc. Fall through to empty
		// config; the extension's in-memory defaults still apply.
		return {};
	}
}
