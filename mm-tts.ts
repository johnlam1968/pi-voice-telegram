/**
 * mm-tts — MiniMax TTS HTTP client (TypeScript module, in-process).
 *
 * Reference: https://platform.minimaxi.com/docs/api-reference/speech-t2a-http
 *
 * v0.2.0 conversion: the original was a Node CLI invoked via spawn. It's
 * now an ESM module exporting `synthesize()` that the extension calls
 * directly. The CLI is gone — there's nothing to deploy to the agent's
 * `bin/` anymore. The host-side ffmpeg call (WAV → OGG) is in
 * `voice-reply.ts`.
 *
 * Two endpoints:
 *   - /v1/text_to_speech (speech-01 / speech-02): flat payload
 *   - /v1/t2a_v2        (speech-2.x):            nested voice_setting / audio_setting
 *
 * Auth sources (priority order):
 *   1. `apiKey` argument
 *   2. $MINIMAX_API_KEY
 *   3. `keyFile` argument
 *   4. ~/.mmx/config.json `key` (mmx-cli's canonical TTS key)
 *   5. $PI_CODING_AGENT_DIR/auth.json `minimax-cn` or `minimax-cn-m3-clean`
 *
 * Exit codes (now thrown as errors with `code`):
 *   1  usage / validation error
 *   2  network error
 *   3  API auth/quota error (HTTP 4xx)
 *   4  API server error (HTTP 5xx)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { request as httpsRequest } from "node:https";

/** MiniMax's legacy endpoint accepts only the short IDs "speech-01"/"speech-02". */
const SPEECH_LEGACY_MODEL_RE = /^speech-0[12]$/;

/** Per-chunk text limit for the legacy endpoint. */
const LEGACY_TEXT_LIMIT = 480;

/** Max parallel chunk requests when chunking is enabled. */
const DEFAULT_CONCURRENCY = 4;

/** Hard text limit for the modern endpoint (matches mmx-cli's check). */
const HARD_TEXT_LIMIT = 10000;

/** Public args shape. Defaults mirror the previous voice-reply defaults. */
export interface MmTtsArgs {
	/** Text to synthesize. */
	text: string;
	/** Voice ID. Default: Cantonese_PlayfulMan */
	voice?: string;
	/** Language boost. Default: Chinese,Yue */
	lang?: string;
	/** Model ID. Default: speech-2.8-hd */
	model?: string;
	/** Speed multiplier. Default: 1.0 */
	speed?: number;
	/** Output format: wav (recommended) | mp3 | pcm | flac. Default: wav */
	format?: "wav" | "mp3" | "pcm" | "flac";
	/** Sample rate in Hz. Default: 32000 */
	sampleRate?: number;
	/** Bitrate in bps. Default: 128000 */
	bitrate?: number;
	/** 1 (mono) or 2 (stereo). Default: 1 */
	channels?: number;
	/** Region: global | cn. Default: cn */
	region?: "global" | "cn";
	/** Override the API base URL */
	baseUrl?: string;
	/** Explicit API key */
	apiKey?: string;
	/** Path to a file containing the API key */
	keyFile?: string;
	/** Parallel chunk requests. Default: 4 */
	concurrency?: number;
	/** Force sequential chunks. Default: false */
	serial?: boolean;
	/** Patch the OGG/Opus OpusHead sample rate. Default: true */
	fixOpusSampleRate?: boolean;
	/** Suppress non-essential logging. Default: false */
	quiet?: boolean;
}

const DEFAULTS: Required<Omit<MmTtsArgs, "text" | "apiKey" | "keyFile">> = {
	voice: "Cantonese_PlayfulMan",
	lang: "Chinese,Yue",
	model: "speech-2.8-hd",
	speed: 1.0,
	format: "wav",
	sampleRate: 32000,
	bitrate: 128000,
	channels: 1,
	region: "cn",
	baseUrl: "",
	concurrency: DEFAULT_CONCURRENCY,
	serial: false,
	fixOpusSampleRate: true,
	quiet: false,
};

/** Error class for mm-tts failures. The `code` mirrors the old CLI exit codes. */
export class MmTtsError extends Error {
	constructor(
		message: string,
		readonly code: 1 | 2 | 3 | 4,
		readonly detail?: Record<string, unknown>,
	) {
		super(message);
		this.name = "MmTtsError";
	}
}

