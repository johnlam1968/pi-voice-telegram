/**
 * synth.ts — TTS pipeline: spawn the tts-{provider}.mjs script, ffmpeg
 * the result to OGG/Opus, return the path + the original text.
 *
 * The script is invoked by absolute path on dev (operator working from
 * the source repo) or by `node <bin-name>` after `npm install` (the
 * `pi-voice-telegram-scripts` package's `bin` field exposes the same
 * scripts as `tts-minimax` / `tts-openai` on PATH). The
 * `resolveScriptPath` helper picks between the two resolution
 * strategies.
 *
 * The text is piped via stdin (not --text) because the LLM's reply
 * may contain newlines, quotes, or other shell metacharacters; both
 * tts-minimax.mjs and tts-openai.mjs already read from stdin when
 * --text is absent.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";
import { getTelegramVoiceSendTranscript } from "@llblab/pi-telegram/voice";

import type { SynthConfig } from "./telegram-config.js";
import { makeLogger } from "./_logger.js";

const log = makeLogger("pi-telegram-tts/synth");

const SCRIPT_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 30_000;

/**
 * Resolve the path to `tts-{provider}.mjs`.
 *
 * 1. Dev: `<repo>/extensions/pi-voice-telegram-scripts/tts-<provider>.mjs`
 *    (walks up from this file's source location; works regardless of
 *    where the operator cloned the repo).
 * 2. npm install: the `pi-voice-telegram-scripts` package's `bin`
 *    field exposes the same scripts as `tts-<provider>` on PATH. We
 *    hand the resolved name to `node` (Node's PATH lookup is built in).
 */
function resolveScriptPath(provider: "minimax" | "openai"): string {
	// Dev: same dir as the scripts package. This file is at
	// extensions/pi-telegram-tts/synth.ts; walk up to extensions/, then
	// into pi-voice-telegram-scripts/.
	const devPath = join(
		dirname(new URL(import.meta.url).pathname),
		"..",
		"pi-voice-telegram-scripts",
		`tts-${provider}.mjs`,
	);
	if (existsSync(devPath)) return devPath;
	// npm install: rely on PATH lookup via `node` argv.
	return `tts-${provider}`;
}

/**
 * Spawn a child process with `stdin` piped (and closed on `end`).
 * Resolves on exit 0; rejects on non-zero exit, signal, or timeout.
 * Captures stderr for error messages.
 */
async function runProcess(
	command: string,
	args: string[],
	stdin: string,
	timeoutMs: number,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve();
			} else {
				reject(
					new Error(
						`${command} ${args.join(" ")} exited with code ${code}${signal ? ` (signal ${signal})` : ""}: ${stderr.slice(0, 1000)}`,
					),
				);
			}
		});

		if (stdin) {
			child.stdin.end(stdin);
		} else {
			child.stdin.end();
		}
	});
}

/**
 * Synthesize `text` to OGG/Opus via the configured provider.
 * Returns `{ audioPath, transcriptText? }` on success, `undefined` on
 * any failure (the bridge falls through to the next provider).
 *
 * The `telegramConfig` is the full `telegram.json` object — needed
 * to read the bridge-owned `voice.sendTranscript` flag via
 * `getTelegramVoiceSendTranscript(telegramConfig)`. Per the plan
 * §v0.1.0 step 5-6, we only include `transcriptText` in the return
 * value when that flag is true; otherwise the bridge gets a clean
 * `{ audioPath }` and the caption is suppressed.
 *
 * v0.1.0 only builds the v0.1.0 top-level config args
 * (`--voice <cfg.voice> --model <cfg.model>`). v0.3.0 expands this
 * to per-provider sub-blocks with the full set of CLI args.
 */
export async function synthesizeOgg(
	text: string,
	_options: { lang?: string; rate?: string } | undefined,
	cfg: SynthConfig,
	telegramConfig: Record<string, unknown> = {},
): Promise<{ audioPath: string; transcriptText?: string } | undefined> {
	if (!cfg.provider) return undefined;

	const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-tts-"));
	const mp3 = join(tempDir, `${randomUUID()}.mp3`);
	const ogg = join(tempDir, `${randomUUID()}.ogg`);

	try {
		// Step 1: TTS script → MP3. Text piped via stdin to avoid
		// argv-escaping issues with the LLM's reply (newlines, quotes,
		// shell metacharacters).
		const scriptPath = resolveScriptPath(cfg.provider);
		const scriptArgs = [
			scriptPath,
			"--out", mp3,
			...(cfg.voice ? ["--voice", cfg.voice] : []),
			...(cfg.model ? ["--model", cfg.model] : []),
		];
		log.info("tts spawn", {
			provider: cfg.provider,
			voice: cfg.voice,
			model: cfg.model,
			chars: text.length,
		});
		await runProcess("node", scriptArgs, text, SCRIPT_TIMEOUT_MS);

		// Step 2: ffmpeg MP3 → OGG/Opus. The bridge only accepts .ogg /
		// .opus (see lib/outbound-voice.ts:92-101).
		await runProcess(
			"ffmpeg",
			[
				"-y", "-i", mp3,
				"-c:a", "libopus", "-b:a", "32k",
				"-ar", "48000", "-ac", "1",
				"-application", "voip",
				"-vbr", "on", "-compression_level", "10",
				"-f", "ogg", ogg,
			],
			"",  // no stdin for ffmpeg
			FFMPEG_TIMEOUT_MS,
		);

		// Cleanup the intermediate MP3. (v0.5.0 will also schedule
		// `unlink(ogg)` 30s after upload; see Gotcha #3 in the design doc.)
		await unlink(mp3).catch(() => {});

		// Read the bridge-owned `voice.sendTranscript` flag. When
		// false (the default), return only `{ audioPath }` so the
		// bridge doesn't attach a caption. The plan §v0.1.0 step 5-6
		// + design doc §3 / §9.1 / §9.2 spell out the contract.
		const sendTranscript = getTelegramVoiceSendTranscript(
			telegramConfig as { voice?: { sendTranscript?: boolean } },
		);
		log.info("tts ok", {
			audioPath: ogg,
			chars: text.length,
			sendTranscript,
		});
		return sendTranscript
			? { audioPath: ogg, transcriptText: text }
			: { audioPath: ogg };
	} catch (err) {
		log.error("tts failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		recordTelegramRuntimeEvent("pi-telegram-tts/synth", err, {
			phase: "spawn",
			provider: cfg.provider,
		});
		return undefined;  // bridge falls through to next provider
	} finally {
		// Best-effort temp-dir cleanup. The OGG may still be in use by
		// the bridge's `uploadVoiceFile`; we use `force: true` to ignore
		// EBUSY and let the OGG linger if needed (see Gotcha #3).
		setTimeout(() => {
			rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}, 60_000);
	}
}
