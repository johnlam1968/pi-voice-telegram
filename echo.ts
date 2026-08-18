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

// --- Configuration (v0.16.2: JSON-driven, not env var) ---

/**
 * Resolved STT defaults, set by `index.ts` `reconfigure()` on every
 * hot-reload. Reads `~/.pi/agent/pi-voice-telegram.json`'s `stt.*`
 * fields (JSON > env > hardcoded) — see `config.ts::resolveSttDefaults`.
 *
 * The echo path is JSON-driven because the JSON is the operator-facing
 * dial. The previous v0.16.1 design read env vars + hardcoded
 * directly, which left the JSON's `stt.lang` informational only — the
 * actual STT call used `DEFAULT_LANG = "yue"` regardless of what the
 * operator set. v0.16.2 fixes this: the JSON is the source of truth.
 *
 * If `lang` is undefined (operator cleared it, or hot-reload hasn't
 * fired yet), the fallback is undefined → whisper-server auto-detects.
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
      // v0.16.2: consume the JSON's stt.* (via the resolved defaults
      // set by index.ts reconfigure). The previous code read
      // `PI_TELEGRAM_STT_TIMEOUT_MS` from the env, which left the
      // JSON's stt.lang / stt.baseUrl / stt.timeoutMs as
      // informational-only. JSON is the source of truth.
      const stt = currentSttDefaults;
      const primary = (await runStt({
        inputPath,
        lang: stt.lang,
        baseUrl: stt.baseUrl,
        timeoutMs: stt.timeoutMs,
      })).trim();
      let transcript = primary;
      // v0.16.2: defensive fallback. whisper on Cantonese audio with
      // a forced lang="yue" hint occasionally returns degenerate
      // outputs (single punctuation like "," or single-character
      // garbage). The fix: if the result is empty OR a single char OR
      // pure punctuation/whitespace, retry once with no lang hint —
      // whisper-server will auto-detect the language, which my
      // 2026-08-17 probes confirmed produces the verbatim Cantonese
      // consistently. The original result is logged for debugging
      // (visibility into the model's failure mode) but the retry's
      // output is what the user sees. Single retry, no loop, to
      // bound the cost of a bad model state.
      //
      // v0.16.3: the root cause of the original "," echo (a double
      // \r\n in the multipart body that corrupted the `language` form
      // field to `"yue\r\n"`) is fixed in `whisper-stt.ts`. This
      // fallback is now a safety net for genuine edge cases — very
      // short audio, no-speech segments, low-confidence decodes that
      // collapse to punctuation. With v0.16.3 it should rarely
      // trigger; the log line below surfaces any residual cases so we
      // can address them.
      if (
        !transcript ||
        transcript.length < 2 ||
        /^[\s,.!?;:\-'"`~(){}\[\]\\/|]+$/.test(transcript)
      ) {
        recordTelegramRuntimeEvent(
          "pi-voice-telegram/echo",
          new Error(`stt primary result looked degenerate: ${JSON.stringify(primary)}`),
          {
            phase: "stt-fallback",
            requestedLang: stt.lang,
            primaryLength: primary.length,
            chatId: message.chat.id,
            messageId: message.message_id,
          },
        );
        const retry = (await runStt({
          inputPath,
          // No lang → whisper auto-detects.
          baseUrl: stt.baseUrl,
          timeoutMs: stt.timeoutMs,
        })).trim();
        if (retry) transcript = retry;
      }
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
