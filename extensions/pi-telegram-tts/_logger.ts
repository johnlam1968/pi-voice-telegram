/**
 * _logger.ts — small stderr logger shared by every extension.
 *
 * Single-line structured log on stderr. The agent's terminal
 * captures stderr, so every line is visible to the operator
 * running `pi`. The bridge's own log file (`~/.pi/agent/tmp/telegram/
 * logs.jsonl`) is sometimes stale or frozen, so this stderr stream
 * is the canonical observability channel for our code.
 *
 * Usage:
 *   import { log, makeLogger } from "./_logger.js";
 *   log.debug("parsed args", { count: 3 });
 *   const log = makeLogger("pi-telegram-tts");
 *   log.info("synthesizing", { model: "speech-2.8-hd" });
 *   log.error("upstream error", { status_code: 2013, message: "..." });
 *
 * Levels: DEBUG (only when PI_VOICE_TELEGRAM_DEBUG=1 or
 * PI_VOICE_TELEGRAM_VERBOSE>=1), INFO (default), WARN, ERROR.
 *
 * Format: <iso-ts> [<LEVEL>] [tag] <msg> [k=v k=v ...]
 *
 * Pinned to stderr (not stdout) so the bridge's execCommand capture
 * separates log lines from command output.
 *
 * Marked as debug instrumentation per the user's request — easy to
 * strip later by deleting this file and the `log.*` calls.
 *
 * Verbatim copy of `extensions/pi-telegram-stt/_logger.ts` (the
 * per-package self-containment is intentional, matching the v0.7.0
 * design decision for the sister STT package).
 */

const LOG_LEVELS: { [k: string]: number } = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const envDebug = process.env.PI_VOICE_TELEGRAM_DEBUG === "1";
const envVerbose = Number.parseInt(process.env.PI_VOICE_TELEGRAM_VERBOSE ?? "0", 10);
const THRESHOLD: number =
	envDebug || envVerbose > 0 ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;

const DEFAULT_TAG = (process.env.PI_VOICE_TELEGRAM_LOG_TAG ?? "extension").slice(0, 32);

function fmtValue(v: unknown): string {
	if (v === undefined || v === null) return String(v);
	if (typeof v === "string") {
		return v.length > 200 ? JSON.stringify(v.slice(0, 200) + "…") : v;
	}
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

function fmtFields(fields?: Record<string, unknown>): string {
	if (!fields) return "";
	const parts: string[] = [];
	for (const [k, v] of Object.entries(fields)) {
		if (v === undefined) continue;
		parts.push(`${k}=${fmtValue(v)}`);
	}
	return parts.length ? " " + parts.join(" ") : "";
}

function writeLine(level: LogLevel, tag: string, msg: string, fields?: Record<string, unknown>): void {
	const ts = new Date().toISOString();
	process.stderr.write(`${ts} [${level}] [${tag}] ${msg}${fmtFields(fields)}\n`);
}

function makeLogMethods(tag: string) {
	const safeTag = tag.slice(0, 32);
	return {
		debug: (msg: string, fields?: Record<string, unknown>) => {
			if (LOG_LEVELS.DEBUG < THRESHOLD) return;
			writeLine("DEBUG", safeTag, msg, fields);
		},
		info: (msg: string, fields?: Record<string, unknown>) => {
			if (LOG_LEVELS.INFO < THRESHOLD) return;
			writeLine("INFO", safeTag, msg, fields);
		},
		warn: (msg: string, fields?: Record<string, unknown>) => {
			writeLine("WARN", safeTag, msg, fields);
		},
		error: (msg: string, fields?: Record<string, unknown>) => {
			writeLine("ERROR", safeTag, msg, fields);
		},
	};
}

export const log = makeLogMethods(DEFAULT_TAG);

/** Create a child logger with a fixed tag (use inside modules that
 *  want a more specific label than the global PI_VOICE_TELEGRAM_LOG_TAG). */
export function makeLogger(tag: string) {
	return makeLogMethods(tag);
}
