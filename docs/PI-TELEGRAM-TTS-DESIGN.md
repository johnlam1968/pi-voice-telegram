# `pi-telegram-tts` — Design Notes

Companion to [`PI-TELEGRAM-TTS-PLAN.md`](./PI-TELEGRAM-TTS-PLAN.md).
Where the plan is the roadmap (what to build, in what order), this is
the design rationale and implementation context (why we chose this
shape, what we ruled out, the design patterns to follow, the gotchas,
and the full v0.1.0 implementation sketch for every source file).

**Last updated 2026-08-24 for the v0.3.0 + v0.3.0-hotfix state;
v0.1.0 sections are historical.** Status: v0.1.0 design shipped
2026-08-23. v0.2.0 (section UI) drafted in
`PI-TELEGRAM-TTS-PLAN.md`, not yet implemented. v0.3.0
(per-provider config schema) shipped 2026-08-24 with an
in-session hotfix: the plan's "no script changes needed" was
based on a misjudgment of how `--config` works (it's a raw
body deep-merge, not a CLI-flag path remap). The fix is
~25 lines in `tts-minimax.mjs` + `tts-openai.mjs` applying the
existing `CLI_TO_PATH` table to `--config` keys. See the v0.3.0
"deltas from this plan" section in the plan doc for the full
post-mortem.

**Read the plan first, then read this, then start building.** Together
they're the briefing for a new session. After reading §1-9 for context
and rationale, §7 has the full v0.1.0 source code (copy-paste ready),
§11 has the README outline, and §12 has the `package.json` /
`_logger.ts` adaptation notes.

## 1. The bridge's TTS pipeline — the 3 paths

`@llblab/pi-telegram`'s outbound voice delivery has **three** sub-paths,
in priority order (`lib/outbound-voice.ts:185-276`):

1. **`outboundHandlers[0].template`** (string-in, file-out) — what the
   operator uses today. The bridge substitutes `{text}`, `{mp3}`,
   `{ogg}` placeholders and runs the configured commands via
   `child_process.exec`. Returns only a file path. The text the bridge
   gave the template **is not echoed back**.
2. **Programmatic voice handlers** (`getProgrammaticVoiceHandlers`) —
   in-process handlers registered via
   `registerTelegramOutboundHandler` with `kind: "voice"`. Return
   `Promise<string>` — also just a file path.
3. **Synthesis providers** (`getTelegramVoiceSynthesisProviders`) —
   registered via `registerTelegramVoiceSynthesisProvider` from
   `@llblab/pi-telegram/voice`. Return
   `Promise<string | { audioPath, transcriptText? }>`. **Only this path
   can return `transcriptText`.**

The bridge's voice delivery is implemented as a single
`createTelegramVoiceReplySender` (`lib/outbound-voice.ts:125-285`) that
tries each path in order. The `transcriptText` plumbing lives at
`lib/outbound-voice.ts:151`:

```ts
...(options?.transcriptText ? { caption: options.transcriptText } : {}),
```

The bridge attaches the transcript as the voice message **caption** when
the provider returns one. No other path produces a caption.

## 2. Why synthesis provider is the only path that closes the gap

The operator's current `telegram.json#outboundHandlers[0].template` uses
path 1. The operator's config has `voice.sendTranscript: true`. The
template returns a file path; the bridge has no transcript to attach.
**The flag is silently dropped.** This is documented in
`archive/docs/MINIMAX-T2A-FINDINGS.md:72-87` as *"sendTranscript is
effectively dead config"*.

To make `sendTranscript: true` produce a real caption, the only path is
to register a synthesis provider (path 3). The scripts
(`tts-minimax.mjs`, `tts-openai.mjs`) are reused as-is; the provider
just spawns them and returns `{ audioPath, transcriptText: text }` to
the bridge. **No re-implementation of the TTS client. No native deps.
No new abstraction layer.**

## 3. The transcript is the text the bridge already gave us

