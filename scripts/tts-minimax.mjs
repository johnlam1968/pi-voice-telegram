#!/usr/bin/env node
// tts-minimax.mjs — voice handler for the MiniMax T2A HTTP API.
//
// pi-telegram's `outboundHandlers` runs this with:
//   - the agent's reply text on stdin
//   - the bridge-substituted {mp3} path as `--out <path>`
//
// Reference: https://platform.minimaxi.com/docs/api-reference/speech-t2a-http
// The modern endpoint `/v1/t2a_v2` (speech-2.x) returns JSON with
// hex-encoded audio. cURL alone can fetch the response, but to get the
// audio bytes we need JSON-parsing + hex-decoding — both done here in
// Node.js. The next template step wraps the result in OGG/Opus for
// Telegram's `sendVoice`.
//
// This replaces the v0.1.0 `pi-minimax-tts` extension (now retired — see
// docs/TTS-VIA-OUTBOUND-HANDLERS.md). The API surface is identical to
// what that extension exposed; just the integration point is now the
// bridge's `outboundHandlers` command-template path.
//
// ## Auth resolution (priority order)
//
//   1. $MINIMAX_API_KEY env var (operator-set)
//   2. $MINIMAX_BASE_URL env var (overrides the region default)
//   3. ~/.mmx/config.json → `api_key` + `region` (mmx-cli's canonical key store)
//
// ## Error model
//
//   - Any non-zero exit causes the bridge to record a runtime event
//     via `recordTelegramRuntimeEvent` and fall through to the next
//     handler (or fall back to text delivery if no provider succeeds).
//   - Stderr messages are surfaced via `/telegram-status --debug`.
//   - Exit codes:
//     2 = missing API key (caller-side configuration error)
//     3 = API/parse/response error (the actual synthesis request failed)
//     4 = write to --out path failed

import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { request as httpsRequest } from "node:https";

// --- CLI args ------------------------------------------------------------

const argv = process.argv.slice(2);
function getArg(name) {
	const eq = `--${name}=`;
	const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(eq));
	if (i === -1) return undefined;
	const a = argv[i];
	return a.startsWith(eq) ? a.slice(eq.length) : argv[i + 1];
}

const OUT = getArg("out");
const TEXT = getArg("text");
const MODEL = getArg("model") ?? "speech-2.8-hd";
const VOICE = getArg("voice") ?? "Cantonese_CuteGirl";
const LANG = getArg("lang") ?? "Chinese,Yue";
const REGION = getArg("region") ?? "cn";
const BITRATE = Number(getArg("bitrate") ?? "128000");
const SAMPLE_RATE = Number(getArg("sample-rate") ?? "32000");
const SPEED = Number(getArg("speed") ?? "1");
const VOL = Number(getArg("vol") ?? "1");
const PITCH = Number(getArg("pitch") ?? "0");
const EMOTION = getArg("emotion") ?? "";
const STREAM = getArg("stream") === "1" || getArg("stream") === "true";

if (!OUT) {
	process.stderr.write("tts-minimax.mjs: missing --out <path>\n");
	process.exit(2);
}

// --- Auth + base URL ------------------------------------------------------

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
			// ignore — try next path
		}
	}
	return {};
}

const mmx = readMmxConfig();
const API_KEY = process.env.MINIMAX_API_KEY ?? mmx.api_key;
if (!API_KEY) {
	process.stderr.write(
		"tts-minimax.mjs: missing API key (set MINIMAX_API_KEY or write ~/.mmx/config.json with `api_key`)\n",
	);
	process.exit(2);
}

const REGION_DEFAULT = mmx.region === "global" ? "global" : "cn";
const REGION_RESOLVED = process.env.MINIMAX_REGION ?? REGION ?? REGION_DEFAULT;
const HOST = process.env.MINIMAX_BASE_URL
	? new URL(process.env.MINIMAX_BASE_URL).host
	: REGION_RESOLVED === "global"
		? "api.minimax.io"
		: "api.minimaxi.com";

// --- Read text from stdin (or --text) ------------------------------------

async function readStdin() {
	const chunks = [];
	for await (const c of process.stdin) chunks.push(c);
	return Buffer.concat(chunks).toString("utf8");
}

const text = TEXT ?? (await readStdin());
if (!text) {
	process.stderr.write("tts-minimax.mjs: empty text (no --text, no stdin)\n");
	process.exit(2);
}

// --- Build the modern /v1/t2a_v2 payload (speech-2.x) --------------------
//
// Reference: docs/MINIMAX-T2A-OPENAPI.md `TextToAudioRequest` schema.
// Findings: docs/MINIMAX-T2A-FINDINGS.md §2 (each field's individual notes),
// §2a/§2b/§2b-bis (voice id gotchas), §2d (legacy endpoint caveat).
//
// We use the modern endpoint because the legacy `/v1/text_to_speech`
// (speech-01/02) silently returns Mandarin for Cantonese voice+boost
// (see §2d). The modern endpoint accepts `language_boost: "Chinese,Yue"`
// and produces the right language.

const body = JSON.stringify({
	model: MODEL,
	text,
	stream: STREAM,
	voice_setting: {
		voice_id: VOICE,
		speed: SPEED,
		vol: VOL,
		pitch: PITCH,
		...(EMOTION ? { emotion: EMOTION } : {}),
	},
	audio_setting: {
		sample_rate: SAMPLE_RATE,
		// bitrate is mp3-only per the spec — server ignores it for other
		// formats. We only send it for the (default) mp3 path. The
		// format is hardcoded to "mp3" because we want the bridge's
		// ffmpeg step to produce a consistent OGG/Opus output.
		bitrate: BITRATE,
		format: "mp3",
		channel: 1,
	},
	language_boost: LANG,
});

// --- POST to the modern endpoint -----------------------------------------

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
	resp = await postJson(HOST, "/v1/t2a_v2", body);
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

// --- Parse the response. Three shapes (per findings §1, §3):
//   1) JSON with `data.audio` hex (modern endpoint — our path)
//   2) JSON with `audio` hex (alternative flat shape — legacy/variants)
//   3) JSON error `{ base_resp: { status_code, status_msg } }` with non-zero code

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

// --- Write the decoded audio to --out -----------------------------------

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
