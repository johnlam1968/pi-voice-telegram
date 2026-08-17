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

// --- TTS defaults (mirror synthesis-provider.ts layering) ---

const DEFAULT_TTS_VOICE = process.env.PI_MM_TTS_VOICE ?? "Cantonese_PlayfulMan";
const DEFAULT_TTS_LANG = process.env.PI_MM_TTS_LANG ?? "Chinese,Yue";
const DEFAULT_TTS_MODEL = process.env.PI_MM_TTS_MODEL ?? "speech-2.8-hd";
const TTS_TIMEOUT_MS = Number(
	process.env.PI_MM_TTS_VOICE_REPLY_TIMEOUT_MS ?? "30000",
);

// --- STT defaults (mirror whisper-stt.ts defaults) ---

const DEFAULT_STT_LANG = process.env.PI_TELEGRAM_LANG ?? "yue";
const STT_TIMEOUT_MS = Number(process.env.PI_TELEGRAM_STT_TIMEOUT_MS ?? "60000");

/** Per-tool overrides from the companion settings file. */
export interface ToolNameConfig {
	tts?: { name?: string };
	stt?: { name?: string };
}

// --- synthesize_voice ---

const TTS_GUIDELINES = [
	"Use synthesize_voice when the user explicitly asks for a voice reply, when a voice memo would convey the answer more naturally than text, or to read a file aloud.",
	"synthesize_voice only writes a file — to deliver it to the user, call the bridge's telegram_attach tool with the returned path.",
	"Do NOT use synthesize_voice as a turn-reply voice — the bridge handles automatic voice replies (driven by voice.replyMode in telegram.json). This tool is for ad-hoc voice.",
];

export function registerSynthesizeVoiceTool(
	pi: ExtensionAPI,
	agentDir: string,
	cfg: ToolNameConfig["tts"],
): void {
	const toolName = cfg?.name ?? "synthesize_voice";
	pi.registerTool({
		name: toolName,
		label: "Synthesize voice (TTS)",
		description:
			"Convert text to a Telegram-ready OGG/Opus voice file via MiniMax TTS. Returns the file path. Use the bridge's telegram_attach tool to deliver it to the user.",
		promptSnippet: "Synthesize text to an OGG/Opus voice file (returns path; pair with telegram_attach to send).",
		promptGuidelines: TTS_GUIDELINES,
		parameters: Type.Object({
			text: Type.String({ description: "Text to speak (≤10k chars, ≤1k per chunk for legacy models)" }),
			voice: Type.Optional(Type.String({ description: `Voice ID. Default: ${DEFAULT_TTS_VOICE}` })),
			lang: Type.Optional(Type.String({ description: `Language boost. Default: ${DEFAULT_TTS_LANG}` })),
			model: Type.Optional(Type.String({ description: `TTS model ID. Default: ${DEFAULT_TTS_MODEL}` })),
			speed: Type.Optional(Type.Number({ description: "Speed multiplier. Default: 1.0" })),
		}),
		async execute(_toolCallId, params) {
			const oggPath = `${agentDir}/tmp/pi-voice-telegram-tool-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.ogg`;
			try {
				await voiceReplySynthesize({
					text: params.text,
					voice: params.voice ?? DEFAULT_TTS_VOICE,
					lang: params.lang ?? DEFAULT_TTS_LANG,
					model: params.model ?? DEFAULT_TTS_MODEL,
					speed: params.speed ?? 1.0,
					oggPath,
					timeoutMs: TTS_TIMEOUT_MS,
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

const STT_GUIDELINES = [
	"Use transcribe_audio when the user asks you to transcribe a local audio file, or when you need to read the contents of a voice note referenced by path.",
	"transcribe_audio POSTs to the local whisper-server (default http://127.0.0.1:8080). The result is the transcript text.",
	"Incoming Telegram voice/audio messages are already transcribed automatically by the inbound echo pipeline — only call transcribe_audio for files the user has not already sent.",
];

export function registerTranscribeAudioTool(
	pi: ExtensionAPI,
	agentDir: string,
	cfg: ToolNameConfig["stt"],
): void {
	const toolName = cfg?.name ?? "transcribe_audio";
	pi.registerTool({
		name: toolName,
		label: "Transcribe audio (STT)",
		description:
			"Transcribe a local audio file via the local whisper-server HTTP endpoint. Returns the transcript text.",
		promptSnippet: "Transcribe a local audio file via whisper-server (returns text).",
		promptGuidelines: STT_GUIDELINES,
		parameters: Type.Object({
			inputPath: Type.String({ description: "Absolute path to the audio file on disk" }),
			lang: Type.Optional(Type.String({ description: `BCP-47 / ISO-639-1 language code. Default: ${DEFAULT_STT_LANG}` })),
			baseUrl: Type.Optional(Type.String({ description: "Override whisper-server base URL. Default: $WHISPER_SERVER_URL or http://127.0.0.1:8080" })),
		}),
		async execute(_toolCallId, params) {
			const transcript = (await whisperTranscribe({
				inputPath: params.inputPath,
				lang: params.lang ?? DEFAULT_STT_LANG,
				timeoutMs: STT_TIMEOUT_MS,
				baseUrl: params.baseUrl,
			})).trim();
			return {
				content: [{ type: "text", text: transcript }],
				details: { inputPath: params.inputPath, lang: params.lang ?? DEFAULT_STT_LANG, length: transcript.length },
			};
		},
	});
}
