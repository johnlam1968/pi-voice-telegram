/**
 * synth.ts — TTS pipeline: direct `fetch` to the configured provider,
 * ffmpeg the response to OGG/Opus, return the path. The provider
 * bodies (`MINIMAX_BODY` + `OPENAI_BODY`) are hardcoded constants;
 * only `text` is interpolated at call time. ComposeWithText
 * text-before-voice composition lives in `index.ts:synthesizeCall`.
 */

// ffmpeg is still here because both providers return MP3 (MiniMax always,
// OpenAI by default). The bridge only accepts OGG/Opus
// (`@llblab/pi-telegram/lib/outbound-voice.ts:92-101`).

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import type { ProviderId, SynthConfig } from "./telegram-config.js";
import { makeLogger } from "./_logger.js";

const log = makeLogger("pi-telegram-tts/synth");

const FFMPEG_TIMEOUT_MS = 30_000;

// Provider bodies. Only `text` is interpolated; everything else is
// the operator's current tuning. Adjust by editing the constants;
// the agent can do it via its `edit` tool.

const MINIMAX_BODY = {
	model: "speech-2.8-hd",
	stream: false,
	voice_setting: {
		voice_id: "Cantonese_CuteGirl",
		speed: 0.95,
		vol: 1,
		pitch: 0,
		emotion: "happy",
	},
	audio_setting: {
		sample_rate: 32000,
		bitrate: 128000,
		format: "mp3",
		channel: 1,
	},
	language_boost: "Chinese,Yue",
	modify_intensity: 0,
	modify_timbre: 10,
} as const;

const MINIMAX_URL = "https://api.minimaxi.com/v1/t2a_v2";

/** OpenAI /v1/audio/speech request body. API defaults. */
const OPENAI_BODY = {
	model: "gpt-4o-mini-tts",
	voice: "alloy",
	response_format: "mp3",
	speed: 1.0,
} as const;

const OPENAI_URL = "https://api.openai.com/v1/audio/speech";

// ============================================================================
// Key resolution (env var → config file). Same precedence as the v0.6.0
// scripts: env wins; config file is the fallback.
// ============================================================================

function resolveMinimaxKey(): string | undefined {
	if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY;
	for (const p of [
		`${homedir()}/.mmx/config.json`,
		"/home/pi/.mmx/config.json",
		"/root/.mmx/config.json",
	]) {
		try {
			const obj = JSON.parse(readFileSync(p, "utf8")) as { api_key?: string };
			if (obj?.api_key) return obj.api_key;
		} catch {
			// try next
		}
	}
	return undefined;
}

function resolveOpenaiKey(): string | undefined {
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
	try {
		const authPath = join(process.env.PI_CODING_AGENT_DIR ?? `${homedir()}/.pi/agent`, "auth.json");
		if (!existsSync(authPath)) return undefined;
		const obj = JSON.parse(readFileSync(authPath, "utf8")) as {
			openai?: { key?: string };
		};
		return obj?.openai?.key;
	} catch {
		return undefined;
	}
}

// ============================================================================
// ffmpeg wrap: MP3 → OGG/Opus. The bridge only accepts OGG/Opus.
// ============================================================================

async function ffmpegToOgg(mp3Path: string, oggPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"ffmpeg",
			[
				"-y", "-i", mp3Path,
				"-c:a", "libopus", "-b:a", "32k",
				"-ar", "48000", "-ac", "1",
				"-application", "voip",
				"-vbr", "on", "-compression_level", "10",
				"-f", "ogg", oggPath,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`));
		}, FFMPEG_TIMEOUT_MS);
		child.on("error", (err) => { clearTimeout(timer); reject(err); });
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 500)}`));
		});
	});
}

// ============================================================================
// Provider adapters. One function per provider; direct `fetch` to the
// API; write the response to a tempdir; ffmpeg; return the OGG path.
// ============================================================================

