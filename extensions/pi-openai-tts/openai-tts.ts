/**
 * openai-tts — in-process client for the OpenAI `/v1/audio/speech`
 * API endpoint, plus a small config-resolution layer that matches
 * the `pi-openai-stt` pattern (telegram.json > env > auth.json >
 * smart default).
 *
 * The same code talks to:
 *   - OpenAI's actual API (`base_url=https://api.openai.com/v1`,
 *     `api_key=sk-...`).
 *   - Any OpenAI-compatible TTS gateway that implements
 *     `POST /v1/audio/speech` (none mainstream as of 2026-08, but
 *     the same convention as the STT side).
 *
 * v0.1.0: initial. The `telegram.json` config surface is
 * `extensions["pi-openai-tts"].{base_url, api_key, voice, model,
 * speed}`. Env-var overrides win for one-off CI / container runs
 * (the `pi-openai-stt` precedence: explicit arg > telegram.json >
 * env > auth.json > smart default).
 *
 * Telegram's `sendVoice` accepts OGG/Opus natively. OpenAI's
 * `response_format: "opus"` returns Opus-in-OGG (`Content-Type:
 * audio/ogg`), which is what we save as the audio path. No
 * ffmpeg-side rewrap is required for the cloud path. Local
 * gateways (none today, but the convention is open) should match
 * the same shape.
 *
 * Errors are thrown as `OpenAiTtsError` with `code: 1|2|3|4`
 * (parallel to `pi-openai-stt`'s `OpenAiSttError`):
 *   1  usage / validation (bad model, voice, speed, or auth)
 *   2  network (timeout, DNS, connection refused)
 *   3  API client (HTTP 4xx, or malformed response)
 *   4  API server (HTTP 5xx)
 *
 * The provider in `index.ts` re-wraps `OpenAiTtsError` as
 * `TtsProviderError` to keep the registry's `code: 1|2|3|4` taxonomy
 * consistent across all TTS providers and parallel to the STT
 * side.
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import type { TtsRequest, TtsResult } from "../pi-telegram-tts-minimax/tts-provider.js";

const DEFAULT_MODEL = "tts-1";
const DEFAULT_VOICE = "alloy";
/** Telegram's `sendVoice` wants OGG/Opus. OpenAI's `response_format:
 *  "opus"` returns Opus-in-OGG, which matches. */
const DEFAULT_FORMAT = "opus";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_SPEED = 1.0;

/** OpenAI's actual TTS API. */
const OPENAI_TTS_BASE_URL = "https://api.openai.com/v1";

const ALLOWED_VOICES = new Set([
	"alloy",
	"echo",
	"fable",
	"onyx",
	"nova",
	"shimmer",
]);
const ALLOWED_FORMATS = new Set([
	"mp3",
	"opus",
	"aac",
	"flac",
	"wav",
	"pcm",
]);

export class OpenAiTtsError extends Error {
	constructor(
		message: string,
		readonly code: 1 | 2 | 3 | 4,
		readonly detail?: Record<string, unknown>,
	) {
		super(message);
		this.name = "OpenAiTtsError";
	}
}

/** Read the OpenAI API key from `~/.pi/agent/auth.json` (the standard
 *  pi-coding-agent credentials file). Returns `undefined` if the file
 *  is missing, unreadable, malformed, or doesn't have an `openai.key`
 *  entry. Mirrors `pi-openai-stt/openai-stt.ts`. */
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
		// ignore parse errors
	}
	return undefined;
}

/** Read the `extensions["pi-openai-tts"]` block from `telegram.json`.
 *  Returns an empty object if missing. Supported keys: `base_url`,
 *  `api_key`, `voice`, `model`. Mirrors `pi-openai-stt/openai-stt.ts`. */
function readTelegramJsonTtsConfig(): {
	baseUrl?: string;
	apiKey?: string;
	voice?: string;
	model?: string;
} {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const configPath = join(dir, "telegram.json");
	if (!existsSync(configPath)) return {};
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as {
			extensions?: Record<
				string,
				{
					base_url?: unknown;
					api_key?: unknown;
					voice?: unknown;
					model?: unknown;
				}
			>;
		};
		const ext = parsed.extensions?.["pi-openai-tts"];
		if (!ext || typeof ext !== "object") return {};
		return {
			baseUrl: typeof ext.base_url === "string" && ext.base_url ? ext.base_url : undefined,
			apiKey: typeof ext.api_key === "string" && ext.api_key ? ext.api_key : undefined,
			voice: typeof ext.voice === "string" && ext.voice ? ext.voice : undefined,
			model: typeof ext.model === "string" && ext.model ? ext.model : undefined,
		};
	} catch {
		return {};
	}
}

/** First non-empty value in `values`. Treats `undefined`, `null`,
 *  `""` as unset. */
function firstNonEmpty(
	...values: Array<string | undefined>
): string | undefined {
	for (const v of values) {
		if (v !== undefined && v !== null && v !== "") return v;
	}
	return undefined;
}

/** Synthesize `text` via the OpenAI `/v1/audio/speech` endpoint and
 *  return the audio path + metadata. Throws `OpenAiTtsError` on
 *  validation, network, or server failures. */
