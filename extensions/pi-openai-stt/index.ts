/**
 * pi-openai-stt — STT provider for any OpenAI-compatible API gateway.
 * The only STT provider in the repo since v0.5.0 (when `pi-whisper-stt`
 * was retired — the OpenAI-compatible fallback chain in this provider
 * covers every backend `pi-whisper-stt` ever talked to).
 *
 * v0.4.5: base_url accepts a fallback chain (string[]) — try each URL
 * in order, return the first non-empty transcript. Natural on-host
 * shape: `["http://127.0.0.1:8081/v1", "https://api.openai.com/v1"]`
 * — local CUDA whisper-server runs free / low-latency until it dies,
 * then OpenAI takes over.
 *
 * v0.4.4: base_url / api_key read from telegram.json before env /
 * auth.json. Recommended way to switch between local and cloud.
 *
 * v0.4.0–v0.4.3: a standalone Pi extension that registers itself in
 * `pi-telegram-stt`'s STT provider registry (id `"pi-openai-stt"`)
 * at module load. The operator selects it via
 * `extensions["pi-telegram-stt"].stt_provider: "pi-openai-stt"` in
 * `telegram.json`. `pi-telegram-stt` looks the provider up at STT
 * call time so load-order doesn't matter.
 *
 * The same provider code talks to:
 *   - OpenAI's actual API (set
 *     `extensions["pi-openai-stt"].base_url="https://api.openai.com/v1"`
 *     and a key in any standard source).
 *   - The local `fw-openai-sts` shim (set
 *     `extensions["pi-openai-stt"].base_url="http://127.0.0.1:8081/v1"`;
 *     the shim forwards to the on-host `whisper-server`'s `/inference`
 *     endpoint, preserving the existing CUDA + large-v3-in-VRAM
 *     setup with zero changes to the inference engine).
 *   - `faster-whisper-server` with `--enable-openai-api`.
 *   - `whisper-asr-webservice` or any other OpenAI-compatible gateway.
 *
 * New STT backends become "another `base_url` value (or array entry)"
 * instead of "another `pi-<backend>-stt` package".
 *
 * The module-load registration pattern was first proven by
 * `pi-whisper-stt` v0.3.1: the provider is in the registry
 * synchronously when jiti loads the file, before any session_start
 * fires, before any message is processed. The registry lives on
 * `globalThis` (set up in `pi-telegram-stt/stt-provider.ts`) so it's
 * shared across all jiti instances in the same Node process.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	registerSttProvider,
	unregisterSttProvider,
	ProviderError,
	type SttProvider,
	type SttRequest,
} from "../pi-telegram-stt/stt-provider.js";

import { transcribe, OpenAiSttError } from "./openai-stt.js";

import { makeLogger } from "../_logger.js";

const log = makeLogger("pi-openai-stt");
const PROVIDER_ID = "pi-openai-stt";

const openaiProvider: SttProvider = {
	id: PROVIDER_ID,
	label: "🟢 OpenAI (any compatible)",
	async transcribe(req: SttRequest): Promise<string> {
		log.info("transcribe start", { file: req.inputPath, lang: req.lang });
		try {
			const text = await transcribe({ inputPath: req.inputPath, lang: req.lang });
			log.info("transcribe ok", { chars: text.length });
			return text;
		} catch (err) {
			// Re-throw as `ProviderError` so the bridge's runtime-event
			// handler sees the same `code: 1|2|3|4` taxonomy as the
			// old monolithic used. `OpenAiSttError` is a direct
			// subclass of `Error` with the right shape; we wrap to
			// keep the `ProviderError` brand for the registry
			// contract.
			if (err instanceof OpenAiSttError) {
				log.error("transcribe failed", {
					code: err.code,
					detail: err.detail ? JSON.stringify(err.detail) : undefined,
					error: err.message,
				});
				throw new ProviderError(err.message, err.code, err.detail);
			}
			log.error("transcribe failed (unwrapped)", { error: err instanceof Error ? err.message : String(err) });
			throw new ProviderError(
				err instanceof Error ? err.message : String(err),
				1,
			);
		}
	},
};

// Register at module load (synchronous top-level side effect, same
// pattern the first STT provider package proved out). The provider
// is in the registry before any session_start fires, before any
// message is processed. Idempotent: if a previous session's
// `session_shutdown` didn't clean up, the globalThis-backed
// registry still holds the entry, and we re-register.
try {
	registerSttProvider(openaiProvider);
	log.info("registered at module load");
} catch (e) {
	log.warn("register at module load failed, retrying after unregister", { error: e instanceof Error ? e.message : String(e) });
	unregisterSttProvider(PROVIDER_ID);
	registerSttProvider(openaiProvider);
	log.info("registered at module load (after retry)");
}

export default function piOpenaiStt(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		log.info("session_start");
		// No-op: the provider is already registered at module load.
		// The handler is defensive — re-registration is idempotent
		// (the try/unwrap above handles the duplicate-id case).
		try {
			registerSttProvider(openaiProvider);
			log.debug("re-registered on session_start");
		} catch {
			// Already registered; ignore.
			log.debug("already registered, skip re-register");
		}
	});

	pi.on("session_shutdown", () => {
		log.info("session_shutdown");
		unregisterSttProvider(PROVIDER_ID);
	});
}
