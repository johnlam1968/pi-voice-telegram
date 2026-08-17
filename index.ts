/**
 * pi-voice-telegram — companion extension for the Pi coding agent + a
 * Telegram bridge (default: @llblab/pi-telegram).
 *
 * Two responsibilities, both fully driven by the bridge's telegram.json:
 *
 *   1. Outbound TTS — register a voice synthesis provider so the bridge
 *      can TTS the LLM's reply text. The provider's return shape adapts
 *      to the config: when `voice.sendTranscript = true` it returns
 *      `{ audioPath, transcriptText }` (the bridge attaches the LLM
 *      text as the voice bubble's caption); when `false` it returns just
 *      the oggPath (voice-only, no caption). The bridge's voice reply
 *      mode (`mirror` / `always` / `hidden`) decides when synthesis
 *      actually fires — this extension just provides the capability.
 *
 *   2. Inbound STT + echo — register a raw update handler that
 *      downloads incoming voice/audio files, runs the in-process
 *      `whisper-stt.ts` client (HTTPS POST to `whisper-server`), and
 *      sends the user a `🎙️ "<transcript>"` echo before the agent
 *      replies. A programmatic inbound handler feeds the same
 *      transcript into the agent prompt via a per-session cache —
 *      single-STT design, no duplicate transcription.
 *
 * The extension does not impose any UX policy of its own. Whatever the
 * operator sets in telegram.json (or via the bridge's settings UI) is
 * what the user gets.
 *
 * v0.3.0: both pipelines (TTS and STT) are in-process TypeScript modules
 * bundled in this extension. The only remaining host-side process
 * boundary is the `ffmpeg` spawn in the synthesis pipeline. There are
 * no host-side scripts to copy or maintain.
 *
 * Public APIs used (all stable per pi-telegram public-api.md):
 *   - @llblab/pi-telegram/voice     → registerTelegramVoiceSynthesisProvider,
 *                                    getTelegramVoiceSendTranscript
 *   - @llblab/pi-telegram/updates   → registerTelegramUpdateHandler
 *   - @llblab/pi-telegram/inbound   → registerTelegramInboundHandler
 *   - @llblab/pi-telegram/delivery  → sendTelegramView
 *   - @llblab/pi-telegram/outbound  → recordTelegramRuntimeEvent
 *   - @earendil-works/pi-coding-agent → getAgentDir, ExtensionAPI
 *
 * Required host-side runtime (NOT bundled; see INSTALL.md):
 *   - `ffmpeg` on PATH (system binary; the only non-Node dep)
 *   - A running `whisper-server` on `WHISPER_SERVER_URL` (default
 *     `http://127.0.0.1:8080`) for STT
 *   - For mm-tts: `MINIMAX_CN_API_KEY` env var (or one of the other
 *     auth sources: `$MINIMAX_API_KEY`, `auth.json`, `~/.mmx/config.json`)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTelegramVoiceSynthesisProvider } from "@llblab/pi-telegram/voice";
import { registerTelegramUpdateHandler } from "@llblab/pi-telegram/updates";
import { registerTelegramInboundHandler } from "@llblab/pi-telegram/inbound";

import { mmTtsSynthesisProvider } from "./synthesis-provider.js";
import {
  clearTranscriptCache,
  handleTelegramInboundForEcho,
  handleTelegramUpdateForEcho,
} from "./echo.js";

// --- Entry point ---

export default function piVoiceTelegram(pi: ExtensionAPI): void {
  let disposers: Array<() => void> = [];

  pi.on("session_start", () => {
    disposers.forEach((d: () => void) => d());
    disposers = [];
    clearTranscriptCache();

    // (1) Outbound TTS — the bridge calls this whenever it wants a voice
    // reply (driven by voice.replyMode + the LLM's reply). The provider
    // returns `{ audioPath, transcriptText }` when telegram.json says
    // `voice.sendTranscript = true`; otherwise just the oggPath.
    disposers.push(
      registerTelegramVoiceSynthesisProvider(mmTtsSynthesisProvider, {
        id: "pi-voice-telegram/tts",
      }),
    );

    // (2) Inbound echo — the bridge's raw update hook fires before the
    // inbound pipeline. We run STT here, cache the transcript by file
    // name, and send the 🎙️ echo to the user. The inbound handler below
    // returns the cached transcript so the agent prompt sees the same
    // text the user saw.
    disposers.push(registerTelegramUpdateHandler(handleTelegramUpdateForEcho));
    disposers.push(registerTelegramInboundHandler("voice", handleTelegramInboundForEcho));
    disposers.push(registerTelegramInboundHandler("audio", handleTelegramInboundForEcho));
  });

  pi.on("session_shutdown", () => {
    disposers.forEach((d: () => void) => d());
    disposers = [];
    clearTranscriptCache();
  });
}
