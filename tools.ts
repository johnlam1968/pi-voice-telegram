/**
 * tools — LLM-callable tool surface (TTS + STT) backed by the existing
 * in-process modules.
 *
 * Two tools are registered when enabled by the companion settings file:
 *
 *   - `synthesize_voice` — wraps `voice-reply.ts` (mm-tts + ffmpeg). Writes
 *     a Telegram-ready OGG/Opus file and returns the path. The agent
 *     delivers the file to the bound chat using the bridge's existing
 *     `telegram_attach` tool, which handles the actual `sendVoice` call.
 *     This is the MVP two-step pattern: synthesize → attach.
 *
 *   - `transcribe_audio` — wraps `whisper-stt.transcribe()`. POSTs the
 *     audio file to the local `whisper-server` and returns the
 *     transcript text. The agent reads the text directly.
 *
 * Why the two-step for TTS: the bridge's `sendVoice` plumbing is in
 * `telegram_attach` (and the voice-reply synthesis provider), neither of
 * which is reachable from an arbitrary tool call. Going through the
 * `telegram_attach` path keeps chat-target resolution, captioning, and
 * multipart-upload concerns in the bridge, where they belong.
 *
 * v0.8.0: per-extension TTS/STT defaults come from the resolved config
 * (JSON > env > hardcoded), not from re-reading env vars here. The
 * prompt text (description / promptSnippet / promptGuidelines) is
 * templated against the resolved tool name, so renames via
 * `tools.tts.name` / `tools.stt.name` are reflected consistently in
 * the LLM-facing strings.
 *
 * Public APIs used (stable per pi-coding-agent + pi-telegram public-api.md):
 *   - @earendil-works/pi-coding-agent → ExtensionAPI, getAgentDir
 *   - @sinclair/typebox                → Type (parameter schemas)
 *   - @llblab/pi-telegram/outbound     → recordTelegramRuntimeEvent
 *   - voice-reply.ts                   → synthesize (TTS pipeline)
 *   - whisper-stt.ts                   → transcribe (STT pipeline)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import { synthesize as voiceReplySynthesize } from "./voice-reply.js";
import { detectLanguage, transcribe as whisperTranscribe } from "./whisper-stt.js";
import {
	type ResolvedSttDefaults,
	type ResolvedTtsDefaults,
} from "./config.js";
import {
	lookupKey as ioLookupKey,
	readSettings as ioReadSettings,
	resetConfig as ioResetConfig,
	writeKey as ioWriteKey,
} from "./config-io.js";
import {
	filterVoices as catalogFilterVoices,
	loadVoicesCatalog,
	uniqueLanguages as catalogUniqueLanguages,
} from "./voices-catalog.js";

// --- Per-tool overrides from the companion settings file ---

export interface ToolNameConfig {
	tts?: { name?: string };
	stt?: { name?: string };
}

// --- Prompt text builders (v0.8.0: templated against the resolved name) ---

interface TtsPromptText {
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
}

function buildTtsPrompt(name: string): TtsPromptText {
	return {
		description:
			`Convert text to a Telegram-ready OGG/Opus voice file via MiniMax TTS. Returns the file path. ` +
			`Use the bridge's telegram_attach tool to deliver it to the user.`,
		promptSnippet: `Synthesize text to an OGG/Opus voice file (returns path; pair with telegram_attach to send).`,
		promptGuidelines: [
			`Use ${name} when the user explicitly asks for a voice reply, when a voice memo would convey the answer more naturally than text, or to read a file aloud.`,
			`${name} only writes a file — to deliver it to the user, call the bridge's telegram_attach tool with the returned path.`,
			`Do NOT use ${name} as a turn-reply voice — the bridge handles automatic voice replies (driven by voice.replyMode in telegram.json). ${name} is for ad-hoc voice.`,
			`When the user asks to change the voice or language, call pi_voice_telegram_list_voices FIRST to discover valid voice IDs. Don't guess — a wrong ID returns 2054 and you can't recover without the operator. The three TTS parameters are independent: tts.voice is the speaker identity, tts.lang is the pronunciation boost (cross-language voice+lang = "boost" effect), and a \`voice under a language\` is just one of the 327 IDs in the catalog.`,
		],
	};
}

interface SttPromptText {
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
}

function buildSttPrompt(name: string): SttPromptText {
	return {
		description:
			`Transcribe a local audio file via the local whisper-server HTTP endpoint. ` +
			`Returns the transcript text.`,
		promptSnippet: `Transcribe a local audio file via whisper-server (returns text).`,
		promptGuidelines: [
			`Use ${name} when the user asks you to transcribe a local audio file, or when you need to read the contents of a voice note referenced by path.`,
			`${name} POSTs to the local whisper-server (default http://127.0.0.1:8080). The result is the transcript text.`,
			`Incoming Telegram voice/audio messages are already transcribed automatically by the inbound echo pipeline — only call ${name} for files the user has not already sent.`,
		],
	};
}

// --- synthesize_voice ---

/**
 * Loose language-match check, used by `synthesize_voice`'s post-synthesis
 * self-check. whisper-server returns detected language as a lowercase
 * English name ("japanese", "cantonese", "english"). The operator's
 * `tts.lang` is MiniMax's "Language,Dialect" format ("Japanese",
 * "Chinese,Yue", "English,American"). Match rules:
 *
 *   1. Direct case-insensitive substring (e.g. "japanese" in "Japanese")
 *   2. First half of a "Language,Dialect" string (e.g. "Chinese" from
 *      "Chinese,Yue" matches "chinese"; "Cantonese" does not match
 *      "Chinese,Yue" — the operator asked for Yue, not generic Chinese)
 *   3. Otherwise: no match
 *
 * Duplicated from synthesis-provider.ts to keep tools.ts self-contained.
 * If this gets a third caller, move to a shared helper module.
 */
