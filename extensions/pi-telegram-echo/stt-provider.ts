/**
 * stt-provider.ts — the STT provider contract and a small in-process registry.
 *
 * Any Pi extension can implement `SttProvider` and register itself with
 * `registerSttProvider(provider)` on `session_start` (or at module load,
 * for early registration — see "load-order race" below).
 * `pi-telegram-echo` looks up the configured provider by `id` at STT
 * call time (not at registration time) to avoid load-order coupling.
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
 * The registry lives on `globalThis` (mirroring the bridge's
 * section-registry pattern at `lib/sections.ts:267-271`) so it's
 * shared across all jiti instances in the same Node process. Without
 * this, a child jiti (e.g., the one the bridge uses to load its
 * `lib/` modules) would have a different `REGISTRY` map than the
 * parent jiti that loaded the extension — and the provider
 * registered in one wouldn't be visible to the other.
 *
 * ## Load-order race (v0.3.0 → v0.3.1)
 *
 * In v0.3.0 the provider was registered on `session_start`. The
 * on-host test surfaced a race: `pi-telegram-echo` session_start
 * fired first (registering the echo handler), the bridge then
 * started processing a voice message, and `pi-whisper-stt`
 * session_start fired LATER. The first voice message saw an
 * empty registry and the echo recorded a
 * `pi-telegram-echo/stt` `provider-missing` event. v0.3.1 fixes
 * this by registering at module load (top-level side effect):
 * jiti evaluates the file synchronously, so the provider is in
 * the registry before any session_start fires, before any message
 * is processed. `session_start` is kept for the
 * re-registration-after-unregister defensive path.
 *
 * The `code: 1|2|3|4` taxonomy in `ProviderError` mirrors the old
 * monolithic's `WhisperSttError` (1=usage, 2=network, 3=4xx, 4=5xx).
 * The bridge's `recordTelegramRuntimeEvent` receives the error
 * with the same code taxonomy, so the operator's
 * `telegram-status` view is consistent across providers.
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
 *  `registerSttProvider(this)` on `session_start` (or at module load
 *  for early registration). */
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

// --- In-process registry, shared on globalThis (bridge-style) ---

const REGISTRY_KEY = "__piTelegramSttProviderRegistry__";

interface SttProviderRegistry {
	providers: Map<string, SttProvider>;
}

function getRegistry(): SttProviderRegistry {
	const g = globalThis as unknown as Record<string, unknown>;
	let reg = g[REGISTRY_KEY] as SttProviderRegistry | undefined;
	if (!reg) {
		reg = { providers: new Map() };
		g[REGISTRY_KEY] = reg;
	}
	return reg;
}

/** Register a provider. Throws if the same id is already registered
 *  (typically a duplicate-load bug; the v0.3.1 defensive path in
 *  `pi-whisper-stt/index.ts` catches this and re-registers). */
export function registerSttProvider(provider: SttProvider): void {
	const reg = getRegistry();
	if (reg.providers.has(provider.id)) {
		throw new Error(
			`stt-provider: provider id "${provider.id}" is already registered`,
		);
	}
	reg.providers.set(provider.id, provider);
}

/** Unregister a provider (called by the provider extension's
 *  `session_shutdown`). */
export function unregisterSttProvider(id: string): void {
	getRegistry().providers.delete(id);
}

/** Look up a provider by id. Returns `undefined` if not registered. */
export function getSttProvider(id: string): SttProvider | undefined {
	return getRegistry().providers.get(id);
}

/** List all registered providers (for the section UI picker). */
export function listSttProviders(): SttProvider[] {
	return [...getRegistry().providers.values()].sort((a, b) =>
		a.id.localeCompare(b.id),
	);
}
