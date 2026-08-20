/**
 * pi-whisper-stt — STT provider for the on-host whisper-server.
 *
 * v0.3.0: a standalone Pi extension that registers itself in
 * `pi-telegram-echo`'s STT provider registry (id `"pi-whisper-stt"`)
 * on `session_start`. The operator selects it via
 * `extensions["pi-telegram-echo"].stt_provider: "pi-whisper-stt"` in
 * `telegram.json`. `pi-telegram-echo` looks the provider up at STT
 * call time (not at registration time) so load-order doesn't matter.
 *
 * v0.3.1: registers at MODULE LOAD (top-level side effect), not on
 * `session_start`. The on-host test of v0.3.0 surfaced a load-order
 * race: `pi-telegram-echo` session_start fired first (registering
 * the echo handler), the bridge processed a voice message, and
 * `pi-whisper-stt` session_start fired LATER. The first voice
 * message saw an empty registry. Module-load registration is
 * synchronous, so the provider is in the registry before any
 * session_start fires. `session_start` is kept as a no-op (the
 * provider is already registered; the handler is defensive
 * against a future hot-reload path).
 *
 * The provider owns the `whisper-server /inference` multipart
 * contract (moved here from `extensions/pi-telegram-echo/whisper-stt.ts`).
 * Env vars: `WHISPER_SERVER_URL` (default `http://127.0.0.1:8080`),
 * `PI_TELEGRAM_LANG` (default `yue`).
 *
 * Deprecated by v0.4.0+ `pi-openai-stt` once the local whisper-server
 * is shimmed to speak the OpenAI-compatible API gateway convention.
 * Kept for one release for back-compat.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	registerSttProvider,
	unregisterSttProvider,
	ProviderError,
	type SttProvider,
	type SttRequest,
} from "../pi-telegram-echo/stt-provider.js";

import { transcribe, WhisperSttError } from "./whisper-stt.js";

const PROVIDER_ID = "pi-whisper-stt";

const whisperProvider: SttProvider = {
	id: PROVIDER_ID,
	label: "🟢 Whisper (local)",
	async transcribe(req: SttRequest): Promise<string> {
		try {
			return await transcribe({ inputPath: req.inputPath, lang: req.lang });
		} catch (err) {
			// Re-throw as `ProviderError` so the bridge's runtime-event
			// handler sees the same `code: 1|2|3|4` taxonomy as the
			// old monolithic. `WhisperSttError` is a direct subclass of
			// `Error` with the right shape; we wrap to keep the
			// `ProviderError` brand for the registry contract.
			if (err instanceof WhisperSttError) {
				throw new ProviderError(err.message, err.code, err.detail);
			}
			throw new ProviderError(
				err instanceof Error ? err.message : String(err),
				1,
			);
		}
	},
};

// Register at module load (synchronous top-level side effect).
// This is the v0.3.1 fix for the load-order race — the provider
// is in the registry before any session_start fires, before any
// message is processed. The session_start handler below is a
// no-op (the provider is already registered) but is kept as a
// defensive hook in case future hot-reload paths need to
// re-register.
try {
	registerSttProvider(whisperProvider);
} catch {
	// Idempotent: if a previous session's `session_shutdown` didn't
	// clean up, the globalThis-backed registry (v0.3.1+) may still
	// hold the entry. Re-register by unregistering first.
	unregisterSttProvider(PROVIDER_ID);
	registerSttProvider(whisperProvider);
}

export default function piWhisperStt(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		// No-op: the provider is already registered at module load.
		// Kept as a defensive hook. Re-registration is idempotent
		// (the try/unwrap above handles the duplicate-id case).
		try {
			registerSttProvider(whisperProvider);
		} catch {
			// Already registered; ignore.
		}
	});

	pi.on("session_shutdown", () => {
		unregisterSttProvider(PROVIDER_ID);
	});
}