function isLanguageMatch(detected: string, requested: string): boolean {
	const d = detected.toLowerCase();
	const r = requested.toLowerCase();
	if (r.includes(d) || d.includes(r)) return true;
	const first = r.split(",")[0]?.trim() ?? "";
	return first === d;
}

export interface RegisterTtsArgs {
	pi: ExtensionAPI;
	agentDir: string;
	nameOverride: string | undefined;
	tts: ResolvedTtsDefaults;
}

export function registerSynthesizeVoiceTool(args: RegisterTtsArgs): void {
	const { pi, agentDir, nameOverride, tts } = args;
	const name = nameOverride ?? "synthesize_voice";
	const prompt = buildTtsPrompt(name);

	pi.registerTool({
		name,
		label: "Synthesize voice (TTS)",
		description: prompt.description,
		promptSnippet: prompt.promptSnippet,
		promptGuidelines: prompt.promptGuidelines,
		parameters: Type.Object({
			text: Type.String({ description: "Text to speak (≤10k chars, ≤1k per chunk for legacy models)" }),
			voice: Type.Optional(Type.String({ description: `Voice ID. Default: ${tts.voice}` })),
			lang: Type.Optional(Type.String({ description: `Language boost. Default: ${tts.lang}` })),
			model: Type.Optional(Type.String({ description: `TTS model ID. Default: ${tts.model}` })),
			speed: Type.Optional(Type.Number({ description: "Speed multiplier. Default: 1.0" })),
		}),
		async execute(_toolCallId, params) {
			const oggPath = `${agentDir}/tmp/pi-voice-telegram-tool-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.ogg`;
			const effectiveVoice = params.voice ?? tts.voice;
			const effectiveLang = params.lang ?? tts.lang;
			try {
				await voiceReplySynthesize({
					text: params.text,
					voice: effectiveVoice,
					lang: effectiveLang,
					model: params.model ?? tts.model,
					speed: params.speed ?? 1.0,
					oggPath,
					timeoutMs: tts.timeoutMs,
					quiet: true,
				});
			} catch (err) {
				recordTelegramRuntimeEvent("pi-voice-telegram/tool", err, {
					phase: "synthesize_voice",
					textLength: params.text.length,
				});
				throw err;
			}
			// v0.16.0+: best-effort self-check via whisper-stt language
			// detection. Logs to runtime events; does not change the
			// tool's return value. Off if `verifyAfterSynthesize` is
			// false.
			if (tts.verifyAfterSynthesize) {
				try {
					const detected = await detectLanguage({ inputPath: oggPath });
					recordTelegramRuntimeEvent("pi-voice-telegram/tts-verify", null, {
						phase: "synthesize_voice",
						requestedLang: effectiveLang,
						detectedLanguage: detected.language,
						confidence: detected.confidence,
						match: isLanguageMatch(detected.language, effectiveLang),
					});
				} catch (err) {
					recordTelegramRuntimeEvent("pi-voice-telegram/tts-verify", err, {
						phase: "synthesize_voice.detect",
						requestedLang: effectiveLang,
					});
				}
			}
			return {
				content: [
					{
						type: "text",
						text: `Wrote ${oggPath}. Call telegram_attach with paths=["${oggPath}"] to deliver it to the user.`,
					},
				],
				details: { audioPath: oggPath, textLength: params.text.length },
			};
		},
	});
}

