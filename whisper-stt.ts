/**
 * whisper-stt — in-process client for the whisper-server STT HTTP API.
 *
 * v0.3.0 conversion: the original was a bash wrapper (`fw-cuda-stdout`)
 * that POSTed an OGG file to `${WHISPER_SERVER_URL}/inference` via
 * Node's built-in `fetch`. This module does the same in pure TypeScript
 * — no shell, no spawn, no temp Node subprocess, no file ownership
 * bookkeeping. The contract is identical: read an audio file, POST it
 * to whisper-server, return the transcript on success.
 *
 * whisper-server (https://github.com/ahmetoner/whisper-asr-webservice)
 * keeps the model loaded in VRAM, so per-call latency is just network
 * + inference. The `--convert` flag on the server handles ffmpeg
 * conversion internally, so we can pass the OGG directly without
 * decoding client-side.
 *
 * Auth sources (priority order):
 *   1. `baseUrl` argument
 *   2. $WHISPER_SERVER_URL
 *   3. http://127.0.0.1:8080 (default)
 *
 * Language sources (priority order):
 *   1. `lang` argument
 *   2. $PI_TELEGRAM_LANG
 *   3. "yue" (default — Cantonese, the operator's working language)
 *
 * Errors are thrown as `WhisperSttError` with `code: 1|2|3|4`:
 *   1  usage / validation error
 *   2  network error (timeout, DNS, connection refused)
 *   3  API client error (HTTP 4xx, or "error: …" body)
 *   4  API server error (HTTP 5xx)
 */

import { readFile } from "node:fs/promises";

/** Public args shape. */
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

/** Error class for whisper-stt failures. The `code` mirrors the bash exit codes 5/6/7/8 (offset by 4 so 1=usage, 2=network, 3=4xx, 4=5xx). */
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

/**
 * Transcribe an audio file to text via whisper-server.
 *
 * @throws WhisperSttError on validation, network, or server failures.
 */
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

	const boundary = `----pi${Date.now().toString(36)}`;
	const filename = args.inputPath.split("/").pop() ?? "voice.ogg";
	const body = buildMultipart(boundary, filename, bytes, lang, responseFormat);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			signal: controller.signal,
			headers: {
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
				"Content-Length": String(body.length),
			},
			body,
		});
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

function buildMultipart(
	boundary: string,
	filename: string,
	fileBytes: Buffer,
	lang: string,
	responseFormat: string,
): Buffer {
	const CRLF = "\r\n";
	const parts: Buffer[] = [
		Buffer.from(
			`--${boundary}${CRLF}` +
				`Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
				`Content-Type: audio/ogg${CRLF}${CRLF}`,
		),
		fileBytes,
		Buffer.from(
			`${CRLF}--${boundary}${CRLF}` +
				`Content-Disposition: form-data; name="language"${CRLF}${CRLF}` +
				`${lang}${CRLF}` +
				`--${boundary}${CRLF}` +
				`Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}` +
				`${responseFormat}${CRLF}` +
				`--${boundary}--${CRLF}`,
		),
	];
	return Buffer.concat(parts);
}
