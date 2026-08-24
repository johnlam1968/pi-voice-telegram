/**
 * pi-telegram-tts — voice synthesis provider for the Pi coding agent +
 * @llblab/pi-telegram bridge. Spawns the same tts-{minimax,openai}.mjs
 * scripts the operator's outboundHandlers template uses, but through
 * the synthesis-provider API so `getVoicePromptContribution` works.
 *
 * v0.1.0 — provider only, no section UI (deferred to v0.2.0).
 * v0.2.0 — `tts-*.mjs` scripts bundled into this package (was a
 *           separate `pi-voice-telegram-scripts` peer-dep, now
 *           deprecated). The `bin` field exposes both on PATH.
 *           Adds the `/telegram-settings` Section UI: enable /
 *           disable toggle, dynamic getLabel(), atomic
 *           `saveSynthConfig` writer. The section file
 *           (`section.ts`) was DROPPED on 2026-08-24 per the
 *           operator's request (drop the UI for tts completely) —
 *           all config is via `telegram.json`. The v0.2.0/v0.4.0
 *           section work is preserved in git history for reference.
 * v0.3.0 — per-provider sub-block config (`minimax: {…}` /
 *           `openai: {…}`) makes every CLI arg the script supports
 *           reachable from `telegram.json`. `synth.ts` writes the
 *           sub-block to a tempfile and passes `--config <path>`;
 *           the script's own deep-merge handles the rest. No
 *           changes to the `.mjs` scripts.
 * v0.4.0 — upstream `@llblab/pi-telegram@0.39.0` removed the
 *           `voice.sendTranscript` config + the
 *           `getTelegramVoiceSendTranscript()` helper + the
 *           provider-returned `transcriptText` field. Synthesis
 *           providers now return only the OGG path; "voice with
 *           text caption" is the agent's explicit composition
 *           (compose the text reply + the voice reply), not an
 *           automatic policy. So we dropped the `telegramConfig`
 *           param from `synthesizeOgg` + the `sendTranscript`
 *           branch in the return value. **Stage 1 of v0.4.0**
 *           re-implements the v0.1.0 `sendTranscript: true`
 *           behavior at the extension level: when
 *           `extensions["pi-telegram-tts"].composeWithText === "auto"`,
 *           the provider sends a text message with the same content
 *           as the voice, just before returning the OGG path. The
 *           user sees text first, then voice. Driven entirely by
 *           `telegram.json` — no upstream dependency. **Stage 2**
 *           adds the form-driven UI on top (per-provider sub-views
 *           + save dialog + `applyInstallDefaults()`).
 *
 * Public APIs used (all stable per @llblab/pi-telegram):
 *   - `@llblab/pi-telegram/voice`    → registerTelegramVoiceSynthesisProvider
 *   - `@llblab/pi-telegram/outbound` → recordTelegramRuntimeEvent
 *   - `@llblab/pi-telegram/delivery` → sendTelegramView
 *                                       (v0.4.0 stage 1: text+voice composition)
 *   - `@llblab/pi-telegram/sections` → registerTelegramSection
 *                                       (v0.2.0; main menu + settings
 *                                       submenu for the disable toggle)
 *   - `@earendil-works/pi-coding-agent` → ExtensionAPI, getAgentDir
 *
 * Public APIs used (all stable per @llblab/pi-telegram):
 *   - `@llblab/pi-telegram/voice`    → registerTelegramVoiceSynthesisProvider
 *   - `@llblab/pi-telegram/outbound` → recordTelegramRuntimeEvent
 *   - `@llblab/pi-telegram/sections` → registerTelegramSection
 *                                       (v0.2.0; main menu + settings
 *                                       submenu for the disable toggle)
 *   - `@earendil-works/pi-coding-agent` → ExtensionAPI, getAgentDir
 *
 * Required host-side runtime (NOT bundled):
 *   - `ffmpeg` on PATH (for MP3 → OGG/Opus conversion).
 *   - Either the MiniMax T2A or OpenAI /v1/audio/speech env config
 *     (`MINIMAX_API_KEY` / `OPENAI_API_KEY`, per the scripts).
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
	registerTelegramVoiceSynthesisProvider,
	type TelegramVoiceSynthesisProvider,
	type TelegramVoiceSynthesisProviderResult,
	type TelegramVoiceTurnView,
} from "@llblab/pi-telegram/voice";
import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";
import { sendTelegramView } from "@llblab/pi-telegram/delivery";

import { loadSynthConfig } from "./telegram-config.js";
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
 *
 * v0.4.0 stage 1 — text+voice composition. When
 * `cfg.composeWithText === "auto"`, send a text message with the
 * same content as the voice just before returning the OGG path.
 * The user sees text first, then voice. Best-effort: a
 * `sendTelegramView` failure is logged + recorded as a runtime
 * event, and the voice is still delivered. The text is sent to
 * the current turn's chat via the upstream's
 * `{ scope: { kind: "active-turn" } }` delivery scope — we don't
 * need the chat ID ourselves.
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
		log.debug("unconfigured, fall through", { id: PROVIDER_ID });
		return undefined;
	}
	const oggPathPromise = (async () => {
		try {
			return await synthesizeOgg(text, options, cfg);
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
})();

if (!oggPathPromise) return undefined;

// v0.4.0 stage 1 — text+voice composition. When
// `composeWithText === "auto"`, send a text message with the
// same content as the voice, IN PARALLEL with the tts script.
//
// **Scope choice: `instance`, not `active-turn`.** The upstream
// `delivery.ts:294-298` wrapper returns `undefined` from
// `getActiveTurnTarget()` whenever `getActiveGuestQueryId()` is
// set — and that ID stays set for the entire voice outbound
// pipeline, not just the LLM call. The live test on 2026-08-24
// (at 21:45:58) showed `active-turn` failing with
// `target-unavailable` even when fired in parallel with the tts
// (4ms before `tts spawn`); the wrapper doesn't release the
// active turn during synthesis.
//
// `instance` scope is the right alternative for a single-
// Telegram-user setup: `getInstanceTarget()` returns the agent's
// primary target, which is the operator's Telegram chat in this
// deployment. **Caveat:** in multi-client deployments (multiple
// Telegram bots, or a Telegram bot + web UI + CLI), the text
// would be sent to all instance clients, not just the current
// chat. The upstream's public API doesn't expose a way to get
// the current chat ID at the provider call site, so this is the
// best we can do without an upstream feature request. Multi-
// client users should leave `composeWithText: "off"`.
//
// Best-effort: a `sendTelegramView` failure is logged + recorded
// as a runtime event, and the voice is still delivered. Skipped
// when the text is empty.
const textPromise =
	cfg.composeWithText === "auto" && text.trim().length > 0
		? sendTelegramView(
				{ text, parseMode: "html" },
				{ scope: { kind: "instance" } },
			).then(
				(result) => {
					if ("ok" in result && !result.ok) {
						log.warn("composeWithText send failed", {
							reason: result.reason,
							error: "error" in result ? result.error : undefined,
						});
						recordTelegramRuntimeEvent(
							PROVIDER_ID,
							new Error(
								`composeWithText send failed: ${result.reason ?? "unknown"}`,
							),
							{ phase: "composeWithText-send" },
						);
					} else {
						log.info("composeWithText text sent", {
							chars: text.length,
						});
					}
				},
				(err) => {
					log.warn("composeWithText send threw", {
						error: err instanceof Error ? err.message : String(err),
					});
					recordTelegramRuntimeEvent(
						PROVIDER_ID,
						err instanceof Error ? err : new Error(String(err)),
						{ phase: "composeWithText-threw" },
					);
				},
			)
		: Promise.resolve();

const oggPath = await oggPathPromise;
if (!oggPath) {
	// Drain the text promise so we don't drop it on the floor.
	await textPromise;
	return undefined;
}
// Await the text promise before returning the OGG path, so
// the bridge upload of the OGG and the text-send happen in
// sequence (text → voice from the user's perspective).
await textPromise;
return oggPath;
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

	// v0.2.0 section UI was dropped on 2026-08-24 per the operator's
	// request — the form-driven UI was more trouble than the
	// telegram.json-driven config. All config is via telegram.json
	// (see README.md "telegram.json-driven config" + the plan doc
	// v0.5.0 entry for the rationale).

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
		log.info("session_start done", {
			disabled: loadSynthConfig().disabled,
			provider: loadSynthConfig().provider,
		});
	});

	pi.on("session_shutdown", () => {
		log.info("session_shutdown");
		for (const d of disposers) d();
		disposers.length = 0;
	});
}
