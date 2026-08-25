/**
 * synth.ts — TTS pipeline: spawn the tts-{provider}.mjs script, ffmpeg
 * the result to OGG/Opus, return the path + the original text.
 *
 * The script is invoked by absolute path on dev (operator working from
 * the source repo) or by `node <bin-name>` after `npm install` (this
 * package's `bin` field exposes `tts-minimax` / `tts-openai` on PATH
 * after install). The `resolveScriptPath` helper picks between the
 * two resolution strategies.
 *
 * The text is piped via stdin (not --text) because the LLM's reply
 * may contain newlines, quotes, or other shell metacharacters; both
 * tts-minimax.mjs and tts-openai.mjs already read from stdin when
 * --text is absent.
 *
 * ## v0.3.0 per-provider sub-block dispatch
 *
 * Every CLI arg the script supports is reachable from `telegram.json`
 * via a per-provider sub-block (`minimax: { ... }` or
 * `openai: { ... }`). We build the request body from the sub-block
 * (with v0.1.0's top-level `voice` / `model` as fallbacks), write it
 * to a tempfile, and pass `--config <path>` to the script. The
 * script's own deep-merge (`DEFAULTS ← --config ← CLI`) takes care of
 * the rest. See `telegram-config.ts` for the schema + the precedence
 * rule, and the plan doc §v0.3.0 for the design rationale.
 *
 * The script is the source of truth for field-level validation
 * (enums, ranges, etc.); the TypeScript side just type-guards the
 * sub-block shape and passes the JSON through verbatim. This keeps
 * the provider in lockstep with the script's surface — adding a new
 * script field requires zero changes here.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import type { ProviderId, SynthConfig } from "./telegram-config.js";
import { makeLogger } from "./_logger.js";

const log = makeLogger("pi-telegram-tts/synth");

const SCRIPT_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 30_000;

/**
 * Resolve the path to `tts-{provider}.mjs`.
 *
 * v0.2.0: the scripts were merged into `pi-telegram-tts` (previously
 * a separate `pi-voice-telegram-scripts` package). The dev path
 * looks in the same dir as this file; the npm-install path is the
 * `bin` field of this package, which exposes `tts-minimax` /
 * `tts-openai` on PATH after `npm install`.
 *
 * 1. Dev: same dir as this file → `tts-<provider>.mjs` (works
 *    regardless of where the operator cloned the repo).
 * 2. npm install: the `pi-telegram-tts` package's `bin` field
 *    exposes the same scripts as `tts-<provider>` on PATH. We hand
 *    the resolved name to `node` (Node's PATH lookup is built in).
 */
function resolveScriptPath(provider: ProviderId): string {
	// Dev: same dir as synth.ts (this file). The scripts moved into
	// `pi-telegram-tts` in v0.2.0; previously they lived at
	// `../pi-voice-telegram-scripts/tts-<provider>.mjs` (the v0.1.x
	// walk-up). After the v0.2.0 merge, the dev path is just the
	// basename.
	const devPath = join(
		dirname(new URL(import.meta.url).pathname),
		`tts-${provider}.mjs`,
	);
	if (existsSync(devPath)) return devPath;
	// npm install: rely on PATH lookup via `node` argv.
	return `tts-${provider}`;
}

/**
 * Build the per-call JSON the script will consume via `--config`.
 *
 * Precedence (per the plan doc §v0.3.0 "Backward compat"):
 *   effective = { ...topLevel, ...subBlock }
 * — sub-block fields override top-level when both are present. This
 * is the per-key merge, not a wholesale replace: a v0.1.0 config
 * with top-level `voice` and no sub-block still works (top-level is
 * the only contributor); a v0.3.0 config with both gets the
 * sub-block values for the fields the sub-block mentions and the
 * top-level values for everything else.
 *
 * v0.1.0 callers that only set top-level `voice` / `model` get the
 * same `{ voice, model }` body they would have via the v0.1.0
 * flag-by-flag path. v0.3.0 callers that set the sub-block get
 * the full set of script fields, including ones the v0.1.0
 * flag-by-flag path didn't cover (e.g. `lang`, `speed`, `vol`,
 * `instructions`, `response_format`, arrays like
 * `pronunciation_dict.tone`, etc.).
 */
