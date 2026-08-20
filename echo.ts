/**
 * Voice echo for pi-voice-telegram.
 *
 * v0.16.7 REDESIGN: one place that does the work, no double-transcription.
 *
 * The bridge (`@llblab/pi-telegram`) is the orchestrator. It downloads
 * voice files, calls registered voice transcription providers, and
 * includes the returned transcript in the agent's user message. We
 * register as a transcription provider and do the actual STT work
 * (POST to whisper-server), plus send the user a `🎙️ "transcript"`
 * echo back to Telegram so they can confirm what was heard.
 *
 * Flow:
 *   1. User sends a voice message.
 *   2. Bridge polling receives the update.
 *   3. Our `handleTelegramUpdateForEcho` fires (registered via
 *      `registerTelegramUpdateHandler`). It does ONE thing: stash the
 *      chat ID for this message, keyed by the deterministic file name
 *      the bridge will use. We need the chat ID later for the echo,
 *      but the transcription provider doesn't get it.
 *   4. Bridge's default handle downloads the file to
 *      `<agentDir>/tmp/telegram/UUID-voice-<id>.<ext>`.
 *   5. Bridge calls `processTelegramInboundHandlers`, which tries
 *      declarative handlers → programmatic handlers → voice
 *      transcription providers. Our
 *      `handleTelegramVoiceTranscription` runs as a transcription
 *      provider (registered via `registerTelegramVoiceTranscriptionProvider`).
 *      It transcribes the bridge's downloaded file, sends the echo
 *      to the user, and returns the transcript.
 *   6. Bridge includes the returned transcript in the agent's user
 *      message (`[outputs]` section).
 *   7. LLM processes the message and replies.
 *
 * The echo in step 5 happens BEFORE step 7, so the user sees the
 * `🎙️ "transcript"` confirmation before the LLM reply.
 *
 * Why this design:
 *   - Single transcription. The previous design (v0.16.6 and earlier)
 *     had two handlers — an update handler that downloaded + transcribed +
 *     cached + sent the echo, and an inbound handler that did its own
 *     on-demand transcribe when the cache was empty. The same audio
 *     was transcribed twice (worst case), and the update handler's
 *     own download could fail silently (no verification of the byte
 *     count, so an empty 200-OK response from Telegram's file endpoint
 *     silently produced an empty transcript and skipped the echo).
 *   - The bridge does the file download. The bridge's download path
 *     is the same one used for the agent's voice message, so it's
 *     well-tested and reliable. We reuse it.
 *   - The bridge runs the provider. The bridge's
 *     `transcribeTelegramVoiceFileWithProviders` is the canonical
 *     place; the resulting transcript is automatically included in
 *     the user message.
 *   - The echo is sent from the same code path that produces the
 *     transcript. No separate update-handler download → less surface
 *     for silent failures.
 *
 * Public APIs used (stable per pi-telegram public-api.md):
 *   - @llblab/pi-telegram/updates   → registerTelegramUpdateHandler
 *   - @llblab/pi-telegram/voice     → registerTelegramVoiceTranscriptionProvider
 *   - @llblab/pi-telegram/delivery  → sendTelegramView
 *   - @earendil-works/pi-coding-agent → getAgentDir
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { sendTelegramView } from "@llblab/pi-telegram/delivery";
import type {
  TelegramVoiceTranscriptionFile,
  TelegramVoiceTranscriptionProviderResult,
} from "@llblab/pi-telegram/voice";

import { transcribe as runStt } from "./whisper-stt.js";

// --- Configuration (JSON > env > hardcoded) ---

/**
 * Resolved STT defaults, set by `index.ts` `reconfigure()` on every
 * hot-reload. Read from `~/.pi/agent/pi-voice-telegram.json`'s `stt.*`
 * fields via `config.ts::resolveSttDefaults`. If `lang` is undefined,
 * whisper-server auto-detects.
 */
interface ResolvedSttDefaults {
  lang?: string;
  baseUrl?: string;
  timeoutMs: number;
}

let currentSttDefaults: ResolvedSttDefaults = {
  lang: undefined,
  baseUrl: undefined,
  timeoutMs: 60_000,
};

export function setSttDefaults(defaults: ResolvedSttDefaults): void {
  currentSttDefaults = defaults;
}

const TELEGRAM_FILE_LIMIT_BYTES = 20 * 1024 * 1024;

// --- Chat-ID cache (file name → chat ID) ---
//
// The voice transcription provider doesn't get the chat ID in its
// arguments. We need it to send the `🎙️` echo to the right chat. The
// update handler runs BEFORE the provider (in the bridge's update
// dispatch) and DOES have the chat ID from the raw update, so it
// stashes it here. The provider looks it up by file name.
//
// Cleaned up after the echo is sent (or on session_shutdown via
// `clearSttState`).

const chatIdByFileName = new Map<string, number>();

export function clearSttState(): void {
  chatIdByFileName.clear();
}

// --- Bot token loader ---

async function loadBotToken(agentDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(agentDir, "telegram.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { botToken?: string }>;
    };
    const profiles = parsed.profiles ?? {};
    const fromDefault = profiles.default?.botToken;
    if (fromDefault) return fromDefault;
    for (const profile of Object.values(profiles)) {
      if (profile?.botToken) return profile.botToken;
    }
  } catch {
    // ignore
  }
  return undefined;
}

