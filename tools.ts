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

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import { synthesize as voiceReplySynthesize } from "./voice-reply.js";
import { transcribe as whisperTranscribe } from "./whisper-stt.js";
import {
	type ResolvedSttDefaults,
	type ResolvedTtsDefaults,
} from "./config.js";

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
