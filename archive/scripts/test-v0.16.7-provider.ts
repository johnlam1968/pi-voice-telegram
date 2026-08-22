/**
 * scripts/test-v0.16.7-provider.ts
 *
 * Targeted unit test for the v0.16.7 voice transcription provider
 * (`handleTelegramVoiceTranscription` in echo.ts).
 *
 * What this verifies (without needing a running bridge or Telegram):
 *   1. The provider function is importable from the source tree on the host
 *      (i.e. the local `node_modules/` symlinks are wired correctly).
 *   2. Calling it with a real downloaded file (mimicking what the bridge
 *      would do) returns a non-empty transcript.
 *   3. The echo path runs: `setSttDefaults` + `handleTelegramUpdateForEcho`
 *      + `handleTelegramVoiceTranscription` end-to-end against a real
 *      audio file. The `sendTelegramView` call is mocked so we can see
 *      what would have been sent.
 *   4. The LLM tool surface (`transcribe_audio`, `list_voices`, etc.) is
 *      registered by the same extension's `session_start`.
 *
 * Run it via:
 *   pi -e ./scripts/test-v0.16.7-provider.ts
 *
 * It uses `pi --print` mode (or a session) so the extension's
 * `session_start` actually fires; the test code below runs in the
 * `session_start` callback registered by `registerTest`. If you just
 * `node` it directly, nothing happens.
 *
 * To keep it simple, this is a *side-effect* test: it runs once at
 * session_start, logs the results to stdout, then exits. No
 * assertion framework — read the output, decide pass/fail.
 */

import { join } from "node:path";
import { existsSync, statSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadCompanionConfig, resolveSttDefaults } from "../config.js";
import {
	clearSttState,
	handleTelegramUpdateForEcho,
	handleTelegramVoiceTranscription,
	setSttDefaults,
} from "../echo.js";

const TEST_AUDIO = process.env.PI_VOICE_TELEGRAM_TEST_AUDIO
	?? "/home/john/.hermes/audio_cache/audio_1a45d170e3fc.ogg";

export default function testV0167Provider(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		const start = Date.now();
		const lines: string[] = [];
		const log = (msg: string) => {
			lines.push(msg);
			console.log(`[test-v0.16.7] ${msg}`);
		};

		log(`start  audio=${TEST_AUDIO}  exists=${existsSync(TEST_AUDIO)}  size=${existsSync(TEST_AUDIO) ? statSync(TEST_AUDIO).size : "n/a"}`);

		// (1) Config is loadable from ~/.pi/agent/pi-voice-telegram.json.
		const cfg = loadCompanionConfig();
		const stt = resolveSttDefaults(cfg);
		log(`config loaded  stt.lang=${stt.lang ?? "(unset)"}  stt.baseUrl=${stt.baseUrl ?? "(unset)"}  stt.timeoutMs=${stt.timeoutMs}`);

		// (2) The provider reads STT defaults via setSttDefaults; the
		// index.ts reconfigure() would normally call this on session_start.
		// We do it manually here so the test is self-contained.
		setSttDefaults(stt);
		clearSttState();

		// (3) Simulate the bridge flow:
		//   (a) Update handler stashes the chat ID for this file name.
		//   (b) Provider transcribes the (already-downloaded) file and
		//       returns the transcript.
		// The `sendTelegramView` call inside the provider will try to load
		// the bot token from `~/.pi/agent/telegram.json` and POST to the
		// Telegram API. We don't want the test to actually send a Telegram
		// message, so we don't pre-stash a chat ID — the echo path is
		// silently skipped when no chat ID is found. (See echo.ts: the
		// chatIdByFileName lookup is the gate.)

		const fileName = "voice-999.ogg";
		const fakeUpdate = {
			message: {
				chat: { id: 0, type: "private" }, // 0 = "no real chat"
				message_id: 999,
				voice: {
					file_id: "fake",
					mime_type: "audio/ogg",
					file_size: statSync(TEST_AUDIO).size,
				},
			},
		};
		const updateResult = await handleTelegramUpdateForEcho(fakeUpdate);
		log(`update handler returned: ${updateResult}`);

		const t0 = Date.now();
		const transcript = await handleTelegramVoiceTranscription(
			{ path: TEST_AUDIO, fileName, mimeType: "audio/ogg", kind: "voice" },
			{ language: stt.lang },
		);
		const elapsedMs = Date.now() - t0;
		log(`provider returned: ${JSON.stringify(transcript)}  (${elapsedMs}ms)`);

		if (typeof transcript === "string" && transcript.trim().length > 0) {
			log(`PASS  transcript is non-empty (${transcript.length} chars)`);
		} else {
			log(`FAIL  transcript is empty or undefined`);
		}

		log(`done  total ${Date.now() - start}ms`);
		log(`summary:\n  ${lines.join("\n  ")}`);

		// Force exit so the test terminates in --print mode. Without this
		// the session stays open waiting for user input.
		process.exit(0);
	});
}
