/**
 * openai-stt — in-process client for the OpenAI `/v1/audio/transcriptions`
 * API gateway convention.
 *
 * v0.4.4: read `base_url` and `api_key` from `telegram.json` (the
 * bridge's canonical config file) before falling back to env vars
 * and the `auth.json` fallback. The recommended way to switch
 * between local (`fw-openai-sts` shim) and cloud (OpenAI's actual
 * API) is one line in `telegram.json`:
 *
 *   "extensions": {
 *     "pi-openai-stt": { "base_url": "http://127.0.0.1:8081/v1" }
 *   }
 *
 * v0.4.3: strip `language` for `api.openai.com` (OpenAI's Whisper
 * rejects `yue` with HTTP 400 even though it's a valid ISO 639-1
 * code; auto-detect handles Cantonese correctly). The local shim
 * and other gateways keep `language`.
 *
 * v0.4.2: read `OPENAI_API_KEY` from `~/.pi/agent/auth.json` as a
 * fallback. v0.4.1: smart default for `OPENAI_STT_BASE_URL`
 * (OpenAI's API if a key is resolvable, local shim otherwise).
 *
 * The same code talks to:
 *   - OpenAI's actual API (`base_url=https://api.openai.com/v1`,
 *     `api_key=sk-...`)
 *   - The local `fw-openai-sts` shim (the on-host `whisper-server`
 *     exposed as OpenAI-compatible; preserves the existing CUDA +
 *     large-v3-in-VRAM setup with zero changes to the inference
 *     engine)
 *   - `faster-whisper-server` with `--enable-openai-api`
 *   - `whisper-asr-webservice`
 *   - Any other OpenAI-compatible gateway
 *
 * Config resolution (first non-empty wins):
 *   1. Explicit `OpenAiSttArgs.baseUrl` / `.apiKey` (test path)
 *   2. `extensions["pi-openai-stt"].base_url` / `.api_key` in
 *      `telegram.json` (recommended for live config)
 *   3. `OPENAI_STT_BASE_URL` / `OPENAI_API_KEY` env vars
 *      (CI / container overrides)
 *   4. `auth.json` → `openai.key` (only for the API key; the base
 *      URL has no auth.json equivalent)
 *   5. Smart default: `https://api.openai.com/v1` if a key is
 *      resolvable from any of the above, else the local shim
 *      `http://127.0.0.1:8081/v1`
 *
 * Other env vars (no `telegram.json` equivalent — kept env-only):
 *   - `OPENAI_STT_MODEL` (default `whisper-1`).
 *   - `PI_TELEGRAM_LANG` (default `yue`).
 *
 * Errors are thrown as `OpenAiSttError` with `code: 1|2|3|4`:
 *   1  usage / validation
 *   2  network (timeout, DNS, connection refused)
 *   3  API client (HTTP 4xx, or malformed response)
 *   4  API server (HTTP 5xx)
 *
 * The provider in `index.ts` re-wraps `OpenAiSttError` as
 * `ProviderError` to keep the registry's `code: 1|2|3|4` taxonomy
 * consistent with `pi-whisper-stt` and the old monolithic's
 * `WhisperSttError`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export interface OpenAiSttArgs {
	/** Path to the audio file on disk. */
	inputPath: string;
	/** BCP-47 / ISO-639-1 language code (e.g. "yue", "en", "zh"). */
	lang?: string;
	/** Per-call timeout in ms. Default: 60000. */
	timeoutMs?: number;
	/** Override the base URL. */
	baseUrl?: string;
	/** Override the API key. */
	apiKey?: string;
	/** Override the model name. */
	model?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL = "whisper-1";
const DEFAULT_LANG = "yue";
/** OpenAI's actual API. */
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
/** The local `fw-openai-sts` shim (forwards to the on-host CUDA
 *  whisper-server with the model in VRAM). The on-host default —
 *  matches the on-host setup from PLAN.md §v0.4.0. */
const LOCAL_SHIM_BASE_URL = "http://127.0.0.1:8081/v1";

export class OpenAiSttError extends Error {
	constructor(
		message: string,
		readonly code: 1 | 2 | 3 | 4,
		readonly detail?: Record<string, unknown>,
	) {
		super(message);
		this.name = "OpenAiSttError";
	}
}

