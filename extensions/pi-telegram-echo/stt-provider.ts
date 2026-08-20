/**
 * stt-provider.ts — the STT provider contract and a small in-process registry.
 *
 * Any Pi extension can implement `SttProvider` and register itself with
 * `registerSttProvider(provider)` on `session_start`. `pi-telegram-echo`
 * looks up the configured provider by `id` at STT call time (not at
 * registration time) to avoid load-order coupling — the provider may
 * register AFTER `pi-telegram-echo`'s `session_start` fires, and the
 * first inbound voice message picks it up.
 *
 * Two providers ship in this repo:
 *
 *   - `pi-whisper-stt` (v0.3.0) — talks to the on-host whisper-server
 *     (`POST /inference` with multipart `file` + `language` +
 *     `response_format`). The current local backend.
 *
 *   - `pi-openai-stt` (v0.4.0+, planned) — talks to any OpenAI-compatible
 *     API gateway (`POST /v1/audio/transcriptions`). After the local
 *     whisper-server is shimmed to speak the same convention, this one
 *     provider works against OpenAI's API, faster-whisper-server, the
 *     local whisper-server (via the shim), etc.
 *
 * Adding a new backend = a new `pi-<backend>-stt` package that
 * implements `SttProvider`, OR a new `OPENAI_STT_BASE_URL` value if the
 * backend already speaks the OpenAI convention.
 *
 * The `code: 1|2|3|4` taxonomy in `ProviderError` mirrors the old
 * monolithic's `WhisperSttError` so the operator's `telegram-status`
 * view is consistent across providers (1=usage, 2=network, 3=4xx, 4=5xx).
 */

/** A transcription request. `inputPath` is the bridge-downloaded audio
 *  file (OGG, MP3, WAV). `lang` is the language hint from the bridge
 *  (`pi-telegram`'s voice options), or undefined for auto-detect. */
export interface SttRequest {
	inputPath: string;
	lang?: string;
}

/** Thrown by a provider when transcription fails. `code` is the same
 *  taxonomy `WhisperSttError` used: 1=usage, 2=network, 3=4xx, 4=5xx. */
export class ProviderError extends Error {
	constructor(
		message: string,
		readonly code: 1 | 2 | 3 | 4,
		readonly detail?: Record<string, unknown>,
	) {
		super(message);
		this.name = "ProviderError";
	}
}

/** An STT provider. Implementations register themselves via
 *  `registerSttProvider(this)` on `session_start`. */
export interface SttProvider {
	/** Stable id, used as the value of `stt_provider` in the config. */
	readonly id: string;
	/** Human label, shown in the section UI picker. */
	readonly label: string;
	/** Transcribe `req.inputPath` and return the transcript text.
	 *  Throw `ProviderError` on failure (the bridge records the error
	 *  via `recordTelegramRuntimeEvent`). */
	transcribe(req: SttRequest): Promise<string>;
}

// --- In-process registry ---

const REGISTRY = new Map<string, SttProvider>();

/** Register a provider. Throws if the same id is registered twice
 *  (typically a duplicate-load bug). */
export function registerSttProvider(provider: SttProvider): void {
	if (REGISTRY.has(provider.id)) {
		throw new Error(
			`stt-provider: provider id "${provider.id}" is already registered`,
		);
	}
	REGISTRY.set(provider.id, provider);
}

/** Unregister a provider (called by the provider extension's `session_shutdown`). */
export function unregisterSttProvider(id: string): void {
	REGISTRY.delete(id);
}

/** Look up a provider by id. Returns `undefined` if not registered. */
export function getSttProvider(id: string): SttProvider | undefined {
	return REGISTRY.get(id);
}

/** List all registered providers (for the section UI picker). */
export function listSttProviders(): SttProvider[] {
	return [...REGISTRY.values()].sort((a, b) => a.id.localeCompare(b.id));
}
