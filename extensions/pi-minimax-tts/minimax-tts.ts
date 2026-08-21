/**
 * minimax-tts — in-process client for the MiniMax T2A HTTP API
 * (`POST /v1/t2a_v2` for `speech-2.x` models, `POST /v1/text_to_speech`
 * for the legacy `speech-01`/`speech-02` models), plus a small
 * ffmpeg step that wraps the synthesized audio in OGG/Opus for
 * Telegram's `sendVoice`.
 *
 * Reference: https://platform.minimaxi.com/docs/api-reference/speech-t2a-http
 *
 * v0.1.0: initial. The MiniMax-specific knobs (`voice_id`,
 * `language_boost`, `emotion`, `pitch`, `vol`, region, model
 * selection) are exposed via the TtsRequest contract's `extras`
 * bag (or as first-class TtsRequest fields where the field name
 * matches OpenAI's). The OGG/Opus rewrap is local via `ffmpeg`
 * (already on the operator's PATH for the STT side; same binary
 * the old monolithic `voice-reply.ts` used).
 *
 * ## Auth resolution
 *
 * Mirrors the STT side's `firstNonEmpty` chain (priority order):
 *   1. `extras.apiKey` on the TtsRequest (test path)
 *   2. `extensions["pi-minimax-tts"].api_key` in `telegram.json`
 *   3. `$MINIMAX_API_KEY` env
 *   4. `~/.mmx/config.json` → `key` (mmx-cli's canonical TTS key)
 *   5. `~/.pi/agent/auth.json` → `minimax-cn.key` or
 *      `minimax-cn-m3-clean.key`
 *
 * ## Region / base URL
 *
 *   - `region: "cn"` (default) → `https://api.minimaxi.com`
 *   - `region: "global"`     → `https://api.minimax.io`
 *   - `base_url` (telegram.json or `extras.baseUrl`) overrides both.
 *
 * ## Errors
 *
 * Thrown as `MinimaxTtsError` with `code: 1|2|3|4` (parallel to
 * `OpenAiTtsError` and `ProviderError`):
 *   1  usage / validation (missing text, bad voice, bad model, bad speed)
 *   2  network (timeout, DNS, connection refused, ffmpeg spawn error)
 *   3  API client (HTTP 4xx, MiniMax `base_resp.status_code !== 0`)
 *   4  API server (HTTP 5xx, ffmpeg non-zero exit)
 *
 * The provider in `index.ts` re-wraps `MinimaxTtsError` as
 * `TtsProviderError` to keep the registry's code taxonomy
 * consistent across all TTS providers and parallel to the STT
 * side.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";

import type {
	TtsRequest,
	TtsResult,
	TtsVoice,
} from "../pi-telegram-tts-minimax/tts-provider.js";

const DEFAULT_MODEL = "speech-2.8-hd";
const DEFAULT_VOICE = "Cantonese_PlayfulMan";
const DEFAULT_LANG = "Chinese,Yue";
const DEFAULT_SPEED = 1.0;
const DEFAULT_SAMPLE_RATE = 32_000;
const DEFAULT_BITRATE = 128_000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_REGION: "cn" | "global" = "cn";
const DEFAULT_FORMAT = "wav"; // MiniMax returns WAV; ffmpeg wraps to OGG/Opus.
const DEFAULT_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 30_000;

const ALLOWED_FORMATS = new Set(["wav", "mp3", "pcm", "flac"]);
const ALLOWED_EMOTIONS = new Set([
	"happy",
	"sad",
	"angry",
	"fearful",
	"disgusted",
	"surprised",
	"neutral",
]);
const SPEECH_LEGACY_MODEL_RE = /^speech-0[12]$/;

/** BCP-47 / ISO-639-1 → MiniMax `language_boost` (CSV of language
 *  tags MiniMax uses to weight the model). The bridge's `lang`
 *  is BCP-47 ("yue", "en", "zh"); MiniMax's `language_boost`
 *  expects MiniMax's own labels ("Chinese,Yue", "English", …).
 *  The table is the common intersection; values not in the table
 *  fall through to the provider's default (`Chinese,Yue`) or
 *  `auto` (when the user explicitly passes `extras.lang` as
 *  `"auto"`). */
