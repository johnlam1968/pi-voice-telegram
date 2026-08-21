/**
 * pi-telegram-tts-minimax — TTS orchestrator (v0.1.0).
 *
 * Registers a `TelegramVoiceSynthesisProvider` with the bridge
 * (id `pi-telegram-tts-minimax/tts`). The provider closure
 * delegates to the configured peer-dep TtsProvider
 * (`pi-openai-tts`, `pi-minimax-tts`) looked up at synthesis
 * call time. The orchestrator is parallel to `pi-telegram-echo`
 * (the STT orchestrator) — same hot-reload + module-load
 * registration pattern, same config-resolution chain.
 *
 * ## Architecture
 *
 *   bridge → TelegramVoiceSynthesisProvider (this file)
 *     → TtsProvider registry (./tts-provider.ts)
 *       → pi-openai-tts (OpenAI /v1/audio/speech)
 *       → pi-minimax-tts (MiniMax T2A + ffmpeg libopus)
 *       → future providers (any package implementing TtsProvider)
 *
 * `telegram.json` selects the provider:
 *
 *   "extensions": {
 *     "pi-telegram-tts-minimax": {
 *       "tts_provider": "pi-minimax-tts"   // or "pi-openai-tts"
 *     }
 *   }
 *
 * ## Config (persisted in telegram.json)
 *
 *   `tts_provider` (string, default "pi-minimax-tts"): id of the
 *     TtsProvider to use. The provider must be installed and
 *     registered.
 *
 *   Other provider-specific settings (voice, model, region,
 *   emotion, etc.) are read by the TtsProvider itself from
 *     `extensions["pi-<provider>-tts"]` in `telegram.json` —
 *     see the provider's README for the field list.
 *
 * ## v0.1.0 scope
 *
 *   - Module-load registration: the TTS provider is in the
 *     bridge's registry before any session_start fires.
 *   - Hot-reload: a `telegram.json` change updates the
 *     configured `tts_provider` and re-registers.
 *   - Errors: the orchestrator records runtime events under
 *     `pi-telegram-tts-minimax/tts` (provider-missing, run,
 *     audio-missing) — same taxonomy as the STT side.
 *   - Voice policy and prompt contribution are deferred to
 *     v0.6.0+ when the section UI lands (the v0.5.0
 *     monolithic had `getVoicePolicy` and
 *     `getVoicePromptContribution` on the synthesis provider;
 *     they're optional per the bridge's
 *     `TelegramVoiceSynthesisProvider` interface).
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
	registerTelegramVoiceSynthesisProvider,
	type TelegramVoiceSynthesisProvider,
	type TelegramVoiceSynthesisProviderResult,
} from "@llblab/pi-telegram/voice";

import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import {
	getTtsProvider,
	listTtsProviders,
	TtsProviderError,
	type TtsOrchestratorConfig,
} from "./tts-config.js";

import { registerTtsSection } from "./tts-section.js";

const PROVIDER_ID = "pi-telegram-tts-minimax/tts";

/** Build the synthesis provider closure. Captures `cfg` so
 *  `telegram.json` writes take effect on the next inbound message
 *  (after the orchestrator re-registers via the watcher). */
function buildSynthesisProvider(
	cfg: TtsOrchestratorConfig,
): TelegramVoiceSynthesisProvider {
	return async (
		text: string,
		options?: { lang?: string; rate?: string },
	): Promise<TelegramVoiceSynthesisProviderResult> => {
		if (!text) {
			recordTelegramRuntimeEvent(
				"pi-telegram-tts-minimax/tts",
				new Error("missing text"),
				{ phase: "input" },
			);
			return undefined;
		}

		const provider = getTtsProvider(cfg.tts_provider);
		if (!provider) {
			recordTelegramRuntimeEvent(
				"pi-telegram-tts-minimax/tts",
				new Error(
					`TTS provider "${cfg.tts_provider}" is not registered. ` +
						`Installed providers: ${listInstalledTtsProviders()}. ` +
						`Install the matching provider extension or change tts_provider in telegram.json.`,
				),
				{ phase: "provider-missing", ttsProviderId: cfg.tts_provider },
			);
			return undefined;
		}

		// Translate the bridge's narrow `(text, { lang, rate })` call
		// to the TtsProvider's richer TtsRequest. `rate` is the
		// bridge's "rate multiplier" — the TtsProvider applies its
		// own range validation (OpenAI 0.25–4.0, MiniMax 0.5–2.0).
		const speed = parseRate(options?.rate);

		let result: { audioPath: string; transcriptText?: string; language?: string };
		try {
			const synth = await provider.synthesize({
				text,
				lang: options?.lang,
				...(speed !== undefined ? { speed } : {}),
			});
			result = {
				audioPath: synth.audioPath,
				transcriptText: synth.transcriptText ?? text,
				language: synth.language,
			};
		} catch (err) {
			recordTelegramRuntimeEvent(
				"pi-telegram-tts-minimax/tts",
				err instanceof Error ? err : new Error(String(err)),
				{
					phase: "run",
					providerId: provider.id,
					...(err instanceof TtsProviderError
						? { code: err.code, detail: err.detail }
						: {}),
				},
			);
			return undefined;
		}

		// Best-effort file existence check before handing the path
		// to the bridge's `delivery` module — providers that ffmpeg-
		// rewrap might leak the intermediate WAV on failure.
		if (!existsSync(result.audioPath)) {
			recordTelegramRuntimeEvent(
				"pi-telegram-tts-minimax/tts",
				new Error(
					`provider returned non-existent audio path: ${result.audioPath}`,
				),
				{ phase: "audio-missing", audioPath: result.audioPath },
			);
			return undefined;
		}

		return {
			audioPath: result.audioPath,
			transcriptText: result.transcriptText,
		};
	};
}

