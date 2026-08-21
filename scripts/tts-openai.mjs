#!/usr/bin/env node
// tts-openai.mjs — voice handler for the OpenAI `/v1/audio/speech` API.
//
// pi-telegram's `outboundHandlers` runs this with:
//   - the agent's reply text on stdin
//   - the bridge-substituted {mp3} path as `--out <path>`
//
// Reference: https://platform.openai.com/docs/api-reference/audio/createSpeech
// The OpenAI endpoint returns the audio BYTES DIRECTLY (no JSON, no
// hex) — much simpler than MiniMax. The next template step wraps
// the result in OGG/Opus via ffmpeg for Telegram's `sendVoice`.
//
// ## 100% knob adjustability (same shape as tts-minimax.mjs)
//
// Every field in the OpenAI TTS request body is reachable via CLI flags:
//   --model, --voice, --response-format, --speed, --instructions
// `--config <json>` is also accepted for forward-compat with fields
// the CLI doesn't cover. Precedence: built-in defaults → --config → CLI.
//
// ## Auth resolution
//
//   1. $OPENAI_API_KEY env var (operator-set)
//   2. ~/.pi/agent/auth.json → `openai.key` (the LLM key, reused)
//   3. (no smart default — we won't talk to OpenAI without a key)
//
// ## Error model
//
//   - Exit 2: caller config error (missing --out, missing API key,
//     invalid CLI value, missing text, malformed --config JSON)
//   - Exit 3: API / HTTP error (network, 4xx, 5xx)
//   - Exit 4: write to --out failed
//   - The bridge's `recordTelegramRuntimeEvent` picks up non-zero
//     exits and falls back to text delivery.
//
// ## Cantonese note
//
// Voices are English-optimized. For Cantonese, use:
//   --model gpt-4o-mini-tts --voice coral --instructions "Speak in Cantonese."
// (see docs/OPENAI-TTS-FINDINGS.md §1 for the verified round-trip).

import { writeFileSync, readFileSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { request as httpsRequest } from "node:https";

// ============================================================================
// Logger (same shape as tts-minimax.mjs; canonical observability channel
// for our code when the bridge's logs.jsonl is stale or frozen).
// ============================================================================

function argv_() {
	return process.argv.slice(2);
}

const VERBOSE =
	argv_().includes("-v") ||
	argv_().includes("--verbose") ||
	process.env.PI_VOICE_TELEGRAM_DEBUG === "1";

const LOG_LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const THRESHOLD = VERBOSE ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;

function fmtFields(fields) {
	if (!fields) return "";
	const parts = [];
	for (const [k, v] of Object.entries(fields)) {
		if (v === undefined || v === null) continue;
		const s = typeof v === "string" ? v : JSON.stringify(v);
		parts.push(`${k}=${s.length > 200 ? s.slice(0, 200) + "…" : s}`);
	}
	return parts.length ? " " + parts.join(" ") : "";
}

function logAt(level, msg, fields) {
	if (LOG_LEVELS[level] < THRESHOLD) return;
	const ts = new Date().toISOString();
	process.stderr.write(`${ts} [${level}] [tts-openai] ${msg}${fmtFields(fields)}\n`);
}

const log = {
	debug: (msg, fields) => logAt("DEBUG", msg, fields),
	info: (msg, fields) => logAt("INFO", msg, fields),
	warn: (msg, fields) => logAt("WARN", msg, fields),
	error: (msg, fields) => logAt("ERROR", msg, fields),
};

if (VERBOSE) {
	log.debug("verbose mode enabled", { argv: process.argv.slice(2).join(" ") });
}

// ============================================================================
// CLI parsing
// ============================================================================

const argv = process.argv.slice(2);

function getArg(name) {
	const eq = `--${name}=`;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === `--${name}`) return argv[i + 1];
		if (a.startsWith(eq)) return a.slice(eq.length);
	}
	return undefined;
}

function coerce(value) {
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
	return value;
}

function die(msg) {
	process.stderr.write(`tts-openai.mjs: ${msg}\n`);
	process.exit(2);
}

