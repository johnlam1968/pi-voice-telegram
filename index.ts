/**
 * pi-voice-telegram — companion extension for the Pi coding agent + a
 * Telegram bridge (default: @llblab/pi-telegram).
 *
 * Three responsibilities, all driven by the bridge's telegram.json plus
 * the companion's own settings file (`~/.pi/agent/pi-voice-telegram.json`):
 *
 *   1. Outbound TTS (bridge-driven) — register a voice synthesis provider
 *      so the bridge can TTS the LLM's reply text. The provider's return
 *      shape adapts to `voice.sendTranscript`: when true it returns
 *      `{ audioPath, transcriptText }` (the bridge attaches the LLM text
 *      as the voice bubble's caption); when false it returns just the
 *      oggPath (voice-only, no caption). The bridge's voice reply mode
 *      (`mirror` / `always` / `hidden`) decides when synthesis actually
 *      fires — this extension just provides the capability.
 *
 *   2. Inbound STT + echo (deterministic, opt-out) — register a raw
 *      update handler that downloads incoming voice/audio files, runs
 *      the in-process `whisper-stt.ts` client (HTTPS POST to
 *      `whisper-server`), and sends the user a `🎙️ "<transcript>"`
 *      echo before the agent replies. A programmatic inbound handler
 *      feeds the same transcript into the agent prompt via a per-session
 *      cache — single-STT design, no duplicate transcription. This is
 *      on by default; turn it off via `inbound.echoEnabled: false` in
 *      `~/.pi/agent/pi-voice-telegram.json`.
 *
 *   3. LLM tool surface (opt-in) — when `tools.enabled: true` in the
 *      companion settings file, register two additional tools the
 *      agent can call explicitly:
 *        - `synthesize_voice` (wraps `voice-reply.ts` + `mm-tts.ts`)
 *          Writes a Telegram-ready OGG/Opus file and returns the path.
 *          The agent delivers it via the bridge's `telegram_attach`
 *          tool. Useful when `voice.replyMode` is `hidden` and the
 *          user has asked for a voice reply, or for ad-hoc voice
 *          (e.g. reading a file aloud).
 *        - `transcribe_audio` (wraps `whisper-stt.transcribe()`)
 *          Transcribes a local audio file via `whisper-server` and
 *          returns the transcript text.
 *      The two tools are independent — `tools.tts.enabled` and
 *      `tools.stt.enabled` can be flipped separately.
 *
 * The extension does not impose any UX policy of its own. Whatever the
 * operator sets in `telegram.json` (or via the bridge's settings UI) is
 * what the user gets. The companion settings file is a strictly
 * opt-in dial for capability registration.
 *
 * v0.6.0: added the LLM tool surface (`synthesize_voice`,
 *         `transcribe_audio`) gated on `tools.enabled` in the companion
 *         settings file. The bridge-driven TTS and inbound echo paths
 *         are unchanged from v0.5.0.
 *
 * Public APIs used (all stable per pi-telegram public-api.md):
 *   - @llblab/pi-telegram/voice     → registerTelegramVoiceSynthesisProvider,
 *                                    getTelegramVoiceSendTranscript
 *   - @llblab/pi-telegram/updates   → registerTelegramUpdateHandler
 *   - @llblab/pi-telegram/inbound   → registerTelegramInboundHandler
 *   - @llblab/pi-telegram/delivery  → sendTelegramView
 *   - @llblab/pi-telegram/outbound  → recordTelegramRuntimeEvent
 *   - @earendil-works/pi-coding-agent → getAgentDir, ExtensionAPI
 *   - @sinclair/typebox             → Type (tool parameter schemas)
 *
 * Required host-side runtime (NOT bundled; see INSTALL.md):
 *   - `ffmpeg` on PATH (system binary; the only non-Node dep)
 *   - A running `whisper-server` on `WHISPER_SERVER_URL` (default
 *     `http://127.0.0.1:8080`) for STT
 *   - For mm-tts: `MINIMAX_CN_API_KEY` env var (or one of the other
 *     auth sources: `$MINIMAX_API_KEY`, `auth.json`, `~/.mmx/config.json`)
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTelegramVoiceSynthesisProvider } from "@llblab/pi-telegram/voice";
import { registerTelegramUpdateHandler } from "@llblab/pi-telegram/updates";
import { registerTelegramInboundHandler } from "@llblab/pi-telegram/inbound";

import { mmTtsSynthesisProvider } from "./synthesis-provider.js";
import {
	clearTranscriptCache,
	handleTelegramInboundForEcho,
	handleTelegramUpdateForEcho,
} from "./echo.js";
import { loadCompanionConfig } from "./config.js";
import {
	registerSynthesizeVoiceTool,
	registerTranscribeAudioTool,
} from "./tools.js";

// --- Entry point ---

export default function piVoiceTelegram(pi: ExtensionAPI): void {
	let disposers: Array<() => void> = [];

	pi.on("session_start", () => {
		// Tear down any prior session's registrations + clear cache.
		disposers.forEach((d: () => void) => d());
		disposers = [];
		clearTranscriptCache();

		const cfg = loadCompanionConfig();
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		// (1) Outbound TTS — always on. The bridge calls this whenever it
		// wants a voice reply (driven by voice.replyMode + the LLM's
		// reply). The provider returns `{ audioPath, transcriptText }`
		// when telegram.json says `voice.sendTranscript = true`;
		// otherwise just the oggPath.
		disposers.push(
			registerTelegramVoiceSynthesisProvider(mmTtsSynthesisProvider, {
				id: "pi-voice-telegram/tts",
			}),
		);

		// (2) Inbound echo — default on, opt-out via
		// `inbound.echoEnabled: false` in the companion settings file.
		// The bridge's raw update hook fires before the inbound pipeline.
		// We run STT here, cache the transcript by file name, and send
		// the 🎙️ echo to the user. The inbound handler below returns
		// the cached transcript so the agent prompt sees the same text
		// the user saw.
		if (cfg.inbound?.echoEnabled !== false) {
			disposers.push(registerTelegramUpdateHandler(handleTelegramUpdateForEcho));
			disposers.push(registerTelegramInboundHandler("voice", handleTelegramInboundForEcho));
			disposers.push(registerTelegramInboundHandler("audio", handleTelegramInboundForEcho));
		}

		// (3) LLM tool surface — opt-in via `tools.enabled: true` in
		// the companion settings file. The two tools are independent;
		// `tools.tts.enabled` and `tools.stt.enabled` can be flipped
		// separately. See `tools.ts` for the per-tool promptGuidelines.
		if (cfg.tools?.enabled === true) {
			if (cfg.tools.tts?.enabled !== false) {
				registerSynthesizeVoiceTool(pi, agentDir, cfg.tools.tts);
			}
			if (cfg.tools.stt?.enabled !== false) {
				registerTranscribeAudioTool(pi, agentDir, cfg.tools.stt);
			}
		}
	});

	pi.on("session_shutdown", () => {
		disposers.forEach((d: () => void) => d());
		disposers = [];
		clearTranscriptCache();
	});
}
