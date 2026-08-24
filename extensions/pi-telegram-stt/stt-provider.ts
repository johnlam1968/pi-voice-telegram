/**
 * stt-provider.ts — the STT provider contract + a `globalThis`-backed
 * in-process registry.
 *
 * Any pi extension can implement `SttProvider` and register with
 * `registerSttProvider()` on `session_start` (or at module load for
 * early registration). `echo-handler.ts` looks up the configured
 * provider by `id` at STT call time to avoid load-order coupling.
 *
 * Full design notes (provider list, load-order-race history, the
 * `code: 1|2|3|4` taxonomy) live in `docs/STT-PACKAGE.md`.
 */

export interface SttRequest {
	inputPath: string;
	lang?: string;
}

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

export interface SttProvider {
	readonly id: string;
	readonly label: string;
	transcribe(req: SttRequest): Promise<string>;
}

// --- In-process registry, shared on globalThis (bridge-style) ----------

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

export function registerSttProvider(provider: SttProvider): void {
	const reg = getRegistry();
	if (reg.providers.has(provider.id)) {
		throw new Error(
			`stt-provider: provider id "${provider.id}" is already registered`,
		);
	}
	reg.providers.set(provider.id, provider);
}

export function unregisterSttProvider(id: string): void {
	getRegistry().providers.delete(id);
}

export function getSttProvider(id: string): SttProvider | undefined {
	return getRegistry().providers.get(id);
}

export function listSttProviders(): SttProvider[] {
	return [...getRegistry().providers.values()].sort((a, b) =>
		a.id.localeCompare(b.id),
	);
}