// --- transcribe_audio ---

export interface RegisterSttArgs {
	pi: ExtensionAPI;
	agentDir: string;
	nameOverride: string | undefined;
	stt: ResolvedSttDefaults;
}

export function registerTranscribeAudioTool(args: RegisterSttArgs): void {
	const { pi, agentDir, nameOverride, stt } = args;
	const name = nameOverride ?? "transcribe_audio";
	const prompt = buildSttPrompt(name);

	pi.registerTool({
		name,
		label: "Transcribe audio (STT)",
		description: prompt.description,
		promptSnippet: prompt.promptSnippet,
		promptGuidelines: prompt.promptGuidelines,
		parameters: Type.Object({
			inputPath: Type.String({ description: "Absolute path to the audio file on disk" }),
			lang: Type.Optional(Type.String({ description: `BCP-47 / ISO-639-1 language code. Default: ${stt.lang}` })),
			baseUrl: Type.Optional(Type.String({ description: `Override whisper-server base URL. Default: ${stt.baseUrl}` })),
		}),
		async execute(_toolCallId, params) {
			const transcript = (await whisperTranscribe({
				inputPath: params.inputPath,
				lang: params.lang ?? stt.lang,
				timeoutMs: stt.timeoutMs,
				baseUrl: params.baseUrl,
			})).trim();
			return {
				content: [{ type: "text", text: transcript }],
				details: { inputPath: params.inputPath, lang: params.lang ?? stt.lang, length: transcript.length },
			};
		},
	});
}

// --- pi_voice_telegram_schema (v0.10.0) ---
//
// Returns the companion settings JSON Schema so the LLM can introspect
// the available knobs, their types, defaults, and valid values on
// demand. The schema lives in `pi-voice-telegram.schema.json` in the
// npm package and is the same one linked from each settings file's
// `$schema` field. Loading is best-effort: if the file can't be read
// (e.g. the npm package was installed without the schema), the tool
// returns a helpful error.

const SCHEMA_FILE_NAME = "pi-voice-telegram.schema.json";

