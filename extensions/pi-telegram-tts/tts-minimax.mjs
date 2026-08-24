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
// Logger
// ============================================================================
//
// Single-line structured stderr log. The bridge's execCommand captures
// stderr, so each call leaves a paper trail. The bridge's own log file
// is occasionally stale (a separate bridge-side bug, not this script's),
// so this script's stderr is the canonical record of what happened.
//
// Levels: DEBUG (only with --verbose/-v), INFO (default), WARN, ERROR.
// Format: <iso-ts> [<LEVEL>] [tts-minimax] <msg> [k=v k=v ...]
//
// Set PI_VOICE_TELEGRAM_DEBUG=1 to force DEBUG on (handy when the script
// is invoked from the bridge and you can't pass --verbose).

function argv_() {
	return process.argv.slice(2);
}

const VERBOSE =
	argv_().includes("-v") ||
	argv_().includes("--verbose") ||
	process.env.PI_VOICE_TELEGRAM_DEBUG === "1";

const LOG_LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const LOG_THRESHOLD = VERBOSE ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;

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
	if (LOG_LEVELS[level] < LOG_THRESHOLD) return;
	const ts = new Date().toISOString();
	const tag = `[${level}] [tts-minimax]`;
	process.stderr.write(`${ts} ${tag} ${msg}${fmtFields(fields)}\n`);
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
	log.debug("config merged from file", { path: configPath, keys: Object.keys(configObj) });

	// The deep-merge above is a raw body merge, not a CLI-flag-style
	// path remap. The `CLI_TO_PATH` table below (and the same
	// pattern in `tts-openai.mjs`) shows where each top-level key
	// actually belongs in the API body — e.g. "voice" lands at the
	// nested `voice_setting.voice_id`, "lang" at top-level
	// `language_boost`, "speed" at `voice_setting.speed`. Without
	// this remap, a user writing `--config {"voice": "X"}` would
	// silently end up with the DEFAULTS' `voice_setting.voice_id`
	// (Cantonese_CuteGirl) and the top-level `voice: "X"` would be
	// ignored by the API.
	//
	// This is the contract the v0.3.0 `pi-telegram-tts` package
	// relies on: the provider's per-provider sub-block in
	// `telegram.json` uses flat names (voice, model, lang, speed,
	// ...) and `synth.ts` passes them via `--config`. Without this
	// remap, the sub-block values would land at the wrong depth and
	// the API would ignore them.
	//
	// Runs BEFORE the CLI flag processing below so that an explicit
	// CLI flag (e.g. `--voice Y`) still wins over a --config key —
	// same precedence as before (CLI > --config > DEFAULTS).
	//
	// Each entry in CLI_TO_PATH is unconditionally remapped. The
	// `SKIP_PATHS` guard used by the CLI scalar block is not
	// applied here because that guard exists to prevent the scalar
	// block from double-handling paths already covered by a
	// boolean flag (POSITIVE_FLAGS / NEGATIVE_FLAGS). For
	// --config, every flat key the user sets deserves the same
	// remap the CLI flag would get.
	//
	// No SKIP_PATHS guard: the setNested() call below is a no-op
	// if `body[path]` already equals the value, and `delete body[flag]`
	// is always safe (removes the stray top-level key that the
	// deep-merge would otherwise leave behind — most APIs ignore
	// unknown fields, but it keeps the request body clean).
	const remappedKeys = [];

	// v0.3.0 hotfix 3 (in-session, 2026-08-24): extend the
	// path-mapping to also cover POSITIVE_FLAGS and NEGATIVE_FLAGS
	// (booleans like `force_cbr`, `aigc_watermark`, `text_normalization`).
	// The original v0.3.0 hotfix only remapped CLI_TO_PATH entries
	// (scalars like `voice`, `speed`, `lang`); booleans were a gap
	// that the v0.3.0 "all knobs" live test exposed.
	//
	// The CLI flag tables use kebab-case keys (e.g. `force-cbr`)
	// because that's what the CLI parser expects (`--force-cbr`).
	// The user's `--config` JSON uses snake_case (e.g.
	// `force_cbr: true`), which is the idiomatic JSON convention.
	// The remap checks both forms so a user can write either
	// `"force_cbr": true` (snake, recommended) or `"force-cbr": true`
	// (kebab, matches the CLI flag name) and have either work.
	function getConfigValue(flag) {
		if (Object.prototype.hasOwnProperty.call(configObj, flag)) {
			return configObj[flag];
		}
		const snake = flag.replace(/-/g, "_");
		if (Object.prototype.hasOwnProperty.call(configObj, snake)) {
			return configObj[snake];
		}
		return undefined;
	}
	function tryRemap(table, tableName) {
		for (const [flag, path] of Object.entries(table)) {
			const value = getConfigValue(flag);
			if (value === undefined) continue;
			setNested(body, path, value);
			// For top-level paths (e.g. `subtitle_enable` is at
			// top level in the API body), `flag === path`; the
			// value we just set is the correct field, don't delete
			// it. For nested paths, delete the stray top-level
			// key (and its snake-case variant) that the deep-merge
			// left behind.
			if (path !== flag) {
				delete body[flag];
				const snake = flag.replace(/-/g, "_");
				if (snake !== flag) delete body[snake];
			}
			remappedKeys.push(`${tableName}.${flag}`);
		}
	}
	tryRemap(CLI_TO_PATH, "scalar");
	tryRemap(POSITIVE_FLAGS, "bool");
	tryRemap(NEGATIVE_FLAGS, "bool");
	if (remappedKeys.length > 0) {
		log.debug("config keys path-mapped", { keys: remappedKeys });
	}
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
log.debug("request body assembled", { body });

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
log.debug("auth resolved", {
	apiKeySource: process.env.MINIMAX_API_KEY ? "env" : "~/.mmx/config.json",
	region: REGION,
	host: HOST,
	baseUrlOverride: process.env.MINIMAX_BASE_URL ?? null,
});

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

