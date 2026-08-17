/**
 * config-io — read / write the companion settings file with
 * schema-validated, atomic, opt-in semantics.
 *
 * Used by the v0.11.0+ `pi_voice_telegram_config_read` /
 * `_write` / `_reset` tools (and any future host-side code that
 * needs to manipulate the config safely).
 *
 * Safety model:
 * - Reads return the parsed JSON or a per-key value (dotted-path
 *   lookup with the same properties-fallback as the schema tool).
 * - Writes are schema-validated: only known top-level keys are
 *   accepted, and `$schema` / `_hint` are explicitly refused.
 * - Writes are atomic: serialize to `<file>.tmp`, rename.
 *   A crash mid-write leaves the previous file intact.
 * - Resets (v0.12.0+) are schema-driven: they walk the JSON
 *   Schema, fill in any missing fields with the schema's `default`
 *   value, and preserve the operator's existing values. The
 *   hardcoded `DEFAULT_CONFIG` in `config.ts` is for first-install
 *   only (auto-seed). After the file exists, the schema is the
 *   source of truth for "what fields exist and what are their
 *   defaults" — `resetConfig()` consults the schema, not the
 *   hardcoded JSON.
 *
 * This module does NOT enforce opt-in flags — those are applied
 * by the tool registrations in `tools.ts` / `index.ts`. Host-side
 * code that needs the opt-in check should consult the config
 * itself before calling these helpers.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const RESERVED_KEYS = new Set(["$schema", "_hint"]);

function schemaPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "pi-voice-telegram.schema.json");
}

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

export interface ResetResult {
	ok: true;
	path: string;
	backupPath: string;
	added: string[];
}

/**
 * Walk a JSON Schema and merge its `default` values into `current`,
 * filling in any fields that `current` is missing. The result is a
 * new object — `current` is not mutated. Operator-set values are
 * preserved; only MISSING fields are added.
 *
 * Recursive: nested objects are walked. `$schema`, `_hint`, and any
 * other keys NOT in the schema's `properties` are left alone (so
 * `_hint` survives, and a future schema can add fields without
 * losing operator-set values).
 *
 * The `added` list records the dotted paths of fields that were
 * added (useful for the LLM to report "filled in 3 missing fields").
 *
 * Three cases for a missing key:
 *   1. Schema has a top-level `default` value (e.g., `tts.timeoutMs:
 *      30000` in the schema's `tts.properties.timeoutMs.default`) →
 *      use that default.
 *   2. Schema defines an object with nested properties that have
 *      defaults (e.g., `inbound` is an object with
 *      `echoEnabled.default: true`, but `inbound` itself has no
 *      top-level default) → recurse with empty current, build the
 *      nested object from its sub-defaults.
 *   3. Neither → skip (no schema-level info on what the value should
 *      be; can't safely synthesize).
 *
 * Edge cases:
 * - `schema.properties` missing → return current unchanged.
 * - `schema.properties[key].type === "object"` but `current[key]`
 *   is a primitive (operator typed a string where an object should
 *   be) → we don't overwrite; we leave the primitive and don't
 *   recurse. The schema-aware reset is non-destructive.
 */
export function mergeWithSchemaDefaults(
	schema: unknown,
	current: Record<string, unknown>,
	path: string[] = [],
): { merged: Record<string, unknown>; added: string[] } {
	const merged: Record<string, unknown> = { ...current };
	const added: string[] = [];

	if (!schema || typeof schema !== "object") return { merged, added };
	const props = (schema as Record<string, unknown>).properties;
	if (!props || typeof props !== "object") return { merged, added };

	for (const [key, propSchema] of Object.entries(props as Record<string, unknown>)) {
		const dottedPath = [...path, key].join(".");
		const currentVal = merged[key];
		const propObj =
			propSchema && typeof propSchema === "object"
				? (propSchema as Record<string, unknown>)
				: null;

		if (currentVal === undefined) {
			// Missing field.
			if (propObj && "default" in propObj) {
				// Case 1: schema has a top-level default — use it.
				merged[key] = propObj.default;
				added.push(dottedPath);
			} else if (
				propObj &&
				propObj.type === "object" &&
				propObj.properties &&
				typeof propObj.properties === "object"
			) {
				// Case 2: schema defines an object with nested properties
				// (which may have their own defaults). Recurse with an
				// empty current so the nested merge builds the object
				// from sub-defaults. Only assign if the recursion
				// actually produced something.
				const sub = mergeWithSchemaDefaults(propObj, {}, [...path, key]);
				if (Object.keys(sub.merged).length > 0) {
					merged[key] = sub.merged;
					added.push(...sub.added);
				}
			}
			// Case 3: no schema info — skip.
			continue;
		}

		// Field present. If both sides are objects, recurse.
		if (
			currentVal !== null &&
			typeof currentVal === "object" &&
			!Array.isArray(currentVal) &&
			propObj &&
			propObj.type === "object"
		) {
			const sub = mergeWithSchemaDefaults(
				propObj,
				currentVal as Record<string, unknown>,
				[...path, key],
			);
			merged[key] = sub.merged;
			added.push(...sub.added);
		}
		// Otherwise: leave the existing value alone.
	}

	return { merged, added };
}

/**
 * Schema-driven reset (v0.12.0+).
 *
 * 1. Reads the bundled JSON Schema.
 * 2. Reads the current settings file (or empty object if missing).
 * 3. Walks the schema, fills in any missing fields with the
 *    schema's `default` value. Preserves all operator-set values.
 * 4. Backs up the current file (if any) to
 *    `pi-voice-telegram.json.bak.<unix-ms>`.
 * 5. Writes the merged object atomically (tmp + rename).
 *
 * The schema is the source of truth for "what fields exist and
 * what their defaults are" — not the hardcoded `DEFAULT_CONFIG` in
 * `config.ts`. That hardcoded JSON is for first-install auto-seed
 * (when the schema might not be authoritative yet) and for tests.
 *
 * @throws if the schema file is missing or malformed (the package
 *   wasn't installed correctly).
 */
export function resetConfig(): ResetResult {
	const path = settingsPath();
	const schemaFile = schemaPath();
	let schemaText: string;
	try {
		schemaText = readFileSync(schemaFile, "utf8");
	} catch (err) {
		throw new Error(
			`config-io.resetConfig: cannot read schema at ${schemaFile}: ${(err as Error).message}. ` +
				`The schema is the source of truth for default values. ` +
				`Reinstall pi-voice-telegram to recover.`,
		);
	}
	let schema: unknown;
	try {
		schema = JSON.parse(schemaText);
	} catch (err) {
		throw new Error(
			`config-io.resetConfig: schema at ${schemaFile} is not valid JSON: ${(err as Error).message}. ` +
				`Reinstall pi-voice-telegram to recover.`,
		);
	}

	const current = existsSync(path) ? readSettings() : {};
	const { merged, added } = mergeWithSchemaDefaults(schema, current);

	let backupPath = "";
	if (existsSync(path)) {
		const ts = Date.now();
		backupPath = `${path}.bak.${ts}`;
		writeFileSync(backupPath, readFileSync(path, "utf8"), "utf8");
	}
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
	renameSync(tmpPath, path);
	return { ok: true, path, backupPath, added };
}
