/**
 * echo-handler.ts — STT + 🎙️ echo logic.
 *
 * Two handlers (per voice.md "Voice Provider Extension Surface"):
 *
 *   1. `registerTelegramUpdateHandler` — fires on raw Telegram
 *      updates, BEFORE the bridge downloads the file. Stashes the
 *      chat ID keyed by the deterministic `voice-<id>.ogg` /
 *      `audio-<id>.<ext>` filename the bridge will use. The
 *      transcription provider needs the chat ID for the echo, but
 *      the provider API doesn't pass it.
 *
 *   2. `registerTelegramVoiceTranscriptionProvider` — looks up
 *      the configured STT provider in the registry (v0.3.0+,
 *      previously hardcoded to whisper-server), calls
 *      `provider.transcribe()`, and sends the 🎙️ reply to the
 *      user (when `echoEnabled`). Returns the transcript for the
 *      bridge to include in the agent's user message.
 *
 * The provider is looked up at STT call time (not at registration
 * time) so the provider's `session_start` doesn't have to fire
 * before ours. If the provider isn't registered, the echo records
 * a runtime event and returns `undefined` so the next provider in
 * the chain can try.
 */

import {
	sendTelegramView,
} from "@llblab/pi-telegram/delivery";
import {
	recordTelegramRuntimeEvent,
} from "@llblab/pi-telegram/outbound";
import {
	registerTelegramUpdateHandler,
} from "@llblab/pi-telegram/updates";
import {
	registerTelegramVoiceTranscriptionProvider,
	type TelegramVoiceTranscriptionFile,
	type TelegramVoiceTranscriptionProviderResult,
} from "@llblab/pi-telegram/voice";

import {
	getSttProvider,
	listSttProviders,
	ProviderError,
} from "./stt-provider.js";

import type { EchoConfig } from "./telegram-config.js";

/** chat-id-by-filename map. Populated by the update handler, consumed
 *  by the STT provider. Cleaned up in the provider's `finally` after
 *  the echo is sent (or attempted). */
const chatIdByFileName = new Map<string, number>();

/** Mirror of @llblab/pi-telegram/lib/media.ts:185 (guessExtensionFromMime).
 *  The bridge builds the transcription-provider's `file.fileName` as
 *  `${prefix}-${message_id}${guessExtensionFromMime(mime, fallback)}`,
 *  so the chat-ID stash must use the same function. Drift risk: if
 *  the bridge adds new mime mappings, this mirror will diverge. */
