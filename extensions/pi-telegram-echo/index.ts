/**
 * pi-telegram-echo — entry point.
 *
 * ## Version history
 *
 * v0.4.0 — add `pi-openai-stt` as a peer-dep provider and the
 *         `fw-openai-sts` shim. The same STT contract
 *         (`SttProvider`, looked up at call time from a
 *         `globalThis`-backed registry) now works against
 *         OpenAI-compatible API gateways: the on-host CUDA
 *         `whisper-server` (CUDA + `ggml-large-v3.bin` in VRAM)
 *         via the `fw-openai-sts` shim; OpenAI's actual API;
 *         `faster-whisper-server` with `--enable-openai-api`;
 *         `whisper-asr-webservice`; any other OpenAI-compatible
 *         gateway. New STT backends become "another
 *         `OPENAI_STT_BASE_URL` value" instead of "another
 *         `pi-<backend>-stt` package". The on-host CUDA
 *         `whisper-server` (PID 704, `--language yue
 *         --no-timestamps --convert`) is unchanged — the shim
 *         adds ~1ms of HTTP overhead. The `pi-whisper-stt` provider
 *         is kept for back-compat (deprecated in v0.5.0, removed
 *         in v0.6.0). The on-host setup is: `cp scripts/fw-openai-sts.ts
 *         ~/.pi/agent/bin/fw-openai-sts; chmod +x
 *         ~/.pi/agent/bin/fw-openai-sts; fw-openai-sts &; export
 *         OPENAI_STT_BASE_URL=http://127.0.0.1:8081/v1`. Then
 *         `stt_provider: "pi-openai-stt"` in `telegram.json`.
 *
 * v0.3.1 — fix the v0.3.0 load-order race. The on-host test
 *         surfaced: `pi-telegram-echo` session_start fired first
 *         (registering the echo handler), the bridge processed
 *         a voice message, and `pi-whisper-stt` session_start
 *         fired LATER. The first voice message saw an empty
 *         registry (`pi-telegram-echo/stt` `provider-missing`
 *         event). v0.3.1 fixes this by moving the provider
 *         registration to module load (top-level side effect in
 *         `pi-whisper-stt/index.ts`); the provider is in the
 *         registry synchronously when jiti loads the file, before
 *         any session_start fires. Also moves the registry from
 *         a per-jiti-instance `Map` to a `globalThis`-backed
 *         registry (matching the bridge's `lib/sections.ts:267-271`
 *         section-registry pattern), so the provider is visible
 *         across all jiti instances in the same Node process.
 *         Fixed a "pi-pi-whisper-stt" double-prefix typo in the
 *         `provider-missing` error message.
 *
 * v0.3.0 — STT provider standardization. The hardcoded
 *         `whisper-stt.ts` is replaced with a registry lookup:
 *         the configured `stt_provider` (default
 *         `"pi-whisper-stt"`) is looked up at STT call time in
 *         the in-process registry (`./stt-provider.ts`). The
 *         first provider package, `pi-whisper-stt`, is a
 *         peer-dep companion extension that registers itself
 *         in the registry on `session_start`. The section UI
 *         gains a "STT provider" picker that lists installed
 *         providers. Adding a new STT backend = a new
 *         `pi-<backend>-stt` package that implements the
 *         `SttProvider` contract, OR a new `OPENAI_STT_BASE_URL`
 *         value if the backend already speaks the OpenAI
 *         API gateway convention. See PLAN.md §v0.3.0 for the
 *         full design and the v0.4.0+ `pi-openai-stt` follow-up.
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
 *      the Telegram Extension Section for the echo on/off toggle
 *      + the STT provider picker. It reads `loadEchoConfig()`
 *      live and lists `listSttProviders()` on every UI render.
 *      We don't re-register on hot-reload because the bridge
 *      mints a fresh token each time — re-registering would
 *      stale the in-Telegram menu buttons ("This section is no
 *      longer available.").
 *
 *   2. HANDLERS (re-registered on hot-reload): the update handler
 *      (chat-ID stasher) and the voice transcription provider.
 *      The provider closure captures `cfg.echoEnabled` and
 *      `cfg.stt_provider` so a `telegram.json` write (e.g., from
 *      the section's toggle button or provider picker) takes
 *      effect on the next inbound voice message.
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
 *   - At least one STT provider extension installed and registered
 *     (default: `pi-whisper-stt`, which talks to
 *     `${WHISPER_SERVER_URL}/inference`).
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
	 *  the new `echoEnabled` and `stt_provider`. */
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
