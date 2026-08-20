/**
 * pi-openai-tts — TTS provider for any OpenAI-compatible `/v1/audio/speech`
 * API gateway. v0.1.0.
 *
 * Parallel to `pi-openai-stt` (the STT side, v0.4.0+). Same pattern:
 *   - A standalone Pi extension that registers itself in
 *     `pi-telegram-tts-minimax`'s `TtsProvider` registry (id
 *     `"pi-openai-tts"`) at module load.
 *   - The orchestrator (`pi-telegram-tts-minimax/index.ts`) selects
 *     the provider via `extensions["pi-telegram-tts-minimax"].tts_provider:
 *     "pi-openai-tts"` in `telegram.json`.
 *   - The provider is looked up at synthesis call time so the load
 *     order doesn't matter.
 *
 * The same provider code talks to:
 *   - OpenAI's actual TTS API (`base_url=https://api.openai.com/v1`,
 *     `api_key=sk-...`). 6 voices (`alloy`, `echo`, `fable`, `onyx`,
 *     `nova`, `shimmer`); 2 models (`tts-1`, `tts-1-hd`); 6 output
 *     formats (we default to `opus` for Telegram).
 *   - Any future OpenAI-compatible TTS gateway that implements
 *     `POST /v1/audio/speech` (none mainstream as of 2026-08, but
 *     the convention is open).
 *
 * Config (first non-empty wins): explicit TtsRequest.{voice,model,...}
 * > extensions["pi-openai-tts"].{voice,model,base_url,api_key} in
 * telegram.json > OPENAI_TTS_{VOICE,MODEL,BASE_URL,FORMAT} env vars
 * > ~/.pi/agent/auth.json (api_key only) > smart default (OpenAI's
 * API). Mirrors the STT-side precedence.
 *
 * Module-load registration: the provider is in the registry
 * synchronously when jiti loads the file, before any session_start
 * fires, before any message is processed. Idempotent: re-registers
 * if a previous session's `session_shutdown` didn't clean up.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	registerTtsProvider,
	unregisterTtsProvider,
	TtsProviderError,
	type TtsProvider,
	type TtsRequest,
	type TtsResult,
} from "../pi-telegram-tts-minimax/tts-provider.js";

import { synthesize, OpenAiTtsError } from "./openai-tts.js";

const PROVIDER_ID = "pi-openai-tts";

const openaiProvider: TtsProvider = {
	id: PROVIDER_ID,
	label: "🟢 OpenAI (any compatible)",
	async synthesize(req: TtsRequest): Promise<TtsResult> {
		try {
			return await synthesize(req);
		} catch (err) {
			// Re-throw as `TtsProviderError` so the bridge's runtime-event
			// handler sees the same `code: 1|2|3|4` taxonomy as the
			// STT side. `OpenAiTtsError` is a direct subclass of
			// `Error` with the right shape; we wrap to keep the
			// `TtsProviderError` brand for the registry contract.
			if (err instanceof OpenAiTtsError) {
				throw new TtsProviderError(err.message, err.code, err.detail);
			}
			throw new TtsProviderError(
				err instanceof Error ? err.message : String(err),
				1,
			);
		}
	},
};

// Register at module load (synchronous top-level side effect, same
// pattern as `pi-openai-stt` v0.4.0). The provider is in the
// registry before any session_start fires, before any message is
// processed. Idempotent: if a previous session's `session_shutdown`
// didn't clean up, the globalThis-backed registry still holds the
// entry, and we re-register.
try {
	registerTtsProvider(openaiProvider);
} catch {
	unregisterTtsProvider(PROVIDER_ID);
	registerTtsProvider(openaiProvider);
}

export default function piOpenaiTts(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		// No-op: the provider is already registered at module load.
		// The handler is defensive — re-registration is idempotent
		// (the try/unwrap above handles the duplicate-id case).
		try {
			registerTtsProvider(openaiProvider);
		} catch {
			// Already registered; ignore.
		}
	});

	pi.on("session_shutdown", () => {
		unregisterTtsProvider(PROVIDER_ID);
	});
}
