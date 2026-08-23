/**
 * openai-stt — in-process client for the OpenAI `/v1/audio/transcriptions`
 * API gateway convention.
 *
 * v0.8.0: subsumed into `pi-telegram-stt`. This file was previously in
 * a separate `pi-openai-stt` npm package; the module-load registration
 * now lives in `pi-telegram-stt/index.ts` and the `base_url` / `apiKey`
 * config keys now sit flat under `extensions["pi-telegram-stt"]` (with
 * a read-only fallback to the legacy `extensions["pi-openai-stt"]` block
 * for operators who haven't migrated yet). The `SttProvider` seam in
 * `stt-provider.ts` stays in case a future backend (e.g. a non-OpenAI
 * speech model) needs to be added without expanding the npm-package
 * surface.
 *
 * v0.4.5: `base_url` (and `OpenAiSttArgs.baseUrl`, and
 * `OPENAI_STT_BASE_URL`) accept a fallback chain — a `string[]` of
 * gateway URLs tried in order. The first non-empty transcript
 * wins; empty results and `OpenAiSttError`s both fall through to
 * the next URL. The natural on-host shape is
 * `["http://127.0.0.1:8081/v1", "https://api.openai.com/v1"]` —
 * local CUDA whisper-server runs free / low-latency until it dies,
 * then OpenAI takes over for the same call.
 *
 * v0.4.4: read `base_url` and `api_key` from `telegram.json` (the
 * bridge's canonical config file) before falling back to env vars
 * and the `auth.json` fallback. The recommended way to switch
 * between local (`fw-openai-sts` shim) and cloud (OpenAI's actual
 * API) is one line in `telegram.json`:
 *
 *   "extensions": {
 *     "pi-telegram-stt": { "base_url": "http://127.0.0.1:8081/v1" }
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
 * Config resolution (first non-empty list wins):
 *   1. Explicit `OpenAiSttArgs.baseUrl` (string or string[]; test path)
 *   2. `extensions["pi-telegram-stt"].base_url` / `.apiKey` in
 *      `telegram.json` (string or string[]; recommended for live config
 *      as of v0.8.0). Falls back to the legacy
 *      `extensions["pi-openai-stt"]` block (read-only) for operators
 *      who haven't migrated yet.
 *   3. `OPENAI_STT_BASE_URL` / `OPENAI_API_KEY` env vars
 *      (string for env, or comma-separated list for the fallback chain;
 *      CI / container overrides)
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
 * consistent across all STT providers and the old monolithic's
 * `WhisperSttError` (1=usage, 2=network, 3=4xx, 4=5xx).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { makeLogger } from "./_logger.js";
import { loadEchoConfig } from "./telegram-config.js";

const log = makeLogger("pi-telegram-stt/stt/http");

export interface OpenAiSttArgs {
	/** Path to the audio file on disk. */
	inputPath: string;
	/** BCP-47 / ISO-639-1 language code (e.g. "yue", "en", "zh"). */
	lang?: string;
	/** Per-call timeout in ms. Default: 60000. */
	timeoutMs?: number;
	/** Override the base URL. Either a single gateway URL (string)
	 *  or a fallback chain (string[]): the provider tries each URL
	 *  in order, returning the first non-empty transcript, and falls
	 *  through to the next on either an empty result or an
	 *  `OpenAiSttError`. Useful for "local first, cloud fallback"
	 *  topologies — set `telegram.json`'s `base_url` to
	 *  `["http://127.0.0.1:8081/v1", "https://api.openai.com/v1"]` and
	 *  the local shim runs free / low-latency until it dies, then
	 *  OpenAI takes over. */
	baseUrl?: string | string[];
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

