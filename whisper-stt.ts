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

/** Public args shape for language detection (no language hint, always verbose_json). */
export interface DetectArgs {
	/** Path to the audio file on disk. */
	inputPath: string;
	/** Per-call timeout in ms. Default: 30000. */
	timeoutMs?: number;
	/** Override the server base URL. */
	baseUrl?: string;
}

/**
 * Result of a language-detection call. The detected `language` is
 * whisper's lowercase English name (`"japanese"`, `"cantonese"`,
 * `"english"`, ...). `confidence` is whisper's `detected_language_probability`
 * in the 0–1 range; values > 0.5 are usually trustworthy, > 0.85
 * very reliable. `transcript` is what whisper heard during detection —
 * useful for double-checking that the audio decoded cleanly.
 * `languageProbabilities` is the full per-language distribution
 * (optional, only populated when verbose_json returns it).
 */
export interface DetectResult {
	/** Detected language (lowercase English name). */
	language: string;
	/** Confidence in the detection, 0-1. */
	confidence: number;
	/** Transcript produced during detection. */
	transcript: string;
	/** Full per-language probability distribution. */
	languageProbabilities?: Record<string, number>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_DETECT_TIMEOUT_MS = 30_000;
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

/**
 * Detect the language of an audio file via whisper-server's verbose_json
 * response. Does NOT send the `language` form field — that triggers
 * whisper-server's auto-detect path and returns `detected_language` +
 * `detected_language_probability` in the JSON body. The transcript is
 * also returned (whisper transcribes in the detected language).
 *
 * Use this as a self-check after a TTS synthesis: did the audio come
 * out in the language we asked for? Useful for catching the
 * "cross-language voice+lang boost" misfires (e.g. voice=Cantonese_*
 * + lang=Japanese producing audio that's neither Cantonese nor
 * Japanese, or the operator misconfigured the boost).
 *
 * v0.16.0: initial implementation. The endpoint already existed in
 * whisper-server; the client just didn't expose it.
 *
 * @throws WhisperSttError on validation, network, or server failures.
 */
export async function detectLanguage(args: DetectArgs): Promise<DetectResult> {
	if (!args.inputPath) {
		throw new WhisperSttError("whisper-stt: missing inputPath", 1);
	}

	const baseUrl = (args.baseUrl ?? process.env.WHISPER_SERVER_URL ?? DEFAULT_BASE_URL).replace(
		/\/$/,
		"",
	);
	const timeoutMs = args.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
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
	// Pass `null` for the language field — that's what triggers detection.
	const body = buildMultipart(boundary, filename, bytes, null, "verbose_json");

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
			throw new WhisperSttError(
				`whisper-stt: detectLanguage timeout after ${timeoutMs}ms`,
				2,
				{ baseUrl, url },
			);
		}
		throw new WhisperSttError(
			`whisper-stt: detectLanguage network error: ${(err as Error).message}`,
			2,
			{ baseUrl, url },
		);
	}
	clearTimeout(timer);

	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).slice(0, 500);
		throw new WhisperSttError(
			`whisper-stt: detectLanguage HTTP ${res.status} from ${url}\n${detail}`,
			res.status >= 500 ? 4 : 3,
			{ baseUrl, url, status: res.status, detail: detail.slice(0, 200) },
		);
	}

	const jsonText = await res.text();
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(jsonText) as Record<string, unknown>;
	} catch (err) {
		throw new WhisperSttError(
			`whisper-stt: detectLanguage: server returned non-JSON: ${jsonText.slice(0, 200)}`,
			3,
			{ baseUrl, url, response: jsonText.slice(0, 200) },
		);
	}

	const language = (parsed.detected_language as string) ?? (parsed.language as string) ?? "";
	const confidence =
		typeof parsed.detected_language_probability === "number"
			? (parsed.detected_language_probability as number)
			: 0;
	const transcript =
		typeof parsed.text === "string" ? (parsed.text as string).trim() : "";
	const languageProbabilities = (parsed.language_probabilities as Record<string, number>) || undefined;

	if (!language) {
		throw new WhisperSttError(
			`whisper-stt: detectLanguage: response had no detected_language field: ${jsonText.slice(0, 300)}`,
			3,
			{ baseUrl, url, response: jsonText.slice(0, 200) },
		);
	}

	return { language, confidence, transcript, languageProbabilities };
}

function buildMultipart(
	boundary: string,
	filename: string,
	fileBytes: Buffer,
	lang: string | null,
	responseFormat: string,
): Buffer {
	// v0.16.3: fix `,` echo bug.
	//
	// Root cause: cpp-httplib's multipart parser (used by whisper.cpp's
	// whisper-server) searches for `\r\n--<boundary>` and treats everything
	// BEFORE that as the field value. Our v0.16.2 body had BOTH a trailing
	// `\r\n` on each value AND a leading `\r\n` on the next part, producing
	// TWO CRLFs between value and next boundary. The parser would find the
	// FIRST `\r\n` (the value's trailing one), so the value included the
	// trailing CRLF: `language` became `"yue\r\n"` instead of `"yue"`.
	// whisper.cpp rejected the malformed language code, fell back to a
	// degenerate decode, and returned `,`. The same bug applied to
	// `response_format` (became `"text\r\n"`), which fortunately matched
	// no known format and silently fell back to the server's default JSON
	// output — masking the bug for `text` mode.
	//
	// Fix: drop the trailing `\r\n` from each value. Each part (except the
	// first) still starts with `\r\n--<boundary>`, so the sequence between
	// value and next boundary becomes a single `\r\n` (provided by the next
	// part's leading CRLF). Result: the parser extracts just the raw value
	// bytes, matching what python-requests and curl produce.
	//
	// Verified via byte-level relay probes:
	//   - buggy body (v0.16.2): HTTP 200, body `,`
	//   - fixed body (v0.16.3): HTTP 200, body `我想睇下而家又點啦` (correct)
	//   - same OGG, curl:       HTTP 200, body `我想睇下而家又點啦`
	//
	// The file content (raw bytes between file-part headers and the next
	// boundary) is correctly extracted because the next part's leading
	// `\r\n` provides the boundary delimiter. The closing boundary is
	// also preceded by a `\r\n` so the last value's terminator and the
	// closing's leading CRLF are the same byte sequence.
	const CRLF = "\r\n";
	const parts: Buffer[] = [
		Buffer.from(
			`--${boundary}${CRLF}` +
				`Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
				`Content-Type: audio/ogg${CRLF}${CRLF}`,
		),
		fileBytes,
	];
	// Each subsequent part starts with `\r\n--<boundary>`. The leading
	// `\r\n` is the previous part's terminator (file bytes terminator for
	// the language part, language value terminator for the response_format
	// part, response_format value terminator for the closing). The value
	// itself has NO trailing `\r\n` — that's the parser's job to consume
	// when it finds the next `\r\n--<boundary>`.
	if (lang !== null) {
		parts.push(
			Buffer.from(
				`${CRLF}--${boundary}${CRLF}` +
					`Content-Disposition: form-data; name="language"${CRLF}${CRLF}` +
					`${lang}`,
			),
		);
	}
	parts.push(
		Buffer.from(
			`${CRLF}--${boundary}${CRLF}` +
				`Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}` +
				`${responseFormat}${CRLF}` +
				`--${boundary}--${CRLF}`,
		),
	);
	return Buffer.concat(parts);
}
