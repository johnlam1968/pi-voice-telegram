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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import { synthesize as voiceReplySynthesize } from "./voice-reply.js";
import { transcribe as whisperTranscribe } from "./whisper-stt.js";
import {
	type ResolvedSttDefaults,
	type ResolvedTtsDefaults,
} from "./config.js";
import {
	lookupKey as ioLookupKey,
	readSettings as ioReadSettings,
	writeKey as ioWriteKey,
} from "./config-io.js";

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
			try {
				await voiceReplySynthesize({
					text: params.text,
					voice: params.voice ?? tts.voice,
					lang: params.lang ?? tts.lang,
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
		"Read the current value(s) of the pi-voice-telegram companion settings file (~/.pi/agent/pi-voice-telegram.json). Without a `key` parameter, returns the full settings object as formatted JSON. With a dotted-path `key` (e.g. 'tts.lang', 'inbound.echoEnabled', 'tools.writable'), returns just that one value. Use this before modifying settings to confirm the current state.",
	promptSnippet: "Reads the current companion settings (full or per-key).",
	promptGuidelines: [
		"Use pi_voice_telegram_config_read to inspect the operator's current settings before suggesting edits. The agent should know what's already set.",
		"Pass the `key` parameter for a single value, omit it for the full file. The dotted path uses the same lookup as the schema tool — short form ('tts.voice') works as well as explicit form.",
		"This tool is only registered when the operator has set `tools.writable: true` in the companion settings. If it's not available, ask the operator to opt in.",
	],
};

const CONFIG_WRITE_PROMPT = {
	description:
		"Modify a single key in the pi-voice-telegram companion settings file. The write is schema-validated (refuses unknown keys) and atomic (write-to-tmp + rename). Always reads the current value first, applies the change, and returns both the old and new values in the result. Reminder: changes take effect only after the agent session is restarted — inform the operator.",
	promptSnippet: "Schema-validated atomic write to the companion settings (single key + value).",
	promptGuidelines: [
		"Use pi_voice_telegram_config_write when the operator asks you to change a setting (e.g. 'set tts.lang to ja', 'turn on the schema tool').",
		"Always read the current value with pi_voice_telegram_config_read FIRST so you can report old → new. This is the operator's safety net — the write is atomic, but reading first means you can also confirm the diff.",
		"Pass the dotted `key` path and the new `value` (as a JSON value, not a string). The tool will reject writes to `$schema`, `_hint`, or any key not in the schema.",
		"After a successful write, tell the operator: 'restart the session for this change to take effect.' The extension reads the config once per session_start.",
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
							`Restart the agent session for this change to take effect.`,
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