function loadApiKey(explicit: string | undefined, keyFile: string | undefined): string | null {
	if (explicit) return explicit;
	if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY;
	if (keyFile) {
		try {
			const v = readFileSync(keyFile, "utf8").trim();
			if (v) return v;
		} catch {
			// ignore
		}
	}
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
			if (obj["minimax-cn-m3-clean"]?.key) return obj["minimax-cn-m3-clean"].key;
		} catch {
			// ignore
		}
	}
	return null;
}

function baseUrlFor(region: "global" | "cn"): string {
	if (region === "global") return "api.minimax.io";
	return "api.minimaxi.com";
}

function pathFor(model: string): string {
	if (SPEECH_LEGACY_MODEL_RE.test(model)) return "/v1/text_to_speech";
	return "/v1/t2a_v2";
}

interface SynthesizeArgs extends MmTtsArgs {
	text: string;
}

function resolveArgs(args: SynthesizeArgs): Required<Omit<MmTtsArgs, "apiKey" | "keyFile">> {
	return { ...DEFAULTS, ...args };
}

interface AudioResponse {
	kind: "binary" | "hex" | "error";
	data?: Buffer;
	statusCode?: number;
	msg?: string;
}

function postJson(
	host: string,
	urlPath: string,
	headers: Record<string, string>,
	body: string,
): Promise<{ status: number; body: Buffer; contentType: string }> {
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
						contentType: (res.headers["content-type"] ?? ""),
					}),
				);
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