/** Read the `extensions["pi-telegram-stt"]` block from `telegram.json`
 *  (the bridge's canonical config file) for the OpenAI STT config.
 *  Returns `{ baseUrl?, apiKey? }`. Reads the flat `base_url` /
 *  `apiKey` keys under the v0.8.0 shape; falls back to the legacy
 *  `extensions["pi-openai-stt"].base_url` / `.api_key` block for
 *  operators who haven't migrated yet (read-only fallback — the
 *  legacy block is no longer written by `saveEchoConfig`).
 *
 *  The supported keys are:
 *
 *    - `base_url` (flat, v0.8.0+) → overrides `OPENAI_STT_BASE_URL`
 *      (and the smart default that picks OpenAI's API when a key is
 *      present). Use `http://127.0.0.1:8081/v1` for the local
 *      `fw-openai-sts` shim, or any OpenAI-compatible gateway URL.
 *    - `apiKey` (flat, v0.8.0+)   → overrides `OPENAI_API_KEY` (and
 *      the `~/.pi/agent/auth.json` fallback). Useful for
 *      key-per-profile routing when one `telegram.json` is shared
 *      across multiple bot profiles.
 *    - `extensions["pi-openai-stt"].base_url` / `.api_key`
 *      (legacy, v0.7.x and earlier) → read-only fallback.
 *
 *  This makes the local-vs-cloud switch a one-line edit in
 *  `telegram.json` instead of an env-var dance, which matches the
 *  rest of the bridge's config conventions. Env vars still win for
 *  one-off overrides (CI, container runs). */
function readTelegramJsonSttConfig(): { baseUrl?: string | string[]; apiKey?: string } {
	const cfg = loadEchoConfig();
	const out: { baseUrl?: string | string[]; apiKey?: string } = {};
	if (cfg.base_url) out.baseUrl = cfg.base_url;
	if (cfg.apiKey) out.apiKey = cfg.apiKey;
	return out;
}

/** Read the OpenAI API key from `~/.pi/agent/auth.json` (the standard
 *  pi-coding-agent credentials file). Returns `undefined` if the file
 *  is missing, unreadable, malformed, or doesn't have an `openai.key`
 *  entry. Used as a fallback when the `OPENAI_API_KEY` env var isn't
 *  set — the on-host path "just works" if the operator already has
 *  the key in `auth.json` (which the LLM provider also reads).
 *
 *  `PI_CODING_AGENT_DIR` is honored via the upstream
 *  `getAgentDir()` helper (matches the bridge and the
 *  `pi-telegram-stt`'s `telegram-config.ts` pattern). */
function readOpenAiKeyFromAuthJson(): string | undefined {
	const dir = getAgentDir();
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

/** Normalize a `string | string[] | undefined` config value into a
 *  `string[]` of non-empty URLs. Drops non-string entries and empty
 *  strings. The fallback-chain semantics in `transcribe()` want a
 *  list, never a single string, so this is the one place we
 *  canonicalize. */
function normalizeBaseUrlList(value: unknown): string[] {
	if (typeof value === "string") {
		return value ? [value] : [];
	}
	if (Array.isArray(value)) {
		return value.filter((v): v is string => typeof v === "string" && Boolean(v));
	}
	return [];
}

/** Single-shot transcribe at one base URL. The loop in `transcribe()`
 *  calls this for each URL in the fallback chain. Returns the
 *  transcript (possibly empty) on success; throws `OpenAiSttError`
 *  on validation, network, or server failures. The caller decides
 *  whether an empty result means "fall through" or "give up". */
async function transcribeAtBaseUrl(
	inputPath: string,
	baseUrl: string,
	apiKey: string | undefined,
	model: string,
	lang: string,
	timeoutMs: number,
): Promise<string> {
	const url = `${baseUrl}/audio/transcriptions`;

	let bytes: Buffer;
	try {
		bytes = await readFile(inputPath);
	} catch (err) {
		throw new OpenAiSttError(
			`openai-stt: cannot read ${inputPath}: ${(err as Error).message}`,
			1,
			{ inputPath },
		);
	}
	const filename = inputPath.split("/").pop() ?? "voice.ogg";

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
			log.error("timeout", { baseUrl, url, timeoutMs });
			throw new OpenAiSttError(
				`openai-stt: timeout after ${timeoutMs}ms`,
				2,
				{ baseUrl, url },
			);
		}
		log.error("network error", { baseUrl, url, error: (err as Error).message });
		throw new OpenAiSttError(
			`openai-stt: network error: ${(err as Error).message}`,
			2,
			{ baseUrl, url },
		);
	}
	clearTimeout(timer);
	log.debug("http response", { baseUrl, status: res.status, ok: res.ok });

	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).slice(0, 500);
		log.error("http non-2xx", { baseUrl, status: res.status, detail: detail.slice(0, 200) });
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

