/**
 * pi-voice-telegram — companion extension for the Pi coding agent + a
 * Telegram bridge (default: @llblab/pi-telegram).
 *
 * v0.16.7 REDESIGN of the inbound voice path: the previous design had
 * two handlers (an update handler that downloaded + transcribed +
 * cached, and an inbound handler that did its own on-demand transcribe
 * on cache miss), which meant the same audio was sometimes transcribed
 * twice, and the update handler's separate download path could fail
 * silently (no byte-count verification — an empty 200-OK response from
 * the Telegram file endpoint would produce an empty transcript and
 * skip the echo). The new design registers as a single voice
 * transcription provider (`registerTelegramVoiceTranscriptionProvider`)
 * so the bridge downloads the file once and calls us with its
 * already-downloaded path. We transcribe once, send the `🎙️` echo
 * from the same code path, and return the transcript. The update
 * handler is reduced to a minimal stasher for the chat ID (which the
 * provider hook doesn't receive). One transcription, blocking UX
 * (echo before LLM processing), no double work, no silent failure.
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
 *   3. LLM tool surface (opt-in) — when `tools.exposed: true` in the
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
 * v0.15.0: added the seventh LLM tool, `pi_voice_telegram_list_voices`,
 *         backed by an embedded `voices.json` catalog (327 MiniMax TTS
 *         voices × 24 languages, ~58KB). The agent can now introspect
 *         valid voice IDs without guessing — guessing returns 2054 and
 *         the agent has no recovery path. The catalog is shipped in
 *         the npm package, parsed on demand when the tool is called.
 *         The existing tool promptGuidelines (synthesize_voice,
 *         pi_voice_telegram_config_write, pi_voice_telegram_schema) are
 *         updated to nudge the agent to call list_voices first when the
 *         user asks about voice/TTS/language changes. Catalog is
 *         rebuildable from the upstream page via
 *         `scripts/build-voice-catalog.py`.
 * v0.14.0: hot-reload. The companion settings file is now
 *         watched via `fs.watch`; any external edit (operator
 *         `vi`/editor, the LLM's own `pi_voice_telegram_config_write`
 *         call, an MCP-driven automation) triggers a debounced
 *         reconfigure — the previous registration set is disposed
 *         and a fresh one is built from the new file contents. The
 *         synthesis provider is re-created (so new TTS defaults
 *         apply on the next bridge event), the echo handlers are
 *         re-registered per the new `inbound.echoEnabled`, and the
 *         six LLM tools are re-registered per the new `tools.*`
 *         flags. Hot-reload is best-effort: if `fs.watch` fails
 *         (sandboxed env, no inotify handles, etc.) the
 *         extension logs a warning and falls back to the
 *         session_start-only behavior. The watcher is closed on
 *         `session_shutdown` so no file handles leak.
 * v0.13.0: redesigned the reset tool to be **schema-driven**
 *         instead of overwriting with a hardcoded `DEFAULT_CONFIG`
 *         JSON. `pi_voice_telegram_config_reset` now walks the
 *         bundled JSON Schema, fills in any MISSING fields with the
 *         schema's `default` value, and preserves the operator's
 *         existing values. The schema is the source of truth for
 *         "what fields exist and what their defaults are" — new
 *         fields added in future schema versions are auto-applied
 *         to existing files when reset is called. The hardcoded
 *         `DEFAULT_CONFIG` in `config.ts` remains for first-install
 *         auto-seed (when the schema might not be authoritative
 *         yet). Also updated the config tool promptGuidelines to
 *         encourage the LLM to evolve the config based on observed
 *         usage (e.g. when the operator keeps asking for English and
 *         the config is `Chinese,Yue`, the LLM should propose or
 *         apply a change). v0.12.0 shipped the reset tool but with
 *         a hardcoded reset payload; v0.13.0 is the schema-driven
 *         refinement.
 * v0.12.0: dropped the `tools.writable` opt-in flag — it was
 *         operator-preference dressed up as a security boundary, and
 *         a sufficiently capable LLM with `bash` + `write` can edit
 *         this file regardless. Replaced with a recovery primitive:
 *         `pi_voice_telegram_config_reset`, which restores the file
 *         to the bundled defaults after backing up the previous
 *         state to a timestamped `.bak.<unix-ms>` file. The
 *         config-read and config-write tools are now registered
 *         whenever `tools.exposed` is true (no double opt-in).
 *         Security model: the container's filesystem permissions
 *         are the real boundary, not a JSON flag.
 * v0.11.0: added two more LLM tools, `pi_voice_telegram_config_read`
 *         and `pi_voice_telegram_config_write`, gated on the new
 *         `tools.writable: true` opt-in. The write tool does
 *         schema-validated atomic writes (refuses `$schema`, `_hint`,
 *         and any unknown key). The LLM can now introspect + modify
 *         the companion settings file end-to-end, but only when the
 *         operator has explicitly opted in. Two-step (read → write)
 *         is encouraged so the LLM can show old → new diffs.
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
 *         `transcribe_audio`) gated on `tools.exposed` in the companion
 *         settings file. The bridge-driven TTS and inbound echo paths
 *         are unchanged from v0.5.0.
 *
 * Public APIs used (all stable per pi-telegram public-api.md):
 *   - @llblab/pi-telegram/voice     → registerTelegramVoiceSynthesisProvider,
 *                                    registerTelegramVoiceTranscriptionProvider,
 *                                    getTelegramVoiceSendTranscript
 *   - @llblab/pi-telegram/updates   → registerTelegramUpdateHandler
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

import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTelegramVoiceSynthesisProvider } from "@llblab/pi-telegram/voice";
import { registerTelegramUpdateHandler } from "@llblab/pi-telegram/updates";
import { registerTelegramVoiceTranscriptionProvider } from "@llblab/pi-telegram/voice";

import { createMmTtsSynthesisProvider } from "./synthesis-provider.js";
import {
	clearSttState,
	handleTelegramUpdateForEcho,
	handleTelegramVoiceTranscription,
	setSttDefaults,
} from "./echo.js";
import {
	loadCompanionConfig,
	resolveSttDefaults,
	resolveTtsDefaults,
} from "./config.js";
import {
	registerConfigReadTool,
	registerConfigResetTool,
	registerConfigWriteTool,
	registerListVoicesTool,
	registerPiVoiceTelegramSchemaTool,
	registerSynthesizeVoiceTool,
	registerTranscribeAudioTool,
} from "./tools.js";

// --- Entry point ---

export default function piVoiceTelegram(pi: ExtensionAPI): void {
	let disposers: Array<() => void> = [];
	let configWatcher: FSWatcher | null = null;
	let reloadTimer: NodeJS.Timeout | null = null;
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const configPath = join(agentDir, "pi-voice-telegram.json");

	/**
	 * Tear down all current registrations and re-run the registration
	 * logic against the current contents of `pi-voice-telegram.json`.
	 *
	 * Called from three places:
	 *   1. `session_start` — initial setup, and on every session restart.
	 *   2. The fs.watch callback (debounced) — when the file changes
	 *      mid-session (v0.14.0+ hot-reload).
	 *   3. (Implicitly) from the previous run's `disposers.forEach(d => d())`
	 *      at the top of the next call.
	 *
	 * What hot-reload re-registers (v0.14.0):
	 *   - Synthesis provider (always on; uses the latest TTS defaults)
	 *   - Echo handlers (gated on `inbound.echoEnabled`)
	 *   - All seven LLM tools (gated on `tools.exposed` + sub-flags)
	 *   - The disposal-then-re-register pattern means previous
	 *     registrations are removed before new ones go in.
	 *
	 * What is NOT hot-reloadable:
	 *   - The watcher itself (it lives across reconfigures, torn
	 *     down only on `session_shutdown`).
	 *   - The `_hint` and `$schema` fields of the file (read-only
	 *     metadata; no behavior change).
	 */
	const reconfigure = (): void => {
		// Tear down previous registrations + clear the in-memory
		// transcript cache (the new echoEnabled flag should take
		// effect on the very next message, with a fresh cache).
		disposers.forEach((d: () => void) => d());
		disposers = [];
		clearSttState();

		const cfg = loadCompanionConfig();

		// Resolve per-extension TTS/STT defaults on every
		// reconfigure so hot-reload picks up new JSON values.
		const ttsDefaults = resolveTtsDefaults(cfg);
		const sttDefaults = resolveSttDefaults(cfg);

		// (1) Outbound TTS — always on. The bridge calls this whenever
		// it wants a voice reply (driven by voice.replyMode + the
		// LLM's reply). The provider is re-created on every
		// reconfigure so it picks up the latest resolved defaults.
		disposers.push(
			registerTelegramVoiceSynthesisProvider(
				createMmTtsSynthesisProvider({ tts: ttsDefaults }),
				{ id: "pi-voice-telegram/tts" },
			),
		);

		// (2) Inbound echo — default on, opt-out via
		// `inbound.echoEnabled: false`.
		//
		// v0.16.7: redesigned to use the bridge's voice-transcription
		// provider hook. The bridge downloads the file (reliable path),
		// calls our provider during `processTelegramInboundHandlers`,
		// and includes the returned transcript in the user message.
		// We transcribe the bridge's file (one transcription, no
		// duplicate work) and send the `🎙️` echo to the user from
		// the same code path. The update handler is minimal — it
		// stashes the chat ID (which the provider doesn't get) keyed
		// by file name, so the provider can route the echo.
		if (cfg.inbound?.echoEnabled !== false) {
			setSttDefaults(sttDefaults);
			disposers.push(registerTelegramUpdateHandler(handleTelegramUpdateForEcho));
			disposers.push(
				registerTelegramVoiceTranscriptionProvider(handleTelegramVoiceTranscription, {
					id: "pi-voice-telegram/stt",
				}),
			);
		}

		// (3) LLM tool surface — opt-in via `tools.exposed: true`.
		//     (v0.16.9: renamed from tools.enabled → tools.exposed; the
		//     nested tools.tts.enabled and tools.stt.enabled are
		//     unchanged.)
		if (cfg.tools?.exposed === true) {
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
			// Documentation + introspection + config tools.
			registerPiVoiceTelegramSchemaTool(pi);
			registerConfigReadTool(pi);
			registerConfigWriteTool(pi);
			registerConfigResetTool(pi);
			registerListVoicesTool(pi);
		}

		// sttDefaults is used by the STT tool; when tools.stt.enabled
		// is false, suppress the unused-var warning without
		// re-introducing the resolve (which is needed to exercise the
		// JSON > env layering even when tools are off).
		void sttDefaults;
	};

	// Start the config file watcher AFTER the first reconfigure.
	// We watch the DIRECTORY (not the file directly) because
	// `fs.watch(file)` is unreliable on some Linux filesystems
	// (Docker overlay, network FS) — it can stop firing after the
	// first event, especially when editors or `sed -i` use the
	// rename pattern to replace the file. Watching the directory
	// catches both in-place writes AND rename-style replacements,
	// and we filter for events on our specific filename.
	const startConfigWatcher = (): void => {
		if (configWatcher) return; // already running
		if (!existsSync(configPath)) return; // file not present yet
		const configDir = dirname(configPath);
		const baseName = configPath.slice(configDir.length + 1);
		try {
			configWatcher = watch(
				configDir,
				{ persistent: true }, // keep the Node process alive while watching; we close on session_shutdown
				(_event, filename) => {
					// Filter for events on our specific file. The
					// `filename` arg is null on some platforms, in
					// which case we conservatively reload (could be a
					// false positive, but the cost of one reconfigure
					// is small).
					if (filename !== null && filename !== baseName) return;
					if (reloadTimer) clearTimeout(reloadTimer);
					reloadTimer = setTimeout(() => {
						reloadTimer = null;
						console.log(
							`[pi-voice-telegram] Hot-reloading from ${configPath} (file change detected).`,
						);
						reconfigure();
					}, 200);
				},
			);
		} catch (err) {
			// fs.watch can fail in sandboxed environments (e.g., no inotify
			// handles, restricted bind mounts). Hot-reload is a UX nicety;
			// session-start still works, so a graceful fallback is fine.
			console.log(
				`[pi-voice-telegram] Hot-reload unavailable: ${(err as Error).message}. ` +
					`Changes to ${configPath} will take effect on the next session_start.`,
			);
		}
	};

	pi.on("session_start", () => {
		reconfigure();
		startConfigWatcher();
	});

	pi.on("session_shutdown", () => {
		// Cancel any pending reload (don't fire it after the session is
		// gone — the `pi` object may be invalidated).
		if (reloadTimer) {
			clearTimeout(reloadTimer);
			reloadTimer = null;
		}
		disposers.forEach((d: () => void) => d());
		disposers = [];
		if (configWatcher) {
			configWatcher.close();
			configWatcher = null;
		}
		clearSttState();
	});
}
