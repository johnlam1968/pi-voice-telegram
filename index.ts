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
 * v0.10.0: added a third LLM tool, `pi_voice_telegram_schema`, that
 *         returns the companion settings JSON Schema as text. The
 *         LLM can call it to discover what knobs are available, what
 *         their types/defaults/valid values are, before suggesting
 *         edits. The schema is the same one linked from each
 *         settings file's `$schema` field. v0.9.0 shipped the
 *         schema itself; v0.10.0 ships the LLM-facing surface for
 *         it. The tool is registered whenever the tool surface is
 *         enabled (it's documentation, not capability — it has no
 *         side effects).
 * v0.9.0: settings file is self-describing. `$schema` + `_hint`
 *         fields added to the seeded `pi-voice-telegram.json`;
 *         `pi-voice-telegram.schema.json` shipped in the repo and
 *         the npm package for editor + tool introspection.
 * v0.8.0: per-extension TTS/STT defaults move into the settings file
 *         (`tts.voice`, `tts.lang`, `tts.model`, `tts.timeoutMs`,
 *         `stt.lang`, `stt.baseUrl`, `stt.timeoutMs`). Resolution:
 *         JSON > env var > hardcoded default. The env vars still work
 *         as fallbacks, so the cluster's `docker-compose.yaml` doesn't
 *         need to change. The tool prompt text (description / snippet /
 *         guidelines) is now templated against the resolved tool name,
 *         so renames via `tools.tts.name` / `tools.stt.name` produce
 *         consistent LLM-facing strings.
 * v0.7.0: auto-seed a default `~/.pi/agent/pi-voice-telegram.json` on
 *         first run (when missing). The seeded default matches v0.5.0
 *         behavior (echo on, tools off), so the file appearing is a
 *         no-op for behavior. Idempotent — existing files are never
 *         overwritten. v0.6.0 was the first release with the tool
 *         surface; v0.7.0 makes the settings file discoverable by
 *         operators who upgrade.
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

import { createMmTtsSynthesisProvider } from "./synthesis-provider.js";
import {
	clearTranscriptCache,
	handleTelegramInboundForEcho,
	handleTelegramUpdateForEcho,
} from "./echo.js";
import {
	loadCompanionConfig,
	resolveSttDefaults,
	resolveTtsDefaults,
} from "./config.js";
import {
	registerPiVoiceTelegramSchemaTool,
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

		// Resolve per-extension TTS/STT defaults once per session. JSON
		// > env var > hardcoded default. See `config.ts` for the
		// layering. The synthesis provider gets the TTS defaults; the
		// tool registrations get both TTS and STT defaults.
		const ttsDefaults = resolveTtsDefaults(cfg);
		const sttDefaults = resolveSttDefaults(cfg);

		// (1) Outbound TTS — always on. The bridge calls this whenever it
		// wants a voice reply (driven by voice.replyMode + the LLM's
		// reply). The provider returns `{ audioPath, transcriptText }`
		// when telegram.json says `voice.sendTranscript = true`;
		// otherwise just the oggPath. The provider is built via the
		// factory so it picks up the resolved TTS defaults from the
		// companion config (v0.8.0+).
		disposers.push(
			registerTelegramVoiceSynthesisProvider(
				createMmTtsSynthesisProvider({ tts: ttsDefaults }),
				{ id: "pi-voice-telegram/tts" },
			),
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
		// the companion settings file. The TTS/STT tools are gated
		// individually on `tools.tts.enabled` / `tools.stt.enabled`.
		// The schema-discovery tool (`pi_voice_telegram_schema`) is
		// always registered when `tools.enabled` is true, since it's
		// documentation rather than an action — it can't make any
		// side effects, only return the schema text. See `tools.ts`
		// for the per-tool promptGuidelines.
		if (cfg.tools?.enabled === true) {
			if (cfg.tools.tts?.enabled !== false) {
				registerSynthesizeVoiceTool({
					pi,
					agentDir,
					nameOverride: cfg.tools.tts?.name,
					tts: ttsDefaults,
				});
			}
			if (cfg.tools.stt?.enabled !== false) {
				registerTranscribeAudioTool({
					pi,
					agentDir,
					nameOverride: cfg.tools.stt?.name,
					stt: sttDefaults,
				});
			}
			// Schema tool: always on when the tool surface is on.
			// It's documentation, not capability, and is useful
			// regardless of whether TTS/STT are individually enabled.
			registerPiVoiceTelegramSchemaTool(pi);
		}

		// Suppress unused-variable warnings for sttDefaults — the
		// synthesis provider doesn't take STT defaults, and the tool
		// registrations only use sttDefaults when tools.stt.enabled is
		// true. Keeping the resolve call above so the JSON > env
		// layering is exercised at startup even when the tools are off.
		void sttDefaults;
	});

	pi.on("session_shutdown", () => {
		disposers.forEach((d: () => void) => d());
		disposers = [];
		clearTranscriptCache();
	});
}