function loadSchemaText(): { ok: true; text: string } | { ok: false; error: string } {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const path = join(here, SCHEMA_FILE_NAME);
		const text = readFileSync(path, "utf8");
		return { ok: true, text };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

const SCHEMA_PROMPT = {
	description:
		"Return the JSON Schema for the pi-voice-telegram companion settings file. The schema is the canonical reference for every knob: type, default, allowed values, and a human description for each. Use this when you need to know what knobs exist, what their defaults are, what values are valid, or what a key means. Optionally pass a `key` to fetch just one section (e.g. 'tts.voice', 'inbound.echoEnabled', 'tools').",
	promptSnippet: "Returns the pi-voice-telegram settings schema (knobs, types, defaults, examples).",
	promptGuidelines: [
		"Use pi_voice_telegram_schema when you need to know what knobs are available, what their defaults are, or what values are valid. Especially useful before suggesting edits to the companion settings file.",
		"The returned text is the same JSON Schema linked from each settings file's $schema field. It includes descriptions, defaults, and examples for every key.",
		"Pass the `key` parameter to fetch a specific section (e.g. key='tts.voice' returns just the description/default/examples for that one field) rather than reading the whole schema.",
		"Note: tts.voice is a free-form string in the schema — for valid voice IDs, call pi_voice_telegram_list_voices instead. The schema tells you WHAT the knob is; the catalog tells you what VALUES are valid for it.",
	],
};

export function registerPiVoiceTelegramSchemaTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pi_voice_telegram_schema",
		label: "pi-voice-telegram settings schema",
		description: SCHEMA_PROMPT.description,
		promptSnippet: SCHEMA_PROMPT.promptSnippet,
		promptGuidelines: SCHEMA_PROMPT.promptGuidelines,
		parameters: Type.Object({
			key: Type.Optional(
				Type.String({
					description:
						"Optional dotted path into the schema. E.g. 'tts', 'tts.voice', 'inbound.echoEnabled', 'tools.tts.name'. If omitted, the full schema is returned.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const loaded = loadSchemaText();
			if (!loaded.ok) {
				throw new Error(
					`pi_voice_telegram_schema: cannot read ${SCHEMA_FILE_NAME} from the extension's npm package: ${loaded.error}. ` +
						`This usually means the package was installed without the schema file. ` +
						`Reinstall pi-voice-telegram@>=0.10.0 or check that pi-voice-telegram.schema.json is present in the npm package.`,
				);
			}
			if (!params.key) {
				return {
					content: [{ type: "text", text: loaded.text }],
					details: { mode: "full", length: loaded.text.length },
				};
			}
			// Per-key lookup. We parse the JSON and walk the path; for
			// any segment, we try `obj[seg]` first and fall back to
			// `obj.properties[seg]` so the agent can use either the
			// short form (`tts.voice`) or the explicit form
			// (`properties.tts.properties.voice`).
			const schema = JSON.parse(loaded.text) as Record<string, unknown>;
			const segments = params.key.split(".");
			let current: unknown = schema;
			const trail: string[] = [];
			for (const seg of segments) {
				trail.push(seg);
				if (current && typeof current === "object") {
					const obj = current as Record<string, unknown>;
					if (seg in obj) {
						current = obj[seg];
						continue;
					}
					// Fallback: try the `properties` namespace.
					const props = obj["properties"];
					if (props && typeof props === "object" && seg in (props as Record<string, unknown>)) {
						current = (props as Record<string, unknown>)[seg];
						continue;
					}
				}
				const topLevel = Object.keys(schema)
					.filter((k) => !k.startsWith("$"))
					.join("', '");
				throw new Error(
					`pi_voice_telegram_schema: key path '${trail.join(".")}' not found in schema. ` +
						`Try a top-level key (e.g. '${topLevel}') or one of its subkeys (e.g. 'tts.voice', 'stt.lang').`,
				);
			}
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(current, null, 2),
					},
				],
				details: { mode: "key", key: params.key, found: true },
			};
		},
	});
}

// --- pi_voice_telegram_config_read / pi_voice_telegram_config_write (v0.11.0) ---
//
// Both tools are gated on `tools.writable: true` in the companion
// settings. They let the LLM read the current settings and modify
// them via the schema-validated, atomic write path in `config-io.ts`.
// The write tool refuses to modify `$schema` / `_hint` or any key
// not present in the schema (see the splitKey allow-list).

const CONFIG_READ_PROMPT = {
	description:
		"Read the current value(s) of the pi-voice-telegram companion settings file (~/.pi/agent/pi-voice-telegram.json). Without a `key` parameter, returns the full settings object as formatted JSON. With a dotted-path `key` (e.g. 'tts.lang', 'inbound.echoEnabled', 'tools.enabled'), returns just that one value. Use this to inspect current state before suggesting edits and to confirm that prior writes took effect.",
	promptSnippet: "Reads the current companion settings (full or per-key).",
	promptGuidelines: [
		"Use pi_voice_telegram_config_read to inspect the operator's current settings before suggesting or applying edits. The agent should know what's already set.",
		"Pass the `key` parameter for a single value, omit it for the full file. The dotted path uses the same lookup as the schema tool — short form ('tts.voice') works as well as explicit form.",
		"This tool is registered whenever `tools.enabled: true` is set in the companion settings. If it's not available, the operator has the tool surface off — that is the only flag gating these tools.",
	],
};