When the bridge calls our provider at `agent_end`, it passes the
agent's reply text as `text` (the first argument). The `transcriptText`
we return to the bridge is **just that same string** (optionally
truncated, but the bridge doesn't enforce a length).

We do **not** need to STT-roundtrip the synthesized audio to recover
the transcript. We do not need to maintain a separate transcript
generator. We just echo the input back as `transcriptText` when
`getTelegramVoiceSendTranscript(config)` returns true.

This is the key insight that keeps the package small. The
`archive/docs/MINIMAX-T2A-FINDINGS.md:80-87` proposed STT-roundtrip as
one way to get a transcript; the v0.1.0 design avoids it entirely by
relying on the fact that **the bridge already has the text**.

## 4. What we ruled out

### 4.1 The `badlogic/pi-telegram` alternative

Mario Zechner's `github.com/badlogic/pi-telegram` is a single-file,
~1130-line reference implementation. It has:

- **Zero** `registerTelegram*` companion API
- **Zero** voice provider seams
- **Zero** STT/TTS hooks
- No `outboundHandlers`, no `inboundHandlers`, no `voice` config
- No sections, no commands, no settings UI
- No multi-instance bus, no leader/follower

To build our features on top of it, we'd have to **add** a public API
surface (section registry, provider registry, config schema, voice
mode matrix, runtime event recorder, multi-instance transport) — which
is forking the project, not extending it. Estimated effort: several
thousand lines plus a permanent maintenance commitment.

By contrast, `@llblab/pi-telegram` already has the seam. Our work is
~200 lines that plug into it.

### 4.2 Re-implementing the TTS client

The `badlogic` comparison also applies here. We could write an in-process
HTTP client for the MiniMax T2A and OpenAI `/v1/audio/speech` APIs.
This is what the v0.18.x monolithic did. The v0.19.0 split removed it
("for the sake of simplification ... to avoid issues"). The scripts
exist precisely to avoid that re-implementation.

We keep the scripts. We don't write a new HTTP client. We don't add
`node-fetch`, `axios`, `undici`, or any HTTP library.

### 4.3 Forking `@llblab/pi-telegram`

The bridge's `lib/outbound-voice.ts:185-276` already iterates
`getTelegramVoiceSynthesisProviders()` — the provider path is wired up
and tested. Forking to add our own voice delivery would mean
re-implementing transport, queue, ownership, and adapter layers
(50+ `lib/*.ts` files). The `BACKLOG.md` discipline (upstream's
`AGENTS.md:31`) ensures only stable, versioned APIs get added. We use
the stable surface; we don't fork it.

## 5. The 4 patterns to copy from `pi-telegram-extension-demo`

The upstream's maintained reference
(`github.com/llblab/pi-telegram-extension-demo`, 234 lines, single
file) demonstrates the package shape. Four patterns carry over
verbatim:

### 5.1 Default export, disposers array, session_shutdown cleanup

`index.ts:12-14, 232-234`:

```typescript
export default function (pi: ExtensionAPI) {
  const disposers: Array<() => void> = [];
  // ... register, push each disposer
  pi.on("session_shutdown", () => {
    for (const dispose of disposers) dispose();
  });
}
```

Same shape for our provider — one registration, one disposer.

### 5.2 `package.json#pi.extensions` + peer deps

`package.json:27-37`:

```json
"pi": { "extensions": ["./index.ts"] },
"peerDependencies": {
  "@earendil-works/pi-coding-agent": "*",
  "@llblab/pi-telegram": "^0.16.0"
}
```

Our `pi-telegram-tts/package.json` mirrors this. We can use `*` for
`@llblab/pi-telegram` because the voice API has been stable since
`0.16.x`.

### 5.3 Disposer returns + push

`index.ts:16-27, 41, 230`:

```typescript
const off = registerTelegramCommand({...});
disposers.push(off);
```

For our case:

```typescript
const off = registerTelegramVoiceSynthesisProvider(provider, {
  id: "pi-telegram-tts/synth",
});
disposers.push(off);
```

`registerTelegramVoiceSynthesisProvider` returns `() => void` exactly
like the demo's two `register*` calls
(`lib/voice.ts:185-201`). **Pattern-compatible.**

### 5.4 `type ExtensionAPI` import (peer dep, not direct dep)

`index.ts:8`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
```

Type-only import. Same line `pi-telegram-stt/index.ts:166` and
`pi-openai-stt/index.ts:46` use. The demo's `package.json#peerDependencies`
declares it. **Match exactly.**

## 6. The 3 things the demo doesn't show (that we need)

### 6.1 Module-load provider registration (load-order safety)

The demo registers inside `export default function (pi) { ... }`. Fine
for commands and sections because the bridge doesn't call them until
after `session_start`, which fires after all extensions load. **For
synthesis providers, `docs/voice.md:42` documents the load-order race:**
if a voice message arrives before our `session_start` runs, the
provider isn't registered yet and the bridge records a
`provider-missing` runtime event.

The fix: register at module load (top-level side effect) **and**
idempotent re-register on `session_start`. The reference pattern is
`pi-openai-stt/index.ts:96-110`:

```typescript
// At module load
const provider: SttProvider = { id, transcribe: ... };
try {
  registerSttProvider(provider);
} catch (e) {
  // duplicate-load defensive: the registry already has our entry
  unregisterSttProvider(PROVIDER_ID);
  registerSttProvider(provider);
}

export default function (pi) {
  pi.on("session_start", () => {
    try { registerSttProvider(provider); } catch { /* already registered */ }
  });
  pi.on("session_shutdown", () => {
    unregisterSttProvider(PROVIDER_ID);
  });
}
```

Same pattern for `registerTelegramVoiceSynthesisProvider`. The
**module-load registration lives for the process lifetime**; the
**session_start registration's disposer is pushed onto the disposers
array**. Don't push the module-load disposer — that would unregister
us on every `session_shutdown`, then we'd be gone for the next
session.

### 6.2 Reading `telegram.json` config

The demo has no config — its `demoFlagOn` is an in-memory boolean
toggled by the section UI. Our provider needs to read
`extensions["pi-telegram-tts"]` from `telegram.json` **on every call**,
so live edits take effect on the next voice-tagged turn.

The reference pattern is `pi-telegram-stt/telegram-config.ts:44-69`:

```typescript
export function loadEchoConfig(): EchoConfig {
  const path = configPath();
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { extensions?: Record<string, unknown> };
    const block = (parsed.extensions ?? {})[KEY] as Partial<EchoConfig> | undefined;
    if (!block) return structuredClone(DEFAULTS);
    return { /* field-by-field with type guards */ };
  } catch {
    return structuredClone(DEFAULTS);
  }
}
```

Note: **`getAgentDir()` is imported from `@earendil-works/pi-coding-agent`**
and used directly — we did the path-resolution fix earlier in this
session (`extensions/pi-openai-stt/openai-stt.ts:73-77` was the
change). `process.env.PI_CODING_AGENT_DIR ?? getAgentDir()` is the
correct pattern.

For v0.2.0's section UI, the **atomic write pattern** at
`pi-telegram-stt/telegram-config.ts:71-96` (`saveEchoConfig` — temp
file + `renameSync`) is the right reference. The bridge's
`recordTelegramRuntimeEvent` is called on any failure.

### 6.3 Spawning an external process + ffmpeg

The demo is pure in-memory + UI. Our provider needs to:

1. `child_process.spawn` `node tts-${provider}.mjs` with the text on
   stdin
2. `child_process.spawn` `ffmpeg` to convert MP3 → OGG
3. Return `{ audioPath, transcriptText? }` to the bridge

The closest upstream reference is
`lib/outbound.ts:457-518` (`generateTelegramVoiceReplyFileWithHandler`),
which is the bridge's own internal implementation of the same flow
(it spawns the template's first step, then the second step). We don't
use `execCommand` (we don't have a port to the bridge's exec), so we
use `child_process.spawn` directly. ~50 lines of code.

The text must be piped via **stdin**, not `--text`, because the LLM's
reply may contain newlines, quotes, or other shell metacharacters.
Both `tts-minimax.mjs` and `tts-openai.mjs` already read from stdin
when `--text` is absent — see `tts-openai.mjs:260-266`:

```typescript
const TEXT = getArg("text");
let text = TEXT ?? (await readStdin());
```

The spawn idiom:

```typescript
import { spawn } from "node:child_process";

function spawnWithStdin(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(0) : reject(new Error(`exit ${code}: ${stderr}`));
    });
    child.stdin.end(stdin);  // pipe + close stdin
  });
}
```

## 7. The v0.1.0 implementation sketch

This is the actual starting point. The plan lists the files; this is
what the `index.ts` body looks like.

### 7.1 `index.ts` (~70 lines)

```typescript
/**
 * pi-telegram-tts — voice synthesis provider for the Pi coding agent +
 * @llblab/pi-telegram bridge. Spawns the same tts-{minimax,openai}.mjs
 * scripts the operator's outboundHandlers template uses, but through
 * the synthesis-provider API so voice.sendTranscript and
 * getVoicePromptContribution both work.
 */

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getTelegramVoiceSendTranscript,
  registerTelegramVoiceSynthesisProvider,
  type TelegramVoiceSynthesisProvider,
  type TelegramVoiceSynthesisProviderResult,
  type TelegramVoiceTurnView,
} from "@llblab/pi-telegram/voice";
import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import { loadSynthConfig } from "./telegram-config.js";
import { makeLogger } from "./_logger.js";
import { synthesizeOgg } from "./synth.js";

const log = makeLogger("pi-telegram-tts");

const PROVIDER_ID = "pi-telegram-tts/synth";

const provider: TelegramVoiceSynthesisProvider = {
  id: PROVIDER_ID,
  async synthesize(text, options): Promise<TelegramVoiceSynthesisProviderResult> {
    const cfg = loadSynthConfig();
    if (!cfg.provider) return undefined;  // fall through to template
    return synthesizeOgg(text, options, cfg);
  },
  getVoicePromptContribution(view: TelegramVoiceTurnView) {
    // Free win: the bridge already provides the view. Returning a
    // short hint here nudges the LLM to keep replies short for voice.
    if (!view.hasVoiceInput && !view.voiceReplyRequired) return undefined;
    return `[tts] Reply briefly; this turn will be spoken aloud via the configured TTS provider.`;
  },
};

// Module-load registration (load-order safety, same pattern as
// pi-openai-stt/index.ts:96-110). The bridge may call this provider
// before our session_start fires (if a voice message arrives early).
try {
  registerTelegramVoiceSynthesisProvider(provider, { id: PROVIDER_ID });
  log.info("registered at module load");
} catch (e) {
  log.warn("module-load register failed, retrying after unregister", {
    error: e instanceof Error ? e.message : String(e),
  });
  // Defensive: the globalThis registry already has our entry from a
  // previous load (hot-reload path).
  registerTelegramVoiceSynthesisProvider(provider, { id: PROVIDER_ID });
}

export default function piTelegramTts(pi: ExtensionAPI): void {
  const disposers: Array<() => void> = [];

  // Re-register on session_start (idempotent; the try above handles
  // duplicate-id on first load). The session_start registration's
  // disposer is the one we push onto the array.
  pi.on("session_start", () => {
    log.info("session_start");
    try {
      const off = registerTelegramVoiceSynthesisProvider(provider, { id: PROVIDER_ID });
      disposers.push(off);
      log.debug("re-registered on session_start");
    } catch {
      log.debug("already registered, skip re-register");
    }
  });

  pi.on("session_shutdown", () => {
    log.info("session_shutdown");
    for (const d of disposers) d();
    disposers.length = 0;
  });
}
```

### 7.2 `synth.ts` (~120 lines, self-contained)

```typescript
/**
 * synth.ts — TTS pipeline: spawn the tts-{provider}.mjs script, ffmpeg
 * the result to OGG/Opus, return the path + the original text.
 *
 * The script is invoked by absolute path on dev (operator working
 * from the source repo — same dir as this file) or by
 * `node <bin-name>` after `npm install` (this package's `bin` field
 * exposes the same scripts as `tts-minimax` / `tts-openai` on PATH
 * as of v0.2.0; previously a separate `pi-voice-telegram-scripts`
 * peer-dep, now deprecated). The `resolveScriptPath` helper picks
 * between the two resolution strategies.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

import type { SynthConfig } from "./telegram-config.js";
import { makeLogger } from "./_logger.js";

const log = makeLogger("pi-telegram-tts/synth");

const SCRIPT_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 30_000;

/**
 * Resolve the path to `tts-{provider}.mjs`.
 *
 * 1. Dev: `<repo>/extensions/pi-telegram-tts/tts-<provider>.mjs`
 *    (same dir as this file; works regardless of where the operator
 *    cloned the repo). The scripts were bundled into this package
 *    in v0.2.0 — previously they lived in a separate
 *    `pi-voice-telegram-scripts` package, now deprecated.
 * 2. npm install: this package's `bin` field exposes the same
 *    scripts as `tts-<provider>` on PATH. We hand the resolved
 *    name to `node` (Node's PATH lookup is built in).
 *
 * Falls back to the bin name on PATH (resolvable via `spawn("node",
 * ["tts-minimax", ...])` — Node's PATH lookup is built in).
 */
function resolveScriptPath(provider: "minimax" | "openai"): string {
  // Dev: same dir as synth.ts (this file).
  const devPath = join(
    dirname(new URL(import.meta.url).pathname),
    `tts-${provider}.mjs`,
  );
  if (existsSync(devPath)) return devPath;
  // npm install: rely on PATH lookup via `node` argv.
  return `tts-${provider}`;
}

/**
 * Spawn a child process with `stdin` piped (and closed on `end`).
 * Resolves on exit 0; rejects on non-zero exit, signal, or timeout.
 * Captures stderr for error messages.
 */
async function runProcess(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code}${signal ? ` (signal ${signal})` : ""}: ${stderr.slice(0, 1000)}`,
          ),
        );
      }
    });

    if (stdin) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Synthesize `text` to OGG/Opus via the configured provider.
 * Returns `{ audioPath, transcriptText }` on success, `undefined` on
 * any failure (the bridge falls through to the next provider).
 *
 * v0.1.0 only builds the v0.1.0 top-level config args
 * (`--voice <cfg.voice> --model <cfg.model>`). v0.3.0 expands this
 * to per-provider sub-blocks with the full set of CLI args.
 */