/** Transcribe an audio file via the OpenAI `/v1/audio/transcriptions`
 *  endpoint. Throws `OpenAiSttError` on validation, network, or
 *  server failures. v0.4.4: walks a fallback chain of base URLs
 *  (one or more, in order), returning the first non-empty
 *  transcript. Empty results and `OpenAiSttError`s both fall
 *  through to the next URL. The final error is thrown if every URL
 *  in the chain fails. */
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
	// smart default. Each source can be a single URL or an array of
	// URLs (fallback chain); the first non-empty list wins. The
	// smart default is a single URL picked by whether a key is
	// resolvable: OpenAI's API if yes, local shim if no.
	//
	// `telegram.json` is the recommended live config source — set
	// `extensions["pi-openai-stt"].base_url` to either a URL or a
	// `["local", "cloud"]` array.
	const fromArgs = normalizeBaseUrlList(args.baseUrl);
	const fromTelegram = normalizeBaseUrlList(telegramSttConfig.baseUrl);
	const fromEnv = normalizeBaseUrlList(process.env.OPENAI_STT_BASE_URL);
	const explicitList = fromArgs.length > 0
		? fromArgs
		: fromTelegram.length > 0
			? fromTelegram
			: fromEnv;
	const baseUrls = (explicitList.length > 0
		? explicitList
		: [apiKey ? OPENAI_API_BASE_URL : LOCAL_SHIM_BASE_URL]
	).map((u) => u.replace(/\/$/, ""));

	const model = args.model ?? process.env.OPENAI_STT_MODEL ?? DEFAULT_MODEL;
	const lang = args.lang ?? process.env.PI_TELEGRAM_LANG ?? DEFAULT_LANG;
	const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// Walk the fallback chain. Empty result OR `OpenAiSttError` both
	// fall through to the next URL. The last error is thrown if
	// every URL fails; if they all returned empty (no errors), we
	// throw a synthesized error so the caller always sees an
	// `OpenAiSttError` rather than `undefined`.
	let lastError: OpenAiSttError | undefined;
	let emptyCount = 0;
	for (const baseUrl of baseUrls) {
		try {
			const result = await transcribeAtBaseUrl(
				args.inputPath,
				baseUrl,
				apiKey,
				model,
				lang,
				timeoutMs,
			);
			if (result) return result;
			emptyCount += 1;
			// Empty result — fall through to the next URL.
		} catch (err) {
			if (err instanceof OpenAiSttError) {
				lastError = err;
			} else {
				lastError = new OpenAiSttError(
					err instanceof Error ? err.message : String(err),
					1,
					{ baseUrl },
				);
			}
			// Errored — fall through to the next URL.
		}
	}

	if (lastError) {
		// Re-throw the last error but include the chain context so
		// the operator can see how many URLs were tried and which
		// ones were in the chain when nothing worked.
		throw new OpenAiSttError(
			`${lastError.message} (tried ${baseUrls.length} base URL(s) in order)`,
			lastError.code,
			{ ...lastError.detail, tried: baseUrls, emptyCount },
		);
	}
	throw new OpenAiSttError(
		`openai-stt: all ${baseUrls.length} base URL(s) returned empty transcripts`,
		1,
		{ tried: baseUrls, emptyCount },
	);
}
