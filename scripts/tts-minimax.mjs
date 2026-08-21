#!/usr/bin/env node
// tts-minimax.mjs — voice handler for the MiniMax T2A HTTP API.
//
// pi-telegram's `outboundHandlers` runs this with:
//   - the agent's reply text on stdin
//   - the bridge-substituted {mp3} path as `--out <path>`
//
// Reference: https://platform.minimaxi.com/docs/api-reference/speech-t2a-http
// The full request schema lives in docs/MINIMAX-T2A-OPENAPI.md (verbatim
// copy of the page); this file's CLI/config mirrors the schema 1:1 so
// every API knob is exposed.
//
// ## 100% adjustability
//
// Every field in the OpenAPI `TextToAudioRequest` schema is reachable
// through one of two channels:
//   1. CLI flag (for scalars / enums; used directly or via the bridge
//      template).
//   2. `--config <json>` for the full request body — needed for the
//      fields the CLI doesn't cover cleanly: `pronunciation_dict.tone`
//      (array of strings), `timbre_weights` (array of objects), and
//      any field added in a future API version.
//
// Precedence (later wins): built-in defaults → --config file → CLI flags.
// The merge is a recursive deep merge, so the config file can override
// just the keys it cares about.
//
// ## Auth resolution
//
//   1. $MINIMAX_API_KEY env var (operator-set)
//   2. $MINIMAX_BASE_URL env var (overrides the region default)
//   3. $MINIMAX_REGION env var (overrides ~/.mmx/config.json)
//   4. ~/.mmx/config.json → `api_key` + `region` (mmx-cli's canonical key store)
//
// ## Error model
//
//   - Exit 2: caller config error (missing --out, missing API key, invalid CLI value)
//   - Exit 3: API/parse/response error (cURL, JSON, upstream base_resp != 0)
//   - Exit 4: write to --out path failed
//   - The bridge's `recordTelegramRuntimeEvent` picks up non-zero exits
//     and falls back to text delivery if no handler succeeds.

import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { request as httpsRequest } from "node:https";

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

function hasFlag(name) {
	return argv.includes(`--${name}`);
}

// Coerce a CLI string to the type the field expects. Numbers are parsed
// when the string is purely numeric; "true"/"false" become booleans;
// anything else passes through as a string. The CLI is intentionally
// stringly-typed for ergonomics.
function coerce(value) {
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^-?\d+$/.test(value)) return Number(value);
	if (/^-?\d+\.\d+$/.test(value)) return Number(value);
	return value;
}

function die(msg) {
	process.stderr.write(`tts-minimax.mjs: ${msg}\n`);
	process.exit(2);
}

// ============================================================================
// Built-in defaults (Cantonese-leaning; override via --config or CLI)
// ============================================================================

const DEFAULTS = {
	model: "speech-2.8-hd",
	voice_setting: {
		voice_id: "Cantonese_CuteGirl",
		speed: 1,
		vol: 1,
		pitch: 0,
	},
	audio_setting: {
		sample_rate: 32000,
		bitrate: 128000,
		format: "mp3",
		channel: 1,
	},
	language_boost: "Chinese,Yue",
};

