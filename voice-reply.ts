/**
 * voice-reply — synthesis pipeline orchestrator (TypeScript module, in-process).
 *
 * v0.2.0 conversion: the original was a bash script invoked via spawn. It's
 * now a TypeScript module exporting `synthesize()` that the extension's
 * synthesis provider calls directly. The CLI is gone.
 *
 * Pipeline:
 *   {text} → mm-tts.synthesize() (WAV) → ffmpeg libopus → {oggPath}
 *
 * The ffmpeg step is still a process boundary (ffmpeg is a system binary,
 * not a Node library we can substitute for in this design). The mm-tts step
 * is now in-process, so we save one full process spawn per synthesis call.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MmTtsError, synthesize as mmTtsSynthesize } from "./mm-tts.js";

/**
 * Opus profile for Telegram voice bubbles. Mirrors the previous bash
 * values; ffmpeg/libopus encoding is a bridge-output concern, not a
 * TTS-API concern.
 */
const FFMPEG_OPUS_ARGS = [
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
] as const;

export interface VoiceReplyArgs {
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
	/** Per-call timeout in ms. Default: 30000. */
	timeoutMs?: number;
	/** Suppress non-essential logging. Default: false */
	quiet?: boolean;
	/** Force sequential chunks. Default: false */
	serial?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Synthesize text to a Telegram-ready OGG/Opus file at `oggPath`.
 *
 * Refuses to overwrite an existing file at `oggPath`. Throws on
 * any mm-tts or ffmpeg failure. Cleans up the intermediate WAV on
 * every exit (success, failure, signal).
 */
export async function synthesize(args: VoiceReplyArgs & { oggPath: string }): Promise<void> {
	const text = args.text;
	const voice = args.voice ?? "Cantonese_PlayfulMan";
	const lang = args.lang ?? "Chinese,Yue";
	const model = args.model ?? "speech-2.8-hd";
	const speed = args.speed ?? 1.0;
	const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const quiet = args.quiet ?? false;
	const oggPath = args.oggPath;

	if (!text) {
		throw new Error("voice-reply: empty text");
	}
	if (!oggPath) {
		throw new Error("voice-reply: missing oggPath");
	}

	// Refuse to clobber; the caller (synthesis-provider) is expected to
	// pass a path that doesn't already exist.
	const { existsSync } = await import("node:fs");
	if (existsSync(oggPath)) {
		throw new Error(`voice-reply: refusing to overwrite existing ${oggPath}`);
	}

	// Step 1: synthesize the WAV via mm-tts (in-process, no spawn).
	let wavBuf: Buffer;
	try {
		wavBuf = await mmTtsSynthesize({
			text,
			voice,
			lang,
			model,
			speed,
			format: "wav",
			quiet,
			serial: args.serial ?? false,
		});
	} catch (err) {
		if (err instanceof MmTtsError) {
			// Re-throw with voice-reply's own context
			throw new Error(`voice-reply: mm-tts failed (code ${err.code}): ${err.message}`);
		}
		throw err;
	}
	if (wavBuf.length === 0) {
		throw new Error("voice-reply: mm-tts produced empty output");
	}

	// Step 2: write WAV to a temp file, run ffmpeg, clean up. The temp
	// file is owned by us (no race with the bridge's templating) and is
	// removed on any exit (success, failure, signal).
	const tmpDir = await mkdtemp(join(tmpdir(), "pi-voice-telegram-"));
	const wavPath = join(tmpDir, "voice.wav");
	await writeFile(wavPath, wavBuf);

	const cleanup = async (): Promise<void> => {
		await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
	};

	try {
		await runFfmpeg(wavPath, oggPath, timeoutMs, quiet);
	} finally {
		await cleanup();
	}

	if (!existsSync(oggPath)) {
		throw new Error(`voice-reply: produced empty ogg at ${oggPath}`);
	}
}

function runFfmpeg(wavPath: string, oggPath: string, timeoutMs: number, quiet: boolean): Promise<void> {
	return new Promise((resolveFfmpeg, reject) => {
		const args = ["-y", "-loglevel", "error", "-i", wavPath, ...FFMPEG_OPUS_ARGS, oggPath];
		const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`voice-reply: ffmpeg timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new Error(`voice-reply: ffmpeg spawn error: ${err.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				if (!quiet) {
					process.stderr.write(
						`voice-reply: ffmpeg encoded ${oggPath} (${stderr.trim().length === 0 ? "OK" : stderr.trim()})\n`,
					);
				}
				resolveFfmpeg();
			} else {
				reject(
					new Error(
						`voice-reply: ffmpeg exit ${code}: ${stderr.trim().slice(0, 500)}`,
					),
				);
			}
		});
	});
}