// --- Type narrows for the raw update ---

interface TelegramVoiceAttachment {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  mime_type?: string;
}

interface TelegramUpdateVoiceMessage {
  voice?: TelegramVoiceAttachment;
  audio?: TelegramVoiceAttachment;
  chat: { id: number; type: string };
  message_id: number;
  message_thread_id?: number;
  from?: { id: number; is_bot: boolean };
}

interface TelegramUpdate {
  message?: TelegramUpdateVoiceMessage;
  edited_message?: TelegramUpdateVoiceMessage;
}

/**
 * Mirror of `@llblab/pi-telegram/lib/media.ts:185` `guessExtensionFromMime`.
 * The bridge builds the transcription-provider's `file.fileName` as
 * `${prefix}-${message_id}${guessExtensionFromMime(mime, fallback)}` (see
 * `lib/media.ts:864` for audio, `:881` for voice). The chat-ID stash in
 * `handleTelegramUpdateForEcho` must use the *same* function for the
 * extension and the *same* prefix to keep the `chatIdByFileName.get(file.fileName)`
 * lookup in the provider branch working.
 *
 * Drift risk: the bridge's public API doesn't expose this function, so
 * if upstream adds new mime mappings, this mirror will diverge and the
 * chat-ID lookup will silently break for the new mime types. v0.18.0
 * (registerTelegramSection migration) is the natural place to revisit
 * this — the section can carry a "last seen bridge version" and warn
 * the operator on drift.
 */
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

// --- Update handler (minimal) ---

/**
 * Runs at the bridge's update-dispatch phase, BEFORE the bridge
 * downloads the file. Does ONE thing: stash the chat ID for this
 * message, keyed by the deterministic file name the bridge will
 * use. The transcription provider looks this up later when it
 * needs to send the echo.
 *
 * The function name is kept (`handleTelegramUpdateForEcho`) for
 * backwards compatibility with the previous design's index.ts
 * registration call — but the body no longer does any
 * download/transcribe/cache work. All of that is now in the
 * transcription provider, which runs against the bridge's
 * already-downloaded file (so the silent-download-failure mode
 * of the v0.16.6 design is gone).
 */
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
  if (attachment.file_size !== undefined && attachment.file_size > TELEGRAM_FILE_LIMIT_BYTES) {
    return "pass";
  }

  const isVoice = Boolean(msg.voice);
  const ext = guessExtensionFromMime(attachment.mime_type, isVoice ? ".ogg" : ".mp3");
  // Mirror the bridge's `lib/media.ts:864,881` filename format:
  //   voice: `voice-${message_id}${ext}`
  //   audio: `audio-${message_id}${ext}`
  // The transcription provider's `file.fileName` is built with this same
  // format; using anything else here silently drops the `🎙️` echo.
  const fileName = `${isVoice ? "voice" : "audio"}-${msg.message_id}${ext}`;
  chatIdByFileName.set(fileName, msg.chat.id);

  return "pass";
}

// --- Transcription provider (the work) ---

/**
 * The voice transcription provider. Registered with
 * `registerTelegramVoiceTranscriptionProvider` so the bridge calls
 * us during `processTelegramInboundHandlers`. The bridge has
 * already downloaded the file (reliable path — same code that
 * delivers the file to the LLM). We:
 *
 *   1. Transcribe the bridge's downloaded file via `runStt`
 *      (POST to whisper-server with FormData).
 *   2. Send the `🎙️ "transcript"` echo to the user via
 *      `sendTelegramView`, using the chat ID we stashed in the
 *      update handler.
 *   3. Return the transcript. The bridge puts it in the user
 *      message's `[outputs]` section for the LLM.
 *
 * Order: the echo is sent BEFORE the bridge constructs the user
 * message and dispatches to the LLM. The user sees the echo
 * confirmation before the agent's voice reply.
 */
export async function handleTelegramVoiceTranscription(
  file: TelegramVoiceTranscriptionFile,
  options?: { language?: string },
): Promise<TelegramVoiceTranscriptionProviderResult> {
  if (!file.path) return undefined;

  const stt = currentSttDefaults;
  const transcript = (
    await runStt({
      inputPath: file.path,
      lang: options?.language ?? stt.lang,
      baseUrl: stt.baseUrl,
      timeoutMs: stt.timeoutMs,
    })
  ).trim();
  if (!transcript) return undefined;

  // Best-effort echo. Failure here does NOT fail the transcription —
  // the agent still gets the transcript via the return value.
  if (file.fileName) {
    const chatId = chatIdByFileName.get(file.fileName);
    if (chatId !== undefined) {
      try {
        const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
        const botToken = await loadBotToken(agentDir);
        if (botToken) {
          await sendTelegramView(
            { text: `🎙️ "<i>${escapeHtml(transcript)}</i>"`, parseMode: "html" },
            { scope: { kind: "target", target: { chatId } } },
          );
        }
      } catch {
        // Echo failure is silent — we don't want a transient
        // delivery hiccup to fail the transcription.
      } finally {
        chatIdByFileName.delete(file.fileName);
      }
    }
  }

  return transcript;
}