async function callMinimax(text: string, cfg: SynthConfig): Promise<string | undefined> {
	const apiKey = resolveMinimaxKey();
	if (!apiKey) {
		log.error("missing minimax api key");
		recordTelegramRuntimeEvent("pi-telegram-tts/synth", new Error("missing minimax api key"), {
			phase: "auth", provider: "minimax",
		});
		return undefined;
	}
	const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-tts-"));
	const mp3 = join(tempDir, `${randomUUID()}.mp3`);
	const ogg = join(tempDir, `${randomUUID()}.ogg`);
	try {
		const body = {
			...MINIMAX_BODY,
			voice_setting: {
				...MINIMAX_BODY.voice_setting,
				voice_id: cfg.voice ?? MINIMAX_BODY.voice_setting.voice_id,
				speed: cfg.speed ?? MINIMAX_BODY.voice_setting.speed,
			},
			text,
		};
		log.info("tts fetch", {
			provider: "minimax",
			url: MINIMAX_URL,
			model: MINIMAX_BODY.model,
			voice: body.voice_setting.voice_id,
			speed: body.voice_setting.speed,
			chars: text.length,
		});
		const response = await fetch(MINIMAX_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 500);
			log.error("minimax http non-2xx", { status: response.status, detail });
			recordTelegramRuntimeEvent(
				"pi-telegram-tts/synth",
				new Error(`minimax http ${response.status}`),
				{ phase: "fetch", provider: "minimax", status: response.status },
			);
			return undefined;
		}
		const data = (await response.json()) as {
			base_resp?: { status_code?: number; status_msg?: string };
			data?: { audio?: string };
			audio?: string;
			trace_id?: string;
		};
		if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
			log.error("minimax upstream error", {
				status_code: data.base_resp.status_code,
				status_msg: data.base_resp.status_msg,
			});
			recordTelegramRuntimeEvent(
				"pi-telegram-tts/synth",
				new Error(`minimax upstream ${data.base_resp.status_code}`),
				{ phase: "fetch", provider: "minimax", status_code: data.base_resp.status_code },
			);
			return undefined;
		}
		const audioHex = data.data?.audio ?? data.audio;
		if (!audioHex) {
			log.error("minimax no audio in response", { keys: Object.keys(data) });
			return undefined;
		}
		await writeFile(mp3, Buffer.from(audioHex, "hex"));
		await ffmpegToOgg(mp3, ogg);
		await unlink(mp3).catch(() => {});
		log.info("tts ok", { audioPath: ogg, chars: text.length, traceId: data.trace_id ?? "?" });
		return ogg;
	} catch (err) {
		log.error("tts failed", {
			provider: "minimax",
			error: err instanceof Error ? err.message : String(err),
		});
		recordTelegramRuntimeEvent("pi-telegram-tts/synth", err, {
			phase: "fetch", provider: "minimax",
		});
		return undefined;
	} finally {
		setTimeout(() => { rm(tempDir, { recursive: true, force: true }).catch(() => {}); }, 60_000);
	}
}

async function callOpenai(text: string, cfg: SynthConfig): Promise<string | undefined> {
	const apiKey = resolveOpenaiKey();
	if (!apiKey) {
		log.error("missing openai api key");
		recordTelegramRuntimeEvent("pi-telegram-tts/synth", new Error("missing openai api key"), {
			phase: "auth", provider: "openai",
		});
		return undefined;
	}
	const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-tts-"));
	const mp3 = join(tempDir, `${randomUUID()}.mp3`);
	const ogg = join(tempDir, `${randomUUID()}.ogg`);
	try {
		const body: Record<string, unknown> = {
			...OPENAI_BODY,
			voice: cfg.voice ?? OPENAI_BODY.voice,
			speed: cfg.speed ?? OPENAI_BODY.speed,
			input: text,
		};
		if (cfg.instructions) body.instructions = cfg.instructions;
		log.info("tts fetch", {
			provider: "openai",
			url: OPENAI_URL,
			model: OPENAI_BODY.model,
			voice: body.voice,
			speed: body.speed,
			chars: text.length,
		});
		const response = await fetch(OPENAI_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 500);
			log.error("openai http non-2xx", { status: response.status, detail });
			recordTelegramRuntimeEvent(
				"pi-telegram-tts/synth",
				new Error(`openai http ${response.status}`),
				{ phase: "fetch", provider: "openai", status: response.status },
			);
			return undefined;
		}
		const audioBuffer = Buffer.from(await response.arrayBuffer());
		await writeFile(mp3, audioBuffer);
		await ffmpegToOgg(mp3, ogg);
		await unlink(mp3).catch(() => {});
		log.info("tts ok", { audioPath: ogg, chars: text.length });
		return ogg;
	} catch (err) {
		log.error("tts failed", {
			provider: "openai",
			error: err instanceof Error ? err.message : String(err),
		});
		recordTelegramRuntimeEvent("pi-telegram-tts/synth", err, {
			phase: "fetch", provider: "openai",
		});
		return undefined;
	} finally {
		setTimeout(() => { rm(tempDir, { recursive: true, force: true }).catch(() => {}); }, 60_000);
	}
}

// ============================================================================
// Public: dispatcher.
// ============================================================================

/**
 * Synthesize `text` to OGG/Opus via the configured provider. Returns
 * the OGG path on success, `undefined` on any failure (the bridge
 * falls through to the next provider).
 *
 * v0.7.0: the per-call body is now a hardcoded constant + `text`. No
 * `telegram.json` body construction, no `--config` tempfile, no
 * sub-process. The only tunable is the `provider` choice
 * (minimax / openai) + the master `disabled` switch.
 */
export async function synthesizeOgg(
	text: string,
	_options: { lang?: string; rate?: string } | undefined,
	cfg: SynthConfig,
): Promise<string | undefined> {
	if (cfg.disabled) return undefined;
	const provider: ProviderId | undefined = cfg.provider;
	if (provider === "minimax") return await callMinimax(text, cfg);
	if (provider === "openai") return await callOpenai(text, cfg);
	return undefined;
}