// ============================================================================
// Field map: every API field, with CLI name, body path, type, and the
// validator to apply. Boolean negations handled separately.
// ============================================================================
//
// OpenAPI constraints (from docs/MINIMAX-T2A-OPENAPI.md, schema
// `TextToAudioRequest` and nested types):
//
//   model:                 enum (modern + legacy)
//   text:                  string (required)
//   stream:                boolean
//   voice_setting.voice_id: string
//   voice_setting.speed:   number 0.5..2.0
//   voice_setting.vol:     number 0.1..10.0
//   voice_setting.pitch:   integer -12..12
//   voice_setting.emotion: enum (modern models only)
//   voice_setting.text_normalization: boolean
//   voice_setting.latex_read:          boolean
//   audio_setting.sample_rate:         integer enum
//   audio_setting.bitrate:             integer enum
//   audio_setting.format:              enum
//   audio_setting.channel:             integer 1..2
//   audio_setting.force_cbr:           boolean
//   pronunciation_dict.tone:           array of strings  (config only)
//   timbre_weights:                    array of objects  (config only)
//   voice_modify.pitch:                integer -100..100
//   voice_modify.intensity:             integer -100..100
//   voice_modify.timbre:               integer -100..100
//   voice_modify.sound_effects:         enum
//   language_boost:                    string
//   subtitle_enable:                   boolean
//   subtitle_type:                     enum
//   aigc_watermark:                    boolean
//   output_format:                     enum
//   emoji_event:                       boolean
//   apply_text_filter:                 boolean

const ENUMS = {
	model: [
		"speech-2.6-hd",
		"speech-2.6-turbo",
		"speech-2.8-hd",
		"speech-2.8-turbo",
		"speech-01-hd",
		"speech-01-turbo",
		"speech-2.5-hd-preview",
		"speech-2.5-turbo-preview",
		"speech-02",
	],
	emotion: ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"],
	format: ["mp3", "pcm", "flac", "wav", "pcmu_raw", "pcmu_wav", "opus"],
	sample_rate: [8000, 16000, 22050, 24000, 32000, 44100],
	bitrate: [32000, 64000, 128000, 256000],
	subtitle_type: ["word", "sentence"],
	output_format: ["hex", "url"],
	sound_effects: ["spacious_echo", "auditorium_echo", "lofi_telephone", "robotic"],
};

const RANGES = {
	"voice_setting.speed": { min: 0.5, max: 2.0 },
	"voice_setting.vol": { min: 0.1, max: 10.0 },
	"voice_setting.pitch": { min: -12, max: 12, integer: true },
	"audio_setting.channel": { min: 1, max: 2, integer: true },
	"voice_modify.pitch": { min: -100, max: 100, integer: true },
	"voice_modify.intensity": { min: -100, max: 100, integer: true },
	"voice_modify.timbre": { min: -100, max: 100, integer: true },
};

function validateField(path, value) {
	if (value === undefined || value === null) return;
	const enumValues = ENUMS[path] ?? ENUMS[path.split(".").pop()];
	if (enumValues && !enumValues.includes(value)) {
		die(`invalid value for ${path}: ${JSON.stringify(value)} (allowed: ${enumValues.join(", ")})`);
	}
	const range = RANGES[path];
	if (range) {
		if (typeof value !== "number" || Number.isNaN(value)) {
			die(`invalid value for ${path}: ${JSON.stringify(value)} (expected number in ${range.min}..${range.max})`);
		}
		if (value < range.min || value > range.max) {
			die(`out of range for ${path}: ${value} (allowed: ${range.min}..${range.max})`);
		}
	}
}

// `cli` → `bodyPath` mapping. Boolean toggles handled separately.
// Keys are kebab-case CLI flag names (what the user actually types).
const CLI_TO_PATH = {
	// Top-level
	model: "model",
	lang: "language_boost",
	"subtitle-type": "subtitle_type",
	"output-format": "output_format",
	// voice_setting
	voice: "voice_setting.voice_id",
	speed: "voice_setting.speed",
	vol: "voice_setting.vol",
	pitch: "voice_setting.pitch",
	emotion: "voice_setting.emotion",
	"text-normalization": "voice_setting.text_normalization",
	"latex-read": "voice_setting.latex_read",
	// audio_setting
	"sample-rate": "audio_setting.sample_rate",
	bitrate: "audio_setting.bitrate",
	format: "audio_setting.format",
	channel: "audio_setting.channel",
	// voice_modify
	"modify-pitch": "voice_modify.pitch",
	"modify-intensity": "voice_modify.intensity",
	"modify-timbre": "voice_modify.timbre",
	"sound-effects": "voice_modify.sound_effects",
};