const startedAt = Date.now();
log.info("synthesizing", { host: HOST, model: body.model, voice: body.voice_setting?.voice_id, lang: body.language_boost, textChars: text.length });

let resp;
try {
	resp = await postJson(HOST, "/v1/t2a_v2", JSON.stringify(body));
} catch (e) {
	log.error("network error", { host: HOST, error: e.message });
	process.exit(3);
}

log.debug("http response", { status: resp.status, bytes: resp.body.length, contentType: resp.contentType });

if (resp.status < 200 || resp.status >= 300) {
	const detail = resp.body.toString("utf8").slice(0, 500);
	log.error("http non-2xx", { status: resp.status, host: HOST, detail });
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
	log.error("non-JSON response", { error: e.message, head });
	process.exit(3);
}
log.debug("parsed response", { keys: Object.keys(data) });

const base = data.base_resp;
if (base && typeof base.status_code === "number" && base.status_code !== 0) {
	log.error("upstream error", { status_code: base.status_code, status_msg: base.status_msg ?? "(no message)" });
	process.exit(3);
}

const audioHex = data.data?.audio ?? data.audio;
if (!audioHex) {
	log.error("no audio in response", { keys: Object.keys(data) });
	process.exit(3);
}

// ============================================================================
// Write the decoded audio to --out
// ============================================================================

try {
	writeFileSync(OUT, Buffer.from(audioHex, "hex"));
} catch (e) {
	log.error("write failed", { out: OUT, error: e.message });
	process.exit(4);
}

const extra = data.extra_info ?? {};
const durationMs = Date.now() - startedAt;
log.info("ok", {
	trace_id: data.trace_id ?? "?",
	audio_length_ms: extra.audio_length ?? "?",
	bytes: audioHex.length / 2 | 0,
	durationMs,
	out: OUT,
	model: body.model,
	voice: body.voice_setting?.voice_id,
});
