/**
 * Voice echo for pi-voice-telegram.
 *
 * Detects incoming voice / audio messages from Telegram, runs the
 * STT pipeline (`whisper-stt.ts` → `whisper-server` HTTP), and sends
 * the user a `🎙️ "<transcript>"` reply so they can confirm what the
 * STT pipeline heard before the agent responds.
 *
 * Single-STT design (no duplicate transcription):
 *   1. The raw update handler runs BEFORE the bridge's default
 *      handler. It downloads the file, runs the in-process STT
 *      client exactly once, caches the transcript by the
 *      deterministic `voice-<id>.<ext>` fileName the bridge assigns,
 *      and sends the `🎙️` echo.
 *   2. The bridge's inbound pipeline then runs the programmatic
 *      inbound handler (below), which returns the cached transcript.
 *      The bridge uses this for the agent's prompt — the same text
 *      the user saw in the echo, no second STT call.
 *
 * Skips:
 *   - Bot-originated messages (`from.is_bot`).
 *   - Files larger than 20 MB (Telegram Bot API cap).
 *
 * v0.3.0: the STT pipeline is now in-process. `whisper-stt.ts` is a
 * pure-TypeScript HTTP client (replaces the `fw-cuda-stdout` bash
 * wrapper). The agent's `~/.pi/agent/bin/fw-cuda-stdout` is now
 * orphaned and can be removed.
 *
 * Public APIs used (stable per pi-telegram public-api.md):
 *   - @llblab/pi-telegram/updates   → registerTelegramUpdateHandler
 *   - @llblab/pi-telegram/inbound   → registerTelegramInboundHandler
 *   - @llblab/pi-telegram/delivery  → sendTelegramView
 *   - @llblab/pi-telegram/outbound  → recordTelegramRuntimeEvent
 *   - @earendil-works/pi-coding-agent → getAgentDir
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { sendTelegramView } from "@llblab/pi-telegram/delivery";
import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import { transcribe as runStt } from "./whisper-stt.js";

// --- Configuration ---

const STT_TIMEOUT_MS = Number(process.env.PI_TELEGRAM_STT_TIMEOUT_MS ?? "60000");

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_FILE_LIMIT_BYTES = 20 * 1024 * 1024;

// --- Per-session transcript cache ---

/**
 * Keyed by the deterministic fileName the bridge assigns to the
 * downloaded attachment (e.g. `voice-12345.ogg`). The update handler
 * writes; the inbound handler reads. Cleared on session_shutdown.
 */
const transcriptCache = new Map<string, string>();

export function getCachedTranscript(fileName: string): string | undefined {
  return transcriptCache.get(fileName);
}

export function clearTranscriptCache(): void {
  transcriptCache.clear();
}

// --- Telegram Bot API helpers ---