export async function synthesizeOgg(
  text: string,
  _options: { lang?: string; rate?: string } | undefined,
  cfg: SynthConfig,
): Promise<{ audioPath: string; transcriptText?: string } | undefined> {
  if (!cfg.provider) return undefined;

  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-tts-"));
  const mp3 = join(tempDir, `${randomUUID()}.mp3`);
  const ogg = join(tempDir, `${randomUUID()}.ogg`);

  try {
    // Step 1: TTS script → MP3. Text piped via stdin to avoid
    // argv-escaping issues with the LLM's reply (newlines, quotes,
    // shell metacharacters).
    const scriptPath = resolveScriptPath(cfg.provider);
    const scriptArgs = [
      scriptPath,
      "--out", mp3,
      ...(cfg.voice ? ["--voice", cfg.voice] : []),
      ...(cfg.model ? ["--model", cfg.model] : []),
    ];
    log.info("tts spawn", {
      provider: cfg.provider,
      voice: cfg.voice,
      model: cfg.model,
      chars: text.length,
    });
    await runProcess("node", scriptArgs, text, SCRIPT_TIMEOUT_MS);

    // Step 2: ffmpeg MP3 → OGG/Opus. The bridge only accepts .ogg /
    // .opus (see lib/outbound-voice.ts:92-101).
    await runProcess(
      "ffmpeg",
      [
        "-y", "-i", mp3,
        "-c:a", "libopus", "-b:a", "32k",
        "-ar", "48000", "-ac", "1",
        "-application", "voip",
        "-vbr", "on", "-compression_level", "10",
        "-f", "ogg", ogg,
      ],
      "",  // no stdin for ffmpeg
      FFMPEG_TIMEOUT_MS,
    );

    // Cleanup the intermediate MP3. (v0.7.0 will also schedule
    // `unlink(ogg)` 30s after upload; see Gotcha #3.)
    await unlink(mp3).catch(() => {});

    log.info("tts ok", { audioPath: ogg, chars: text.length });
    return { audioPath: ogg, transcriptText: text };
  } catch (err) {
    log.error("tts failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    recordTelegramRuntimeEvent("pi-telegram-tts/synth", err, {
      phase: "spawn",
      provider: cfg.provider,
    });
    return undefined;  // bridge falls through to next provider
  } finally {
    // Best-effort temp-dir cleanup. The OGG may still be in use by
    // the bridge's `uploadVoiceFile`; we use `force: true` to ignore
    // EBUSY and let the OGG linger if needed (see Gotcha #3).
    setTimeout(() => {
      rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }, 60_000);
  }
}
```

### 7.3 `telegram-config.ts` (~50 lines, self-contained)

```typescript
/**
 * telegram-config.ts — read/write this extension's key in telegram.json.
 *
 * Persistence: `telegram.json` under `extensions["pi-telegram-tts"]`.
 *
 * v0.1.0 shape:
 *   { "disabled": boolean, "provider": "minimax"|"openai",
 *     "voice": string, "model": string }
 *
 * If `extensions["pi-telegram-tts"]` is absent, `loadSynthConfig()`
 * returns `DEFAULTS` — which has `provider: undefined`. The provider
 * checks for `provider` in `synthesizeOgg` and returns `undefined`
 * (the bridge falls through to `outboundHandlers[0].template`).
 *
 * v0.2.0 will add `saveSynthConfig` (atomic temp+rename, same pattern
 * as `pi-telegram-stt/telegram-config.ts:71-96`) for the section UI's
 * enable/disable toggle. v0.1.0 only reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ProviderId = "minimax" | "openai";

export interface SynthConfig {
  /**
   * If true, the provider returns `undefined` from `synthesizeOgg`
   * even when `provider` is configured. Set by the v0.2.0 section UI
   * toggle so the operator can disable the provider without
   * uninstalling. v0.1.0 reads but doesn't write.
   */
  disabled: boolean;
  /** TTS provider id. `undefined` = fall through to template. */
  provider: ProviderId | undefined;
  /** Voice id for the chosen provider. v0.3.0 moves this to a per-provider sub-block. */
  voice: string | undefined;
  /** Model name for the chosen provider. v0.3.0 moves this to a per-provider sub-block. */
  model: string | undefined;
}