/** Read the `extensions["pi-openai-stt"]` block from `telegram.json`
 *  (the bridge's canonical config file). Returns an empty object if
 *  the file is missing, unreadable, malformed, or doesn't have the
 *  block. The supported keys are:
 *
 *    - `base_url`  → overrides `OPENAI_STT_BASE_URL` (and the smart
 *                    default that picks OpenAI's API when a key is
 *                    present). Use `http://127.0.0.1:8081/v1` for the
 *                    local `fw-openai-sts` shim, or any
 *                    OpenAI-compatible gateway URL.
 *    - `api_key`   → overrides `OPENAI_API_KEY` (and the
 *                    `~/.pi/agent/auth.json` fallback). Useful for
 *                    key-per-profile routing when one `telegram.json`
 *                    is shared across multiple bot profiles.
 *
 *  This makes the local-vs-cloud switch a one-line edit in
 *  `telegram.json` instead of an env-var dance, which matches the
 *  rest of the bridge's config conventions. Env vars still win for
 *  one-off overrides (CI, container runs).
 *
 *  `PI_CODING_AGENT_DIR` is honored (matches the bridge and the
 *  `pi-telegram-echo`'s `getAgentDir()` pattern). */
function readTelegramJsonSttConfig(): { baseUrl?: string; apiKey?: string } {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const configPath = join(dir, "telegram.json");
	if (!existsSync(configPath)) return {};
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as {
			extensions?: Record<string, { base_url?: unknown; api_key?: unknown } | undefined>;
		};
		const ext = parsed.extensions?.["pi-openai-stt"];
		if (!ext || typeof ext !== "object") return {};
		return {
			baseUrl: typeof ext.base_url === "string" && ext.base_url ? ext.base_url : undefined,
			apiKey: typeof ext.api_key === "string" && ext.api_key ? ext.api_key : undefined,
		};
	} catch {
		// ignore parse errors; env vars are the next fallback
		return {};
	}
}

/** Read the OpenAI API key from `~/.pi/agent/auth.json` (the standard
 *  pi-coding-agent credentials file). Returns `undefined` if the file
 *  is missing, unreadable, malformed, or doesn't have an `openai.key`
 *  entry. Used as a fallback when the `OPENAI_API_KEY` env var isn't
 *  set — the on-host path "just works" if the operator already has
 *  the key in `auth.json` (which the LLM provider also reads).
 *
 *  `PI_CODING_AGENT_DIR` is honored (matches the bridge and the
 *  `pi-telegram-echo`'s `getAgentDir()` pattern). */
function readOpenAiKeyFromAuthJson(): string | undefined {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const authPath = join(dir, "auth.json");
	if (!existsSync(authPath)) return undefined;
	try {
		const raw = readFileSync(authPath, "utf8");
		const parsed = JSON.parse(raw) as {
			openai?: { type?: string; key?: unknown };
		};
		const openai = parsed.openai;
		if (openai && typeof openai.key === "string" && openai.key) {
			return openai.key;
		}
	} catch {
		// ignore parse errors; the env var is the primary source
	}
	return undefined;
}

/** Return the first non-empty value in `values`. Treats `undefined`,
 *  `null`, and `""` as unset so an operator who sets (and then
 *  unsets) an env var falls through to the next option. Used for
 *  env-var chains where an empty string is never a valid value
 *  (API key, base URL). */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
	for (const v of values) {
		if (v !== undefined && v !== null && v !== "") return v;
	}
	return undefined;
}

/** Transcribe an audio file via the OpenAI `/v1/audio/transcriptions`
 *  endpoint. Throws `OpenAiSttError` on validation, network, or
 *  server failures. */