// Negative-flag table: `--no-X` sets the value to false. The default
// for aigc_watermark and apply_text_filter is `true` (per the OpenAPI
// spec), so the negative flag is the way to opt out.
const NEGATIVE_FLAGS = {
	"no-watermark": "aigc_watermark",
	"no-text-filter": "apply_text_filter",
	"no-text-normalization": "voice_setting.text_normalization",
	"no-latex-read": "voice_setting.latex_read",
};

// Positive boolean flags: presence alone enables them.
const POSITIVE_FLAGS = {
	"force-cbr": "audio_setting.force_cbr",
	"subtitle-enable": "subtitle_enable",
	"emoji-event": "emoji_event",
	"stream": "stream",
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

const body = structuredClone(DEFAULTS);

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
}

// CLI: positive boolean flags
for (const [flag, path] of Object.entries(POSITIVE_FLAGS)) {
	if (hasFlag(flag)) setNested(body, path, true);
}

// CLI: negative boolean flags
for (const [flag, path] of Object.entries(NEGATIVE_FLAGS)) {
	if (hasFlag(flag)) setNested(body, path, false);
}

// CLI: scalar flags (each takes a value; coerced to number/boolean/string).
// Skip paths that are already covered by a boolean flag (above) so the
// precedence is: positive/negative boolean flag wins, then scalar value.
const SKIP_PATHS = new Set([
	...Object.values(POSITIVE_FLAGS),
	...Object.values(NEGATIVE_FLAGS),
]);
for (const [flag, path] of Object.entries(CLI_TO_PATH)) {
	if (SKIP_PATHS.has(path)) continue;
	const v = getArg(flag);
	if (v === undefined) continue;
	setNested(body, path, coerce(v));
}

function setNested(obj, path, value) {
	const parts = path.split(".");
	let cursor = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const k = parts[i];
		if (cursor[k] === undefined || cursor[k] === null || typeof cursor[k] !== "object" || Array.isArray(cursor[k])) {
			cursor[k] = {};
		}
		cursor = cursor[k];
	}
	cursor[parts[parts.length - 1]] = value;
}

// ============================================================================
// Validate the assembled body
// ============================================================================

function validateBody(b) {
	for (const path of Object.keys(ENUMS)) {
		validateField(path, b[path]);
	}
	if (b.voice_setting) {
		validateField("voice_setting.speed", b.voice_setting.speed);
		validateField("voice_setting.vol", b.voice_setting.vol);
		validateField("voice_setting.pitch", b.voice_setting.pitch);
		validateField("voice_setting.emotion", b.voice_setting.emotion);
	}
	if (b.audio_setting) {
		validateField("audio_setting.sample_rate", b.audio_setting.sample_rate);
		validateField("audio_setting.bitrate", b.audio_setting.bitrate);
		validateField("audio_setting.format", b.audio_setting.format);
		validateField("audio_setting.channel", b.audio_setting.channel);
	}
	if (b.voice_modify) {
		validateField("voice_modify.pitch", b.voice_modify.pitch);
		validateField("voice_modify.intensity", b.voice_modify.intensity);
		validateField("voice_modify.timbre", b.voice_modify.timbre);
		validateField("voice_modify.sound_effects", b.voice_modify.sound_effects);
	}
	validateField("model", b.model);
	validateField("subtitle_type", b.subtitle_type);
	validateField("output_format", b.output_format);
}

validateBody(body);

// ============================================================================
// Streaming is not implemented in this script — it requires a different
// response shape (text/event-stream with `data: {...}` SSE chunks and
// multi-chunk hex concat). The non-streaming JSON path is what the
// bridge's outboundHandlers flow expects anyway. Reject early with a
// clear error rather than letting the user discover the SSE format at
// the parse step.
// ============================================================================