export const DEFAULTS: SynthConfig = {
  disabled: false,
  provider: undefined,
  voice: undefined,
  model: undefined,
};

const KEY = "pi-telegram-tts";

function configPath(): string {
  // getAgentDir() honors PI_CODING_AGENT_DIR (per upstream
  // @earendil-works/pi-coding-agent/dist/config.js:412-418). Same
  // single source of truth as the sister extensions.
  return join(getAgentDir(), "telegram.json");
}

export function loadSynthConfig(): SynthConfig {
  const path = configPath();
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as {
      extensions?: Record<string, unknown>;
    };
    const block = (parsed.extensions ?? {})[KEY] as
      | Partial<SynthConfig>
      | undefined;
    if (!block) return structuredClone(DEFAULTS);
    return {
      disabled:
        typeof block.disabled === "boolean"
          ? block.disabled
          : DEFAULTS.disabled,
      provider:
        block.provider === "minimax" || block.provider === "openai"
          ? block.provider
          : DEFAULTS.provider,
      voice:
        typeof block.voice === "string" && block.voice
          ? block.voice
          : DEFAULTS.voice,
      model:
        typeof block.model === "string" && block.model
          ? block.model
          : DEFAULTS.model,
    };
  } catch {
    // Malformed telegram.json (parse error, missing keys, etc.) →
    // fall back to DEFAULTS rather than crashing the extension.
    return structuredClone(DEFAULTS);
  }
}
```

## 8. The migration story

The operator's current `telegram.json` has
`outboundHandlers[0].template` configured. When they install
`pi-telegram-tts`, three options:

1. **Replace** — clear `outboundHandlers[0]`, set
   `extensions["pi-telegram-tts"]` in `telegram.json`. Provider is the
   sole TTS path. **`sendTranscript: true` actually works.** (Recommended
   for the operator's case: `replyMode: "mirror" + sendTranscript: true`.)
2. **Keep template as primary, provider as fallback** — leave
   `outboundHandlers[0]` in place. The template fires first
   (`lib/outbound-voice.ts:185-207`); provider only runs if the
   template fails. **`sendTranscript: true` is still a no-op for the
   template path** — the operator's caption won't appear.
3. **Don't install** — nothing changes. Existing template keeps
   working exactly as it does today. The package is opt-in.

The README in v0.1.0 documents these three options.

## 9. Gotchas

1. **`voice.sendTranscript` is bridge-owned.** The operator sets it
   in `telegram.json#voice.sendTranscript` (read by the bridge via
   `getTelegramVoiceSendTranscript(config)`). We don't add a
   `pi-telegram-tts`-specific setting. We just read it.

