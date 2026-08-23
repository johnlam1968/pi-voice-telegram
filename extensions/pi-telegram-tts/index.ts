/**
 * pi-telegram-tts — voice synthesis provider for the Pi coding agent +
 * @llblab/pi-telegram bridge. Spawns the same tts-{minimax,openai}.mjs
 * scripts the operator's outboundHandlers template uses, but through
 * the synthesis-provider API so voice.sendTranscript and
 * getVoicePromptContribution both work.
 *
 * v0.1.0 — provider only, no section UI (deferred to v0.2.0).
 *
 * Public APIs used (all stable per @llblab/pi-telegram):
 *   - `@llblab/pi-telegram/voice`    → registerTelegramVoiceSynthesisProvider,
 *                                       getTelegramVoiceSendTranscript
 *   - `@llblab/pi-telegram/outbound` → recordTelegramRuntimeEvent
 *   - `@earendil-works/pi-coding-agent` → ExtensionAPI, getAgentDir
 *
 * Required host-side runtime (NOT bundled):
 *   - `pi-voice-telegram-scripts` peer-dep installed (the runtime
 *     scripts the provider spawns). The provider falls back to the
 *     scripts package's bin names on PATH when npm-installed.
 *   - `ffmpeg` on PATH (for MP3 → OGG/Opus conversion).
 *   - Either the MiniMax T2A or OpenAI /v1/audio/speech env config
 *     (`PI_MINIMAX_*` / `OPENAI_API_KEY`, per the scripts).
 *
 * Lifecycle:
 *   1. Module load: register the provider at the top level. This
 *      handles the load-order race documented in
 *      `docs/voice.md:42` — if a voice message arrives before our
 *      `session_start` fires, the provider is already in the registry.
 *   2. `session_start`: re-register idempotently (the module-load
 *      registration is durable; the session_start registration is
 *      pushed onto the disposers array so the next shutdown tears it
 *      down).
 *   3. `session_shutdown`: dispose the session_start registration.
 *      The module-load registration stays for the process lifetime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getTelegramVoiceSendTranscript,
	registerTelegramVoiceSynthesisProvider,
	type TelegramVoiceSynthesisProvider,
	type TelegramVoiceSynthesisProviderResult,
	type TelegramVoiceTurnView,
} from "@llblab/pi-telegram/voice";
import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import { loadSynthConfig, loadTelegramConfig } from "./telegram-config.js";
import { makeLogger } from "./_logger.js";
import { synthesizeOgg } from "./synth.js";

const log = makeLogger("pi-telegram-tts");

const PROVIDER_ID = "pi-telegram-tts/synth";

/**
 * Provider callable. The bridge v0.36.11 contract
 * (`@llblab/pi-telegram/voice:58-67` + `outbound-voice.ts:235-244`)
 * requires the registered provider to be a *function* with optional
 * `getVoicePolicy` / `getVoicePromptContribution` properties. An
 * object literal satisfies the TypeScript type but fails the bridge's
 * runtime `typeof provider !== "function"` check
 * (`outbound-voice.ts:235`), which records a "Registered voice
 * synthesis provider is not callable (policy-only object?)" runtime
 * event and skips the provider entirely.
 *
 * The bridge's own `registerTelegramVoiceSynthesisProvider` wraps
 * function inputs with the same `Object.assign(callable, properties)`
 * pattern (`voice.ts:131-141`); we mirror it here so the in-process
 * smoke test sees the same shape the bridge sees.
 */
async function synthesizeCall(
	text: string,
	options?: { lang?: string; rate?: string },
): Promise<TelegramVoiceSynthesisProviderResult> {
	const cfg = loadSynthConfig();
	if (cfg.disabled) {
		log.debug("disabled, fall through", { id: PROVIDER_ID });
		return undefined;
	}
	if (!cfg.provider) {
		// No `extensions["pi-telegram-tts"].provider` configured →
		// the operator hasn't opted in. Fall through to
		// `outboundHandlers[0].template` (the v0.19.0 default).
		log.debug("unconfigured, fall through", { id: PROVIDER_ID });
		return undefined;
	}
	// Read the full telegram.json so `synthesizeOgg` can decide
	// whether to include `transcriptText` based on the bridge-owned
	// `voice.sendTranscript` flag.
	const telegramConfig = loadTelegramConfig();
	try {
		return await synthesizeOgg(text, options, cfg, telegramConfig);
	} catch (err) {
		// synthesizeOgg already records runtime events on its
		// own failure path; this is the belt-and-suspenders for
		// unexpected throws outside the spawn block.
		log.error("synthesize threw", {
			error: err instanceof Error ? err.message : String(err),
		});
		recordTelegramRuntimeEvent(
			PROVIDER_ID,
			err instanceof Error ? err : new Error(String(err)),
			{ phase: "unexpected" },
		);
		return undefined;
	}
}

const provider: TelegramVoiceSynthesisProvider = Object.assign(
	synthesizeCall,
	{
		getVoicePromptContribution(view: TelegramVoiceTurnView): string | undefined {
			// Free win: the bridge already provides the view. Returning a
			// short hint here nudges the LLM to keep replies short for
			// voice.
			if (!view.hasVoiceInput && !view.voiceReplyRequired) return undefined;
			return `[tts] Reply briefly; this turn will be spoken aloud via the configured TTS provider.`;
		},
	},
);

// Module-load registration (load-order safety, same pattern as
// pi-openai-stt/index.ts:96-110). The bridge may call this provider
// before our session_start fires (if a voice message arrives early).
try {
	registerTelegramVoiceSynthesisProvider(provider, { id: PROVIDER_ID });
	log.info("registered at module load", { id: PROVIDER_ID });
} catch (e) {
	// Defensive: the globalThis registry already has our entry from a
	// previous load (hot-reload path) or a duplicate import. The
	// registry's `set` overwrites, so the safe move is to log + skip.
	// We don't unregister-and-retry: the existing entry is
	// functionally identical to ours.
	log.warn("module-load register failed (likely duplicate); leaving existing entry", {
		id: PROVIDER_ID,
		error: e instanceof Error ? e.message : String(e),
	});
}

export default function piTelegramTts(pi: ExtensionAPI): void {
	const disposers: Array<() => void> = [];

	// Re-register on session_start (idempotent; the try above handles
	// duplicate-id on first load). The session_start registration's
	// disposer is the one we push onto the array. The module-load
	// registration's disposer is NOT pushed — it lives for the
	// process lifetime, not the session.
	pi.on("session_start", () => {
		log.info("session_start");
		try {
			const off = registerTelegramVoiceSynthesisProvider(provider, { id: PROVIDER_ID });
			disposers.push(off);
			log.debug("re-registered on session_start", { id: PROVIDER_ID });
		} catch {
			log.debug("already registered, skip re-register", { id: PROVIDER_ID });
		}
	});

	pi.on("session_shutdown", () => {
		log.info("session_shutdown");
		for (const d of disposers) d();
		disposers.length = 0;
	});
}
