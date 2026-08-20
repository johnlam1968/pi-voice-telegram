/**
 * pi-telegram-echo — entry point.
 *
 * ## Version history
 *
 * v0.2.1 — section is registered ONCE per session; the bridge
 *         mints a fresh token at each `registerTelegramSection`
 *         call, so re-registering on hot-reload would stale the
 *         in-Telegram menu buttons ("This section is no longer
 *         available."). The section's `getLabel` / `render` /
 *         `settings.open` now read `loadEchoConfig()` live so the
 *         UI always reflects the current state without needing a
 *         fresh token. The watcher dropped the `filename === null`
 *         over-eager fallback so sibling writes to the agent dir
 *         (sessions, logs, state) no longer trigger a reconfigure.
 *         Also a cleanup pass: dropped the v0.2.0 redundant
 *         history comments, the dead `loadBotToken` (the token
 *         was never passed to `sendTelegramView`), the unused
 *         `clearEchoState` test helper, and the ported-but-unused
 *         `detectLanguage` from the old monolithic.
 *
 * v0.2.0 — port from the v0.1.0 scaffold to a working STT path.
 *         The configurable `stt.command` indirection was replaced
 *         with a hardcoded call to `./whisper-stt.ts`'s
 *         `transcribe()` (in-process FormData POST to
 *         `${WHISPER_SERVER_URL}/inference`). The section UI
 *         was simplified to a single `echoEnabled` toggle
 *         (STT command presets removed). The new `whisper-stt.ts`
 *         is a verbatim port of the old monolithic's whisper
 *         client (transcribe, WhisperSttError, env-var layering).
 *
 * v0.1.0 — initial scaffold. Configurable `stt.command` (argv
 *         spawn) + STT command presets in the section UI. See
 *         the v0.1.0 commit for the original design.
 *
 * ## Design
 *
 * Two registrations, both per voice.md "Voice Provider Extension
 * Surface":
 *
 *   1. SECTION (registered ONCE per session, never re-registered):
 *      the Telegram Extension Section for the echo on/off toggle.
 *      It reads `loadEchoConfig()` live on every UI render. We
 *      don't re-register on hot-reload because the bridge mints
 *      a fresh token each time — re-registering would stale the
 *      in-Telegram menu buttons ("This section is no longer
 *      available."). The regression history is in PLAN.md §v0.2.1.
 *
 *   2. HANDLERS (re-registered on hot-reload): the update handler
 *      (chat-ID stasher) and the voice transcription provider.
 *      The provider closure captures `cfg.echoEnabled` so a
 *      `telegram.json` write (e.g., from the section's toggle
 *      button) takes effect on the next inbound voice message.
 *
 * The watcher fires only on a real `telegram.json` change
 * (`filename` matches the base name). Sibling writes to the
 * agent dir (sessions, logs, state) are ignored — they would
 * otherwise re-trigger a hot-reload and waste the reconfigure
 * cost.
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
 *   - A reachable whisper-server on `${WHISPER_SERVER_URL}/inference`
 *     (default `http://127.0.0.1:8080`).
 *   - The `PI_TELEGRAM_LANG` env var (default `yue`).
 *   - The bridge's `telegram.json` `inboundHandlers` should be
 *     empty so this extension is the only STT path.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { registerEchoHandlers } from "./echo-handler.js";
import { registerEchoSection } from "./echo-section.js";
import { loadEchoConfig } from "./telegram-config.js";

export default function piTelegramEcho(pi: ExtensionAPI): void {
	let handlerDisposers: Array<() => void> = [];
	let sectionDisposer: (() => void) | null = null;

	let configWatcher: FSWatcher | null = null;
	let reloadTimer: NodeJS.Timeout | null = null;
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const configPath = join(agentDir, "telegram.json");

	/** Register the section once. Re-registering would mint a new
	 *  token and stale the in-Telegram menu buttons. */
	const registerSectionOnce = (): void => {
		if (sectionDisposer) return;
		sectionDisposer = registerEchoSection();
	};

	/** Re-register the handlers so the provider closure picks up
	 *  the new `echoEnabled`. */
	const reconfigureHandlers = (): void => {
		handlerDisposers.forEach((d: () => void) => d());
		handlerDisposers = [];
		handlerDisposers.push(...registerEchoHandlers(loadEchoConfig()));
	};

	const startConfigWatcher = (): void => {
		if (configWatcher) return;
		if (!existsSync(configPath)) return;
		const configDir = dirname(configPath);
		const baseName = configPath.slice(configDir.length + 1);
		try {
			configWatcher = watch(
				configDir,
				{ persistent: true },
				(_event, filename) => {
					// Only fire on a real `telegram.json` change. The
					// null-filename fallback (some platforms) is
					// intentionally NOT used — it would re-fire on
					// every sibling write (sessions, logs, state)
					// and waste a reconfigure.
					if (filename !== baseName) return;
					if (reloadTimer) clearTimeout(reloadTimer);
					reloadTimer = setTimeout(() => {
						reloadTimer = null;
						reconfigureHandlers();
					}, 200);
				},
			);
		} catch {
			// fs.watch can fail in sandboxed envs. Hot-reload is a
			// nicety; session_start still works.
		}
	};

	pi.on("session_start", () => {
		registerSectionOnce();
		reconfigureHandlers();
		startConfigWatcher();
	});

	pi.on("session_shutdown", () => {
		if (reloadTimer) {
			clearTimeout(reloadTimer);
			reloadTimer = null;
		}
		handlerDisposers.forEach((d: () => void) => d());
		handlerDisposers = [];
		if (sectionDisposer) {
			sectionDisposer();
			sectionDisposer = null;
		}
		if (configWatcher) {
			configWatcher.close();
			configWatcher = null;
		}
	});
}