2. **The transcript is the text the bridge already gave us.** Don't
   STT-roundtrip the synthesized audio. Don't maintain a separate
   transcript generator. The bridge calls `provider.synthesize(text)`;
   the `transcriptText` is just `text` (echoed back).

3. **Temp files need cleanup (deferred to v0.7.0).** The bridge's
   `lib/outbound-voice.ts:271-275` only unlinks the provider's file
   if the result was a different file than the input. We return a
   fresh OGG, so the bridge doesn't clean it up. v0.1.0 has no
   cleanup — temp files linger in `<tmp>/`. The standard fix is
   `setTimeout(() => unlink(ogg), 30_000)` scheduled after the
   bridge's `uploadVoiceFile`.

4. **Stdin vs argv for the script text.** Both `tts-minimax.mjs` and
   `tts-openai.mjs` already read from stdin when `--text` is absent
   (`tts-openai.mjs:260-266`). The LLM's reply may contain newlines,
   quotes, or other shell metacharacters; piping via stdin avoids
   argv-escaping entirely.

5. **Module-load registration must use the same `id`.** The
   `registerTelegramVoiceSynthesisProvider(provider, { id: "..." })`
   signature is `(provider, { id? })`. Omitting `id` works but
   receives a generated session-local id; with `id`, the registration
   is durable and visible across jiti instances. Same pattern as the
   other sister extensions.

