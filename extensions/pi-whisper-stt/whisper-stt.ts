/**
 * whisper-stt — in-process client for the whisper-server STT HTTP API.
 *
 * Owned by `pi-whisper-stt` (v0.3.0). Moved here from
 * `extensions/pi-telegram-echo/whisper-stt.ts` so the STT is a
 * separate, installable provider package. `pi-telegram-echo` looks
 * it up in the provider registry at STT call time.
 *
 * The body is `multipart/form-data` to
 * `${WHISPER_SERVER_URL}/inference`; Node's built-in `FormData`
 * generates the boundary (a hand-rolled byte buffer was the source
 * of an upstream `,` echo bug — see the old `pi-voice-telegram`'s
 * git history for the full story).
 *
 * Env vars:
 *   - `WHISPER_SERVER_URL` (default `http://127.0.0.1:8080`)
 *   - `PI_TELEGRAM_LANG` (default `yue`)
 *
 * Errors are thrown as `WhisperSttError` with `code: 1|2|3|4`:
 *   1  usage / validation
 *   2  network (timeout, DNS, connection refused)
 *   3  API client (HTTP 4xx, or "error: …" body)
 *   4  API server (HTTP 5xx)
 *
 * After the v0.4.0+ refactor of the local whisper-server to speak
 * the OpenAI-compatible API gateway convention, this package is
 * deprecated in favor of `pi-openai-stt` (one provider, many
 * backends). The shim is a host-side Node script (no upstream
 * whisper.cpp change needed).
 */

import { readFile } from "node:fs/promises";

export interface SttArgs {
	/** Path to the audio file on disk. whisper-server's --convert flag decodes the format. */
	inputPath: string;
	/** BCP-47 / ISO-639-1 language code (e.g. "yue", "en", "zh"). */
	lang?: string;
	/** Per-call timeout in ms. Default: 60000. */
	timeoutMs?: number;
	/** Override the server base URL. */
	baseUrl?: string;
	/** Override the response format. Default: "text". */
	responseFormat?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_LANG = "yue";
const DEFAULT_RESPONSE_FORMAT = "text";

export class WhisperSttError extends Error {
	constructor(
		message: string,
		readonly code: 1 | 2 | 3 | 4,
		readonly detail?: Record<string, unknown>,
	) {
		super(message);
		this.name = "WhisperSttError";
	}
}

/** Transcribe an audio file via whisper-server. Throws `WhisperSttError`
 *  on validation, network, or server failures. */
export async function transcribe(args: SttArgs): Promise<string> {
	if (!args.inputPath) {
		throw new WhisperSttError("whisper-stt: missing inputPath", 1);
	}

	const baseUrl = (args.baseUrl ?? process.env.WHISPER_SERVER_URL ?? DEFAULT_BASE_URL).replace(
		/\/$/,
		"",
	);
	const lang = args.lang ?? process.env.PI_TELEGRAM_LANG ?? DEFAULT_LANG;
	const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const responseFormat = args.responseFormat ?? DEFAULT_RESPONSE_FORMAT;
	const url = `${baseUrl}/inference`;

	// Build the multipart body. Read the file into a Buffer and wrap in a
	// Blob (with `type: "audio/ogg"`) so the part has both a Content-Type
	// and a filename. `fetch()` reads the FormData, generates a unique
	// boundary, sets the proper Content-Type, and computes Content-Length.
	let bytes: Buffer;
	try {
		bytes = await readFile(args.inputPath);
	} catch (err) {
		throw new WhisperSttError(
			`whisper-stt: cannot read ${args.inputPath}: ${(err as Error).message}`,
			1,
			{ inputPath: args.inputPath },
		);
	}
	const filename = args.inputPath.split("/").pop() ?? "voice.ogg";
	const form = new FormData();
	form.append("file", new Blob([bytes], { type: "audio/ogg" }), filename);
	form.append("language", lang);
	form.append("response_format", responseFormat);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let res: Response;
	try {
		// fetch + FormData sets Content-Type (with the right boundary) and
		// Content-Length automatically. Do NOT set Content-Type manually —
		// that would clobber the boundary.
		res = await fetch(url, { method: "POST", signal: controller.signal, body: form });
	} catch (err) {
		clearTimeout(timer);
		if ((err as Error).name === "AbortError") {
			throw new WhisperSttError(`whisper-stt: timeout after ${timeoutMs}ms`, 2, {
				baseUrl,
				url,
			});
		}
		throw new WhisperSttError(
			`whisper-stt: network error: ${(err as Error).message}`,
			2,
			{ baseUrl, url },
		);
	}
	clearTimeout(timer);

	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).slice(0, 500);
		throw new WhisperSttError(
			`whisper-stt: HTTP ${res.status} from ${url}\n${detail}`,
			res.status >= 500 ? 4 : 3,
			{ baseUrl, url, status: res.status, detail: detail.slice(0, 200) },
		);
	}

	const text = await res.text();
	const trimmed = text.trim();
	if (!trimmed) return "";
	if (trimmed.toLowerCase().startsWith("error")) {
		throw new WhisperSttError(`whisper-stt: server error: ${trimmed}`, 3, {
			baseUrl,
			url,
			response: trimmed.slice(0, 200),
		});
	}
	return trimmed;
}
