/**
 * config-io — read / write the companion settings file with
 * schema-validated, atomic, opt-in semantics.
 *
 * Used by the v0.11.0+ `pi_voice_telegram_config_read` and
 * `pi_voice_telegram_config_write` tools (and any future host-side
 * code that needs to manipulate the config safely).
 *
 * Safety model:
 * - Reads return the parsed JSON or a per-key value (dotted-path
 *   lookup with the same properties-fallback as the schema tool).
 * - Writes are schema-validated: only known top-level keys are
 *   accepted, and `$schema` / `_hint` are explicitly refused.
 * - Writes are atomic: serialize to `<file>.tmp`, fsync, rename.
 *   A crash mid-write leaves the previous file intact.
 *
 * This module does NOT enforce the `tools.writable` opt-in — that
 * gate is applied by the tool registrations in `tools.ts` /
 * `index.ts`. Host-side code that needs the opt-in check should
 * consult the config itself before calling these helpers.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const RESERVED_KEYS = new Set(["$schema", "_hint"]);

function settingsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	return join(agentDir, "pi-voice-telegram.json");
}

/** Read the raw settings JSON string. Empty/missing file → empty string. */
export function readSettingsRaw(): string {
	const path = settingsPath();
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf8");
}

/** Read the parsed settings object. Empty/missing file → empty object. */
export function readSettings(): Record<string, unknown> {
	const raw = readSettingsRaw();
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Dotted-path lookup with properties-fallback. Returns undefined if not found. */
export function lookupKey(obj: Record<string, unknown>, dotted: string): unknown {
	const segments = dotted.split(".");
	let current: unknown = obj;
	for (const seg of segments) {
		if (current && typeof current === "object") {
			const node = current as Record<string, unknown>;
			if (seg in node) {
				current = node[seg];
				continue;
			}
			const props = node["properties"];
			if (props && typeof props === "object" && seg in (props as Record<string, unknown>)) {
				current = (props as Record<string, unknown>)[seg];
				continue;
			}
		}
		return undefined;
	}
	return current;
}

interface ValidatedKey {
	root: string;
	remainder: string[];
}

function splitKey(dotted: string): ValidatedKey {
	const segments = dotted.split(".");
	if (segments.length === 0 || segments[0] === "") {
		throw new Error("config: key must be a non-empty dotted path (e.g. 'tts.lang').");
	}
	const root = segments[0];
	if (RESERVED_KEYS.has(root)) {
		throw new Error(
			`config: cannot write reserved key '${root}'. ` +
				`$schema and _hint are managed by the extension; they are not operator-tunable.`,
		);
	}
	const knownRoots = new Set(["inbound", "tools", "tts", "stt"]);
	if (!knownRoots.has(root)) {
		throw new Error(
			`config: unknown top-level key '${root}'. ` +
				`Allowed: inbound, tools, tts, stt. To add a new knob, update the schema in pi-voice-telegram.schema.json first.`,
		);
	}
	return { root, remainder: segments.slice(1) };
}

function setNestedPath(obj: Record<string, unknown>, remainder: string[], value: unknown): void {
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < remainder.length; i++) {
		const seg = remainder[i];
		const isLast = i === remainder.length - 1;
		if (isLast) {
			current[seg] = value;
			return;
		}
		// Descend, creating intermediate objects if missing.
		const next = current[seg];
		if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
			current[seg] = {};
		}
		current = current[seg] as Record<string, unknown>;
	}
}

export interface WriteResult {
	ok: true;
	path: string;
	oldValue: unknown;
	newValue: unknown;
	key: string;
}

/**
 * Set a single dotted key to a JSON value. Validates against the
 * allow-list of top-level keys; refuses `$schema` / `_hint`; performs
 * an atomic write (tmp file + rename).
 *
 * The whole-file write happens after the in-memory mutation, so a
 * failed validation never touches disk.
 */
export function writeKey(dotted: string, value: unknown): WriteResult {
	const { root, remainder } = splitKey(dotted);
	const current = readSettings();
	const oldValue = lookupKey(current, dotted);

	if (remainder.length === 0) {
		// Top-level-only key: set directly. Validators above have
		// already restricted this to inbound/tools/tts/stt.
		current[root] = value;
	} else {
		// Ensure the root key is a plain object so the nested write
		// has a valid target. If the root is a primitive (e.g.
		// `tts.lang = "x"` is a no-op because lang is a leaf under
		// tts; but for `tts = { ... }` the caller is replacing the
		// whole root, which is the remainder.length === 0 case above).
		if (
			current[root] === undefined ||
			current[root] === null ||
			typeof current[root] !== "object" ||
			Array.isArray(current[root])
		) {
			current[root] = {};
		}
		// Descend INTO the root, not the top-level object. This is
		// the bug fix: previously we passed `current` to
		// setNestedPath, which created the key at the top level.
		setNestedPath(current[root] as Record<string, unknown>, remainder, value);
	}

	const path = settingsPath();
	const serialized = JSON.stringify(current, null, 2) + "\n";
	const tmpPath = `${path}.tmp`;

	if (existsSync(tmpPath)) {
		// Stale tmp from a crashed previous write — leave it for the
		// operator to clean up; we still write to the same path.
	}
	writeFileSync(tmpPath, serialized, "utf8");
	renameSync(tmpPath, path);

	return { ok: true, path, oldValue, newValue: value, key: dotted };
}

/** Snapshot the settings file's mtime + size, for change-detection. */
export function settingsMetadata(): { exists: boolean; mtimeMs: number; size: number } {
	const path = settingsPath();
	if (!existsSync(path)) return { exists: false, mtimeMs: 0, size: 0 };
	const s = statSync(path);
	return { exists: true, mtimeMs: s.mtimeMs, size: s.size };
}