export async function transcribe(args: OpenAiSttArgs): Promise<string> {
	if (!args.inputPath) {
		throw new OpenAiSttError("openai-stt: missing inputPath", 1);
	}

	// API key resolution: explicit arg > telegram.json > env var >
	// auth.json fallback. The auth.json fallback is for the on-host
	// path — operators who already have the key in `auth.json` (the
	// LLM provider reads the same file) don't need to set a separate
	// env var for STT. `telegram.json` is the bridge's canonical
	// config file, so the operator can pin the key per profile
	// without touching the environment. `firstNonEmpty` treats an
	// empty string as unset so unsets fall through to the next
	// option.
	const telegramSttConfig = readTelegramJsonSttConfig();
	const apiKey = firstNonEmpty(
		args.apiKey,
		telegramSttConfig.apiKey,
		process.env.OPENAI_API_KEY,
		readOpenAiKeyFromAuthJson(),
	);

	// baseUrl resolution: explicit arg > telegram.json > env var >
	// smart default. The smart default picks OpenAI's actual API
	// when a key is resolvable (any source) and the local
	// `fw-openai-sts` shim otherwise. `telegram.json` is the
	// recommended way to switch between local and cloud — set
	// `extensions["pi-openai-stt"].base_url` to the gateway URL.
	const baseUrl = firstNonEmpty(
		args.baseUrl,
		telegramSttConfig.baseUrl,
		process.env.OPENAI_STT_BASE_URL,
		apiKey ? OPENAI_API_BASE_URL : LOCAL_SHIM_BASE_URL,
	)!.replace(/\/$/, "");
	const model = args.model ?? process.env.OPENAI_STT_MODEL ?? DEFAULT_MODEL;
	const lang = args.lang ?? process.env.PI_TELEGRAM_LANG ?? DEFAULT_LANG;
	const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const url = `${baseUrl}/audio/transcriptions`;

	let bytes: Buffer;
	try {
		bytes = await readFile(args.inputPath);
	} catch (err) {
		throw new OpenAiSttError(
			`openai-stt: cannot read ${args.inputPath}: ${(err as Error).message}`,
			1,
			{ inputPath: args.inputPath },
		);
	}
	const filename = args.inputPath.split("/").pop() ?? "voice.ogg";

	// Build the multipart body. `request response_format=text` so the
	// API returns plain text directly (no JSON unwrap).
	const form = new FormData();
	form.append("file", new Blob([bytes], { type: "audio/ogg" }), filename);
	form.append("model", model);
	// OpenAI's Whisper API accepts a limited set of ISO-639-1 language
	// codes (en, zh, es, fr, de, ja, ko, etc.) and rejects others
	// (e.g. `yue` for Cantonese) with HTTP 400 even though they're
	// valid ISO 639-1. The clean fix for OpenAI's actual API is to
	// omit the `language` field and let Whisper auto-detect — its
	// auto-detect handles Cantonese correctly. The local
	// `fw-openai-sts` shim (whisper.cpp) supports `yue` and
	// forwards to whisper.cpp's `--language yue`, so we keep
	// `language` for that path. Other OpenAI-compatible gateways
	// (faster-whisper-server, etc.) usually accept the same set
	// as their underlying model, so we keep `language` for them.
	//
	// The check is host-based: only OpenAI's actual API strips
	// `language`. Custom gateways on a different host keep it.
	let isOpenAiApi = false;
	try {
		const u = new URL(baseUrl);
		isOpenAiApi = u.host === "api.openai.com";
	} catch {
		// baseUrl was a relative or otherwise invalid URL; treat as
		// not-OpenAI (we'd have already failed the request anyway).
	}
	if (!isOpenAiApi) {
		form.append("language", lang);
	}
	form.append("response_format", "text");

	const headers: Record<string, string> = {};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			signal: controller.signal,
			body: form,
			headers,
		});
	} catch (err) {
		clearTimeout(timer);
		if ((err as Error).name === "AbortError") {
			throw new OpenAiSttError(
				`openai-stt: timeout after ${timeoutMs}ms`,
				2,
				{ baseUrl, url },
			);
		}
		throw new OpenAiSttError(
			`openai-stt: network error: ${(err as Error).message}`,
			2,
			{ baseUrl, url },
		);
	}
	clearTimeout(timer);

	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).slice(0, 500);
		throw new OpenAiSttError(
			`openai-stt: HTTP ${res.status} from ${url}\n${detail}`,
			res.status >= 500 ? 4 : 3,
			{ baseUrl, url, status: res.status, detail: detail.slice(0, 200) },
		);
	}

	const text = await res.text();
	const trimmed = text.trim();
	if (!trimmed) return "";
	return trimmed;
}