// ============================================================================
// Constraints (from docs/OPENAI-TTS-OPENAPI.md)
// ============================================================================

// All 13 built-in voices. The docs page lists these in two
// groups: 9 voices for tts-1/tts-1-hd, all 13 for gpt-4o-mini-tts.
// (The user copy didn't make this distinction explicit, but
// OPENAI-TTS-FINDINGS.md §1 documents it. The 4 voices not in
// tts-1/tts-1-hd: ballad, cedar, marin, verse.)
const ALL_VOICES = new Set([
	"alloy", "ash", "ballad", "coral", "echo", "fable",
	"marin", "nova", "onyx", "sage", "shimmer", "verse", "cedar",
]);
const LEGACY_VOICES = new Set([
	"alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer",
]);

const MODELS = new Set(["gpt-4o-mini-tts", "tts-1", "tts-1-hd"]);
const RESPONSE_FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);

const SPEED_RANGE = { min: 0.25, max: 4.0 };

function voicesForModel(model) {
	if (model === "gpt-4o-mini-tts") return ALL_VOICES;
	if (model === "tts-1" || model === "tts-1-hd") return LEGACY_VOICES;
	return ALL_VOICES;
}

function validateField(name, value, opts = {}) {
	if (value === undefined) return;
	if (opts.enum && !opts.enum.has(value)) {
		const allowed = opts.enumLabel ?? [...opts.enum].join(", ");
		die(`invalid value for ${name}: ${JSON.stringify(value)} (allowed: ${allowed})`);
	}
	if (opts.range) {
		const { min, max } = opts.range;
		if (typeof value !== "number" || Number.isNaN(value)) {
			die(`invalid value for ${name}: ${JSON.stringify(value)} (expected number in ${min}..${max})`);
		}
		if (value < min || value > max) {
			die(`out of range for ${name}: ${value} (allowed: ${min}..${max})`);
		}
	}
}

// ============================================================================
// Built-in defaults (Cantonese-leaning, mirroring tts-minimax.mjs)
// ============================================================================

const DEFAULTS = {
	model: "gpt-4o-mini-tts",
	voice: "coral",
	response_format: "mp3",
	speed: 1.0,
	// `instructions` is only sent if the model supports it. The
	// script only sends the field when --instructions is provided
	// explicitly (no default; adding a generic prompt would bias
	// the output unexpectedly).
};

// ============================================================================
// Build the request body: defaults ← --config ← CLI flags
// ============================================================================

function deepMerge(target, source) {
	for (const [k, v] of Object.entries(source)) {
		if (
			v !== null &&
			typeof v === "object" &&
			!Array.isArray(v) &&
			typeof target[k] === "object" &&
			!Array.isArray(target[k])
		) {
			deepMerge(target[k], v);
		} else {
			target[k] = v;
		}
	}
}

const body = { ...DEFAULTS };

// --config <json>: deep merge into body
const configPath = getArg("config");
if (configPath !== undefined) {
	let raw;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (e) {
		die(`--config ${configPath}: ${e.message}`);
	}
	let configObj;
	try {
		configObj = JSON.parse(raw);
	} catch (e) {
		die(`--config ${configPath}: invalid JSON: ${e.message}`);
	}
	if (configObj === null || typeof configObj !== "object" || Array.isArray(configObj)) {
		die(`--config ${configPath}: expected a JSON object`);
	}
	deepMerge(body, configObj);
	log.debug("config merged from file", { path: configPath, keys: Object.keys(configObj) });
}

// CLI: scalar flags. Each takes a value; coerced to number/boolean/string.
const CLI_TO_PATH = {
	model: "model",
	voice: "voice",
	"response-format": "response_format",
	speed: "speed",
	instructions: "instructions",
};

for (const [flag, path] of Object.entries(CLI_TO_PATH)) {
	const v = getArg(flag);
	if (v === undefined) continue;
	body[path] = coerce(v);
}

// ============================================================================
// Validate the assembled body
// ============================================================================