const CONFIG_WRITE_PROMPT = {
	description:
		"Modify a single key in the pi-voice-telegram companion settings file. The write is schema-validated (refuses unknown keys) and atomic (write-to-tmp + rename). The companion settings file (NOT telegram.json) is where TTS/STT defaults live — tts.lang, tts.voice, tts.model, stt.lang, stt.baseUrl. Always reads the current value first, applies the change, and returns both the old and new values in the result. Changes take effect immediately on the next turn (v0.14.0+ hot-reload) — no session restart required.",
	promptSnippet: "Schema-validated atomic write to the companion settings (TTS/STT defaults live HERE, not in telegram.json).",
	promptGuidelines: [
		"Use pi_voice_telegram_config_write when the operator asks to change a setting — especially voice/TTS/language settings like 'change tts.lang to ja', 'use English voice', 'switch to a female voice', 'turn off inbound echo'. Don't just talk about the change being possible — actually call the tool. The operator is using the LLM as the interface to the config; talking without acting is a fail mode.",
		"CRITICAL: TTS/STT settings (tts.lang, tts.voice, tts.model, stt.lang, stt.baseUrl, etc.) live in THIS file (~/.pi/agent/pi-voice-telegram.json), NOT in telegram.json. The bridge's telegram.json controls the bridge (which chat to use, polling, role-based access). The companion settings control the voice pipeline. If the user asks about voice/TTS/language, this is the right place to look.",
		"Before writing tts.voice, call pi_voice_telegram_list_voices to confirm the ID is valid. The catalog is the only in-band source of truth for what IDs MiniMax TTS accepts — guessing returns 2054 and you can't recover. Same for tts.lang (any string is accepted but a wrong value produces wrong pronunciation). The three TTS parameters are independent: tts.voice (speaker identity), tts.lang (pronunciation boost — cross-language voice+lang = 'boost' effect), and the implicit 'voice under a language' (a `Japanese_*` ID is a Japanese-language voice).",
		"Two flows to choose between: (1) Reactive — operator asks 'set tts.lang to ja' → call config_write with the new value. (2) Proactive — operator keeps asking for English voice while tts.lang is 'Chinese,Yue' → call config_read first to confirm the mismatch, then either propose the change (recommended) or apply it directly if the pattern is clear.",
		"Always call config_read FIRST when changing a value, so you can report old → new. Two-step (read → write) is the operator's safety net.",
		"Pass the dotted `key` path and the new `value` (as a JSON value, not a string). The tool will reject writes to `$schema`, `_hint`, or any key not in the schema.",
		"After a successful write, tell the operator: 'the change takes effect on the next turn (hot-reload is on).' No session restart needed.",
	],
};