const BCP47_TO_MINIMAX_LANG: Record<string, string> = {
	auto: "auto",
	yue: "Chinese,Yue",
	zh: "Chinese",
	"zh-cn": "Chinese",
	"zh-tw": "Chinese",
	"zh-hk": "Chinese,Yue",
	en: "English",
	"en-us": "English",
	"en-gb": "English",
	ja: "Japanese",
	ko: "Korean",
	fr: "French",
	de: "German",
	es: "Spanish",
	ru: "Russian",
	it: "Italian",
	pt: "Portuguese",
	ar: "Arabic",
	hi: "Hindi",
	vi: "Vietnamese",
	id: "Indonesian",
	th: "Thai",
};

/** If the input is a MiniMax-recognized label (e.g., the user set
 *  `lang: "Chinese,Yue"` directly), pass it through. If it's
 *  BCP-47, translate via `BCP47_TO_MINIMAX_LANG`. If it's
 *  neither, return `undefined` so the field is omitted (which
 *  lets MiniMax auto-detect). */
function resolveLanguageBoost(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	if (BCP47_TO_MINIMAX_LANG[raw.toLowerCase()]) {
		return BCP47_TO_MINIMAX_LANG[raw.toLowerCase()];
	}
	// If the user passed a MiniMax label directly (e.g., "English",
	// "Chinese"), pass it through unchanged.
	if (/^[A-Z][a-z]+(,[A-Z][a-z]+)*$/.test(raw)) return raw;
	return undefined;
}

export class MinimaxTtsError extends Error {
	constructor(
		message: string,
		readonly code: 1 | 2 | 3 | 4,
		readonly detail?: Record<string, unknown>,
	) {
		super(message);
		this.name = "MinimaxTtsError";
	}
}

function firstNonEmpty(
	...values: Array<string | undefined>
): string | undefined {
	for (const v of values) {
		if (v !== undefined && v !== null && v !== "") return v;
	}
	return undefined;
}

function readTelegramJsonTtsConfig(): {
	baseUrl?: string;
	apiKey?: string;
	voice?: string;
	model?: string;
	region?: "cn" | "global";
	emotion?: string;
	lang?: string;
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
					region?: unknown;
					emotion?: unknown;
					lang?: unknown;
				}
			>;
		};
		const ext = parsed.extensions?.["pi-minimax-tts"];
		if (!ext || typeof ext !== "object") return {};
		return {
			baseUrl: typeof ext.base_url === "string" && ext.base_url ? ext.base_url : undefined,
			apiKey: typeof ext.api_key === "string" && ext.api_key ? ext.api_key : undefined,
			voice: typeof ext.voice === "string" && ext.voice ? ext.voice : undefined,
			model: typeof ext.model === "string" && ext.model ? ext.model : undefined,
			region:
				ext.region === "cn" || ext.region === "global" ? ext.region : undefined,
			emotion: typeof ext.emotion === "string" && ext.emotion ? ext.emotion : undefined,
			lang: typeof ext.lang === "string" && ext.lang ? ext.lang : undefined,
		};
	} catch {
		return {};
	}
}

function loadApiKey(
	explicit: string | undefined,
	telegramConfigKey: string | undefined,
): string | undefined {
	if (explicit) return explicit;
	if (telegramConfigKey) return telegramConfigKey;
	if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY;
	// mmx-cli's canonical TTS key
	const mmxCandidates = [
		join(homedir(), ".mmx", "config.json"),
		"/home/pi/.mmx/config.json",
		"/root/.mmx/config.json",
	];
	for (const p of mmxCandidates) {
		try {
			const obj = JSON.parse(readFileSync(p, "utf8")) as { key?: string };
			if (typeof obj.key === "string" && obj.key) return obj.key;
		} catch {
			// ignore
		}
	}
	// Pi's auth.json (LLM chat key fallback)
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const authCandidates = [
		join(agentDir, "auth.json"),
		"/home/pi/.pi/agent/auth.json",
		"/root/.pi/agent/auth.json",
	];
	for (const p of authCandidates) {
		try {
			const obj = JSON.parse(readFileSync(p, "utf8")) as Record<
				string,
				{ key?: string } | undefined
			>;
			if (obj["minimax-cn"]?.key) return obj["minimax-cn"].key;
			if (obj["minimax-cn-m3-clean"]?.key)
				return obj["minimax-cn-m3-clean"].key;
		} catch {
			// ignore
		}
	}
	return undefined;
}

