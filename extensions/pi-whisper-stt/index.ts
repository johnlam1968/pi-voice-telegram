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
	getSttProvider,
	ProviderError,
	registerSttProvider,
	type SttProvider,
	type SttRequest,
	unregisterSttProvider,
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

export default function piWhisperStt(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		try {
			registerSttProvider(whisperProvider);
		} catch (err) {
			// Duplicate registration means a previous session's
			// `session_shutdown` didn't clean up (e.g., the agent
			// was killed). Tolerate: replace.
			if (getSttProvider(PROVIDER_ID)) {
				unregisterSttProvider(PROVIDER_ID);
				registerSttProvider(whisperProvider);
			} else {
				throw err;
			}
		}
	});

	pi.on("session_shutdown", () => {
		unregisterSttProvider(PROVIDER_ID);
	});
}
