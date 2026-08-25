/**
 * pi-telegram-tts — voice synthesis provider. Direct `fetch` to the
 * configured provider; see synth.ts for the TTS pipeline and
 * telegram-config.ts for the 3-field `telegram.json` surface. Public
 * APIs + lifecycle + operational notes live in
 * `docs/PI-TELEGRAM-TTS-DESIGN.md` §13.
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

// Bridge v0.36.11 contract: registered provider must be a function (the
// `Object.assign(callable, properties)` pattern mirrors the bridge's own
// `registerTelegramVoiceSynthesisProvider` wrapper). v0.4.0 stage 1:
// composeWithText="auto" sends the text reply in parallel with the tts
// fetch, so the user sees text first, then voice (text + voice
// composition in lieu of the removed upstream voice.sendTranscript).
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

// Module-load registration (load-order safety — the bridge may call
// this provider before our session_start fires).
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

	// v0.4.0 section UI dropped (operator directive 2026-08-24); v0.6.0
	// dropped the in-package config writer. See PI-TELEGRAM-TTS-PLAN.md
	// Progress table.

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