function baseUrlFor(region: "cn" | "global"): string {
	return region === "global" ? "api.minimax.io" : "api.minimaxi.com";
}

function pathFor(model: string): string {
	return SPEECH_LEGACY_MODEL_RE.test(model)
		? "/v1/text_to_speech"
		: "/v1/t2a_v2";
}

interface PostJsonResult {
	status: number;
	body: Buffer;
	contentType: string;
}

function postJson(
	host: string,
	urlPath: string,
	headers: Record<string, string>,
	body: string,
): Promise<PostJsonResult> {
	return new Promise((resolve, reject) => {
		const data = Buffer.from(body, "utf8");
		const req = httpsRequest(
			{
				host,
				path: urlPath,
				method: "POST",
				headers: { ...headers, "Content-Length": data.length },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks),
						contentType: (res.headers["content-type"] ?? "") as string,
					}),
				);
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

interface AudioResponse {
	kind: "binary" | "hex" | "error";
	data?: Buffer;
	statusCode?: number;
	msg?: string;
}

/** Parse the MiniMax T2A response. Three shapes:
 *   1) Raw binary audio (legacy endpoint, audio/mpeg or audio/wav)
 *   2) JSON with hex audio (`{ data: { audio: "<hex>" } }` or
 *      `{ audio: "<hex>" }`)
 *   3) JSON error (`{ base_resp: { status_code, status_msg } }`)
 */
function extractAudio(resp: PostJsonResult): AudioResponse {
	try {
		const parsed = JSON.parse(resp.body.toString("utf8")) as {
			base_resp?: { status_code?: number; status_msg?: string };
			data?: { audio?: string };
			audio?: string;
		};
		if (parsed.base_resp?.status_code && parsed.base_resp.status_code !== 0) {
			return {
				kind: "error",
				statusCode: parsed.base_resp.status_code,
				msg: parsed.base_resp.status_msg,
			};
		}
		if (parsed.data?.audio) {
			return { kind: "hex", data: Buffer.from(parsed.data.audio, "hex") };
		}
		if (parsed.audio) {
			return { kind: "hex", data: Buffer.from(parsed.audio, "hex") };
		}
		return { kind: "error", statusCode: -1, msg: "no audio in response" };
	} catch {
		return { kind: "binary", data: resp.body };
	}
}

/** Wrap the synthesized audio in OGG/Opus via ffmpeg. Telegram's
 *  `sendVoice` accepts OGG/Opus natively. The argument set is
 *  the one verified by docs/MINIMAX-T2A-FINDINGS.md §1:
 *    -c:a libopus
 *    -b:a 32k                 (matches Telegram's voice-message
 *                              bandwidth; was 16k in v0.1.0)
 *    -application voip        (speech-optimized mode)
 *    -vbr on                  (variable bitrate)
 *    -compression_level 10    (max compression)
 *    -ac 1                    (mono)
 *    -ar 48000                (Opus native rate)
 *    -f ogg
 *  The earlier 24 kHz / 16 k / no compression_level was valid
 *  but produced a 48 kHz / unknown-rate output that decoders
 *  handled leniently; the verified 32 kbps / 48 kHz / compression
 *  level 10 settings are the round-trip-tested values. */
function runFfmpegToOggOpus(
	inputPath: string,
	outputPath: string,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const args = [
			"-y",
			"-loglevel",
			"error",
			"-i",
			inputPath,
			"-c:a",
			"libopus",
			"-b:a",
			"32k",
			"-application",
			"voip",
			"-vbr",
			"on",
			"-compression_level",
			"10",
			"-ac",
			"1",
			"-ar",
			"48000",
			"-f",
			"ogg",
			outputPath,
		];
		const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`minimax-tts: ffmpeg timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		let stderr = "";
		child.stderr.on("data", (c: Buffer) => {
			stderr += c.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new Error(`minimax-tts: ffmpeg spawn error: ${err.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve();
			} else {
				reject(
					new Error(
						`minimax-tts: ffmpeg exit ${code}: ${stderr.trim().slice(0, 500)}`,
					),
				);
			}
		});
	});
}

