/**
 * TTS synthesis provider for pi-voice-telegram.
 *
 * Reads `telegram.json` on every synthesis call so runtime changes from
 * the bridge's settings UI take effect without a session restart.
 *
 * Layered default resolution (first non-empty wins):
 *   1. bridge-supplied options (from `<!-- telegram_voice lang=… -->` or
 *      an upstream programmatic handler)
 *   2. `telegram.json.outboundHandlers[voice].defaults.{voice,lang}`
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
import { type ResolvedTtsDefaults, resolveTtsDefaults } from "./config.js";
import { detectLanguage as whisperDetectLanguage } from "./whisper-stt.js";

// --- Configuration (host-side runtime contract) ---

/**
 * The synthesis provider reads the companion config to resolve its
 * defaults (JSON > env > hardcoded, see config.ts). The `telegram.json`
 * bridge file is still read on every call for the bridge-owned
 * `outboundHandlers[voice].defaults.{voice,lang}` layering.
 *
 * The companion config is read once per provider construction (which
 * happens at `session_start`), so changes to `pi-voice-telegram.json`
 * require a session restart. `telegram.json` edits still take effect
 * mid-session.
 */
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

/**
 * The TTS synthesis provider. Reads companion config (JSON > env >
 * hardcoded) once at construction; bridge `telegram.json` is re-read
 * on every call so the bridge's per-handler voice/lang defaults take
 * effect mid-session.
 *
 * Built as a factory (not a bare `export const`) so the caller can
 * pass an explicit config snapshot if they want to override. v0.8.0+
 * pattern — `index.ts` calls `createMmTtsSynthesisProvider()` once on
 * `session_start`.
 *
 * v0.16.0: when `tts.verifyAfterSynthesize` is true, run whisper-stt
 * language detection on the produced OGG and record the result in the
 * runtime event log under `category: "pi-voice-telegram/tts-verify"`.
 * This catches the cross-language "boost" misfires (e.g. voice=
 * Cantonese_* + lang=Japanese producing audio that's neither) and
 * gives the operator a per-call signal in the event log. Verification
 * is best-effort: if the whisper call fails, the synthesis still
 * succeeds and the error is logged separately.
 */
export function createMmTtsSynthesisProvider(
  cfg?: { tts?: ResolvedTtsDefaults },
): TelegramVoiceSynthesisProvider {
	const tts = cfg?.tts ?? resolveTtsDefaults(undefined);
	const fallbackLang = tts.lang;
	const fallbackVoice = tts.voice;
	const fallbackModel = tts.model;
	const fallbackTimeout = tts.timeoutMs;
	const verifyAfter = tts.verifyAfterSynthesize;

	return async (
		text: string,
		options?: { lang?: string; rate?: string },
	): Promise<TelegramVoiceSynthesisProviderResult> => {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
		const snapshot = await readTelegramJson(agentDir);
		const defaults = pickVoiceDefaults(snapshot);

		const lang = options?.lang ?? defaults.lang ?? fallbackLang;
		const voice = defaults.voice ?? fallbackVoice;
		const model = fallbackModel;
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
				timeoutMs: fallbackTimeout,
			});
		} catch (err) {
			recordTelegramRuntimeEvent("pi-voice-telegram/tts", err, {
				phase: "synthesize",
				textLength: text.length,
			});
			throw err;
		}

		// v0.16.0+: best-effort self-check. The synthesis already
		// succeeded; verification failure must not change the result.
		if (verifyAfter) {
			try {
				const detected = await whisperDetectLanguage({ inputPath: oggPath });
				recordTelegramRuntimeEvent("pi-voice-telegram/tts-verify", null, {
					requestedLang: lang,
					detectedLanguage: detected.language,
					confidence: detected.confidence,
					match: isLanguageMatch(detected.language, lang),
					transcriptLength: detected.transcript.length,
				});
			} catch (err) {
				recordTelegramRuntimeEvent("pi-voice-telegram/tts-verify", err, {
					phase: "detect",
					requestedLang: lang,
				});
			}
		}

		if (!getTelegramVoiceSendTranscript(snapshot)) {
			return oggPath;
		}

		const wasTruncated = text.length > CAPTION_MAX;
		const caption = wasTruncated
			? text.slice(0, CAPTION_MAX - 1) + "…"
			: text;
		if (wasTruncated) {
			recordTelegramRuntimeEvent("pi-voice-telegram/tts", null, {
				phase: "caption-truncated",
				textLength: text.length,
				captionLength: CAPTION_MAX,
			});
		}

		return { audioPath: oggPath, transcriptText: caption };
	};
}

/**
 * Loose language-match check. whisper-server returns detected language
 * as a lowercase English name ("japanese", "cantonese", "english").
 * The operator's `tts.lang` is MiniMax's "Language,Dialect" format
 * ("Japanese", "Chinese,Yue", "English,American"). Match rules:
 *
 *   1. Direct case-insensitive substring (e.g. "japanese" in "Japanese")
 *   2. First half of a "Language,Dialect" string (e.g. "Chinese" from
 *      "Chinese,Yue" matches "chinese"; "Cantonese" does not match
 *      "Chinese,Yue" — the operator asked for Yue, not generic Chinese)
 *   3. Otherwise: no match
 */
function isLanguageMatch(detected: string, requested: string): boolean {
	const d = detected.toLowerCase();
	const r = requested.toLowerCase();
	if (r.includes(d) || d.includes(r)) return true;
	const first = r.split(",")[0]?.trim() ?? "";
	return first === d;
}

/**
 * Default export for backwards compatibility — uses the auto-resolved
 * defaults (reads env vars + companion config from disk). `index.ts`
 * should prefer the factory form (`createMmTtsSynthesisProvider`) to
 * share one config snapshot with the tool registrations.
 */
export const mmTtsSynthesisProvider: TelegramVoiceSynthesisProvider = createMmTtsSynthesisProvider();