function parseRate(rate: string | undefined): number | undefined {
	if (!rate) return undefined;
	const n = Number(rate);
	return Number.isFinite(n) ? n : undefined;
}

function listInstalledTtsProviders(): string {
	const ids = listTtsProviders().map((p) => p.id);
	return ids.length === 0 ? "(none)" : ids.join(", ");
}

export default function piTelegramTtsMinimax(pi: ExtensionAPI): void {
	let disposer: (() => void) | null = null;
	// The section UI must be registered once per session; the
	// bridge mints a fresh token on each registerTelegramSection
	// call, so re-registering would stale the in-Telegram menu
	// buttons. The disposer is held across hot-reloads so the
	// next `reconfigure()` (which only re-registers the bridge
	// TTS provider) doesn't re-register the section.
	let sectionDisposer: (() => void) | null = null;

	let configWatcher: FSWatcher | null = null;
	let reloadTimer: NodeJS.Timeout | null = null;
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const configPath = join(agentDir, "telegram.json");

	/** Re-register the bridge TTS provider so its closure picks up
	 *  the new `tts_provider`. Re-registering with the same id
	 *  replaces the previous entry in the bridge's registry. */
	const reconfigure = (): void => {
		if (disposer) {
			disposer();
			disposer = null;
		}
		const cfg = loadTtsOrchestratorConfig();
		try {
			disposer = registerTelegramVoiceSynthesisProvider(
				buildSynthesisProvider(cfg),
				{ id: PROVIDER_ID },
			);
		} catch (err) {
			recordTelegramRuntimeEvent(
				"pi-telegram-tts-minimax/tts",
				err instanceof Error ? err : new Error(String(err)),
				{ phase: "register", ttsProviderId: cfg.tts_provider },
			);
		}
	};

	const startConfigWatcher = (): void => {
		if (configWatcher) return;
		if (!existsSync(configPath)) return;
		const configDir = dirname(configPath);
		const baseName = configPath.slice(configDir.length + 1);
		try {
			configWatcher = watch(
				configDir,
				{ persistent: true },
				(_event, filename) => {
					if (filename !== baseName) return;
					if (reloadTimer) clearTimeout(reloadTimer);
					reloadTimer = setTimeout(() => {
						reloadTimer = null;
						reconfigure();
					}, 200);
				},
			);
		} catch {
			// fs.watch can fail in sandboxed envs. Hot-reload is a
			// nicety; session_start still works.
		}
	};

	pi.on("session_start", () => {
		// The section must be registered BEFORE reconfigure() so
		// the user can see the current TTS state in the main menu
		// (and so the section can be picked up by a hot-reload
		// before any voice message is processed).
		if (!sectionDisposer) sectionDisposer = registerTtsSection();
		reconfigure();
		startConfigWatcher();
	});

	pi.on("session_shutdown", () => {
		if (reloadTimer) {
			clearTimeout(reloadTimer);
			reloadTimer = null;
		}
		if (configWatcher) {
			try {
				configWatcher.close();
			} catch {
				// ignore
			}
			configWatcher = null;
		}
		if (disposer) {
			disposer();
			disposer = null;
		}
		if (sectionDisposer) {
			sectionDisposer();
			sectionDisposer = null;
		}
	});
}