export function registerConfigReadTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pi_voice_telegram_config_read",
		label: "Read pi-voice-telegram settings",
		description: CONFIG_READ_PROMPT.description,
		promptSnippet: CONFIG_READ_PROMPT.promptSnippet,
		promptGuidelines: CONFIG_READ_PROMPT.promptGuidelines,
		parameters: Type.Object({
			key: Type.Optional(
				Type.String({
					description:
						"Optional dotted path into the settings. E.g. 'tts.voice', 'inbound.echoEnabled', 'tools.writable'. Omit to return the full file as formatted JSON.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const current = ioReadSettings();
			if (!params.key) {
				return {
					content: [{ type: "text", text: JSON.stringify(current, null, 2) }],
					details: { mode: "full", keys: Object.keys(current).length },
				};
			}
			const value = ioLookupKey(current, params.key);
			if (value === undefined) {
				const topLevel = Object.keys(current).filter((k) => !k.startsWith("$"));
				throw new Error(
					`pi_voice_telegram_config_read: key '${params.key}' not found. ` +
						`Top-level keys present: ${topLevel.length ? topLevel.join(", ") : "(none)"}.`,
				);
			}
			return {
				content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
				details: { mode: "key", key: params.key, type: typeof value },
			};
		},
	});
}

export function registerConfigWriteTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pi_voice_telegram_config_write",
		label: "Modify pi-voice-telegram setting",
		description: CONFIG_WRITE_PROMPT.description,
		promptSnippet: CONFIG_WRITE_PROMPT.promptSnippet,
		promptGuidelines: CONFIG_WRITE_PROMPT.promptGuidelines,
		parameters: Type.Object({
			key: Type.String({
				description:
					"Dotted path to the key to set. E.g. 'tts.lang', 'inbound.echoEnabled', 'tools.enabled'. Refused: '$schema', '_hint', and any key not in the schema.",
			}),
			value: Type.Unknown({
				description:
					"New value for the key. JSON value: string, number, boolean, or object. For top-level keys like 'inbound.echoEnabled' pass a primitive. For nested keys like 'tts.lang' pass the new primitive value; the tool will preserve the rest of the object.",
			}),
		}),
		async execute(_toolCallId, params) {
			const result = ioWriteKey(params.key, params.value);
			return {
				content: [
					{
						type: "text",
						text: `Wrote ${result.key} in ${result.path}.\n` +
							`Old: ${JSON.stringify(result.oldValue)}\n` +
							`New: ${JSON.stringify(result.newValue)}\n\n` +
							`The change takes effect on the next turn (hot-reload is on, v0.14.0+). No session restart needed.`,
					},
				],
				details: {
					key: result.key,
					oldValue: result.oldValue,
					newValue: result.newValue,
					path: result.path,
				},
			};
		},
	});
}

// --- pi_voice_telegram_config_reset (v0.12.0, schema-driven in v0.12.1, prompt fix in v0.16.1) ---
//
// Schema-driven recovery primitive. Walks the JSON Schema, fills in
// any missing fields with the schema's `default` value, preserves
// the operator's existing values. Backs up the current file to
// `pi-voice-telegram.json.bak.<unix-ms>` first so the operator can
// `cp` the previous state back if the migration is wrong.
//
// The schema is the source of truth for "what fields exist and what
// are their defaults" — not a hardcoded JSON in source. New fields
// added in future schema versions are auto-applied to existing files
// when reset is called.
//
// v0.16.1: prompt overhaul. The previous promptGuidelines were too
// cautious — the agent would ask "which reset do you want?" when
// the operator said "reset config", even though config_reset is the
// obvious tool for the job. The new prompt explicitly marks
// config_reset as the DEFAULT interpretation of "reset config" and
// tells the agent to just call it. Also fixed a stale "restart
// required" line in the description (the v0.14.0 hot-reload made
// that wrong, but only the promptGuidelines were fixed in v0.14.2).

const CONFIG_RESET_PROMPT = {
	description:
		"Schema-driven migration of the pi-voice-telegram companion settings file (~/.pi/agent/pi-voice-telegram.json). This is the DEFAULT interpretation of 'reset config' for this extension — when the operator says 'reset', 'migrate', 'fill in missing fields', 'update to current schema', 'rebuild from defaults', or 'I broke the config', call this tool. Walks the JSON Schema, fills in any MISSING fields with the schema's `default` value, and PRESERVES the operator's existing values. Backs up the current file to a timestamped `.bak.<unix-ms>` first so the previous state is recoverable via `cp`. ADDITIVE migration only — does NOT overwrite the operator's existing values. The tool takes no parameters. Changes take effect on the next turn (hot-reload is on, v0.14.0+); no session restart needed.",
	promptSnippet:
		"Schema-driven migration: fills missing fields with schema defaults, preserves existing values, timestamped backup. The default interpretation of 'reset config'.",
	promptGuidelines: [
		"Use pi_voice_telegram_config_reset as the DEFAULT action when the operator says 'reset config', 'reset the settings', 'migrate the config', 'fill in missing fields', 'update to current schema', 'rebuild from defaults', 'I broke the config', or 'sync the file with the schema'. DO NOT ask for clarification on which reset they want — if the request maps to any of these phrasings, call the tool. Clarification is only needed if the request is genuinely ambiguous (e.g. 'reset tts.voice' is a single-value reset, see below).",
		"Disambiguation from config_write: if the operator asks to reset a SINGLE VALUE (e.g. 'reset tts.voice to Cantonese_PlayfulMan', 'set tts.lang back to default'), use pi_voice_telegram_config_write with the specific value — that's a different operation. The reset tool here is for the WHOLE FILE (fill all missing fields), not a single value.",
		"The tool does NOT take any parameters — it always walks the bundled schema and applies defaults to missing fields. Operator's existing values are preserved (additive migration, not destructive). The result reports which dotted paths were added.",
		"Safety net: the tool backs up the current file to `pi-voice-telegram.json.bak.<unix-ms>` first, so if the migration is wrong the operator can `cp ${backupPath} ${result.path}` to restore. This is why you can call it without asking — there's a real recovery path. The cost of an unnecessary reset is one timestamped `.bak` file; the cost of asking is operator friction.",
		"After a successful reset, tell the operator: 'migration done. N fields added from schema defaults. Your previous settings are in ~/.pi/agent/pi-voice-telegram.json.bak.<timestamp> — recoverable via `cp`. Hot-reload is on, so the changes take effect on the next turn (no session restart).'",
	],
};

