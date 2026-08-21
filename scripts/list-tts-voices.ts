#!/usr/bin/env node
// list-tts-voices — list voices available from each registered TTS provider.
//
// Loads every `pi-*-tts` extension in this repo via jiti, then calls
// `TtsProvider.listVoices()` on each and prints a unified table. Used
// by the operator to pick a voice for `telegram.json`
// (`extensions["pi-telegram-tts-minimax"].tts_provider` +
// `extensions["<provider>-tts"].voice`).
//
// Usage:
//   node --experimental-strip-types scripts/list-tts-voices.ts
//   node --experimental-strip-types scripts/list-tts-voices.ts --provider pi-minimax-tts
//   node --experimental-strip-types scripts/list-tts-voices.ts --language Cantonese
//   node --experimental-strip-types scripts/list-tts-voices.ts --json
//
// Exits 0 on success, 1 if no providers are registered (rare —
// the providers register at module load; if the script can't find
// jiti or the extensions, the error is fatal).

import { createJiti } from "jiti";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- arg parsing -----------------------------------------------------------

function parseArgs(argv: readonly string[]): {
	provider?: string;
	language?: string;
	json: boolean;
	help: boolean;
} {
	const out = { json: false, help: false } as ReturnType<typeof parseArgs>;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--provider" && i + 1 < argv.length) {
			out.provider = argv[++i];
		} else if (a === "--language" && i + 1 < argv.length) {
			out.language = argv[++i];
		} else if (a === "--json") {
			out.json = true;
		} else if (a === "--help" || a === "-h") {
			out.help = true;
		}
	}
	return out;
}

function printHelp(): void {
	console.log(`list-tts-voices — enumerate voices from every registered TTS provider

Usage:
  list-tts-voices [options]

Options:
  --provider <id>    List voices for a specific provider (default: all)
  --language <code>  Filter by language (e.g., "Cantonese", "en")
  --json             Output as JSON (default: human-readable table)
  --help, -h         Show this help

Providers are loaded by scanning ./extensions/ for any directory
containing a package.json with a "pi" field. Each provider's
listVoices() is called; results are merged and (optionally) filtered.
`);
}

// ---- load every pi-*-tts extension from ./extensions/ -----------------------

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const extensionsDir = join(projectRoot, "extensions");

interface ProviderInfo {
	id: string;
	label: string;
	voices: readonly { id: string; name?: string; language?: string; description?: string; models?: readonly string[] }[];
}

async function loadAllProviders(): Promise<ProviderInfo[]> {
	if (!existsSync(extensionsDir)) {
		console.error(`extensions/ not found at ${extensionsDir}; run from the repo root.`);
		process.exit(1);
	}

	// jiti is the loader the agent uses for .ts extensions; the
	// provider modules are jiti-loaded too. Use the same loader
	// so the load-order semantics match a real agent session.
	const jiti = createJiti(import.meta.url, { interopDefault: true });

	// Always load the orchestrator (registers the TtsProvider
	// contract on globalThis) before the providers.
	const ttsProviderPath = join(
		extensionsDir,
		"pi-telegram-tts-minimax",
		"tts-provider.ts",
	);
	const ttsMod = await jiti.import(ttsProviderPath);
	const ttsNs = ttsMod as {
		listTtsProviders: () => ReadonlyArray<{ id: string; label: string }>;
	};

	// Load every pi-*-tts/ directory under ./extensions/. The
	// provider registers itself at module load; if there's no
	// listVoices() method we still include the provider in the
	// output with an empty voices list.
	const entries = readdirSync(extensionsDir);
	const ttsDirs = entries.filter((e) => {
		const p = join(extensionsDir, e);
		if (!statSync(p).isDirectory()) return false;
		if (!e.startsWith("pi-")) return false;
		if (!e.endsWith("-tts")) return false;
		// Skip the orchestrator's tts-provider module (it's a
		// file inside pi-telegram-tts-minimax, not a separate
		// provider package).
		if (e === "pi-telegram-tts-minimax") return false;
		return true;
	});

	// Load all providers in parallel; jiti's import is async and
	// each provider's top-level registerTtsProvider() call is sync.
	await Promise.all(
		ttsDirs.map((d) => jiti.import(join(extensionsDir, d, "index.ts"))),
	);

	const registered = ttsNs.listTtsProviders();
	const out: ProviderInfo[] = [];
	for (const meta of registered) {
		// The provider is on globalThis via the registry; look it
		// up again. The registry exports getTtsProvider(id).
		const provider = (ttsMod as {
			getTtsProvider: (id: string) => { listVoices?: () => Promise<readonly ProviderInfo["voices"][number][]> } | undefined;
		}).getTtsProvider(meta.id);
		if (!provider) continue;
		let voices: ProviderInfo["voices"] = [];
		try {
			voices = (await provider.listVoices?.()) ?? [];
		} catch (err) {
			console.error(
				`  WARN: ${meta.id}.listVoices() failed: ${(err as Error).message}`,
			);
		}
		out.push({ id: meta.id, label: meta.label, voices });
	}
	return out;
}

// ---- output formatting -----------------------------------------------------

function asTable(providers: readonly ProviderInfo[]): string {
	const lines: string[] = [];
	for (const p of providers) {
		lines.push(`\n${p.label}  (id: ${p.id}, ${p.voices.length} voices)`);
		lines.push(
			"  " +
				"id".padEnd(36) +
				"name".padEnd(20) +
				"lang".padEnd(14) +
				"models".padEnd(20) +
				"description",
		);
		lines.push("  " + "-".repeat(110));
		for (const v of p.voices) {
			const id = v.id.length > 34 ? v.id.slice(0, 33) + "…" : v.id;
			const name = (v.name ?? "").padEnd(20);
			const lang = (v.language ?? "?").padEnd(14);
			const models = (v.models ?? []).join(",").padEnd(20);
			lines.push(`  ${id.padEnd(36)}${name}${lang}${models}${v.description ?? ""}`);
		}
	}
	return lines.join("\n");
}

// ---- main ------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	printHelp();
	process.exit(0);
}

let providers = await loadAllProviders();

if (args.provider) {
	providers = providers.filter((p) => p.id === args.provider);
	if (providers.length === 0) {
		console.error(`No provider with id "${args.provider}" is registered.`);
		process.exit(1);
	}
}

if (args.language) {
	const lang = args.language;
	for (const p of providers) {
		// Replace .voices with the filtered list.
		(p as { voices: readonly typeof p.voices }).voices = p.voices.filter(
			(v) => v.language === lang,
		);
	}
	// Drop providers with zero matches so the table is tight.
	providers = providers.filter((p) => p.voices.length > 0);
}

if (args.json) {
	console.log(JSON.stringify(providers, null, 2));
} else {
	if (providers.length === 0) {
		console.log("(no voices match the filters)");
	} else {
		console.log(asTable(providers));
	}
}