export async function synthesize(req: TtsRequest): Promise<TtsResult> {
	if (!req.text) {
		throw new OpenAiTtsError("openai-tts: missing text", 1);
	}
	if (req.text.length > 4096) {
		// OpenAI's /audio/speech caps input at 4096 chars.
		throw new OpenAiTtsError(
			`openai-tts: text too long (${req.text.length} > 4096)`,
			1,
			{ textLength: req.text.length },
		);
	}

	const telegramConfig = readTelegramJsonTtsConfig();

	// apiKey: explicit arg > telegram.json > env > auth.json. The
	// local shim (none for TTS as of v0.1.0) would ignore the
	// header; OpenAI's API requires it. A missing key on the
	// cloud path will return 401, which we surface as code 3.
	const apiKey = firstNonEmpty(
		telegramConfig.apiKey,
		process.env.OPENAI_API_KEY,
		readOpenAiKeyFromAuthJson(),
	);

	// baseUrl: telegram.json > env > smart default (OpenAI's API).
	const baseUrl = firstNonEmpty(
		telegramConfig.baseUrl,
		process.env.OPENAI_TTS_BASE_URL,
		OPENAI_TTS_BASE_URL,
	)!.replace(/\/$/, "");

	// voice / model / format: explicit arg > telegram.json > env > default.
	const voice = firstNonEmpty(
		req.voice,
		telegramConfig.voice,
		process.env.OPENAI_TTS_VOICE,
		DEFAULT_VOICE,
	)!;
	if (!ALLOWED_VOICES.has(voice)) {
		throw new OpenAiTtsError(
			`openai-tts: invalid voice "${voice}" (allowed: ${[...ALLOWED_VOICES].join(", ")})`,
			1,
			{ voice, allowed: [...ALLOWED_VOICES] },
		);
	}
	const model = firstNonEmpty(
		req.model,
		telegramConfig.model,
		process.env.OPENAI_TTS_MODEL,
		DEFAULT_MODEL,
	)!;
	if (model !== "tts-1" && model !== "tts-1-hd") {
		throw new OpenAiTtsError(
			`openai-tts: invalid model "${model}" (allowed: tts-1, tts-1-hd)`,
			1,
			{ model },
		);
	}
	const responseFormat = firstNonEmpty(
		req.responseFormat,
		process.env.OPENAI_TTS_FORMAT,
		DEFAULT_FORMAT,
	) as TtsRequest["responseFormat"];
	if (!ALLOWED_FORMATS.has(responseFormat)) {
		throw new OpenAiTtsError(
			`openai-tts: invalid response_format "${responseFormat}" (allowed: ${[...ALLOWED_FORMATS].join(", ")})`,
			1,
			{ responseFormat, allowed: [...ALLOWED_FORMATS] },
		);
	}
	const speed = req.speed ?? DEFAULT_SPEED;
	if (speed < 0.25 || speed > 4.0) {
		throw new OpenAiTtsError(
			`openai-tts: invalid speed ${speed} (allowed: 0.25–4.0)`,
			1,
			{ speed },
		);
	}

	const url = `${baseUrl}/audio/speech`;

	// OpenAI's /audio/speech uses application/json, not multipart.
	const body = JSON.stringify({
		model,
		input: req.text,
		voice,
		response_format: responseFormat,
		...(speed !== DEFAULT_SPEED ? { speed } : {}),
	});

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

	const startedAt = Date.now();
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			signal: controller.signal,
			headers,
			body,
		});
	} catch (err) {
		clearTimeout(timer);
		if ((err as Error).name === "AbortError") {
			throw new OpenAiTtsError(
				`openai-tts: timeout after ${DEFAULT_TIMEOUT_MS}ms`,
				2,
				{ baseUrl, url },
			);
		}
		throw new OpenAiTtsError(
			`openai-tts: network error: ${(err as Error).message}`,
			2,
			{ baseUrl, url },
		);
	}
	clearTimeout(timer);

	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).slice(0, 500);
		throw new OpenAiTtsError(
			`openai-tts: HTTP ${res.status} from ${url}\n${detail}`,
			res.status >= 500 ? 4 : 3,
			{ baseUrl, url, status: res.status, detail: detail.slice(0, 200) },
		);
	}

	const audioBytes = Buffer.from(await res.arrayBuffer());
	if (audioBytes.length === 0) {
		throw new OpenAiTtsError("openai-tts: empty response body", 3, { url });
	}

	// Save to a temp file. The format is `opus` by default — Telegram
	// accepts OGG/Opus natively. Other formats are saved with the
	// matching extension for diagnostic clarity.
	const ext = responseFormat === "opus" ? "ogg" : responseFormat;
	const filename = `tts-${randomUUID()}.${ext}`;
	const audioPath = join(tmpdir(), filename);
	await writeFile(audioPath, audioBytes);

	const durationMs = Date.now() - startedAt;
	return {
		audioPath,
		transcriptText: req.text,
		language: req.lang,
		durationMs,
		metadata: {
			model,
			voice,
			responseFormat,
			speed,
			bytes: audioBytes.length,
		},
	};
}