export async function synthesize(req: TtsRequest): Promise<TtsResult> {
	if (!req.text) {
		throw new MinimaxTtsError("minimax-tts: missing text", 1);
	}
	if (req.text.length > 10_000) {
		// Modern endpoint hard limit (matches mmx-cli's check).
		throw new MinimaxTtsError(
			`minimax-tts: text too long (${req.text.length} > 10000)`,
			1,
			{ textLength: req.text.length },
		);
	}

	const telegramConfig = readTelegramJsonTtsConfig();
	const extras = (req.extras ?? {}) as {
		apiKey?: string;
		baseUrl?: string;
		region?: "cn" | "global";
		emotion?: string;
		sampleRate?: number;
		bitrate?: number;
		channels?: number;
		format?: "wav" | "mp3" | "pcm" | "flac";
		timeoutMs?: number;
	};

	// Resolve config with the same precedence as the STT side.
	const apiKey = loadApiKey(extras.apiKey, telegramConfig.apiKey);
	if (!apiKey) {
		throw new MinimaxTtsError(
			"minimax-tts: missing API key (tried extras.apiKey, telegram.json, $MINIMAX_API_KEY, ~/.mmx/config.json, auth.json)",
			1,
		);
	}

	const model = firstNonEmpty(
		req.model,
		telegramConfig.model,
		process.env.MINIMAX_TTS_MODEL,
		DEFAULT_MODEL,
	)!;
	if (!/^speech-0[12](-.+)?$|^speech-2\..+/.test(model)) {
		// Be permissive on the modern side (speech-2.x family) since
		// MiniMax ships new versions frequently.
		if (!/^speech-2\./.test(model) && !SPEECH_LEGACY_MODEL_RE.test(model)) {
			throw new MinimaxTtsError(
				`minimax-tts: invalid model "${model}" (allowed: speech-01, speech-02, speech-2.*)`,
				1,
				{ model },
			);
		}
	}

	const voice = firstNonEmpty(
		req.voice,
		telegramConfig.voice,
		process.env.MINIMAX_TTS_VOICE,
		DEFAULT_VOICE,
	)!;

	const lang = firstNonEmpty(
		req.lang,
		telegramConfig.lang,
		process.env.MINIMAX_TTS_LANG,
		DEFAULT_LANG,
	)!;
	// Translate BCP-47 (the bridge's `lang` and the env's value)
	// to MiniMax's `language_boost` CSV format. If the input is
	// already a MiniMax label (e.g., the user set it directly in
	// `telegram.json`), pass it through. If neither, the field is
	// omitted (MiniMax auto-detects).
	const languageBoost = resolveLanguageBoost(lang);

	const region = firstNonEmpty(
		extras.region,
		telegramConfig.region,
		process.env.MINIMAX_TTS_REGION,
		DEFAULT_REGION,
	) as "cn" | "global";

	const baseUrl = firstNonEmpty(
		extras.baseUrl,
		telegramConfig.baseUrl,
		process.env.MINIMAX_TTS_BASE_URL,
		baseUrlFor(region),
	)!;

	const speed = req.speed ?? DEFAULT_SPEED;
	if (speed < 0.5 || speed > 2.0) {
		throw new MinimaxTtsError(
			`minimax-tts: invalid speed ${speed} (allowed: 0.5–2.0)`,
			1,
			{ speed },
		);
	}

	const emotion = firstNonEmpty(
		extras.emotion,
		telegramConfig.emotion,
		process.env.MINIMAX_TTS_EMOTION,
	) as string | undefined;
	if (emotion && !ALLOWED_EMOTIONS.has(emotion)) {
		throw new MinimaxTtsError(
			`minimax-tts: invalid emotion "${emotion}" (allowed: ${[...ALLOWED_EMOTIONS].join(", ")})`,
			1,
			{ emotion, allowed: [...ALLOWED_EMOTIONS] },
		);
	}

	const sampleRate = extras.sampleRate ?? DEFAULT_SAMPLE_RATE;
	const bitrate = extras.bitrate ?? DEFAULT_BITRATE;
	const channels = extras.channels ?? DEFAULT_CHANNELS;
	const format = (extras.format ?? DEFAULT_FORMAT) as "wav" | "mp3" | "pcm" | "flac";
	if (!ALLOWED_FORMATS.has(format)) {
		throw new MinimaxTtsError(
			`minimax-tts: invalid format "${format}" (allowed: ${[...ALLOWED_FORMATS].join(", ")})`,
			1,
			{ format, allowed: [...ALLOWED_FORMATS] },
		);
	}

	// Build the request body. Two shapes — legacy (speech-01/02) and
	// modern (speech-2.x). The legacy body is flat; the modern body
	// nests `voice_setting` / `audio_setting`.
	const isLegacy = SPEECH_LEGACY_MODEL_RE.test(model);
	const payload = isLegacy
		? {
				// Legacy `/v1/text_to_speech` (speech-01/02): flat
				// payload, uses `channels` (plural) per the legacy
				// docs. Note: speech-02 on this endpoint silently
				// returns Mandarin for Cantonese voice+boost — see
				// docs/MINIMAX-T2A-FINDINGS.md §2d. The default model
				// is `speech-2.8-hd` which routes via the modern
				// endpoint and actually produces Cantonese.
				model,
				text: req.text,
				stream: false,
				voice_id: voice,
				speed: Number(speed),
				vol: Number(speed),
				pitch: 0,
				sample_rate: Number(sampleRate),
				// `bitrate` is mp3-only per the modern docs §2 but
				// the legacy endpoint accepts it for any format; the
				// server ignores it for non-mp3. Send it
				// unconditionally for the legacy path.
				bitrate: Number(bitrate),
				format,
				channels: Number(channels),
				...(languageBoost ? { language_boost: languageBoost } : {}),
			}
		: {
				// Modern `/v1/t2a_v2` (speech-2.x): nested
				// voice_setting / audio_setting. Note the field is
				// `channel` (singular) per docs §2 — the legacy
				// `mm-tts` shipped `channels` (plural) which the API
				// accepted leniently, but the canonical name is
				// singular. `bitrate` is mp3-only per docs §2 (server
				// ignores it for other formats) — we only send it
				// when the format is mp3.
				model,
				text: req.text,
				stream: false,
				voice_setting: {
					voice_id: voice,
					speed: Number(speed),
					vol: Number(speed),
					pitch: 0,
					...(emotion ? { emotion } : {}),
				},
				audio_setting: {
					sample_rate: Number(sampleRate),
					...(format === "mp3" ? { bitrate: Number(bitrate) } : {}),
					format,
					channel: Number(channels),
				},
				...(languageBoost ? { language_boost: languageBoost } : {}),
			};

	const host = baseUrl;
	const urlPath = pathFor(model);
	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
	};

	const startedAt = Date.now();
	let resp: PostJsonResult;
	try {
		resp = await postJson(host, urlPath, headers, JSON.stringify(payload));
	} catch (e) {
		throw new MinimaxTtsError(
			`minimax-tts: network error: ${(e as Error).message}`,
			2,
			{ host, urlPath },
		);
	}

	if (resp.status < 200 || resp.status >= 300) {
		const detail = resp.body.toString("utf8").slice(0, 500);
		throw new MinimaxTtsError(
			`minimax-tts: HTTP ${resp.status} from ${host}${urlPath}\n${detail}`,
			resp.status >= 500 ? 4 : 3,
			{ host, urlPath, status: resp.status, detail: detail.slice(0, 200) },
		);
	}

	const audio = extractAudio(resp);
	if (audio.kind === "error") {
		throw new MinimaxTtsError(
			`minimax-tts: upstream error (status_code=${audio.statusCode}): ${audio.msg ?? "(no message)"}`,
			3,
			{ host, urlPath, statusCode: audio.statusCode, msg: audio.msg },
		);
	}
	if (!audio.data || audio.data.length === 0) {
		throw new MinimaxTtsError("minimax-tts: empty audio in response", 3, {
			host,
			urlPath,
		});
	}

	// Save the synthesized audio to a temp file. MiniMax returns WAV
	// (or whatever `format` is). We always rewrap to OGG/Opus via
	// ffmpeg because Telegram's `sendVoice` wants Opus-in-OGG.
	const intermediateExt = format === "pcm" ? "pcm" : format;
	const intermediatePath = join(tmpdir(), `tts-mm-${randomUUID()}.${intermediateExt}`);
	writeFileSync(intermediatePath, audio.data);

	const oggPath = join(tmpdir(), `tts-mm-${randomUUID()}.ogg`);
	try {
		await runFfmpegToOggOpus(intermediatePath, oggPath, FFMPEG_TIMEOUT_MS);
	} catch (err) {
		// Best-effort cleanup of the intermediate file on ffmpeg failure.
		try {
			const { unlinkSync } = await import("node:fs");
			unlinkSync(intermediatePath);
		} catch {
			// ignore
		}
		throw new MinimaxTtsError(
			`minimax-tts: ffmpeg rewrap failed: ${(err as Error).message}`,
			2,
			{ intermediatePath, oggPath },
		);
	}
	// Best-effort cleanup of the intermediate file.
	try {
		const { unlinkSync } = await import("node:fs");
		unlinkSync(intermediatePath);
	} catch {
		// ignore
	}

	const durationMs = Date.now() - startedAt;
	return {
		audioPath: oggPath,
		transcriptText: req.text,
		language: lang,
		durationMs,
		metadata: {
			model,
			voice,
			lang,
			region,
			emotion: emotion ?? null,
			speed,
			sampleRate,
			bitrate,
			channels,
			format,
			bytes: audio.data.length,
		},
	};
}