if (body.stream === true) {
	die(
		"stream=true is not supported by this script — the non-streaming JSON response is the only path. " +
			"Drop the --stream flag (or set stream: false in --config) to use the canonical pipeline.",
	);
}

// ============================================================================
// Required: --out, text
// ============================================================================

const OUT = getArg("out");
if (!OUT) die("missing --out <path>");

const TEXT = getArg("text");
async function readStdin() {
	const chunks = [];
	for await (const c of process.stdin) chunks.push(c);
	return Buffer.concat(chunks).toString("utf8");
}
const text = TEXT ?? (await readStdin());
if (!text) die("empty text (no --text, no stdin)");

body.text = text;

// ============================================================================
// Auth + base URL
// ============================================================================

function readMmxConfig() {
	for (const p of [
		`${homedir()}/.mmx/config.json`,
		"/home/pi/.mmx/config.json",
		"/root/.mmx/config.json",
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

const mmx = readMmxConfig();
const API_KEY = process.env.MINIMAX_API_KEY ?? mmx.api_key;
if (!API_KEY) {
	die("missing API key (set MINIMAX_API_KEY or write ~/.mmx/config.json with `api_key`)");
}

const REGION = process.env.MINIMAX_REGION
	? process.env.MINIMAX_REGION
	: mmx.region === "global"
		? "global"
		: "cn";
const HOST = process.env.MINIMAX_BASE_URL
	? new URL(process.env.MINIMAX_BASE_URL).host
	: REGION === "global"
		? "api.minimax.io"
		: "api.minimaxi.com";

// ============================================================================
// POST
// ============================================================================

function postJson(host, urlPath, payload) {
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
				},
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks),
						contentType: (res.headers["content-type"] ?? "").toString(),
					}),
				);
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

let resp;
try {
	resp = await postJson(HOST, "/v1/t2a_v2", JSON.stringify(body));
} catch (e) {
	process.stderr.write(`tts-minimax.mjs: network error: ${e.message}\n`);
	process.exit(3);
}

if (resp.status < 200 || resp.status >= 300) {
	process.stderr.write(
		`tts-minimax.mjs: HTTP ${resp.status} from ${HOST}/v1/t2a_v2\n${resp.body.toString("utf8").slice(0, 500)}\n`,
	);
	process.exit(3);
}

// ============================================================================
// Parse the response (three shapes per the spec; see MINIMAX-T2A-FINDINGS.md §1)
// ============================================================================

let data;
try {
	data = JSON.parse(resp.body.toString("utf8"));
} catch (e) {
	const head = resp.body.toString("utf8").slice(0, 200) || "(empty)";
	process.stderr.write(`tts-minimax.mjs: non-JSON response (${e.message}): ${head}\n`);
	process.exit(3);
}

const base = data.base_resp;
if (base && typeof base.status_code === "number" && base.status_code !== 0) {
	process.stderr.write(
		`tts-minimax.mjs: upstream error status_code=${base.status_code}: ${base.status_msg ?? "(no message)"}\n`,
	);
	process.exit(3);
}

const audioHex = data.data?.audio ?? data.audio;
if (!audioHex) {
	process.stderr.write(
		`tts-minimax.mjs: no audio in response (keys: ${Object.keys(data).join(", ")})\n`,
	);
	process.exit(3);
}

// ============================================================================
// Write the decoded audio to --out
// ============================================================================

try {
	writeFileSync(OUT, Buffer.from(audioHex, "hex"));
} catch (e) {
	process.stderr.write(`tts-minimax.mjs: write ${OUT} failed: ${e.message}\n`);
	process.exit(4);
}

// One-line stderr summary for /telegram-status --debug
const extra = data.extra_info ?? {};
process.stderr.write(
	`tts-minimax.mjs: ok trace_id=${data.trace_id ?? "?"} ` +
		`audio_length_ms=${extra.audio_length ?? "?"} ` +
		`bytes=${audioHex.length / 2 | 0} → ${OUT}\n`,
);
