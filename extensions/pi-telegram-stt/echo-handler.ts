/**
 * echo-handler.ts — wires the two STT extension points:
 * `registerTelegramUpdateHandler` (stashes the chat ID keyed by
 * filename, since the transcription provider API doesn't pass it) and
 * `registerTelegramVoiceTranscriptionProvider` (calls
 * `provider.transcribe()` + sends the show-transcript reply).
 * Design (chat-ID-by-filename map, runtime event categories, cleanup
 * shape) in `docs/STT-PACKAGE.md`.
 */

import { sendTelegramView } from "@llblab/pi-telegram/delivery";
import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";
import { registerTelegramUpdateHandler } from "@llblab/pi-telegram/updates";
import {
	registerTelegramVoiceTranscriptionProvider,
	type TelegramVoiceTranscriptionFile,
	type TelegramVoiceTranscriptionProviderResult,
} from "@llblab/pi-telegram/voice";

import { makeLogger } from "./_logger.js";
import {
	getSttProvider,
	listSttProviders,
	ProviderError,
} from "./stt-provider.js";
import type { EchoConfig } from "./telegram-config.js";

const log = makeLogger("pi-telegram-stt/stt");

// chat-id-by-filename map. Populated by the update handler, consumed
// by the STT provider, cleaned up in the provider's `finally`.
const chatIdByFileName = new Map<string, number>();

/** Mirror of `@llblab/pi-telegram/lib/media.ts:185` for the two
 *  audio types we care about (the bridge builds the transcription
 *  filename as `${prefix}-${id}${ext}`). Drift risk: if the
 *  bridge adds a new audio mime, this mirror will diverge. */
function guessAudioExt(
	mimeType: string | undefined,
	fallback: string,
): string {
	const m = mimeType?.toLowerCase();
	if (m === "audio/ogg") return ".ogg";
	if (m === "audio/mpeg") return ".mp3";
	if (m === "audio/wav") return ".wav";
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

/** Stash the chat ID for the deterministic filename the bridge
 *  will use. The transcription provider looks this up later. */
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
	if (
		attachment.file_size !== undefined &&
		attachment.file_size > TELEGRAM_FILE_LIMIT_BYTES
	) {
		return "pass";
	}

	const isVoice = Boolean(msg.voice);
	const ext = guessAudioExt(attachment.mime_type, isVoice ? ".ogg" : ".mp3");
	const fileName = `${isVoice ? "voice" : "audio"}-${msg.message_id}${ext}`;
	chatIdByFileName.set(fileName, msg.chat.id);
	log.info("inbound stashed", {
		fileName,
		chatId: msg.chat.id,
		isVoice,
		mime: attachment.mime_type,
		sizeBytes: attachment.file_size,
	});
	return "pass";
}

async function transcribeAndMaybeEcho(
	file: TelegramVoiceTranscriptionFile,
	options: { language?: string } | undefined,
	showTranscript: boolean,
	sttProviderId: string,
): Promise<TelegramVoiceTranscriptionProviderResult> {
	if (!file.path || !file.fileName) return undefined;

	const provider = getSttProvider(sttProviderId);
	if (!provider) {
		log.warn("STT provider not registered", {
			wanted: sttProviderId,
			installed: listSttProviders().map((p) => p.id),
		});
		recordTelegramRuntimeEvent(
			"pi-telegram-stt/stt",
			new Error(
				`STT provider "${sttProviderId}" is not registered. ` +
					`Installed providers: ${listSttProviders().map((p) => p.id).join(", ") || "(none)"}. ` +
					`Install the matching provider extension or change stt_provider in telegram.json.`,
			),
			{ phase: "provider-missing", sttProviderId },
		);
		return undefined;
	}
	log.info("transcribe start", {
		provider: provider.id,
		file: file.fileName,
		lang: options?.language ?? process.env.PI_TELEGRAM_LANG,
	});

	let transcript: string;
	try {
		transcript = (
			await provider.transcribe({
				inputPath: file.path,
				lang: options?.language ?? process.env.PI_TELEGRAM_LANG,
			})
		).trim();
	} catch (err) {
		const code = err instanceof ProviderError ? err.code : undefined;
		const detail = err instanceof ProviderError ? err.detail : undefined;
		log.error("transcribe failed", {
			provider: provider.id,
			code,
			detail: detail ? JSON.stringify(detail) : undefined,
			error: err instanceof Error ? err.message : String(err),
		});
		recordTelegramRuntimeEvent(
			"pi-telegram-stt/stt",
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
	if (!transcript) {
		log.warn("transcribe returned empty", { provider: provider.id });
		return undefined;
	}
	log.info("transcribe ok", { provider: provider.id, chars: transcript.length });

	// Best-effort "show transcript" reply. Failure here does NOT
	// fail the transcription — the agent still gets the transcript.
	if (showTranscript) {
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
				log.info("echo sent", { chatId, chars: transcript.length });
			} catch (err) {
				log.error("echo send failed", {
					chatId,
					error: err instanceof Error ? err.message : String(err),
				});
				recordTelegramRuntimeEvent(
					"pi-telegram-stt/echo",
					err instanceof Error ? err : new Error(String(err)),
					{ phase: "send", chatId, transcriptLength: transcript.length },
				);
			} finally {
				chatIdByFileName.delete(file.fileName);
			}
		} else {
			log.warn("showTranscript enabled but no chatId stashed", {
				file: file.fileName,
			});
		}
	} else {
		log.debug("showTranscript disabled, skipping", { file: file.fileName });
	}

	return options?.language
		? { text: transcript, language: options.language }
		: transcript;
}

/** Wire the two handlers. Returns disposers (one per `register*`
 *  call) so `index.ts` can tear them down on hot-reload or
 *  `session_shutdown`. The provider closure captures
 *  `cfg.showTranscript` and `cfg.stt_provider`, so a `telegram.json`
 *  write (e.g., from the section's toggle button or provider
 *  picker) takes effect on the next inbound voice message. */
export function registerEchoHandlers(cfg: EchoConfig): Array<() => void> {
	return [
		registerTelegramUpdateHandler(handleTelegramUpdateForEcho),
		registerTelegramVoiceTranscriptionProvider(
			(file, options) =>
				transcribeAndMaybeEcho(file, options, cfg.showTranscript, cfg.stt_provider),
			{ id: "pi-telegram-stt/stt" },
		),
	];
}