export function registerConfigResetTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pi_voice_telegram_config_reset",
		label: "Migrate pi-voice-telegram settings to current schema",
		description: CONFIG_RESET_PROMPT.description,
		promptSnippet: CONFIG_RESET_PROMPT.promptSnippet,
		promptGuidelines: CONFIG_RESET_PROMPT.promptGuidelines,
		parameters: Type.Object({}), // no parameters
		async execute(_toolCallId) {
			const result = ioResetConfig();
			const addedSummary = result.added.length
				? `\nFields added (from schema defaults): ${result.added.join(", ")}.`
				: "\nNo missing fields — file was already up to date with the schema.";
			return {
				content: [
					{
						type: "text",
						text:
							`Migrated ${result.path}.` +
							addedSummary +
							(result.backupPath
								? `\nPrevious content backed up to: ${result.backupPath}\n`
								: "\nNo previous file to back up.\n") +
							`\nThe migration takes effect on the next turn (hot-reload is on, v0.14.0+). No session restart needed. ` +
							(result.backupPath
								? `To recover the previous settings: cp ${result.backupPath} ${result.path}`
								: "There was no previous content."),
					},
				],
				details: {
					path: result.path,
					backupPath: result.backupPath,
					added: result.added,
					hadPrevious: Boolean(result.backupPath),
				},
			};
		},
	});
}

// --- pi_voice_telegram_list_voices (v0.15.0) ---
//
// Returns the embedded MiniMax TTS voice catalog (327 entries, 24
// languages) so the LLM can discover valid voice IDs and pick the
// right one for a language. The catalog is shipped as `voices.json`
// in the npm package, parsed on demand (the file is small, ~58KB,
// and rarely changes). The tool is read-only, no side effects.
// Registered unconditionally when `tools.enabled: true`.
//
// Why this exists: the agent can't otherwise know which voice IDs
// are valid for MiniMax TTS. A wrong ID returns 2054 and the agent
// has no way to recover without the operator. The catalog gives the
// agent an in-band answer.
//
// Filter semantics: `language` is a case-insensitive substring match
// against either the English label ("Japanese") or the original
// Chinese label ("日文"). `voiceName` is a case-insensitive substring
// match against the display name. Both are optional; omit both for
// the full catalog.

