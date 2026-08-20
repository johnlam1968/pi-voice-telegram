/**
 * tts-provider.ts — the TTS provider contract and a small in-process registry.
 *
 * Parallel to `pi-telegram-echo/stt-provider.ts`. The orchestrator
 * (`pi-telegram-tts-minimax/index.ts`) registers a TTS provider with
 * the bridge via `registerTelegramVoiceSynthesisProvider`, and that
 * provider delegates to the `TtsProvider` looked up in this registry
 * at synthesis time. Provider packages (`pi-openai-tts`,
 * `pi-minimax-tts`) implement the `TtsProvider` interface and
 * register themselves at module load.
 *
 * The TtsProvider contract is richer than the bridge's
 * `TelegramVoiceSynthesisProvider` (which only takes `(text,
 * {lang, rate})`) so providers can express OpenAI's voice / model /
 * speed / response_format knobs and the MiniMax T2A `voice_id` /
 * `model` / `emotion` / `speed` knobs without losing fidelity. The
 * orchestrator is responsible for translating the bridge's narrow
 * call to a TtsProvider's richer `TtsRequest`.
 *
 * The registry lives on `globalThis` (mirroring the bridge's section-
 * registry pattern at `lib/sections.ts:267-271` and the STT
 * registry's `globalThis` pattern from v0.3.1) so it's shared across
 * all jiti instances in the same Node process. Without this, a
 * child jiti (e.g., the one the bridge uses to load its `lib/`
 * modules) would have a different registry than the parent jiti
 * that loaded the extension — and the provider registered in one
 * wouldn't be visible to the other.
 *
 * ## Load-order (mirrors the v0.3.1 STT fix)
 *
 * Providers register at module load (top-level side effect, not on
 * `session_start`). jiti evaluates the file synchronously, so the
 * provider is in the registry before any session_start fires,
 * before any message is processed. The orchestrator looks the
 * provider up at synthesis call time, so the provider and the
 * orchestrator can load in any order.
 *
 * The `code: 1|2|3|4` taxonomy in `TtsProviderError` mirrors the
 * STT `ProviderError` (1=usage, 2=network, 3=4xx, 4=5xx) so the
 * bridge's `recordTelegramRuntimeEvent` and the operator's
 * `/telegram-status --debug` view use a consistent code space.
 */

/** A TTS request. Fields are optional where the provider can default
 *  them — OpenAI's TTS API requires `voice` (default `alloy`),
 *  `model` (default `tts-1`), and `response_format` (default `opus`
 *  for Telegram). MiniMax T2A's defaults are different. The provider
 *  resolves its own defaults from env / `telegram.json`. */
export interface TtsRequest {
	/** The text to synthesize. */
	text: string;
	/** BCP-47 / ISO-639-1 language code, e.g. `"yue"`, `"en"`, `"zh"`.
	 *  Optional; provider-specific behavior on missing (OpenAI ignores,
	 *  MiniMax T2A passes to its `TimberWeights` / `VoiceSetting`
	 *  block). */
	lang?: string;
	/** Voice id, provider-specific. OpenAI: `"alloy"` | `"echo"` |
	 *  `"fable"` | `"onyx"` | `"nova"` | `"shimmer"`. MiniMax T2A:
	 *  `"male-qn-qingse"`, `"female-shaonv"`, etc. (see the
	 *  `voices.json` catalog). */
	voice?: string;
	/** Model name, provider-specific. OpenAI: `"tts-1"` | `"tts-1-hd"`.
	 *  MiniMax T2A: `"speech-01"`, `"speech-02"`, etc. */
	model?: string;
	/** Speech rate multiplier. OpenAI: 0.25–4.0. MiniMax T2A: 0.5–2.0.
	 *  Provider-specific; out-of-range values throw a `TtsProviderError`
 *  with `code: 1` (usage). */
	speed?: number;
	/** Output audio format. Telegram voice messages are OGG/Opus;
	 *  the orchestrator defaults to `"opus"`. Providers that can't
	 *  produce the requested format throw a `TtsProviderError` with
	 *  `code: 1`. */
	responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
	/** Provider-specific extras (e.g., MiniMax's `emotion`). The
	 *  provider's own `synthesize` reads the fields it understands
	 *  and ignores the rest. */
	extras?: Record<string, unknown>;
}

