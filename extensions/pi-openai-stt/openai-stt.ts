/**
 * openai-stt — in-process client for the OpenAI `/v1/audio/transcriptions`
 * API gateway convention.
 *
 * The same code talks to:
 *   - OpenAI's actual API (`OPENAI_STT_BASE_URL=https://api.openai.com/v1`,
 *     `OPENAI_API_KEY=sk-...`)
 *   - The local `fw-openai-sts` shim (the on-host `whisper-server` exposed
 *     as OpenAI-compatible; preserves the existing CUDA + large-v3-in-VRAM
 *     setup with zero changes to the inference engine)
 *   - `faster-whisper-server` with `--enable-openai-api`
 *   - `whisper-asr-webservice`
 *   - Any other OpenAI-compatible gateway
 *
 * Env vars (all read at call time, no caching):
 *   - `OPENAI_STT_BASE_URL` (default `https://api.openai.com/v1`).
 *   - `OPENAI_API_KEY` (optional; only the `Authorization` header is sent
 *     when the key is set. The local shim ignores the header; OpenAI's
 *     API requires it.)
 *   - `OPENAI_STT_MODEL` (default `whisper-1`).
 *   - `PI_TELEGRAM_LANG` (default `yue`).
 *
 * Errors are thrown as `OpenAiSttError` with `code: 1|2|3|4`:
 *   1  usage / validation
 *   2  network (timeout, DNS, connection refused)
 *   3  API client (HTTP 4xx, or malformed response)
 *   4  API server (HTTP 5xx)
 *
 * The provider in `index.ts` re-wraps `OpenAiSttError` as `ProviderError`
 * to keep the registry's `code: 1|2|3|4` taxonomy consistent with
 * `pi-whisper-stt` and the old monolithic's `WhisperSttError`.
 */

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
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "whisper-1";
const DEFAULT_LANG = "yue";

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

/** Transcribe an audio file via the OpenAI `/v1/audio/transcriptions`
 *  endpoint. Throws `OpenAiSttError` on validation, network, or
 *  server failures. */
export async function transcribe(args: OpenAiSttArgs): Promise<string> {
	if (!args.inputPath) {
		throw new OpenAiSttError("openai-stt: missing inputPath", 1);
	}

	const baseUrl = (args.baseUrl ?? process.env.OPENAI_STT_BASE_URL ?? DEFAULT_BASE_URL).replace(
		/\/$/,
		"",
	);
	const apiKey = args.apiKey ?? process.env.OPENAI_API_KEY;
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
	form.append("language", lang);
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