const LIST_VOICES_PROMPT = {
	description:
		"List valid MiniMax TTS voice IDs from the embedded catalog. Without filters, returns the full catalog (327 voices across 24 language families). Pass `language` to filter to a single language (e.g. 'Japanese', 'Cantonese', 'Korean', 'Mandarin' — substring match on either the English or original Chinese label). Pass `voiceName` to filter by display-name substring (e.g. 'optimistic', 'commander', 'maiden'). Returns a JSON object with `voices` (array of {voiceId, voiceName, language, languageKey, index}), `count` (filtered), `total` (full catalog), and `languages` (sorted list of language labels in the result). Use this to pick a valid voiceId before calling pi_voice_telegram_config_write with tts.voice, or before passing a per-call `voice` argument to synthesize_voice.",
	promptSnippet:
		"Returns valid MiniMax TTS voice IDs (327 across 24 languages). Filter by language or voice-name substring.",
	promptGuidelines: [
		"Use pi_voice_telegram_list_voices before suggesting or writing a tts.voice value. The catalog is the only in-band way to know which IDs are valid — guessing returns 2054 and the agent can't recover.",
		"Three TTS parameters are independent and each matters: (1) `tts.voice` is the SPEAKER IDENTITY (a `Japanese_*` ID is a Japanese-language voice, a `Cantonese_*` ID is a Cantonese-language voice). (2) `tts.lang` is the PRONUNCIATION BOOST — what language the text should SOUND like, regardless of the voice's native family. (3) The 'voice under a language' is just a specific ID from one of the catalog's 24 language families. Same-language voice+lang gives natural pronunciation; cross-language voice+lang is the 'boost' effect (e.g. Cantonese_PlayfulMan + lang=Japanese speaks in Japanese pronunciation with a Cantonese speaker).",
		"Pass the `language` filter with an exact English label from the catalog ('Japanese', 'Cantonese', 'Mandarin', 'Korean', 'Spanish', etc.) — substring match is supported for partial input. Pass `voiceName` to narrow further (e.g. language='Japanese' + voiceName='commander' returns Japanese_SeriousCommander).",
		"After picking a voiceId from the result, call pi_voice_telegram_config_read first to capture the old value, then pi_voice_telegram_config_write with the new tts.voice. The standard two-step (read → write) gives the operator an old→new diff.",
		"If the operator asks for a 'natural-sounding' voice, the default heuristic is same-language voice+lang (e.g. tts.voice='Japanese_OptimisticYouth' + tts.lang='Japanese' for natural Japanese). If they ask for a 'boost' or 'voice in language X but pronounced like Y', that means cross-language voice+lang.",
	],
};

export function registerListVoicesTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pi_voice_telegram_list_voices",
		label: "List valid TTS voice IDs",
		description: LIST_VOICES_PROMPT.description,
		promptSnippet: LIST_VOICES_PROMPT.promptSnippet,
		promptGuidelines: LIST_VOICES_PROMPT.promptGuidelines,
		parameters: Type.Object({
			language: Type.Optional(
				Type.String({
					description:
						"Optional language filter. Substring (case-insensitive) on either the English label ('Japanese', 'Cantonese', 'Mandarin', 'Korean', 'Spanish', 'Portuguese', 'French', 'German', 'Russian', 'Italian', 'Arabic', 'Indonesian', 'Turkish', 'Dutch', 'Vietnamese', 'Thai', 'Polish', 'Romanian', 'Greek', 'Czech', 'Finnish', 'Hindi', 'Ukrainian', 'English') or the original Chinese label from the upstream catalog ('日文', '中文 (粤语)', '中文 (普通话)', '韩文', '西班牙文', etc.). Omit for all languages.",
				}),
			),
			voiceName: Type.Optional(
				Type.String({
					description:
						"Optional case-insensitive substring filter on the display name (e.g. 'optimistic', 'commander', 'maiden', 'playful', 'intellectual'). Combine with `language` to narrow further.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const loaded = loadVoicesCatalog();
			if (!loaded.ok) {
				throw new Error(
					`pi_voice_telegram_list_voices: cannot read voices.json from the extension's npm package: ${loaded.error}. ` +
						`This usually means the package was installed without the catalog. ` +
						`Reinstall pi-voice-telegram@>=0.15.0 or check that voices.json is present in the npm package.`,
				);
			}
			const filtered = catalogFilterVoices(loaded.data.voices, {
				language: params.language,
				voiceName: params.voiceName,
			});
			const result = {
				count: filtered.length,
				total: loaded.data.voices.length,
				languages: catalogUniqueLanguages(filtered),
				filters: {
					language: params.language ?? null,
					voiceName: params.voiceName ?? null,
				},
				voices: filtered,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: {
					count: filtered.length,
					total: loaded.data.voices.length,
					language: params.language ?? null,
					voiceName: params.voiceName ?? null,
				},
			};
		},
	});
}
