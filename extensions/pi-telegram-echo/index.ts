/**
 * pi-telegram-echo — entry point.
 *
 * Registered as a Pi extension via `package.json#pi.extensions`. The
 * host's jiti loader reads `./index.ts` directly; no build, no transpile.
 *
 * Two responsibilities, both driven by `telegram.json` under
 * `extensions["pi-telegram-echo"]`:
 *
 *   1. Register a voice transcription provider that runs the operator's
 *      configured STT command and sends the 🎙️ reply to the user
 *      (fallback path — the operator can also configure a stronger
 *      inbound handler in `telegram.json.inboundHandlers` to bypass us).
 *   2. Register a Telegram Extension Section in `/telegram-settings`
 *      so the operator can toggle the echo on/off and pick an STT
 *      command preset (whisper-server, local script, or clear).
 *
 * Public APIs used (all stable per @llblab/pi-telegram):
 *   - `@llblab/pi-telegram/voice`     → registerTelegramVoiceTranscriptionProvider
 *   - `@llblab/pi-telegram/updates`   → registerTelegramUpdateHandler
 *   - `@llblab/pi-telegram/delivery`  → sendTelegramView
 *   - `@llblab/pi-telegram/outbound`  → recordTelegramRuntimeEvent
 *   - `@llblab/pi-telegram/sections`  → registerTelegramSection
 *   - `@earendil-works/pi-coding-agent` → ExtensionAPI, getAgentDir
 *
 * Required host-side runtime (NOT bundled):
 *   - A working STT endpoint the operator has configured. The default
 *     `stt.command` is empty — the operator sets it via the Telegram
 *     Settings UI or by editing `telegram.json` directly.
 *   - For the reference install: `whisper-server` on
 *     `http://127.0.0.1:8080` (any HTTP STT works).
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { registerEchoHandlers } from "./echo-handler.js";
import { registerEchoSection } from "./echo-section.js";
import { loadEchoConfig, type EchoConfig } from "./telegram-config.js";

export default function piTelegramEcho(pi: ExtensionAPI): void {
	let disposers: Array<() => void> = [];
	let configWatcher: FSWatcher | null = null;
	let reloadTimer: NodeJS.Timeout | null = null;
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const configPath = join(agentDir, "telegram.json");

	/**
	 * Tear down all current registrations and re-run against the
	 * current `telegram.json` under `extensions["pi-telegram-echo"]`.
	 *
	 * Called from three places:
	 *   1. `session_start` — initial setup.
	 *   2. The `fs.watch` callback (debounced 200ms) — when the
	 *      operator edits `telegram.json` or uses the section UI
	 *      (which writes to it).
	 *   3. (Implicitly) at the top of the next call, via `disposers.forEach(d => d())`.
	 */
	const reconfigure = (): void => {
		disposers.forEach((d: () => void) => d());
		disposers = [];
		const cfg = loadEchoConfig();
		disposers.push(...registerEchoHandlers(cfg));
		disposers.push(registerEchoSection(cfg));
	};

	const startConfigWatcher = (): void => {
		if (configWatcher) return; // already running
		if (!existsSync(configPath)) return; // file not present yet
		const configDir = dirname(configPath);
		const baseName = configPath.slice(configDir.length + 1);
		try {
			configWatcher = watch(
				configDir,
				{ persistent: true },
				(_event, filename) => {
					if (filename !== null && filename !== baseName) return;
					if (reloadTimer) clearTimeout(reloadTimer);
					reloadTimer = setTimeout(() => {
						reloadTimer = null;
						reconfigure();
					}, 200);
				},
			);
		} catch {
			// fs.watch can fail in sandboxed envs. Hot-reload is a nicety;
			// session_start still works, so a graceful fallback is fine.
		}
	};

	pi.on("session_start", () => {
		reconfigure();
		startConfigWatcher();
	});

	pi.on("session_shutdown", () => {
		if (reloadTimer) {
			clearTimeout(reloadTimer);
			reloadTimer = null;
		}
		disposers.forEach((d: () => void) => d());
		disposers = [];
		if (configWatcher) {
			configWatcher.close();
			configWatcher = null;
		}
	});
}

// Re-export the config type for consumers (e.g., tests).
export type { EchoConfig };
