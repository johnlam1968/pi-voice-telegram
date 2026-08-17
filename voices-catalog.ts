/**
 * voices-catalog — load and query the embedded MiniMax TTS voice catalog.
 *
 * The catalog is shipped as `voices.json` alongside the package; it's a
 * static asset, parsed on demand when the agent calls
 * `pi_voice_telegram_list_voices`. The data is small (~58KB) and rarely
 * changes, so we keep it in a JSON file (not a TypeScript const) — that
 * way it's also inspectable on disk and updatable by the operator without
 * a rebuild.
 *
 * Schema of `voices.json`:
 *
 *   {
 *     "version": "YYYY-MM-DD",
 *     "source": "https://...",
 *     "lastUpdated": "YYYY-MM-DD",
 *     "count": 327,
 *     "voices": [
 *       { "index": 81, "voiceId": "Japanese_IntellectualSenior",
 *         "voiceName": "Intellectual Senior",
 *         "language": "Japanese", "languageKey": "日文" },
 *       ...
 *     ]
 *   }
 *
 * The English `language` field is what the agent filters on. The original
 * `languageKey` (Chinese label from the upstream catalog) is kept for
 * back-compat and to make the source attribution clear.
 *
 * v0.15.0: initial embed. The catalog is rebuilt from the upstream page
 * via `scripts/build-voice-catalog.py`; the JSON file is committed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** One voice entry in the catalog. */
export interface VoiceEntry {
	index: number;
	voiceId: string;
	voiceName: string;
	/** Normalized English label (e.g. "Japanese", "Cantonese"). */
	language: string;
	/** Original Chinese label from the upstream catalog (e.g. "日文", "中文 (粤语)"). */
	languageKey: string;
}

/** Top-level shape of voices.json. */
export interface VoicesCatalog {
	version: string;
	source: string;
	lastUpdated: string;
	count: number;
	voices: VoiceEntry[];
}

const CATALOG_FILE_NAME = "voices.json";

/** Resolve the path to voices.json relative to this module. */
function catalogPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, CATALOG_FILE_NAME);
}

/**
 * Load the catalog from disk. Best-effort: returns a structured error
 * if the file is missing or malformed. The tool caller turns the error
 * into a user-facing message; we never throw from here.
 */
export function loadVoicesCatalog():
	| { ok: true; data: VoicesCatalog }
	| { ok: false; error: string } {
	try {
		const text = readFileSync(catalogPath(), "utf8");
		const parsed = JSON.parse(text) as VoicesCatalog;
		if (!parsed || !Array.isArray(parsed.voices)) {
			return { ok: false, error: "voices.json is not a catalog-shaped object" };
		}
		return { ok: true, data: parsed };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

/** Build a deduped, sorted list of the language labels present in `voices`. */
export function uniqueLanguages(voices: VoiceEntry[]): string[] {
	return Array.from(new Set(voices.map((v) => v.language))).sort();
}

/** Filter the catalog by optional language and/or voice-name substring. */
export function filterVoices(
	voices: VoiceEntry[],
	opts: { language?: string; voiceName?: string } = {},
): VoiceEntry[] {
	let out = voices;
	if (opts.language) {
		const needle = opts.language.toLowerCase();
		// Match on either the English label or the original Chinese
		// label. Substring is intentional — the agent might pass
		// "japan" instead of "Japanese" and still get a useful result.
		out = out.filter(
			(v) =>
				v.language.toLowerCase().includes(needle) ||
				v.languageKey.toLowerCase().includes(needle) ||
				v.languageKey.includes(opts.language!),
		);
	}
	if (opts.voiceName) {
		const needle = opts.voiceName.toLowerCase();
		out = out.filter((v) => v.voiceName.toLowerCase().includes(needle));
	}
	return out;
}
