/**
 * pi-telegram-stt — entry point. Wires the section, the STT +
 * 🎙️ echo handlers, the config watcher, and the bundled
 * `pi-openai-stt` provider registration.
 *
 * Full design + version history + per-component docs live in
 * `docs/STT-PACKAGE.md`. This file is the lifecycle orchestrator.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { makeLogger } from "./_logger.js";
import { registerEchoHandlers } from "./echo-handler.js";
import { registerOpenAiSttProvider } from "./openai-stt.js";
import piTelegramSttSection from "./section.js";
import { loadEchoConfig } from "./telegram-config.js";

const log = makeLogger("pi-telegram-stt");

// Module-load side effect: register the bundled OpenAI-compatible
// provider before any `session_start` fires. Idempotent — handled
// inside `registerOpenAiSttProvider()`.
registerOpenAiSttProvider();

export default function piTelegramStt(pi: ExtensionAPI): void {
	let handlerDisposers: Array<() => void> = [];
	let configWatcher: FSWatcher | null = null;
	let reloadTimer: NodeJS.Timeout | null = null;
	const configPath = join(
		process.env.PI_CODING_AGENT_DIR ?? getAgentDir(),
		"telegram.json",
	);

	/** Re-register the handlers so the provider closure picks up
	 *  the new `showTranscript` and `stt_provider`. */
	const reconfigureHandlers = (): void => {
		const cfg = loadEchoConfig();
		log.info("reconfigure handlers", {
			showTranscript: cfg.showTranscript,
			sttProvider: cfg.stt_provider,
		});
		handlerDisposers.forEach((d) => d());
		handlerDisposers = [];
		handlerDisposers.push(...registerEchoHandlers(cfg));
	};

	/** `fs.watch` on the agent dir. Sibling writes (sessions,
	 *  logs, state) are ignored — only a real `telegram.json` change
	 *  re-binds the handlers. Best-effort: if `fs.watch` fails in
	 *  a sandbox, `session_start` still works; live edits just need
	 *  a reload. */
	const startConfigWatcher = (): void => {
		if (configWatcher) return;
		if (!existsSync(configPath)) {
			log.warn("config not found, skipping watcher", { path: configPath });
			return;
		}
		const configDir = dirname(configPath);
		const baseName = configPath.slice(configDir.length + 1);
		try {
			configWatcher = watch(
				configDir,
				{ persistent: true },
				(_event, filename) => {
					if (filename !== baseName) return;
					log.debug("telegram.json changed", { filename });
					if (reloadTimer) clearTimeout(reloadTimer);
					reloadTimer = setTimeout(() => {
						reloadTimer = null;
						reconfigureHandlers();
					}, 200);
				},
			);
			log.info("config watcher started", { path: configPath });
		} catch (e) {
			log.warn("config watcher failed", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	};

	// Section lifecycle is owned by `section.ts`'s default export
	// (per `docs/sections.md` §4). The STT provider is module-
	// lifetime — the module-load call above registered it and the
	// `globalThis`-backed registry keeps it visible for the agent's
	// whole lifetime. `session_shutdown` does not unregister it
	// (no per-session state to reset).
	piTelegramSttSection(pi);

	pi.on("session_start", () => {
		log.info("session_start");
		reconfigureHandlers();
		startConfigWatcher();
		log.info("session_start done", {
			showTranscript: loadEchoConfig().showTranscript,
			sttProvider: loadEchoConfig().stt_provider,
			watcherStarted: !!configWatcher,
		});
	});

	pi.on("session_shutdown", () => {
		log.info("session_shutdown");
		if (reloadTimer) {
			clearTimeout(reloadTimer);
			reloadTimer = null;
		}
		handlerDisposers.forEach((d) => d());
		handlerDisposers = [];
		if (configWatcher) {
			configWatcher.close();
			configWatcher = null;
		}
	});
}