validateField("model", body.model, { enum: MODELS, enumLabel: [...MODELS].join(", ") });
validateField("voice", body.voice, { enum: voicesForModel(body.model) });
validateField("response_format", body.response_format, {
	enum: RESPONSE_FORMATS,
	enumLabel: [...RESPONSE_FORMATS].join(", "),
});
validateField("speed", body.speed, { range: SPEED_RANGE });
// `input` and `instructions` are strings — no enum/range to check.

log.debug("request body assembled", { body });

// ============================================================================
// Required: --out, text
// ============================================================================

const OUT = getArg("out");
if (!OUT) die("missing --out <path>");
log.debug("out path", { out: OUT });

const TEXT = getArg("text");
async function readStdin() {
	const chunks = [];
	for await (const c of process.stdin) chunks.push(c);
	return Buffer.concat(chunks).toString("utf8");
}
const text = TEXT ?? (await readStdin());
if (!text) die("empty text (no --text, no stdin)");
log.debug("text source", { source: TEXT !== undefined ? "--text" : "stdin", length: text.length });

body.input = text;

// ============================================================================
// Auth
// ============================================================================

function readAuthJson() {
	for (const p of [
		`${homedir()}/.pi/agent/auth.json`,
		"/home/pi/.pi/agent/auth.json",
		"/root/.pi/agent/auth.json",
	]) {
		try {
			const obj = JSON.parse(readFileSync(p, "utf8"));
			if (obj && typeof obj === "object") return obj;
		} catch {
			// try next
		}
	}
	return {};
}

const auth = readAuthJson();
const API_KEY = process.env.OPENAI_API_KEY ?? auth.openai?.key;
if (!API_KEY) {
	die(
		"missing API key (set OPENAI_API_KEY or write ~/.pi/agent/auth.json with `openai: { key: \"...\" }`)",
	);
}
log.debug("auth resolved", {
	apiKeySource: process.env.OPENAI_API_KEY ? "env" : "~/.pi/agent/auth.json",
});

const HOST = "api.openai.com";
const URL_PATH = "/v1/audio/speech";

// ============================================================================
// POST (binary response — Node's https.request streams into --out)
// ============================================================================

function postBinary(host, urlPath, payload, outPath) {
	return new Promise((resolve, reject) => {
		const data = Buffer.from(payload, "utf8");
		const req = httpsRequest(
			{
				host,
				path: urlPath,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${API_KEY}`,
					"Content-Length": data.length,
					Accept: `audio/${body.response_format === "pcm" ? "pcm" : body.response_format}`,
				},
			},
			(res) => {
				if (res.statusCode < 200 || res.statusCode >= 300) {
					// Error path: drain the body so we can read the error
					// message. Most OpenAI errors are JSON.
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => {
						const body = Buffer.concat(chunks).toString("utf8");
						reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`));
					});
					return;
				}
				// Success: stream the binary body to --out.
				const ws = createWriteStream(outPath);
				ws.on("error", reject);
				ws.on("finish", () => resolve(Number(ws.bytesWritten || 0)));
				res.on("error", reject);
				res.pipe(ws);
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

const startedAt = Date.now();
log.info("synthesizing", {
	host: HOST,
	model: body.model,
	voice: body.voice,
	format: body.response_format,
	textChars: text.length,
	hasInstructions: typeof body.instructions === "string" && body.instructions.length > 0,
});

let bytesWritten;
try {
	bytesWritten = await postBinary(HOST, URL_PATH, JSON.stringify(body), OUT);
} catch (e) {
	const m = e.message || String(e);
	// Distinguish network from HTTP-from-API errors by message prefix.
	if (m.startsWith("HTTP ")) {
		log.error("http error", { error: m });
	} else {
		log.error("network error", { error: m });
	}
	process.exit(3);
}

const durationMs = Date.now() - startedAt;
// OpenAI doesn't return a trace_id in the response (the body is raw
// audio), so we don't log one. We do log size + duration so the
// operator can correlate with the bridge's runtime event log.
log.info("ok", {
	bytes: bytesWritten,
	durationMs,
	out: OUT,
	model: body.model,
	voice: body.voice,
	format: body.response_format,
});