// --- Voice catalog (lazy-loaded, cached) -----------------------------------

interface MiniMaxVoiceEntry {
	index: number;
	voiceId: string;
	voiceName: string;
	language: string;
	languageKey: string;
}

interface MiniMaxVoiceCatalog {
	version: string;
	source: string;
	lastUpdated: string;
	count: number;
	voices: MiniMaxVoiceEntry[];
}

/** Resolve the path to the bundled `voices.json` catalog. The catalog
 *  is shipped alongside the source (see `package.json` `files`); we
 *  resolve via `import.meta.url` so the path works whether the
 *  package is loaded by jiti from source or by Node from
 *  `node_modules/pi-minimax-tts/`. */
function voicesCatalogPath(): string {
	// jiti-loaded modules: `import.meta.url` is the resolved file://
	// path of this source file. Walk up from `minimax-tts.ts` to
	// the package root, then to `voices.json`.
	const here = fileURLToPath(import.meta.url);
	return join(dirname(here), "voices.json");
}

let cachedCatalog: MiniMaxVoiceCatalog | null = null;
function loadCatalog(): MiniMaxVoiceCatalog {
	if (cachedCatalog) return cachedCatalog;
	const path = voicesCatalogPath();
	if (!existsSync(path)) {
		throw new MinimaxTtsError(
			`minimax-tts: voices.json not found at ${path}; the catalog is bundled with the package — reinstall pi-minimax-tts`,
			1,
			{ path },
		);
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as MiniMaxVoiceCatalog;
		if (!Array.isArray(parsed.voices)) {
			throw new Error("voices.json: missing `voices` array");
		}
		cachedCatalog = parsed;
		return parsed;
	} catch (err) {
		throw new MinimaxTtsError(
			`minimax-tts: failed to parse voices.json: ${(err as Error).message}`,
			1,
			{ path },
		);
	}
}