function buildScriptConfig(
	cfg: SynthConfig,
): Record<string, unknown> {
	if (!cfg.provider) return {};
	const topLevel: Record<string, unknown> = {};
	if (cfg.voice !== undefined) topLevel.voice = cfg.voice;
	if (cfg.model !== undefined) topLevel.model = cfg.model;
	const subBlock =
		cfg.provider === "minimax" ? cfg.minimax : cfg.provider === "openai" ? cfg.openai : undefined;
	return { ...topLevel, ...(subBlock ?? {}) };
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
 * Returns the OGG path on success, `undefined` on any failure
 * (the bridge falls through to the next provider).
 *
 * v0.3.0: the script is invoked with `--config <tempfile>` carrying
 * the per-provider sub-block (with v0.1.0 top-level fallbacks). The
 * flag-by-flag `--voice` / `--model` path is gone — every script
 * arg now flows through `--config`. The script's own `validateBody`
 * is the runtime validator.
 *
 * Upstream `@llblab/pi-telegram@0.39.0` removed the
 * `voice.sendTranscript` config + the
 * `getTelegramVoiceSendTranscript()` helper + the provider-returned
 * `transcriptText` field. Synthesis providers now return only the
 * OGG path; "voice with text caption" is the agent's explicit
 * composition (compose the text reply + the voice reply), not an
 * automatic policy. So we no longer need the `telegramConfig`
 * param: there's no flag to read.
 */
export async function synthesizeOgg(
	text: string,
	_options: { lang?: string; rate?: string } | undefined,
	cfg: SynthConfig,
): Promise<string | undefined> {
	if (!cfg.provider) return undefined;

	const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-tts-"));
	const mp3 = join(tempDir, `${randomUUID()}.mp3`);
	const ogg = join(tempDir, `${randomUUID()}.ogg`);

	try {
		// Step 1: write the per-call config JSON. The file lives in
		// the same `tempDir` we'll hand to the script; the existing
		// 60s cleanup timer (in the `finally` block) removes it
		// alongside the OGG.
		const scriptConfig = buildScriptConfig(cfg);
		const configPath = join(tempDir, "config.json");
		await writeFile(
			configPath,
			JSON.stringify(scriptConfig, null, 2) + "\n",
			{ encoding: "utf8", mode: 0o600 },
		);

		// Step 2: TTS script → MP3. Text piped via stdin to avoid
		// argv-escaping issues with the LLM's reply (newlines, quotes,
		// shell metacharacters). The script reads its config from
		// `--config`; the script's own deep-merge (DEFAULTS ← --config
		// ← CLI) takes care of overrides.
		const scriptPath = resolveScriptPath(cfg.provider);
		const scriptArgs = [
			scriptPath,
			"--out", mp3,
			"--config", configPath,
		];
		log.info("tts spawn", {
			provider: cfg.provider,
			config: configPath,
			configKeys: Object.keys(scriptConfig),
			chars: text.length,
		});
		await runProcess("node", scriptArgs, text, SCRIPT_TIMEOUT_MS);

		// Step 3: ffmpeg MP3 → OGG/Opus. The bridge only accepts
		// .ogg / .opus (see lib/outbound-voice.ts:92-101).
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

		// Cleanup the intermediate MP3. (v0.7.0 will also schedule
		// `unlink(ogg)` 30s after upload; see Gotcha #3 in the design doc.)
		await unlink(mp3).catch(() => {});

		log.info("tts ok", { audioPath: ogg, chars: text.length });
		return ogg;
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
		// The config.json tempfile lives in the same dir and rides
		// the same cleanup.
		setTimeout(() => {
			rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}, 60_000);
	}
}