function extractAudio(resp: { status: number; body: Buffer; contentType: string }): AudioResponse {
	// Three response shapes:
	//   1) Raw binary audio (legacy endpoint, audio/mpeg or audio/ogg)
	//   2) JSON with hex audio (`{ data: { audio: "<hex>" } }` or `{ audio: "<hex>" }`)
	//   3) JSON error (`{ base_resp: { status_code, status_msg } }`)
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

/** Patch the OGG/Opus OpusHead input sample rate. */
function fixOggOpusSampleRate(buf: Buffer, expectedRate: number): { data: Buffer; changed: boolean; from?: number; to?: number } {
	const head = buf.indexOf("OpusHead");
	if (head < 0) return { data: buf, changed: false };
	if (head < 27) return { data: buf, changed: false };
	const version = buf[head + 8];
	if (version !== 1) return { data: buf, changed: false };
	const mappingFamily = buf[head + 18];
	if (mappingFamily !== 0) return { data: buf, changed: false };

	const currentRate = buf.readUInt32LE(head + 12);
	if (currentRate === expectedRate) return { data: buf, changed: false };

	const out = Buffer.from(buf);
	out.writeUInt32LE(expectedRate, head + 12);
	return { data: out, changed: true, from: currentRate, to: expectedRate };
}

/**
 * Split text on sentence boundaries, never producing a chunk larger than
 * maxLen characters. Prefers terminal punctuation; falls back to whitespace
 * and hard splits. Always returns at least one chunk.
 */
function splitText(text: string, maxLen: number): string[] {
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > maxLen) {
		const window = remaining.slice(0, maxLen + 1);
		let splitAt = -1;
		const dblNl = window.match(/\n\s*\n[^\n]/g);
		if (dblNl) {
			const last = dblNl[dblNl.length - 1]!;
			splitAt = remaining.indexOf(last) + last.indexOf("\n\n") + 2;
		} else {
			const sentEnds = window.match(/[。！？\.!\?][\s"'`」』\]）)]/g);
			if (sentEnds) {
				const last = sentEnds[sentEnds.length - 1]!;
				splitAt = remaining.indexOf(last) + last.length;
			} else {
				const sentOnly = window.match(/[。！？\.!\?]/g);
				if (sentOnly) {
					const last = sentOnly[sentOnly.length - 1]!;
					splitAt = remaining.indexOf(last) + last.length;
				} else {
					const ws = window.match(/\s/g);
					if (ws) {
						const last = ws[ws.length - 1]!;
						splitAt = remaining.indexOf(last) + last.length;
					} else {
						splitAt = maxLen;
					}
				}
			}
		}
		if (splitAt <= 0 || splitAt > maxLen + 1) splitAt = maxLen;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).replace(/^\s+/, "");
	}
	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

async function synthesizeChunk(
	text: string,
	resolved: Required<Omit<MmTtsArgs, "apiKey" | "keyFile">>,
	apiKey: string,
): Promise<Buffer> {
	const isFlat = SPEECH_LEGACY_MODEL_RE.test(resolved.model);
	const payload = isFlat
		? {
				model: resolved.model,
				text,
				stream: false,
				voice_id: resolved.voice,
				speed: Number(resolved.speed),
				vol: Number(resolved.speed), // vol reuses speed in legacy; not great but matches old CLI
				pitch: 0,
				sample_rate: Number(resolved.sampleRate),
				bitrate: Number(resolved.bitrate),
				format: resolved.format,
				channels: Number(resolved.channels),
				language_boost: resolved.lang,
			}
		: {
				model: resolved.model,
				text,
				stream: false,
				voice_setting: {
					voice_id: resolved.voice,
					speed: Number(resolved.speed),
					vol: Number(resolved.speed),
					pitch: 0,
				},
				audio_setting: {
					sample_rate: Number(resolved.sampleRate),
					bitrate: Number(resolved.bitrate),
					format: resolved.format,
					channels: Number(resolved.channels),
				},
				language_boost: resolved.lang,
			};

	const host = resolved.baseUrl || baseUrlFor(resolved.region);
	const urlPath = pathFor(resolved.model);
	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
	};

	let resp: { status: number; body: Buffer; contentType: string };
	try {
		resp = await postJson(host, urlPath, headers, JSON.stringify(payload));
	} catch (e) {
		throw new MmTtsError(`mm-tts: network error: ${(e as Error).message}`, 2, {
			host,
			urlPath,
		});
	}

	if (resp.status < 200 || resp.status >= 300) {
		const detail = resp.body.toString("utf8").slice(0, 800);
		throw new MmTtsError(
			`mm-tts: HTTP ${resp.status} from ${host}${urlPath}\n${detail}`,
			resp.status >= 500 ? 4 : 3,
			{ host, urlPath, status: resp.status, detail: detail.slice(0, 200) },
		);
	}

	const out = extractAudio(resp);
	if (out.kind === "error") {
		throw new MmTtsError(
			`mm-tts: API error ${out.statusCode}: ${out.msg}`,
			3,
			{ statusCode: out.statusCode, msg: out.msg },
		);
	}
	if (!out.data || out.data.length === 0) {
		throw new MmTtsError("mm-tts: empty audio payload", 1);
	}

	let writeBuf = out.data;
	if (resolved.fixOpusSampleRate) {
		const patched = fixOggOpusSampleRate(writeBuf, Number(resolved.sampleRate));
		if (patched.changed && !resolved.quiet) {
			process.stderr.write(
				`mm-tts: patched OpusHead sample rate ${patched.from} -> ${patched.to} Hz\n`,
			);
		}
		writeBuf = patched.data;
	}

	return writeBuf;
}

async function runPool<T>(items: T[], limit: number, worker: (item: T, idx: number) => Promise<Buffer>): Promise<Buffer[]> {
	const results: Buffer[] = [];
	let next = 0;
	const launch = async (): Promise<void> => {
		while (true) {
			const idx = next++;
			if (idx >= items.length) return;
			results[idx] = await worker(items[idx]!, idx);
		}
	};
	const runners: Promise<void>[] = [];
	for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(launch());
	await Promise.all(runners);
	return results;
}

/**
 * Synthesize text to an audio buffer (default format: wav).
 *
 * @throws MmTtsError on auth, network, API, or empty-payload failures.
 */
export async function synthesize(args: SynthesizeArgs): Promise<Buffer> {
	const resolved = resolveArgs(args);

	if (!args.text || args.text.trim() === "") {
		throw new MmTtsError("mm-tts: empty text", 1);
	}
	if (args.text.length > HARD_TEXT_LIMIT) {
		throw new MmTtsError(
			`mm-tts: text length ${args.text.length} exceeds ${HARD_TEXT_LIMIT} char limit`,
			1,
			{ length: args.text.length },
		);
	}

	const apiKey = loadApiKey(args.apiKey, args.keyFile);
	if (!apiKey) {
		throw new MmTtsError(
			"mm-tts: no MiniMax API key. Set $MINIMAX_API_KEY, pass apiKey/keyFile, or put one in /home/pi/.pi/agent/auth.json under 'minimax-cn'.",
			3,
		);
	}

	const isLegacy = SPEECH_LEGACY_MODEL_RE.test(resolved.model);
	const maxChunk = isLegacy ? LEGACY_TEXT_LIMIT : HARD_TEXT_LIMIT;

	if (args.text.length <= maxChunk) {
		if (!resolved.quiet) {
			process.stderr.write(`mm-tts: text ${args.text.length} chars (single chunk)\n`);
		}
		return await synthesizeChunk(args.text, resolved, apiKey);
	}

	const chunks = splitText(args.text, maxChunk);
	if (!resolved.quiet) {
		process.stderr.write(
			`mm-tts: text ${args.text.length} chars exceeds ${maxChunk}, splitting into ${chunks.length} chunks (concurrency=${resolved.concurrency})\n`,
		);
	}
	if (chunks.length === 1) {
		return await synthesizeChunk(chunks[0]!, resolved, apiKey);
	}
	const concurrency = resolved.serial ? 1 : Math.max(1, resolved.concurrency);
	const buffers = await runPool(chunks, concurrency, (chunk) => synthesizeChunk(chunk, resolved, apiKey));
	const finalBuf = Buffer.concat(buffers);
	if (!resolved.quiet) {
		process.stderr.write(`mm-tts: stitched ${chunks.length} chunks into ${finalBuf.length} bytes\n`);
	}
	return finalBuf;
}

/**
 * Convenience: synthesize text and write to a file.
 *
 * Creates the parent directory if needed. Throws on write failure.
 */
export async function synthesizeToFile(args: SynthesizeArgs & { out: string }): Promise<void> {
	const buf = await synthesize(args);
	const out = resolve(args.out);
	const dir = dirname(out);
	if (dir && dir !== "." && dir !== "/") {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(out, buf);
}

/** Read a text payload from --text-file (file path or `-` for stdin). */
export async function readTextFromArgs(args: MmTtsArgs & { text?: string; textFile?: string }): Promise<string> {
	if (args.text != null) return args.text;
	if (args.textFile === "-") {
		return new Promise<string>((resolveText, reject) => {
			let buf = "";
			process.stdin.setEncoding("utf8");
			process.stdin.on("data", (c: string) => (buf += c));
			process.stdin.on("end", () => resolveText(buf));
			process.stdin.on("error", reject);
		});
	}
	if (args.textFile) {
		const { readFile } = await import("node:fs/promises");
		return readFile(args.textFile, "utf8");
	}
	throw new MmTtsError("mm-tts: missing --text or --text-file", 1);
}

/** Build the JSON payload that would be sent to the API (diagnostic). */
export function buildPayloadFor(args: MmTtsArgs & { text: string }): Record<string, unknown> {
	const resolved = resolveArgs(args);
	const isFlat = SPEECH_LEGACY_MODEL_RE.test(resolved.model);
	return isFlat
		? {
				model: resolved.model,
				text: args.text,
				stream: false,
				voice_id: resolved.voice,
				speed: Number(resolved.speed),
				vol: Number(resolved.speed),
				pitch: 0,
				sample_rate: Number(resolved.sampleRate),
				bitrate: Number(resolved.bitrate),
				format: resolved.format,
				channels: Number(resolved.channels),
				language_boost: resolved.lang,
			}
		: {
				model: resolved.model,
				text: args.text,
				stream: false,
				voice_setting: {
					voice_id: resolved.voice,
					speed: Number(resolved.speed),
					vol: Number(resolved.speed),
					pitch: 0,
				},
				audio_setting: {
					sample_rate: Number(resolved.sampleRate),
					bitrate: Number(resolved.bitrate),
					format: resolved.format,
					channels: Number(resolved.channels),
				},
				language_boost: resolved.lang,
			};
}

// Suppress unused-import warnings for legacy optional fields
void existsSync;
