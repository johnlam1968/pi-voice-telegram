/**
 * pi-minimax-tts — TTS provider for the MiniMax T2A API.
 * Parallel to `pi-openai-tts` (the OpenAI-compatible provider).
 * v0.1.0.
 *
 * Mirrors the `pi-openai-tts` pattern:
 *   - A standalone Pi extension that registers itself in
 *     `pi-telegram-tts-minimax`'s `TtsProvider` registry (id
 *     `"pi-minimax-tts"`) at module load.
 *   - The orchestrator (`pi-telegram-tts-minimax/index.ts`)
 *     selects the provider via
 *     `extensions["pi-telegram-tts-minimax"].tts_provider:
 *     "pi-minimax-tts"` in `telegram.json`.
 *   - The provider is looked up at synthesis call time so the
 *     load order doesn't matter.
 *
 * ## The "special usage" (vs OpenAI)
 *
 * The MiniMax T2A API has knobs OpenAI doesn't expose:
 *   - **327 voices** across 24 languages (the `voices.json` catalog;
 *     see the orchestrator's section UI for the picker).
 *   - **`emotion`**: `happy` | `sad` | `angry` | `fearful` |
 *     `disgusted` | `surprised` | `neutral` (modern `speech-2.x`
 *     models only; the legacy `speech-01`/`speech-02` ignore it).
 *   - **`language_boost`**: a CSV of language tags MiniMax uses to
 *     weight the model (e.g. `Chinese,Yue` for Cantonese).
 *   - **`voice_setting.pitch`** and **`vol`**: explicit control,
 *     in addition to `speed`.
 *   - **Region**: `cn` (api.minimaxi.com) or `global`
 *     (api.minimax.io). The orchestrator's default is `cn` (the
 *     operator's auth.json key is in the `minimax-cn` block).
 *   - **Hex-encoded JSON response** (modern endpoint) vs OpenAI's
 *     binary response.
 *
 * Exposed via the TtsRequest contract:
 *   - `voice`, `lang`, `model`, `speed` (first-class TtsRequest
 *     fields)
 *   - `extras.emotion`, `extras.region`, `extras.baseUrl`,
 *     `extras.sampleRate`, `extras.bitrate`, `extras.channels`,
 *     `extras.format` (provider-specific)
 *
 * ## ffmpeg
 *
 * MiniMax T2A returns WAV (or MP3/PCM/FLAC). Telegram's `sendVoice`
 * wants OGG/Opus. We rewrap via `ffmpeg` (already on the operator's
 * PATH for the STT side; same binary the old monolithic's
 * `voice-reply.ts` used).
 *
 * Module-load registration: the provider is in the registry
 * synchronously when jiti loads the file, before any session_start
 * fires, before any message is processed. Idempotent:
 * re-registers if a previous session's `session_shutdown` didn't
 * clean up.
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

import { synthesize, MinimaxTtsError } from "./minimax-tts.js";

const PROVIDER_ID = "pi-minimax-tts";

const minimaxProvider: TtsProvider = {
	id: PROVIDER_ID,
	label: "🌊 MiniMax T2A",
	async synthesize(req: TtsRequest): Promise<TtsResult> {
		try {
			return await synthesize(req);
		} catch (err) {
			// Re-throw as `TtsProviderError` so the bridge's
			// runtime-event handler sees the same `code: 1|2|3|4`
			// taxonomy as the STT side and as `pi-openai-tts`.
			// `MinimaxTtsError` is a direct subclass of `Error` with
			// the right shape; we wrap to keep the
			// `TtsProviderError` brand for the registry contract.
			if (err instanceof MinimaxTtsError) {
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
// pattern as `pi-openai-tts`). The provider is in the registry
// before any session_start fires, before any message is processed.
// Idempotent: if a previous session's `session_shutdown` didn't
// clean up, the globalThis-backed registry still holds the entry,
// and we re-register.
try {
	registerTtsProvider(minimaxProvider);
} catch {
	unregisterTtsProvider(PROVIDER_ID);
	registerTtsProvider(minimaxProvider);
}

export default function piMinimaxTts(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		// No-op: the provider is already registered at module load.
		// The handler is defensive — re-registration is idempotent.
		try {
			registerTtsProvider(minimaxProvider);
		} catch {
			// Already registered; ignore.
		}
	});

	pi.on("session_shutdown", () => {
		unregisterTtsProvider(PROVIDER_ID);
	});
}