async function loadBotToken(agentDir: string): Promise<string | undefined> {
  const path = join(agentDir, "telegram.json");
  try {
    const raw = await readFile(path, "utf8");
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

interface TelegramFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

async function getTelegramFile(
  botToken: string,
  fileId: string,
  signal: AbortSignal,
): Promise<TelegramFile> {
  const url = `${TELEGRAM_API}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`getFile ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { ok: boolean; result?: TelegramFile; description?: string };
  if (!json.ok || !json.result) {
    throw new Error(`getFile failed: ${json.description ?? "unknown"}`);
  }
  return json.result;
}

async function downloadTelegramFile(
  botToken: string,
  filePath: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = `${TELEGRAM_API}/file/bot${botToken}/${filePath}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`file download ${res.status}: ${await res.text()}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// --- STT invocation (in-process via whisper-stt.ts) ---
//
// (No spawn helper needed — whisper-stt.transcribe() returns a Promise<string>
//  directly. The single per-call timeout comes from STT_TIMEOUT_MS.)

// --- Type narrows for the raw update ---

interface TelegramUpdateVoiceMessage {
  voice?: { file_id: string; file_unique_id?: string; file_size?: number; mime_type?: string };
  audio?: { file_id: string; file_unique_id?: string; file_size?: number; mime_type?: string };
  chat: { id: number; type: string };
  message_id: number;
  message_thread_id?: number;
  from?: { id: number; is_bot: boolean };
}

interface TelegramUpdate {
  message?: TelegramUpdateVoiceMessage;
  edited_message?: TelegramUpdateVoiceMessage;
}

function fileNameFor(messageId: number, ext: string): string {
  return `voice-${messageId}${ext}`;
}

function mimeToExtension(mime: string | undefined, fallback: string): string {
  if (!mime) return fallback;
  const m = mime.toLowerCase();
  if (m.includes("ogg")) return ".ogg";
  if (m.includes("opus")) return ".opus";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("mp4") || m.includes("m4a")) return ".m4a";
  if (m.includes("wav")) return ".wav";
  return fallback;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- STT + echo pipeline ---

async function transcribeAndEcho(
  botToken: string,
  message: TelegramUpdateVoiceMessage,
): Promise<void> {
  const attachment = message.voice ?? message.audio;
  if (!attachment) return;

  if (attachment.file_size !== undefined && attachment.file_size > TELEGRAM_FILE_LIMIT_BYTES) {
    recordTelegramRuntimeEvent("pi-voice-telegram/echo", new Error("file too large"), {
      phase: "size-check",
      chatId: message.chat.id,
      messageId: message.message_id,
    });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);

  const isVoice = Boolean(message.voice);
  const fallbackExt = isVoice ? ".ogg" : ".mp3";
  const ext = mimeToExtension(attachment.mime_type, fallbackExt);
  const cacheKey = fileNameFor(message.message_id, ext);

  try {
    const meta = await getTelegramFile(botToken, attachment.file_id, controller.signal);
    if (!meta.file_path) throw new Error("getFile returned no file_path");

    const bytes = await downloadTelegramFile(botToken, meta.file_path, controller.signal);
    const tmp = await mkdtemp(join(tmpdir(), "pi-tg-stt-"));
    const inputPath = join(tmp, `voice${ext}`);
    try {
      await writeFile(inputPath, bytes);
      const transcript = (await runStt({ inputPath, timeoutMs: STT_TIMEOUT_MS })).trim();
      if (!transcript) return;

      // Cache BEFORE echoing so a slow echo can't race the inbound handler.
      transcriptCache.set(cacheKey, transcript);

      const target: { chatId: number; threadId?: number } = { chatId: message.chat.id };
      if (typeof message.message_thread_id === "number") {
        target.threadId = message.message_thread_id;
      }

      const result = await sendTelegramView(
        { text: `🎙️ "<i>${escapeHtml(transcript)}</i>"`, parseMode: "html" },
        { scope: { kind: "target", target } },
      );
      if (!result.ok) {
        recordTelegramRuntimeEvent("pi-voice-telegram/echo", new Error(result.message), {
          phase: "send",
          reason: result.reason,
          chatId: message.chat.id,
          messageId: message.message_id,
        });
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    recordTelegramRuntimeEvent("pi-voice-telegram/echo", error, {
      phase: "transcribe",
      chatId: message.chat.id,
      messageId: message.message_id,
    });
  } finally {
    clearTimeout(timer);
  }
}

// --- Update + inbound handlers ---

export async function handleTelegramUpdateForEcho(
  update: unknown,
): Promise<"pass"> {
  const u = update as TelegramUpdate;
  const msg = u.message ?? u.edited_message;
  if (!msg) return "pass";
  if (!msg.voice && !msg.audio) return "pass";
  if (msg.from?.is_bot) return "pass";

  const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
  const botToken = await loadBotToken(agentDir);
  if (!botToken) {
    recordTelegramRuntimeEvent("pi-voice-telegram/echo", new Error("bot token unavailable"), {
      phase: "config",
    });
    return "pass";
  }

  await transcribeAndEcho(botToken, msg);
  return "pass";
}

export function handleTelegramInboundForEcho(input: {
  kind: string;
  file?: { fileName?: string; path?: string };
}): Promise<string | undefined> {
  if (!input.file) return Promise.resolve(undefined);
  const fileName = input.file.fileName;
  if (!fileName) return Promise.resolve(undefined);
  return Promise.resolve(transcriptCache.get(fileName));
}
