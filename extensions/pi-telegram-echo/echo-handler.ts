/**
 * echo-handler.ts — STT + 🎙️ echo logic.
 *
 * Registers two handlers with the bridge:
 *
 *   1. `registerTelegramUpdateHandler` — fires on raw Telegram updates,
 *      BEFORE the bridge downloads the file. Does ONE thing: stash
 *      the chat ID for this message, keyed by the deterministic file
 *      name the bridge will use. The transcription provider needs the
 *      chat ID to send the echo, but the provider API doesn't pass it
 *      (the provider only sees the file).
 *
 *   2. `registerTelegramVoiceTranscriptionProvider` — the STT provider
 *      itself. The bridge calls us with the downloaded file path. We:
 *        a. Run the operator's configured STT command
 *        b. Send the 🎙️ reply to the user (the cached chat ID)
 *        c. Return the transcript
 *
 *   The operator can also configure `telegram.json.inboundHandlers` with
 *   a command template. That path runs FIRST ("stronger" path per
 *   voice.md). If it returns text, the chain ends and we're bypassed —
 *   the echo doesn't fire. That's the operator's choice.
 *
 *   We are the FALLBACK path: only used when no stronger handler
 *   produces output. The STT call inside us is itself a configurable
 *   command (any HTTP/script STT the operator has on hand).
 */

import { spawn } from "node:child_process";

import {
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	recordTelegramRuntimeEvent,
} from "@llblab/pi-telegram/outbound";
import {
	sendTelegramView,
} from "@llblab/pi-telegram/delivery";
import {
	registerTelegramUpdateHandler,
} from "@llblab/pi-telegram/updates";
import {
	registerTelegramVoiceTranscriptionProvider,
} from "@llblab/pi-telegram/voice";

import type { EchoConfig } from "./telegram-config.js";

/** chat-id-by-filename map. Populated by the update handler, consumed
 *  by the STT provider. Bounded by the provider's `finally` cleanup. */
const chatIdByFileName = new Map<string, number>();

/** Mirror of @llblab/pi-telegram/lib/media.ts:185 (guessExtensionFromMime).
 *  Needed because the update handler must build the same `voice-<id>.ogg`
 *  filename the bridge will use, so the chat ID is keyed correctly.
 *  Drift risk: if the bridge adds new mime mappings, this mirror will
 *  diverge and the chat-ID lookup will silently miss for new mimes. */
function guessExtension(
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

/** Run the operator's configured STT command on `inputPath`. Substitutes
 *  the literal token `{file}` in any argument with the actual path. */
async function runSttCommand(
	inputPath: string,
	command: string[],
): Promise<string> {
	const cmd = command.map((part) => (part === "{file}" ? inputPath : part));
	return new Promise((resolve, reject) => {
		const child = spawn(cmd[0]!, cmd.slice(1), {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error("STT command timed out after 30s"));
		}, 30_000);
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) resolve(stdout);
			else
				reject(
					new Error(
						`STT command exited ${code}: ${stderr.slice(0, 500)}`,
					),
				);
		});
	});
}

export function registerEchoHandlers(cfg: EchoConfig): Array<() => void> {
	const disposers: Array<() => void> = [];

	// 1. Update handler — stash chat ID by deterministic file name.
	disposers.push(
		registerTelegramUpdateHandler((update: unknown) => {
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
				attachment.file_size > 20 * 1024 * 1024
			) {
				return "pass";
			}

			const isVoice = Boolean(msg.voice);
			const ext = guessExtension(
				attachment.mime_type,
				isVoice ? ".ogg" : ".mp3",
			);
			const fileName = `${isVoice ? "voice" : "audio"}-${msg.message_id}${ext}`;
			chatIdByFileName.set(fileName, msg.chat.id);
			return "pass";
		}),
	);

	// 2. STT provider — run the command, send the echo, return the transcript.
	disposers.push(
		registerTelegramVoiceTranscriptionProvider(
			async (file, options) => {
				if (!cfg.echoEnabled) return undefined; // echo off — pass through
				if (!file.path || cfg.stt.command.length === 0) {
					// No STT configured — pass through so another
					// provider (or a stronger inbound handler) can pick
					// it up.
					return undefined;
				}

				let transcript: string;
				try {
					const stdout = await runSttCommand(
						file.path,
						cfg.stt.command,
					);
					transcript = stdout.trim();
				} catch (err) {
					recordTelegramRuntimeEvent(
						"pi-telegram-echo/stt",
						err instanceof Error ? err : new Error(String(err)),
						{ phase: "run" },
					);
					return undefined; // fall through; don't fail the bridge
				}

				if (!transcript) return undefined;

				// Send the 🎙️ echo. Failure here does NOT fail the
				// transcription — the agent still gets the transcript
				// via the return value.
				if (file.fileName) {
					const chatId = chatIdByFileName.get(file.fileName);
					if (chatId !== undefined) {
						try {
							const agentDir =
								process.env.PI_CODING_AGENT_DIR ??
								getAgentDir();
							const botToken = await loadBotToken(agentDir);
							if (botToken) {
								await sendTelegramView(
									{
										text: `🎙️ "<i>${escapeHtml(transcript)}</i>"`,
										parseMode: "html",
									},
									{
										scope: {
											kind: "target",
											target: { chatId },
										},
									},
								);
							}
						} catch (err) {
							recordTelegramRuntimeEvent(
								"pi-telegram-echo/echo",
								err instanceof Error ? err : new Error(String(err)),
								{ phase: "send" },
							);
						} finally {
							chatIdByFileName.delete(file.fileName);
						}
					}
				}

				return options?.language
					? { text: transcript, language: options.language }
					: transcript;
			},
			{ id: "pi-telegram-echo/stt" },
		),
	);

	return disposers;
}

/** Load the bot token from telegram.json. Mirrors the pattern in
 *  the current pi-voice-telegram/echo.ts (we don't own a copy of the
 *  bridge's loadBotToken). */
async function loadBotToken(agentDir: string): Promise<string | undefined> {
	const { existsSync, readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const path = join(agentDir, "telegram.json");
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as {
			profiles?: Record<string, { botToken?: string }>;
		};
		const def = parsed.profiles?.default;
		return def?.botToken;
	} catch {
		return undefined;
	}
}