function guessExtensionFromMime(
	mimeType: string | undefined,
	fallback: string,
): string {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

interface TelegramUpdateVoiceMessage {
	voice?: { mime_type?: string; file_size?: number };
	audio?: { mime_type?: string; file_size?: number };
	chat: { id: number; type: string };
	message_id: number;
	from?: { id: number; is_bot: boolean };
}

interface TelegramUpdate {
	message?: TelegramUpdateVoiceMessage;
	edited_message?: TelegramUpdateVoiceMessage;
}

const TELEGRAM_FILE_LIMIT_BYTES = 20 * 1024 * 1024;

/** Stash the chat ID for the deterministic filename the bridge will
 *  use. The transcription provider looks this up later when it
 *  needs to send the echo. */
export async function handleTelegramUpdateForEcho(
	update: unknown,
): Promise<"pass"> {
	const u = update as TelegramUpdate;
	const msg = u.message ?? u.edited_message;
	if (!msg) return "pass";
	if (!msg.voice && !msg.audio) return "pass";
	if (msg.from?.is_bot) return "pass";

	const attachment = msg.voice ?? msg.audio;
	if (!attachment) return "pass";

	// 20 MB cap matches the Telegram Bot API limit.
	if (
		attachment.file_size !== undefined &&
		attachment.file_size > TELEGRAM_FILE_LIMIT_BYTES
	) {
		return "pass";
	}

	const isVoice = Boolean(msg.voice);
	const ext = guessExtensionFromMime(attachment.mime_type, isVoice ? ".ogg" : ".mp3");
	const fileName = `${isVoice ? "voice" : "audio"}-${msg.message_id}${ext}`;
	chatIdByFileName.set(fileName, msg.chat.id);

	return "pass";
}

/** The voice transcription provider. Looks up the configured STT
 *  provider in the registry at call time, runs the transcription,
 *  sends the 🎙️ echo (when `echoEnabled`), and returns the
 *  transcript for the bridge to include in the user message.
 *  Returns `undefined` on any failure so the next provider in
 *  the chain can try. */
async function transcribeAndMaybeEcho(
	file: TelegramVoiceTranscriptionFile,
	options: { language?: string } | undefined,
	echoEnabled: boolean,
	sttProviderId: string,
): Promise<TelegramVoiceTranscriptionProviderResult> {
	if (!file.path) return undefined;
	if (!file.fileName) return undefined;

	const provider = getSttProvider(sttProviderId);
	if (!provider) {
		recordTelegramRuntimeEvent(
			"pi-telegram-echo/stt",
			new Error(
				`STT provider "${sttProviderId}" is not registered. ` +
					`Installed providers: ${listSttProviders().map((p) => p.id).join(", ") || "(none)"}. ` +
					`Install the provider extension (e.g., pi-${sttProviderId}) or change stt_provider in telegram.json.`,
			),
			{ phase: "provider-missing", sttProviderId },
		);
		return undefined;
	}

	let transcript: string;
	try {
		transcript = (
			await provider.transcribe({
				inputPath: file.path,
				lang: options?.language ?? process.env.PI_TELEGRAM_LANG,
			})
		).trim();
	} catch (err) {
		recordTelegramRuntimeEvent(
			"pi-telegram-echo/stt",
			err instanceof Error ? err : new Error(String(err)),
			{
				phase: "run",
				providerId: provider.id,
				...(err instanceof ProviderError
					? { code: err.code, detail: err.detail }
					: {}),
			},
		);
		return undefined;
	}
	if (!transcript) return undefined;

	// Best-effort 🎙️ echo. Failure here does NOT fail the
	// transcription — the agent still gets the transcript via the
	// return value.
	if (echoEnabled) {
		const chatId = chatIdByFileName.get(file.fileName);
		if (chatId !== undefined) {
			try {
				await sendTelegramView(
					{
						text: `🎙️ "<i>${escapeHtml(transcript)}</i>"`,
						parseMode: "html",
					},
					{ scope: { kind: "target", target: { chatId } } },
				);
			} catch (err) {
				recordTelegramRuntimeEvent(
					"pi-telegram-echo/echo",
					err instanceof Error ? err : new Error(String(err)),
					{ phase: "send", chatId, transcriptLength: transcript.length },
				);
			} finally {
				chatIdByFileName.delete(file.fileName);
			}
		}
	}

	return options?.language
		? { text: transcript, language: options.language }
		: transcript;
}

/** Canonical entry point. Exported for tests; the runtime path is
 *  through `registerEchoHandlers` so `cfg.echoEnabled` and
 *  `cfg.stt_provider` are captured in the closure. */
export function handleTelegramVoiceTranscription(
	file: TelegramVoiceTranscriptionFile,
	options?: { language?: string },
): Promise<TelegramVoiceTranscriptionProviderResult> {
	return transcribeAndMaybeEcho(file, options, true, "pi-whisper-stt");
}

/** Wire the two handlers. Returns disposers (one per `register*`
 *  call) so `index.ts` can tear them down on hot-reload or
 *  session_shutdown.
 *
 *  The provider is ALWAYS registered (so the agent always gets
 *  the transcript as text). The 🎙️ echo is gated on
 *  `cfg.echoEnabled`. The STT provider is looked up at call time
 *  via `cfg.stt_provider` (the registry may not have the provider
 *  yet at registration time). Hot-reload re-creates the closure
 *  with the new `cfg.echoEnabled` + `cfg.stt_provider`. */
export function registerEchoHandlers(cfg: EchoConfig): Array<() => void> {
	const disposers: Array<() => void> = [];

	disposers.push(
		registerTelegramUpdateHandler(handleTelegramUpdateForEcho),
	);
	disposers.push(
		registerTelegramVoiceTranscriptionProvider(
			(file, options) =>
				transcribeAndMaybeEcho(
					file,
					options,
					cfg.echoEnabled,
					cfg.stt_provider,
				),
			{ id: "pi-telegram-echo/stt" },
		),
	);

	return disposers;
}
