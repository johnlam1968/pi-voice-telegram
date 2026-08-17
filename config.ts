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
 * Auto-seed is idempotent — it only fires when the file is absent; an
 * existing file (operator-edited or hand-placed) is never overwritten.
 *
 * v0.8.0: per-extension TTS and STT defaults move into the settings file
 * (replacing env-var-only configuration). Resolution order: explicit
 * JSON value > env var > hardcoded default. Env vars still work as
 * fallbacks, so the cluster's `docker-compose.yaml` doesn't need to
 * change. The new fields are:
 *
 *   tts.voice       (was PI_MM_TTS_VOICE,        default "Cantonese_PlayfulMan")
 *   tts.lang        (was PI_MM_TTS_LANG,         default "Chinese,Yue")
 *   tts.model       (was PI_MM_TTS_MODEL,        default "speech-2.8-hd")
 *   tts.timeoutMs   (was PI_MM_TTS_VOICE_REPLY_TIMEOUT_MS, default 30000)
 *   stt.lang        (was PI_TELEGRAM_LANG,       default "yue")
 *   stt.baseUrl     (was WHISPER_SERVER_URL,     default "http://127.0.0.1:8080")
 *   stt.timeoutMs   (was PI_TELEGRAM_STT_TIMEOUT_MS, default 60000)
 *
 * Settings are read once per `session_start`. Reload via session restart
 * (or `/reload` if the host agent supports it). The synthesis provider
 * separately re-reads `telegram.json` on every call so the bridge's
 * settings-UI edits take effect mid-session; this file is not in that
 * hot path because it controls capability registration + per-extension
 * defaults, both of which are session-scoped decisions.
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
	/**
	 * Per-extension TTS defaults. v0.8.0+: each field overrides the
	 * corresponding env var; the env var is the fallback when the JSON
	 * field is absent. None of these need to be set for the extension
	 * to work — the hardcoded defaults are applied last.
	 */
	tts?: {
		/** Voice ID. Default: `Cantonese_PlayfulMan` (or `$PI_MM_TTS_VOICE`). */
		voice?: string;
		/** Language boost. Default: `Chinese,Yue` (or `$PI_MM_TTS_LANG`). */
		lang?: string;
		/** TTS model ID. Default: `speech-2.8-hd` (or `$PI_MM_TTS_MODEL`). */
		model?: string;
		/** Per-call synthesis timeout in ms. Default: `30000` (or `$PI_MM_TTS_VOICE_REPLY_TIMEOUT_MS`). */
		timeoutMs?: number;
	};
	/**
	 * Per-extension STT defaults. v0.8.0+: same JSON > env > hardcoded
	 * layering as `tts.*`.
	 */
	stt?: {
		/** BCP-47 / ISO-639-1 language code. Default: `yue` (or `$PI_TELEGRAM_LANG`). */
		lang?: string;
		/** whisper-server base URL. Default: `http://127.0.0.1:8080` (or `$WHISPER_SERVER_URL`). */
		baseUrl?: string;
		/** Per-call STT timeout in ms. Default: `60000` (or `$PI_TELEGRAM_STT_TIMEOUT_MS`). */
		timeoutMs?: number;
	};
}

/** Resolved TTS defaults — every field populated, ready to use. */
export interface ResolvedTtsDefaults {
	voice: string;
	lang: string;
	model: string;
	timeoutMs: number;
}

/** Resolved STT defaults — every field populated, ready to use. */
export interface ResolvedSttDefaults {
	lang: string;
	baseUrl: string;
	timeoutMs: number;
}

/** Hardcoded TTS fallbacks (used when neither JSON nor env var is set). */
const TTS_FALLBACKS = {
	voice: "Cantonese_PlayfulMan",
	lang: "Chinese,Yue",
	model: "speech-2.8-hd",
	timeoutMs: 30_000,
} as const;

/** Hardcoded STT fallbacks. */
const STT_FALLBACKS = {
	lang: "yue",
	baseUrl: "http://127.0.0.1:8080",
	timeoutMs: 60_000,
} as const;

/** Resolve the TTS defaults: JSON > env > hardcoded. */
export function resolveTtsDefaults(cfg: CompanionConfig | undefined): ResolvedTtsDefaults {
	const cfgTimeout = cfg?.tts?.timeoutMs;
	const envTimeout = process.env.PI_MM_TTS_VOICE_REPLY_TIMEOUT_MS;
	const fallbackTimeout = envTimeout ? Number(envTimeout) : TTS_FALLBACKS.timeoutMs;
	return {
		voice: cfg?.tts?.voice ?? process.env.PI_MM_TTS_VOICE ?? TTS_FALLBACKS.voice,
		lang: cfg?.tts?.lang ?? process.env.PI_MM_TTS_LANG ?? TTS_FALLBACKS.lang,
		model: cfg?.tts?.model ?? process.env.PI_MM_TTS_MODEL ?? TTS_FALLBACKS.model,
		timeoutMs: cfgTimeout ?? fallbackTimeout,
	};
}

/** Resolve the STT defaults: JSON > env > hardcoded. */
export function resolveSttDefaults(cfg: CompanionConfig | undefined): ResolvedSttDefaults {
	const cfgTimeout = cfg?.stt?.timeoutMs;
	const envTimeout = process.env.PI_TELEGRAM_STT_TIMEOUT_MS;
	const fallbackTimeout = envTimeout ? Number(envTimeout) : STT_FALLBACKS.timeoutMs;
	return {
		lang: cfg?.stt?.lang ?? process.env.PI_TELEGRAM_LANG ?? STT_FALLBACKS.lang,
		baseUrl: cfg?.stt?.baseUrl ?? process.env.WHISPER_SERVER_URL ?? STT_FALLBACKS.baseUrl,
		timeoutMs: cfgTimeout ?? fallbackTimeout,
	};
}

/**
 * Default config — matches v0.5.0 behavior (echo on, no tools, hardcoded
 * TTS/STT defaults). Written to disk on first run when the file is
 * missing. Safe: an operator who doesn't edit the file gets the same
 * experience as before the upgrade.
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
		console.log(
			`[pi-voice-telegram] Seeded default config at ${path} ` +
				`(echo: on, tools: off). Edit and restart to enable tools.`,
		);
		return DEFAULT_CONFIG;
	} catch {
		return {};
	}
}
