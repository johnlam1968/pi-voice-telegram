/**
 * TTS synthesis provider for pi-voice-telegram.
 *
 * Reads `telegram.json` on every synthesis call so runtime changes from
 * the bridge's settings UI take effect without a session restart.
 *
 * Layered default resolution (first non-empty wins):
 *   1. bridge-supplied options (from `<!-- telegram_voice lang=… -->` or
 *      an upstream programmatic handler)
 *   2. `telegram.json.outboundHandlers[voice].defaults.{voice,lang,rate}`
 *   3. provider-level defaults (env-overridable via PI_MM_TTS_VOICE /
 *      PI_MM_TTS_LANG / PI_MM_TTS_MODEL)
 *   4. hard-coded constants (Cantonese_PlayfulMan / Chinese,Yue / speech-2.8-hd)
 *
 * v0.2.0: the synthesis pipeline is now in-process (mm-tts + ffmpeg via
 * `voice-reply.ts`), so this file no longer spawns a separate voice-reply
 * process. The behavior is otherwise identical to the v0.1.0 version.
 *
 * Return shape adapts to `voice.sendTranscript`:
 *   - true  → `{ audioPath, transcriptText }`  (voice bubble + caption)
 *   - false → just the oggPath                  (voice bubble, no caption)
 *
 * When `sendTranscript` is true, the transcript is truncated to 1024
 * characters (Telegram's sendVoice caption limit) with an ellipsis marker.
 * The audio itself is the full spoken text; only the visible caption is
 * trimmed.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  getTelegramVoiceSendTranscript,
  type TelegramVoiceSynthesisProvider,
  type TelegramVoiceSynthesisProviderResult,
} from "@llblab/pi-telegram/voice";

import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import { synthesize as voiceReply } from "./voice-reply.js";

// --- Configuration (host-side runtime contract) ---

const DEFAULT_VOICE = process.env.PI_MM_TTS_VOICE ?? "Cantonese_PlayfulMan";
const DEFAULT_LANG = process.env.PI_MM_TTS_LANG ?? "Chinese,Yue";
const DEFAULT_MODEL = process.env.PI_MM_TTS_MODEL ?? "speech-2.8-hd";
const VOICE_REPLY_TIMEOUT_MS = Number(
  process.env.PI_MM_TTS_VOICE_REPLY_TIMEOUT_MS ?? "30000",
);

const CAPTION_MAX = 1024;

// --- telegram.json snapshot ---

interface VoiceDefaults {
  voice?: string;
  lang?: string;
  rate?: string;
}

interface TelegramJsonSnapshot {
  voice?: { sendTranscript?: boolean };
  outboundHandlers?: Array<{
    type?: string;
    defaults?: VoiceDefaults;
  }>;
}

async function readTelegramJson(agentDir: string): Promise<TelegramJsonSnapshot> {
  try {
    const raw = await readFile(join(agentDir, "telegram.json"), "utf8");
    const parsed = JSON.parse(raw) as TelegramJsonSnapshot;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function pickVoiceDefaults(snapshot: TelegramJsonSnapshot): VoiceDefaults {
  const voiceHandler = (snapshot.outboundHandlers ?? []).find(
    (h) => h?.type === "voice",
  );
  return voiceHandler?.defaults ?? {};
}

// --- Provider ---

export const mmTtsSynthesisProvider: TelegramVoiceSynthesisProvider = async (
  text: string,
  options?: { lang?: string; rate?: string },
): Promise<TelegramVoiceSynthesisProviderResult> => {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
  const snapshot = await readTelegramJson(agentDir);
  const defaults = pickVoiceDefaults(snapshot);

  const lang = options?.lang ?? defaults.lang ?? DEFAULT_LANG;
  const voice = defaults.voice ?? DEFAULT_VOICE;
  const model = DEFAULT_MODEL;
  const speed = Number(options?.rate ?? 1.0);

  // voice-reply needs a writable path it can guarantee ownership of.
  // The bridge may keep / delete this file after delivery — we just have
  // to hand it a path that doesn't already exist.
  const oggPath = `${agentDir}/tmp/pi-voice-telegram-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.ogg`;

  try {
    await voiceReply({
      text,
      voice,
      lang,
      model,
      speed,
      oggPath,
      timeoutMs: VOICE_REPLY_TIMEOUT_MS,
    });
  } catch (err) {
    recordTelegramRuntimeEvent("pi-voice-telegram/tts", err, {
      phase: "synthesize",
      textLength: text.length,
    });
    throw err;
  }

  if (!getTelegramVoiceSendTranscript(snapshot)) {
    return oggPath;
  }

  const caption =
    text.length > CAPTION_MAX ? text.slice(0, CAPTION_MAX - 1) + "…" : text;

  return { audioPath: oggPath, transcriptText: caption };
};
