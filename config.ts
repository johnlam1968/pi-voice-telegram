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
	/**
	 * Optional JSON Schema reference for editor support. Most modern
	 * editors (VS Code, IntelliJ) use this for inline hints,
	 * validation, and autocomplete. The extension itself ignores it.
	 * Conventionally a URL (HTTP or local file://) to a `.schema.json`.
	 */
	$schema?: string;
	/**
	 * Optional free-form hint. The extension never reads this; it's a
	 * place for an at-a-glance reminder (e.g. "see README.md for
	 * docs, restart after editing"). Useful for humans and LLMs that
	 * inspect the file directly.
	 */
	_hint?: string;
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
		/**
		 * Master switch for LLM tool registration. When false, NONE of
		 * the LLM-callable tools (synthesize_voice, transcribe_audio,
		 * pi_voice_telegram_schema, pi_voice_telegram_config_read /
		 * _write / _reset) are registered. When true, they're all
		 * available.
		 *
		 * Note: this is an OPERATOR PREFERENCE (token-cost + ergonomic),
		 * not a security boundary. A sufficiently capable LLM with
		 * `bash` + `write` can modify this file regardless of how
		 * `tools.enabled` is set. The real security boundary is the
		 * container's filesystem permissions, the bridge's role-based
		 * access, etc. The settings file is just JSON; the LLM is
		 * fully capable of editing it via the host's write tool.
		 *
		 * Default: false. Set true to opt the LLM into the full tool
		 * surface (TTS, STT, schema discovery, config introspection,
		 * config modification, config reset).
		 */
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
		/**
		 * When true (default), run whisper-stt language detection on every
		 * synthesized OGG and record the result in the runtime event log
		 * under `category: "pi-voice-telegram/tts-verify"`. Catches the
		 * cross-language "boost" misfires and any other voice/lang drift.
		 * Adds ~500ms–1s per synthesis; turn off for latency-sensitive
		 * paths. v0.16.0+.
		 */
		verifyAfterSynthesize?: boolean;
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
	verifyAfterSynthesize: boolean;
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
	verifyAfterSynthesize: true,
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
		verifyAfterSynthesize:
			cfg?.tts?.verifyAfterSynthesize ?? TTS_FALLBACKS.verifyAfterSynthesize,
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
 *
 * The `tts.*` and `stt.*` fields are included with the same hardcoded
 * values that `resolveTtsDefaults(undefined)` / `resolveSttDefaults(undefined)`
 * would produce, so the seeded file is a complete reference of every
 * knob the extension knows about. Operators can read the file, see
 * what's available, and edit any field. The fields are redundant with
 * the hardcoded fallbacks (writing them doesn't change behavior), but
 * the file becomes self-documenting.
 *
 * v0.9.0+: the seeded file also includes `_hint` and `$schema` fields
 * so it's discoverable in editors (which use `$schema` for inline
 * validation + hints) and in `cat` output (where the `_hint` string
 * is the first thing the operator sees). The `_hint` is a free-form
 * pointer to the docs; the `$schema` is the canonical machine-readable
 * spec at `pi-voice-telegram.schema.json` in the npm package.
 *
 * MAINTENANCE: when adding a new knob to the schema, also update:
 *   1. `CompanionConfig` interface (this file)
 *   2. `TTS_FALLBACKS` / `STT_FALLBACKS` constants (if a hardcoded default exists)
 *   3. `resolveTtsDefaults` / `resolveSttDefaults` (if a new env-var fallback exists)
 *   4. `DEFAULT_CONFIG` below (so auto-seed produces a complete file)
 *   5. `examples/pi-voice-telegram.json` (so the copy-paste example is current)
 *   6. `pi-voice-telegram.schema.json` (the machine-readable spec)
 *   7. README.md settings table
 *   8. PLAN.md knobs table
 */
const DEFAULT_CONFIG: CompanionConfig & Record<string, unknown> = {
	$schema: "https://raw.githubusercontent.com/johnlam1968/pi-voice-telegram/main/pi-voice-telegram.schema.json",
	_hint: "pi-voice-telegram companion settings (v0.16.0+). Hot-reload is on — changes take effect on the next turn, no restart. TTS/STT defaults (tts.lang, tts.voice, tts.model, tts.lang, tts.verifyAfterSynthesize, stt.lang, stt.baseUrl) live HERE, NOT in telegram.json. telegram.json controls the bridge (chat/polling/role access); THIS file controls the voice pipeline. For valid voice IDs, see $schema (and the agent has a pi_voice_telegram_list_voices tool that returns the embedded 327-voice catalog). v0.16.0: tts.verifyAfterSynthesize (default true) runs whisper-stt language detection on every synthesis and logs the result under `category: \"pi-voice-telegram/tts-verify\"`.",
	inbound: { echoEnabled: true },
	tools: {
		enabled: false,
		tts: { enabled: true, name: "synthesize_voice" },
		stt: { enabled: true, name: "transcribe_audio" },
	},
	tts: {
		voice: TTS_FALLBACKS.voice,
		lang: TTS_FALLBACKS.lang,
		model: TTS_FALLBACKS.model,
		timeoutMs: TTS_FALLBACKS.timeoutMs,
		verifyAfterSynthesize: TTS_FALLBACKS.verifyAfterSynthesize,
	},
	stt: {
		lang: STT_FALLBACKS.lang,
		baseUrl: STT_FALLBACKS.baseUrl,
		timeoutMs: STT_FALLBACKS.timeoutMs,
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