/** A TTS result. `audioPath` is the only required field — the
 *  bridge reads the audio file from there. `transcriptText` (when
 *  set) is included as the caption on the sent voice message
 *  (controlled by `config.voice.sendTranscript`). `language` and
 *  `durationMs` are for telemetry / `getVoicePromptContribution`. */
export interface TtsResult {
	/** Path to the synthesized audio file on disk. The bridge's
	 *  `delivery` module reads from here. */
	audioPath: string;
	/** Caption text to attach to the voice message. Defaults to
	 *  `req.text` if the provider doesn't set it explicitly. */
	transcriptText?: string;
	/** Detected or used language code. */
	language?: string;
	/** Wall-clock duration of the synthesis call (HTTP round-trip +
	 *  provider inference + local file write). For the bridge's
	 *  runtime event log. */
	durationMs?: number;
	/** Provider-specific metadata (e.g., the upstream response id
	 *  for OpenAI, or MiniMax T2A's `audio_length` field). For
	 *  the bridge's runtime event log. */
	metadata?: Record<string, unknown>;
}

/** Thrown by a provider when synthesis fails. `code` is the same
 *  taxonomy as `SttProvider` (1=usage, 2=network, 3=4xx, 4=5xx). */
export class TtsProviderError extends Error {
	constructor(
		message: string,
		readonly code: 1 | 2 | 3 | 4,
		readonly detail?: Record<string, unknown>,
	) {
		super(message);
		this.name = "TtsProviderError";
	}
}

/** A TTS provider. Implementations register themselves via
 *  `registerTtsProvider(this)` at module load (not on `session_start`,
 *  per the v0.3.1 STT load-order fix). The orchestrator
 *  (`pi-telegram-tts-minimax/index.ts`) looks the configured provider
 *  up by `id` at synthesis call time. */
export interface TtsProvider {
	/** Stable id, used as the value of `tts_provider` in the config. */
	readonly id: string;
	/** Human label, shown in the orchestrator's section UI picker. */
	readonly label: string;
	/** Synthesize `req.text` and return the audio path + optional
	 *  metadata. Throw `TtsProviderError` on failure (the bridge
	 *  records the error via `recordTelegramRuntimeEvent`). */
	synthesize(req: TtsRequest): Promise<TtsResult>;
}

// --- In-process registry, shared on globalThis (bridge-style) ---

const REGISTRY_KEY = "__piTelegramTtsProviderRegistry__";

interface TtsProviderRegistry {
	providers: Map<string, TtsProvider>;
}

function getRegistry(): TtsProviderRegistry {
	const g = globalThis as unknown as Record<string, unknown>;
	let reg = g[REGISTRY_KEY] as TtsProviderRegistry | undefined;
	if (!reg) {
		reg = { providers: new Map() };
		g[REGISTRY_KEY] = reg;
	}
	return reg;
}

/** Register a provider. Throws if the same id is already registered
 *  (typically a duplicate-load bug; the v0.3.1 defensive path in
 *  the provider's `index.ts` catches this and re-registers). */
export function registerTtsProvider(provider: TtsProvider): void {
	const reg = getRegistry();
	if (reg.providers.has(provider.id)) {
		throw new Error(
			`tts-provider: provider id "${provider.id}" is already registered`,
		);
	}
	reg.providers.set(provider.id, provider);
}

/** Unregister a provider (called by the provider extension's
 *  `session_shutdown`). */
export function unregisterTtsProvider(id: string): void {
	const reg = getRegistry();
	reg.providers.delete(id);
}

/** Look up a provider by id. Returns `undefined` if the id is not
 *  registered (e.g., the operator hasn't installed the matching
 *  provider package). The orchestrator's caller decides whether
 *  "missing" is a runtime event or a silent fall-through. */
export function getTtsProvider(id: string): TtsProvider | undefined {
	return getRegistry().providers.get(id);
}

/** List all registered providers (for the orchestrator's section
 *  UI picker). */
export function listTtsProviders(): ReadonlyArray<{
	id: string;
	label: string;
}> {
	return Array.from(getRegistry().providers.values()).map((p) => ({
		id: p.id,
		label: p.label,
	}));
}