6. **Hot-reload caveat.** `pi-telegram-stt/index.ts:185-189`
   documents that re-registering sections on hot-reload mints a new
   token and stales in-Telegram menu buttons. This doesn't apply to
   providers (no token). Our module-load + session_start dual
   registration is safe for hot-reload.

## 10. What the plan says vs what this doc adds

| Topic | Plan | Design |
|---|---|---|
| **v0.1.0 file structure** | ✅ lists 4 files with line estimates | ✅ same |
| **Config shape (v0.1.0)** | ✅ top-level `provider` + `voice` + `model` | ✅ same |
| **The 3 TTS pipeline paths** | ❌ not covered | ✅ §1, §2 |
| **The "transcript is the input" insight** | ❌ not covered | ✅ §3 |
| **Why we ruled out `badlogic/pi-telegram`** | ❌ not covered | ✅ §4.1 |
| **Why we ruled out re-implementing the TTS client** | ❌ not covered | ✅ §4.2 |
| **The 4 demo patterns to copy** | ❌ not covered (the plan says "see demo") | ✅ §5 |
| **The 3 things the demo doesn't show** | ❌ not covered | ✅ §6 |
| **The `pi-openai-stt` module-load pattern** | referenced briefly | ✅ §6.1 with full code |
| **The `getAgentDir` import** | referenced briefly | ✅ §6.2 explicit |
| **The atomic-write pattern for v0.2.0** | not covered | ✅ §6.2 |
| **The stdin-vs-argv pattern with line citations** | not covered | ✅ §6.3, §9.4 |
| **The v0.1.0 implementation sketch** | not covered | ✅ §7 with full code for all 4 source files (`index.ts`, `synth.ts`, `telegram-config.ts`; `_logger.ts` is a copy of the sister package per §12) |
| **The v0.1.0 README outline** | not covered | ✅ §11 |
| **The `package.json` and `_logger.ts` adaptation notes** | not covered | ✅ §12 |
| **The 3 migration options** | brief mention in "Open questions" | ✅ §8 |
| **The 6 gotchas** | not covered | ✅ §9 |

