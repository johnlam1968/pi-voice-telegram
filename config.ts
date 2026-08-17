/**
 * config — load companion settings from `~/.pi/agent/pi-voice-telegram.json`.
 *
 * The bridge owns `telegram.json`; this file is the companion extension's
 * own settings. Convention: one JSON per concern at the agent-dir root,
 * matching `telegram.json`, `settings.json`, `mcp.json`, `auth.json`,
 * `models-store.json`, etc.
 *
 * Absent or invalid file = empty config. The extension's defaults (echo
 * on, tools off) kick in. The file is opt-in for any feature that
 * diverges from that default.
 *
 * Settings are read once per `session_start`. Reload via session restart
 * (or `/reload` if the host agent supports it). The synthesis provider
 * separately re-reads `telegram.json` on every call so the bridge's
 * settings-UI edits take effect mid-session; this file is not in that
 * hot path because it controls capability registration, which is a
 * session-scoped decision.
 */

import { readFileSync } from "node:fs";
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

/** Read + parse the companion settings file, or return an empty config. */
export function loadCompanionConfig(): CompanionConfig {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const path = join(agentDir, "pi-voice-telegram.json");
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as CompanionConfig;
		return parsed ?? {};
	} catch {
		// Missing file, permission denied, malformed JSON — all treated as
		// "no overrides" so the extension's defaults apply. The user's
		// `telegram.json` is the authoritative config; this file is optional.
		return {};
	}
}
