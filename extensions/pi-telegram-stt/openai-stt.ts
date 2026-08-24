/**
 * openai-stt — in-process client for the OpenAI `/v1/audio/transcriptions`
 * gateway convention, plus the package's bundled STT provider.
 *
 * Talks to OpenAI's actual API, the local `fw-openai-sts` shim,
 * `faster-whisper-server`, `whisper-asr-webservice`, and any other
 * OpenAI-compatible gateway. The full version history + design
 * + config resolution + error taxonomy live in
 * `docs/STT-PACKAGE.md` (this file is intentionally terse — the
 * implementation is short, the docstring would be longer than the
 * code).
 *
 * Provider registration: `registerOpenAiSttProvider()` is the
 * module-load side effect that puts the provider in the
 * in-process registry before any `session_start` fires (load-
 * order invariant from v0.3.1).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { makeLogger } from "./_logger.js";
import { loadEchoConfig } from "./telegram-config.js";
import {
	registerSttProvider,
	unregisterSttProvider,
	ProviderError,
	type SttProvider,
	type SttRequest,
} from "./stt-provider.js";

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
	 *  `OpenAiSttError`. */
	baseUrl?: string | string[];
	/** Override the API key. */
	apiKey?: string;
	/** Override the model name. */
	model?: string;
}

const PROVIDER_ID = "pi-openai-stt";

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

/** Read the flat `base_url` / `apiKey` keys from
 *  `extensions["pi-telegram-stt"]` in `telegram.json`. The
 *  recommended live config source; the env-var + auth.json
 *  fallbacks come later in `transcribe()`. */
function readTelegramJsonSttConfig(): { baseUrl?: string | string[]; apiKey?: string } {
	const cfg = loadEchoConfig();
	const out: { baseUrl?: string | string[]; apiKey?: string } = {};
	if (cfg.base_url) out.baseUrl = cfg.base_url;
	if (cfg.apiKey) out.apiKey = cfg.apiKey;
	return out;
}

/** Read the OpenAI API key from `~/.pi/agent/auth.json` (the
 *  LLM provider reads the same file). The on-host "just works"
 *  if the operator already has the key in `auth.json`. */
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

/** First non-empty value. `undefined` / `null` / `""` count as
 *  unset so a removed env var falls through to the next option. */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
	for (const v of values) {
		if (v !== undefined && v !== null && v !== "") return v;
	}
	return undefined;
}

/** Normalize a `string | string[] | undefined` to a `string[]`
 *  of non-empty URLs. The fallback chain in `transcribe()` wants
 *  a list, never a single string. */
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

	// Build the multipart body. `response_format=text` returns plain
	// text directly (no JSON unwrap).
	const form = new FormData();
	form.append("file", new Blob([bytes], { type: "audio/ogg" }), filename);
	form.append("model", model);
	// OpenAI's actual API rejects `language=yue` with HTTP 400 even
	// though it's a valid ISO 639-1 (auto-detect handles Cantonese
	// correctly). The local `fw-openai-sts` shim (whisper.cpp)
	// supports `yue`. So: strip `language` only for api.openai.com.
	// Other OpenAI-compatible gateways keep it.
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
 *  endpoint. Walks a fallback chain of base URLs; empty results
 *  and `OpenAiSttError`s both fall through to the next URL. The
 *  final error is thrown if every URL in the chain fails. */
export async function transcribe(args: OpenAiSttArgs): Promise<string> {
	if (!args.inputPath) {
		throw new OpenAiSttError("openai-stt: missing inputPath", 1);
	}

	// API key resolution: explicit arg > telegram.json > env > auth.json
	const telegramSttConfig = readTelegramJsonSttConfig();
	const apiKey = firstNonEmpty(
		args.apiKey,
		telegramSttConfig.apiKey,
		process.env.OPENAI_API_KEY,
		readOpenAiKeyFromAuthJson(),
	);

	// baseUrl resolution: explicit arg > telegram.json > env >
	// smart default (OpenAI's API if a key is resolvable, else the
	// local shim). Each source can be a single URL or an array.
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
		} catch (err) {
			lastError =
				err instanceof OpenAiSttError
					? err
					: new OpenAiSttError(
							err instanceof Error ? err.message : String(err),
							1,
							{ baseUrl },
					  );
		}
	}

	if (lastError) {
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

// --- Bundled STT provider (registered at module load) -------------------

/** Wrap `transcribe()` as an `SttProvider`. `OpenAiSttError` is
 *  re-wrapped as `ProviderError` to keep the registry's
 *  `code: 1|2|3|4` taxonomy consistent. */
const openaiProvider: SttProvider = {
	id: PROVIDER_ID,
	label: "🟢 OpenAI (any compatible)",
	async transcribe(req: SttRequest): Promise<string> {
		log.info("transcribe start", { file: req.inputPath, lang: req.lang });
		try {
			const text = await transcribe({ inputPath: req.inputPath, lang: req.lang });
			log.info("transcribe ok", { chars: text.length });
			return text;
		} catch (err) {
			if (err instanceof OpenAiSttError) {
				log.error("transcribe failed", {
					code: err.code,
					detail: err.detail ? JSON.stringify(err.detail) : undefined,
					error: err.message,
				});
				throw new ProviderError(err.message, err.code, err.detail);
			}
			log.error("transcribe failed (unwrapped)", {
				error: err instanceof Error ? err.message : String(err),
			});
			throw new ProviderError(
				err instanceof Error ? err.message : String(err),
				1,
			);
		}
	},
};

/** Register the bundled OpenAI-compatible provider in the
 *  in-process registry. Called at module load so the provider
 *  is in the registry before any `session_start` fires. The
 *  unregister-first-then-register pattern is idempotent: it
 *  handles both cold-start (nothing to unregister) and
 *  hot-reload (clears the stale entry from a previous load). */
export function registerOpenAiSttProvider(): void {
	unregisterSttProvider(PROVIDER_ID);
	registerSttProvider(openaiProvider);
	log.info("registered", { id: PROVIDER_ID });
}