The plan tells you *what to ship*. This doc tells you *how to build it
without re-deriving the design*. Read them in order.

## 11. The v0.1.0 `README.md` outline

The README is operator-facing copy. Mirror the existing sister
packages' structure (`pi-telegram-stt/README.md`, `pi-openai-stt/README.md`)
and weave in the migration story from §8.

```markdown
# pi-telegram-tts

Voice **synthesis** provider for the Pi coding agent +
[@llblab/pi-telegram](https://github.com/llblab/pi-telegram) bridge. Closes
the `voice.sendTranscript: true` gap (which is a silent no-op for the
`outboundHandlers` template path) and unlocks `getVoicePromptContribution`
for voice-tagged turns. Reuses the existing `tts-minimax.mjs` /
`tts-openai.mjs` scripts — no new HTTP client, no native deps.

**STT is delegated to [`pi-telegram-stt`](../pi-telegram-stt/README.md)**
and its provider extensions. This package only does TTS.

## Install

From npm (once published):

```bash
pi install npm:pi-telegram-tts
```

The `tts-minimax` and `tts-openai` scripts ship **inside this
package** as of v0.2.0 (previously a separate `pi-voice-telegram-scripts`
peer-dep, now deprecated). The package's `bin` field exposes both
on PATH after `npm install`; the provider spawns them by name when
npm-installed, or by absolute path when dev-loaded (same dir as
`synth.ts`).

On-host dev loader (one-liner re-export shim), assuming the operator
runs from the source repo:

```bash
cat > ~/.pi/agent/extensions/pi-telegram-tts.ts <<'EOF'
export { default } from "/path/to/this/repo/extensions/pi-telegram-tts/index.ts";
EOF
```

## Configure (v0.1.0)

Edit `~/.pi/agent/telegram.json`:

```json
{
  "voice": {
    "replyMode": "mirror",
    "sendTranscript": true
  },
  "extensions": {
    "pi-telegram-tts": {
      "provider": "minimax",
      "voice": "Cantonese_PlayfulMan",
      "model": "speech-2.8-hd"
    }
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `provider` | `"minimax"` \| `"openai"` | required for the provider to fire |
| `voice` | string | passed as `--voice` to the TTS script |
| `model` | string | passed as `--model` to the TTS script |
| `disabled` | boolean | (v0.2.0) set by the section UI toggle |

Live edits take effect on the next voice-tagged turn (the provider
re-reads config on every call).

## Migration from the existing template

If you already have `outboundHandlers[0].template` configured (the
v0.19.0 default path), three options:

1. **Replace** — clear `outboundHandlers[0]` so the provider is the
   sole TTS path. `voice.sendTranscript: true` actually attaches the
   transcript as the voice caption. **Recommended** if you set
   `sendTranscript: true`.
2. **Keep template as primary, provider as fallback** — leave
   `outboundHandlers[0]` in place. The template fires first; the
   provider only runs if the template fails. **Note:** `sendTranscript:
   true` is still a no-op for the template path.
3. **Don't install** — nothing changes. The existing template keeps
   working exactly as before. The package is opt-in.

After v0.1.0 is in place, the upstream voice reply pipeline
(`lib/outbound-voice.ts:185-276`) iterates: configured
`outboundHandlers[0]` → programmatic voice handlers → registered
synthesis providers. Our provider is tier 3; for `sendTranscript: true`
to fire, you must replace (option 1).

## v0.1.0 capabilities

- `voice.sendTranscript: true` produces a real voice caption.
- `getVoicePromptContribution(view)` adds `[tts] Reply briefly; this
  turn will be spoken aloud via the configured TTS provider.` to
  voice-tagged prompts.
- Module-load + session_start dual registration, idempotent on
  hot-reload.

## What's not in v0.1.0

- **Section UI** — the provider is not yet visible in
  `/telegram-settings`. v0.2.0 adds a section (similar to
  `pi-telegram-stt/echo-section.ts`).
- **Per-provider config schema** — `instructions`, `speed`,
  `response_format`, `lang`, etc. are not yet configurable from
  `telegram.json`. v0.3.0 expands to per-provider sub-blocks.
- **UI-driven config** — voice / model editable from Telegram. v0.4.0.
- **Temp-file cleanup** — the OGG produced by the provider lingers
  in `<tmp>/` after upload. v0.7.0 schedules `unlink` 30s after upload.

## Diagnostics

- **Stderr** — every action logs to stderr with the `[pi-telegram-tts]`
  tag. Set `PI_VOICE_TELEGRAM_DEBUG=1` for DEBUG-level output.
- **Telegram runtime events** — spawn failures are recorded via
  `recordTelegramRuntimeEvent("pi-telegram-tts/synth", ...)` and
  visible in `/telegram-status`.
- **Provider registry** — the provider is registered with stable id
  `pi-telegram-tts/synth`. Visible in the bridge's `telegram-status`
  if a voice message fires while mis-configured.

## License

MIT
```

The README is **sketch, not the final copy**. A new session should
treat it as the outline: each section's content comes from the
plan/design docs, but the operator-facing wording (especially the
"why" framing in the intro and the migration story) should be written
to match the existing sister packages' voice
(see `pi-telegram-stt/README.md` and `pi-openai-stt/README.md` for
the house style).

## 12. The v0.1.0 `package.json` and `_logger.ts`

These two files are mechanical to fill in from existing references; not
worth a separate §7.x section. The new agent should:

- **`package.json`** — copy `pi-telegram-stt/package.json` and change:
  - `name: "pi-telegram-stt"` → `"pi-telegram-tts"`
  - `version: "0.7.0"` → `"0.1.0"` (then `0.2.0` for the v0.2.0
    scripts-bundle, `0.3.0` for the v0.3.0 per-provider sub-block).
  - `description` → the v0.1.0 description from the plan
  - `peerDependencies` → drop `pi-openai-stt` (we don't depend on
    the STT chain), keep `@earendil-works/pi-coding-agent` and
    `@llblab/pi-telegram` (use `*`, not `^0.16.0` — the voice API
    is stable across versions, matching the sister package's
    looseness). **Do not** add `pi-voice-telegram-scripts` as a
    peer-dep; the scripts are bundled inside this package as of
    v0.2.0. Also add a `bin` field exposing `tts-minimax` and
    `tts-openai` on PATH after `npm install`, and include the
    `.mjs` files in the `files` array (alongside `*.ts` + `README.md`).
  - `exports` — drop the `./stt-provider` subpath export (we don't
    expose one); keep only `.` and the `pi.extensions` field.
  - `files` — same as sister plus the `.mjs` files:
    `["*.ts", "*.mjs", "README.md"]`.

- **`_logger.ts`** — copy `pi-telegram-stt/_logger.ts` verbatim. The
  per-package self-containment is intentional (v0.7.0 design
  decision for `pi-telegram-stt`; we follow the same pattern). 90
  lines, no changes.

## Related docs

- `PI-TELEGRAM-TTS-PLAN.md` (this repo) — the v0.1.0 → v0.4.0 roadmap
- `UPSTREAM-API-COMPLIANCE.md` (this repo) — the audit doc this design
  plan extends
- `@llblab/pi-telegram/docs/voice.md` — the bridge's voice integration
  contract
- `@llblab/pi-telegram/api/voice.ts` — the public symbol surface
  (`registerTelegramVoiceSynthesisProvider`,
  `getTelegramVoiceSendTranscript`, etc.)
- `@llblab/pi-telegram-extension-demo` (`github.com/llblab/pi-telegram-extension-demo`)
  — the pattern reference
- `extensions/pi-telegram-stt/` — the sister package we mirror
- `extensions/pi-openai-stt/index.ts:96-110` — the module-load
  registration pattern
- `extensions/pi-telegram-stt/telegram-config.ts` — the config I/O
  pattern (read on every call, atomic write on save)
- `extensions/pi-openai-stt/openai-stt.ts:73-77` — the
  `getAgentDir()` path-resolution fix
- `archive/docs/MINIMAX-T2A-FINDINGS.md:72-87` — the documented
  "sendTranscript is dead config" finding that motivates v0.1.0