/** List MiniMax T2A voices from the bundled catalog (327 voices
 *  across 22 languages as of the 2026-08-17 catalog build). The
 *  catalog is static — re-running this is just a `readFileSync` on
 *  the bundled JSON, no upstream call. Cached at module scope
 *  after the first call.
 *
 *  The returned `TtsVoice[]` is the provider-agnostic shape from
 *  `pi-telegram-tts-minimax/tts-provider.ts`. Provider-specific
 *  fields (`languageKey` = Chinese label, `index` = catalog position)
 *  go in `metadata`. Voice ids are passed through byte-exact — see
 *  `docs/MINIMAX-T2A-FINDINGS.md` §2a for the parens byte-trap
 *  and §2b-bis for the ProfessionalHost stoplist. */
export async function listVoices(): Promise<readonly TtsVoice[]> {
	const catalog = loadCatalog();
	return catalog.voices.map((v) => ({
		id: v.voiceId,
		name: v.voiceName,
		language: v.language,
		// languageKey is the Chinese label from the upstream catalog;
		// keep it on `description` for visibility (English label is
		// in `language`).
		description: v.languageKey,
		// All voices work with all `speech-2.x` and the legacy
		// `speech-01`/`speech-02`. The §2a-byte-trap and §2b-bis-
		// stoplist are runtime concerns; the catalog doesn't encode
		// them.
		models: ["speech-01", "speech-02", "speech-2.x"],
		metadata: {
			index: v.index,
			languageKey: v.languageKey,
			catalogVersion: catalog.version,
			catalogSource: catalog.source,
		},
	}));
}
