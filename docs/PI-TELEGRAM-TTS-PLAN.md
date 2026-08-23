# `pi-telegram-tts` — Build Plan

A new sister extension package that grows the TTS story for
`@llblab/pi-telegram`. v0.1.0 closes the documented `sendTranscript` gap;
later versions grow the package into a full provider surface that uses
every relevant API upstream exposes.

The package is a **sister to `pi-telegram-stt` / `pi-openai-stt`**: same
shape, same lifecycle, same load-order safety. It registers against
the bridge's public APIs only — never `lib/*`, never private types.

## How to use this plan

This plan is the **spec**; the per-version **Acceptance matrix** (see
[### v0.1.0 — Acceptance matrix](#v010--acceptance-matrix) and the
equivalent for v0.2.0 → v0.4.0 when they're added) is the executable
contract. The two together are what a new session implements
against, and what a verifier reads to confirm a release.

### Pre-flight checklist for the implementing session

Run through this before writing the first line of code for any
version. Each item is something a previous session got wrong; the
checklist is the discipline that would have caught the gap.

- [ ] **Each public API the package will use is listed in the plan's
      "Upstream APIs used" table** for the target version. If a
      function is called from the code but not in the table, the
      table is wrong (or the code is using a private surface) — fix
      one of them before proceeding.
- [ ] **For each public API, there is a smoke stage that exercises it
      (or an explicit deferral note).** The smoke test is the
      executable proof that the API is actually wired up. A smoke
      test that doesn't touch the API is a smoke test that wouldn't
      catch a missing call.
- [ ] **Each config field the package reads has a smoke stage covering
      the default, the "true" case, and the "false" case.** "It
      compiles" is not coverage; the test must assert the value
      matters.
- [ ] **Each bridge-owned config field (`voice.sendTranscript`,
      `voice.replyMode`) has a smoke stage for every reachable
      bridge-decoded combination.** `replyMode` has 3 modes
      (`hidden` / `mirror` / `always`) × 2 input mediums (voice /
      text) = 5 combinations, of which 3 reach the provider's
      prompt-contribution surface. Pin all 3.
- [ ] **The smoke stage count is at least equal to the plan's
      "Provider runtime flow" step count.** If the plan's runtime
      flow has 6 steps, the smoke test has ≥ 6 stages. A plan step
      with no smoke stage is a silent skip.
- [ ] **Every `Returns { ... }` line in the plan has a stage
      asserting every field's presence AND absence.** A test that
      only checks "field equals X" passes for both the correct
      implementation and a buggy one that always returns X. The
      absence case is what catches "always returns the wrong
      thing".
- [ ] **Each deferred feature has a one-line "Defer?" note in the
      Acceptance matrix** — the cell isn't blank, it says "v0.2.0"
      (or whichever) so the next session knows the gap is
      intentional, not forgotten.

These 7 items are the minimum. New versions may add more (e.g.,
v0.2.0 should add: "Section registration uses `ctx.callbackData()`,
not hand-rolled `section:` strings").

### When the implementing session is done

- Run the full smoke test (not just `--no-network`) and post the
  output in the PR description.
- Update the Acceptance matrix in the plan doc if any new stages
  were added or any deferrals were reprioritized.
- Update the Progress section's status row for the version.

## Progress

| Version | Status | Date | Notes |
| --- | --- | --- | --- |
| **v0.1.0** — `sendTranscript` works | ✅ **SHIPPED** | 2026-08-23 | Provider + module-load + session_start dual registration; unconfigured/disabled/invalid-provider fall through; `voice.sendTranscript` honored (provider consults `getTelegramVoiceSendTranscript` before including `transcriptText`); `getVoicePromptContribution` returns the hint for all 3 reachable replyMode × input-medium combos; live TTS round-trip verified end-to-end with MiniMax (`speech-2.8-hd` / `Cantonese_PlayfulMan` → 22-28 KB OGG/Opus). All 12 stages of `scripts/pi-telegram-tts-smoke-test.sh` green. |
| **v0.1.1** — Bridge callable contract (in-session fix) | ✅ **SHIPPED** | 2026-08-23 | Live test caught that bridge v0.36.11 requires `typeof provider === "function"`; v0.1.0 source shipped an object literal that satisfied TypeScript but failed the bridge's runtime gate (`outbound-voice.ts:235-244`). Fixed: `index.ts` wraps `synthesizeCall` (an async function) with `Object.assign(callable, { getVoicePromptContribution })` — the same pattern the bridge itself uses in `voice.ts:131-141`. Pinned by smoke stage 13. |
| **v0.1.2** — 4-package re-bump | ✅ **SHIPPED** | 2026-08-23 | No-content re-bump to (a) trigger the publish workflow to also publish the `pi-telegram-tts` step that the v0.20.0 workflow file change was missing, and (b) support the `echoEnabled → showTranscript` rename in `pi-telegram-stt@0.7.2` (see below). |
| **`pi-telegram-stt@0.7.2`** — `echoEnabled → showTranscript` rename | ✅ **SHIPPED** | 2026-08-23 | Naming symmetry with the bridge's `voice.sendTranscript`: `pi-telegram-stt.showTranscript` is the inbound direction (show the user's voice as a text message), `voice.sendTranscript` is the outbound direction (send the agent's voice as a caption). The reader accepts the old `echoEnabled` key as a fallback; the section UI's toggle writes the new key. |
| **Repo-wide consolidation** | ⏳ next | — | See `docs/CONSOLIDATION-PLAN.md` for the full plan. Reduces the active package count from 4 to 2 by (a) subsuming `pi-openai-stt` into `pi-telegram-stt` (in-code abstraction; the `SttProvider` interface stays), and (b) merging `pi-voice-telegram-scripts` into `pi-telegram-tts` (the `tts-{minimax,openai}` bins are exposed via the package's `bin` field). The 3 superseded packages are deprecated on npm. Target: `pi-telegram-stt@0.8.0` + `pi-telegram-tts@0.2.0`. |
| **v0.2.0** — Section UI | pending | — | Unblocked: `loadSynthConfig()` already reads on every call (live edit takes effect on next voice-tagged turn); only needs `saveSynthConfig` (atomic temp+rename, mirror `pi-telegram-stt/telegram-config.ts:71-96`) + `section.ts` mirroring `pi-telegram-stt/echo-section.ts:26-114`. |
| **v0.3.0** — Per-provider config schema | pending | — | No code in this session; `telegram-config.ts` is already structured to extend (sub-block overrides top-level). |
| **v0.4.0** — UI-driven config | pending | — | Depends on v0.2.0 + v0.3.0. |

### v0.1.0 actual file sizes vs. estimate

The design doc's §7 line estimates were a starting point. What shipped:

| File | Est. | Actual | Delta |
| --- | --- | --- | --- |
| `extensions/pi-telegram-tts/index.ts` | ~70 | 141 | +71 (comment header + version-history block mirroring `pi-telegram-stt/index.ts`; `getVoicePromptContribution`; belt-and-suspenders `recordTelegramRuntimeEvent` for unexpected throws outside the spawn block; `disabled` short-circuit) |
| `extensions/pi-telegram-tts/synth.ts` | ~70 | 213 | +143 (full doc comment block citing design-doc §6.3 + the line citations; `recordTelegramRuntimeEvent` invocation in catch; `setTimeout(rm, 60_000)` best-effort temp-dir cleanup; `telegramConfig` 4th param + `getTelegramVoiceSendTranscript` import + conditional `transcriptText` return per plan §v0.1.0 step 5-6) |
| `extensions/pi-telegram-tts/telegram-config.ts` | ~50 | 130 | +80 (header comment block; per-field type guards for `disabled` + `provider` + `voice` + `model`; `loadTelegramConfig()` reader for the full file, used by the `sendTranscript` decision) |
| `extensions/pi-telegram-tts/_logger.ts` | ~90 | 96 | +6 (verbatim copy of `pi-telegram-stt/_logger.ts`; only delta is the package name in the header comment) |
| `extensions/pi-telegram-tts/package.json` | ~35 | 42 | +7 (engines `node >=22.6.0`; full `repository` + `bugs` + `publishConfig` blocks matching the sister packages) |
| `extensions/pi-telegram-tts/README.md` | ~80 | 135 | +55 (3 migration options expanded into a numbered list with the "Recommended" call-out; "What's not in v0.1.0" enumeration; "Diagnostics" section) |
| **Total** | **~395** | **758** | **+363** (mostly comment/README density + the v0.1.0-step-5 `getTelegramVoiceSendTranscript` wiring that the original design was missing) |

### v0.1.0 verification (replayable)

The acceptance criteria from the v0.1.0 brief were all met; the verification recipe is automated in `scripts/pi-telegram-tts-smoke-test.sh`. The script's 12 stages map 1:1 to the brief:

| Stage | Surface | Assertion |
| --- | --- | --- |
| 1 | module-load registration | `globalThis.__piTelegramVoiceSynthesisProviders__` contains `'pi-telegram-tts/synth'` after `jiti('./index.ts')` |
| 2 | hot-reload safety | registry stays single-keyed after re-loading `index.ts` |
| 3 | unconfigured fall-through | no `telegram.json` → `provider(text, options)` returns `undefined` |
| 4 | disabled fall-through | `extensions["pi-telegram-tts"].disabled: true` → `provider(text, options)` returns `undefined` |
| 5 | type-guard fall-through | invalid `provider: "bogus"` → `provider(text, options)` returns `undefined` |
| 6 | live round-trip + sendTranscript: true | with `voice.sendTranscript: true`, `synthesizeOgg()` returns `{ audioPath, transcriptText: text }`; OGG is valid Opus/48kHz/mono (network) |
| 7 | sendTranscript: true (explicit) | live round-trip with `sendTranscript: true` → `result.transcriptText === input text` (network) |
| 8 | sendTranscript: false (explicit) | live round-trip with `sendTranscript: false` → `result.transcriptText === undefined` (network) |
| 9 | replyMode: hidden | `getVoicePromptContribution({})` returns `undefined` |
| 10 | replyMode: mirror + voice | `getVoicePromptContribution({ hasVoiceInput: true, voiceReplyPreferred: true, userText: "hi" })` returns the `[tts] Reply briefly; …` hint |
| 11 | replyMode: always + text | `getVoicePromptContribution({ hasVoiceInput: false, voiceReplyRequired: true, userText: "hi" })` returns the hint |
| 12 | replyMode: always + voice | `getVoicePromptContribution({ hasVoiceInput: true, voiceReplyPreferred: true, voiceReplyRequired: true, userText: "hi" })` returns the hint |
| 13 | bridge v0.36.11 callable contract | `typeof p === "function"` (passes `outbound-voice.ts:235`); `p(text, { lang, rate })` returns `undefined` when unconfigured; `getVoicePromptContribution` reachable as a property |

Stages 1-5 + 9-13 run in `--no-network` mode (≈5s, no API key needed). Stages 6-8 need network + a MiniMax or OpenAI key (≈10-20s with `--provider minimax`, depending on API latency).

Run: `bash scripts/pi-telegram-tts-smoke-test.sh` (full) or `bash scripts/pi-telegram-tts-smoke-test.sh --no-network` (CI / offline).

For the per-bullet contract (which plan section each stage covers,
and which v0.1.0 features are deferred to v0.2.0+), see
[### v0.1.0 — Acceptance matrix](#v010--acceptance-matrix).

### v0.1.0 deltas from the design doc

Three design deltas worth noting — two intentional, one a real gap that was caught and fixed in-session:

- **`recordTelegramRuntimeEvent` on unexpected throws** *(intentional)*. The design doc's §7.2 only calls `recordTelegramRuntimeEvent` in the `catch` block of `synthesizeOgg`. The shipped `index.ts` adds a second, outer `try/catch` around the `synthesizeOgg` call so a thrown error from an *unexpected* path (e.g. the load step itself) is also recorded. The bridge's diagnostic view stays consistent.
- **`disabled` short-circuit lives in `index.ts`, not `synth.ts`** *(intentional)*. The design doc puts the `disabled` check in the section-toggle discussion (v0.2.0), but the field is already in the v0.1.0 config schema (so a future section can flip it without a schema change). The provider checks `cfg.disabled` before calling `synthesizeOgg` so a section toggle takes effect on the next voice-tagged turn with zero reload.
- **`getTelegramVoiceSendTranscript` was missing from the first cut** *(gap, fixed)*. The plan §v0.1.0 step 5-6 specifies that `synthesizeOgg` should call `getTelegramVoiceSendTranscript(telegramConfig)` and only include `transcriptText` when the flag is true. The first v0.1.0 cut (commit on 2026-08-23 morning) omitted this — `synth.ts` always returned `transcriptText: text`, so even with `voice.sendTranscript: false` the bridge would still attach a caption. The fix landed the same day: `synth.ts` now accepts a 4th `telegramConfig` parameter, imports `getTelegramVoiceSendTranscript`, and conditionally returns `{ audioPath, transcriptText: text }` vs `{ audioPath }`. `telegram-config.ts` gained `loadTelegramConfig()` to read the full `telegram.json`. `index.ts` reads it in the provider closure and passes it through. The 6-stage smoke test grew to 12 stages to pin the contract on both directions (true → present, false → undefined) and on all 3 replyMode × hasVoiceInput combinations for `getVoicePromptContribution`. The fix is covered by stages 7 + 8 of `scripts/pi-telegram-tts-smoke-test.sh`.

None of the three deltas change the public surface; all three are safe for v0.2.0 to keep.

## Why a separate package

The bridge's outbound TTS pipeline has three sub-paths
(`lib/outbound-voice.ts:185-276`), in priority order:

1. `outboundHandlers[0].template` (string-in, file-out) — what the
   operator uses today
2. Programmatic voice handlers (return `string` only — no
   `transcriptText`)
3. **Synthesis providers** (return `{ audioPath, transcriptText? }`) —
   the only path that supports `voice.sendTranscript`

The operator's current `telegram.json#outboundHandlers[0].template`
uses path 1. Path 1 **silently drops** the transcript when
`voice.sendTranscript: true` because it returns only a file path. This
is a known limitation, explicitly documented in
`archive/docs/MINIMAX-T2A-FINDINGS.md:72-87` as *"sendTranscript is
effectively dead config."*

Closing the gap requires a synthesis provider (path 3). The provider
**shells out to the same `tts-minimax.mjs` / `tts-openai.mjs` scripts** the
template already uses, so we keep the v0.19.0 simplicity (no in-process
HTTP client, no native deps, no new abstraction layer) and only add the
provider registration seam.

## Phased roadmap

| Version | Theme | New upstream surface | User-visible delta |
|---|---|---|---|
| **v0.1.0** | `sendTranscript` works | `registerTelegramVoiceSynthesisProvider` | Voice captions re-appear |
| **v0.2.0** | Section UI | `registerTelegramSection` | Provider visible in `/telegram-settings` |
| **v0.3.0** | Per-provider config schema | (telegram.json expansion; no new bridge API) | Every CLI arg reachable from config |
| **v0.4.0** | UI-driven config | Section grows; same APIs as v0.2.0 | Voice/model editable from Telegram |

Versions v0.1.0 → v0.4.0 are sequential. Each version is independently
useful and shippable. The provider is the only piece that **must** land
first; everything else is UX.

---

### v0.1.0 — Solve the `sendTranscript` gap *(immediate deliverable)* ✅ SHIPPED 2026-08-23

**Files (4 source + 2 meta):**

**Files (4 source + 2 meta):**

| File | Purpose | Lines (est.) |
|---|---|---|
| `extensions/pi-telegram-tts/index.ts` | default export, module-load + `session_start` provider registration, disposer hygiene | ~70 |
| `extensions/pi-telegram-tts/synth.ts` | spawn `tts-*.mjs` + `ffmpeg MP3→OGG`, return `{ audioPath, transcriptText? }` | ~70 |
| `extensions/pi-telegram-tts/telegram-config.ts` | read `extensions["pi-telegram-tts"]` from `telegram.json` (fall through if unset) | ~50 |
| `extensions/pi-telegram-tts/_logger.ts` | per-package stderr logger (copy from `pi-telegram-stt/_logger.ts`) | ~90 |
| `extensions/pi-telegram-tts/package.json` | peer deps + `pi.extensions` | ~35 |
| `extensions/pi-telegram-tts/README.md` | install + config + migration from template | ~80 |

**Config shape (v0.1.0 minimal — top-level only):**

```json
"extensions": {
  "pi-telegram-tts": {
    "provider": "minimax",
    "voice": "Cantonese_PlayfulMan",
    "model": "speech-2.8-hd"
  }
}
```

The three fields are the operator's current template args, lifted into
config so the provider and the template can converge. If
`extensions["pi-telegram-tts"]` is absent, the provider returns
`undefined` → the bridge falls through to `outboundHandlers[0].template`
(no behavior change for unconfigured installations).

**Provider runtime flow:**

1. `loadTelegramConfig()` → `extensions["pi-telegram-tts"]`. If no
   `provider` field → return `undefined`.
2. Spawn `node tts-${provider}.mjs --out <tmp>/<uuid>.mp3` with the
   agent's reply text on **stdin** (not argv) and
   `--voice <cfg.voice> --model <cfg.model>`. Text via stdin avoids
   shell-escaping the LLM's reply, which may contain newlines, quotes,
   or other metacharacters; both `tts-minimax.mjs` and `tts-openai.mjs`
   already read from stdin when `--text` is absent
   (`tts-openai.mjs:260-266`).
3. Spawn `ffmpeg -y -i <mp3> -c:a libopus -b:a 32k -ar 48000 -ac 1
   -application voip -vbr on -compression_level 10 -f ogg
   <tmp>/<uuid>.ogg`. The OGG is what the bridge uploads.
4. Unlink the intermediate MP3.
5. Call `getTelegramVoiceSendTranscript(telegramConfig)` from
   `@llblab/pi-telegram/voice` to read the bridge-owned
   `voice.sendTranscript` flag.
6. Return `{ audioPath: <ogg>, transcriptText?: <text> }` accordingly.

**Upstream APIs used (v0.1.0):**

| API | Source | Role |
|---|---|---|
| `registerTelegramVoiceSynthesisProvider` | `@llblab/pi-telegram/voice` | the seam we're plugging into |
| `getTelegramVoiceSendTranscript` | `@llblab/pi-telegram/voice` | the bridge-owned transcript preference |
| `getAgentDir` | `@earendil-works/pi-coding-agent` | path resolution (consistent with `pi-telegram-stt`) |
| `ExtensionAPI` (factory shape, `pi.on("session_start" / "session_shutdown")`) | `@earendil-works/pi-coding-agent` | extension lifecycle |
| `recordTelegramRuntimeEvent` | `@llblab/pi-telegram/outbound` | diagnostics on spawn failures |

**Module-load safety:** `registerTelegramVoiceSynthesisProvider(...)` at
the top level of `index.ts` (synchronous side effect during jiti load)
**and** idempotent re-register on `session_start`. Disposer from the
session_start call is pushed onto the disposers array; the module-load
registration lives for the process lifetime. Same pattern as
`pi-openai-stt/index.ts:96-110` and `pi-telegram-stt/index.ts:237-248`.

**Verification (v0.1.0 acceptance):**

- `jiti` load test: `index.ts` loads, `transcribeAndMaybeEcho`-equivalent
  function exports, `synth.ts` exports `synthesizeOgg`.
- Live TTS round-trip: `tts-minimax.mjs` + `ffmpeg` produces a valid OGG
  in a temp dir; `unlink` removes the MP3.
- Path-resolution equivalence: `getAgentDir()` returns the same value as
  the hand-rolled `process.env.PI_CODING_AGENT_DIR ?? ~/.pi/agent` (the
  pattern `pi-telegram-stt/telegram-config.ts:40` and our own
  `pi-openai-stt/openai-stt.ts:148-191` use).
- Operator smoke: with the provider configured, the agent's voice
  reply carries the transcript as the Telegram caption.

The full per-bullet contract is in
[### v0.1.0 — Acceptance matrix](#v010--acceptance-matrix) below.
The 4 bullets here are the historical short-list; the matrix is the
executable spec.

### v0.1.0 — Acceptance matrix

The v0.1.0 contract. **Each row maps a plan bullet to a smoke stage
in `scripts/pi-telegram-tts-smoke-test.sh` (or an explicit deferral
note).** A blank "Defer?" cell is a bug — the cell must say either
"covered" with a stage number, or a future version. The matrix is
the spec; the smoke test is the proof.

| Plan reference | What it requires | Smoke stage | Defer? |
| --- | --- | --- | --- |
| §v0.1.0 "Files" | `extensions/pi-telegram-tts/{index,synth,telegram-config,_logger}.ts` + `package.json` + `README.md` exist | (file existence, not a smoke stage) | covered |
| §v0.1.0 step 1 (`Provider runtime flow`) | `loadSynthConfig()` reads `extensions["pi-telegram-tts"]`; absent → `undefined` | stage 3 (unconfigured) | covered |
| §v0.1.0 step 1 | absent `provider` field → `undefined` | stage 5 (invalid provider) | covered |
| §v0.1.0 step 1 | `disabled: true` → `undefined` | stage 4 | covered |
| §v0.1.0 step 2 | spawn `node tts-${provider}.mjs --out ...` with text on stdin | stage 6 (live round-trip) | covered |
| §v0.1.0 step 2 | `--voice` and `--model` passed from cfg | stage 6 | covered |
| §v0.1.0 step 3 | spawn `ffmpeg` MP3→OGG/Opus (libopus, 48kHz, mono, 32k, voip, vbr, comp 10) | stage 6 (file type check) | covered |
| §v0.1.0 step 4 | unlink intermediate MP3 | (synth.ts:166-168 `unlink(mp3).catch(() => {})`) | covered |
| §v0.1.0 step 5 | call `getTelegramVoiceSendTranscript(telegramConfig)` | stage 7 (true → included) + stage 8 (false → undefined) | covered |
| §v0.1.0 step 6 | return `{ audioPath }` when flag is false | stage 8 | covered |
| §v0.1.0 step 6 | return `{ audioPath, transcriptText: text }` when flag is true | stage 6 + 7 | covered |
| §v0.1.0 "Module-load safety" | top-level `registerTelegramVoiceSynthesisProvider` at module load | stage 1 (jiti load → registry has the id) | covered |
| §v0.1.0 "Module-load safety" | idempotent re-register on `session_start` | stage 2 (registry stays single-keyed after re-load) | covered |
| §v0.1.0 "Module-load safety" | module-load registration lives for process lifetime, not session | (implicit — `index.ts:139-141` doesn't push module-load disposer) | covered |
| Bridge v0.36.11 contract (`outbound-voice.ts:235-244`) | registered provider is **callable** (`typeof provider === "function"`); not a plain object | stage 13 (typeof check + call shape + `getVoicePromptContribution` still reachable) | covered |
| §6.1 (design doc) `disabled` short-circuit lives in `index.ts` | section toggle takes effect without reload | stage 4 (disabled → undefined without reload) | covered |
| §6.1 (design doc) | provider doesn't add a `pi-telegram-tts`-specific setting for `sendTranscript`; just reads the bridge-owned flag | (implicit — `telegram-config.ts` doesn't have a `sendTranscript` field) | covered |
| §3 (design doc) "transcript is the input" | `transcriptText` is the input text, not a STT roundtrip | stage 7 (`result.transcriptText === text`) | covered |
| §6.3 (design doc) spawn via absolute path on dev, by name when npm-installed | both resolution strategies work | (synth.ts `resolveScriptPath()` — manual code review; no separate test) | covered (deferred to v0.5.0) |
| "Upstream APIs used" | `registerTelegramVoiceSynthesisProvider` called with stable id `pi-telegram-tts/synth` | stage 1 (registry key) | covered |
| "Upstream APIs used" | `getTelegramVoiceSendTranscript` consulted per call (not at registration) | stages 7 + 8 (per-call config) | covered |
| "Upstream APIs used" | `getAgentDir()` honored (same single source of truth as sister packages) | (implicit — `telegram-config.ts:69` uses `getAgentDir()`) | covered |
| "Upstream APIs used" | `ExtensionAPI` factory shape (`pi.on("session_start" / "session_shutdown")`) | stage 1 (default export wires both) | covered |
| "Upstream APIs used" | `recordTelegramRuntimeEvent` on spawn failures | (manual — `synth.ts:196`; no in-process test) | covered |
| `getVoicePromptContribution(view)` | returns the `[tts] Reply briefly; …` hint for voice-tagged turns | stages 10 (mirror+voice), 11 (always+text), 12 (always+voice) | covered |
| `getVoicePromptContribution(view)` | returns `undefined` when neither `voiceReplyRequired` nor `hasVoiceInput` is true | stage 9 (hidden) | covered |
| Section UI (`/telegram-settings`) | main menu row + settings submenu | — | **v0.2.0** |
| Per-provider config schema (`minimax` / `openai` sub-blocks) | every CLI arg reachable from `telegram.json` | — | **v0.3.0** |
| UI-driven config (form-based edit) | voice / model editable from Telegram | — | **v0.4.0** |
| Temp-file cleanup | `setTimeout(unlink(ogg), 30_000)` scheduled after bridge's `uploadVoiceFile` | — | **v0.5.0** |
| In-Telegram commands (`/tts_status`, `/tts_test`) | diagnostic surface | — | **v0.5.0** |
| Status line | row in `/start` menu's compact status | — | **v0.5.0** |
| Pre-existing migration friction | `outboundHandlers[0].template` still works (opt-in semantics) | (verified by leaving the operator's existing config untouched — `stage 3` covers the unconfigured path) | covered |

**Gap this matrix would have caught:** the original 6-stage smoke had
no row for §v0.1.0 step 5 (`getTelegramVoiceSendTranscript`). The
matrix is a row-per-bullet table; a missing row is visible at
write-time, not after the user notices. As of the in-session fix
(see "v0.1.0 deltas from the design doc" in `## Progress`), stages
7 + 8 cover steps 5-6.

A second gap was caught by the v0.1.0 **live test on 2026-08-23**:
the matrix had no row for the bridge v0.36.11 runtime contract that
the registered provider must be a *callable function*, not an object
(`@llblab/pi-telegram/voice:58-67` +
`outbound-voice.ts:235-244`). The shipped v0.1.0 source registered an
object literal `{ id, synthesize, getVoicePromptContribution }`,
which TypeScript accepted but the bridge rejected at runtime with
"Registered voice synthesis provider is not callable (policy-only
object?)". The fix landed the same day: `index.ts` now wraps
`synthesizeCall` (an `async` function) with `Object.assign(callable,
{ getVoicePromptContribution })` — the same pattern the bridge uses
internally in `voice.ts:131-141`. Stage 13 pins the fix.

---

### v0.2.0 — Section UI

**Goal:** the provider shows up in `/telegram-settings` with a clear
on/off indicator. The operator can disable the provider without
uninstalling the package (sets a `disabled: true` flag in config; the
provider returns `undefined` when set, falling through to the template).

**Files added:**

- `extensions/pi-telegram-tts/section.ts` — `registerTelegramSection(...)`
  with main menu + settings submenu. Shape mirrors
  `pi-telegram-stt/echo-section.ts:26-114`.

**Section shape:**

- **Main menu row**: `🎙️ TTS provider` (order 10) with dynamic
  `getLabel()` showing the active provider and on/off status
  (e.g., `🟢 TTS · minimax` or `⚫️ TTS · off`).
- **Settings submenu**: shows the current provider, the current
  `voice.sendTranscript` (read-only reminder, points the operator to
  the pi-telegram settings location), an enable/disable toggle.
- **Back navigation**: handled by the bridge automatically (per
  `docs/sections.md` §8). The section's `ctx.edit()` re-renders the
  current view; `ctx.open()` sends a fresh message.

**Upstream APIs added:**

| API | Source | Role |
|---|---|---|
| `registerTelegramSection` | `@llblab/pi-telegram/sections` | main menu + settings |
| `TelegramSectionContext` | (same) | `render` + `settings.open` ports |
| `ctx.callbackData(action, payload?)` | (same) | namespaced callback tokens (never hand-roll `section:` strings) |
| `ctx.edit` / `ctx.answerCallback` | (same) | re-render + popup |

**No new config fields.** The section is a thin view over the v0.1.0
config (`provider`, `voice`, `model`) plus the bridge-owned
`voice.sendTranscript`.

---

### v0.3.0 — Per-provider speech parameters in `telegram.json`

**Goal:** every CLI arg the script supports is reachable via
`telegram.json` config. Operators can pin `lang`, `speed`, `instructions`,
`response_format`, `output_format`, etc. without editing the template.

**Config shape (v0.3.0 — per-provider sub-blocks):**

```json
"extensions": {
  "pi-telegram-tts": {
    "provider": "minimax",
    "minimax": {
      "voice": "Cantonese_PlayfulMan",
      "model": "speech-2.8-hd",
      "lang": "Chinese,Yue",
      "speed": 1.0,
      "output_format": "mp3"
    },
    "openai": {
      "voice": "coral",
      "model": "gpt-4o-mini-tts",
      "instructions": "Speak in Cantonese.",
      "speed": 1.0,
      "response_format": "mp3"
    }
  }
}
```

**Backward compat:** v0.1.0's top-level `voice` + `model` continue to
work as a fallback when the per-provider sub-block is absent. The
`loadTelegramConfig()` reader applies: sub-block overrides top-level
when both are present. Live edits take effect on the next
voice-tagged turn (the provider reads config on every call, not at
registration time — same pattern as `pi-telegram-stt/echo-handler.ts:142-235`).

**`synth.ts` changes:** dispatch to the per-provider sub-block; build
the full `--voice X --model Y [--lang Z] [--speed W] [--instructions
"…"] …` CLI arg list. Each script's existing `validateField` already
checks the right set of values per provider
(`tts-openai.mjs:241-247` validates `model`, `voice`, `response_format`,
`speed`; `tts-minimax.mjs` validates its own schema).

**No new upstream APIs.** Pure config-schema expansion.

---

### v0.4.0 — UI-driven speech parameters

**Goal:** the operator can change voice / model / instructions / speed
/ etc. from the Telegram UI, no `telegram.json` editing required.

**Section growth (v0.2.0 → v0.4.0):**

- Settings submenu gains **per-provider sub-views**. Each sub-view
  renders the form fields for that provider (voice list, model list,
  speed, instructions, etc.).
- **Save** button writes the form to
  `telegram.json#extensions["pi-telegram-tts"]` via atomic write
  (temp file + rename, same pattern as
  `pi-telegram-stt/telegram-config.ts:71-96`'s `saveEchoConfig`).
- The form is generated from a small **per-provider schema** in
  `ui-schema.ts`. Adding a field = adding it to the schema, not to
  the section code.

**Voice / model lists:** hardcoded in v0.4.0 (small, finite sets from
the script's enums). Future versions could load from the TTS provider's
API at boot or on first use, but that's deferred — the value is small
relative to the API-call complexity.

**Upstream APIs used (v0.4.0 = v0.2.0 + section growth):**

| API | Source | Role |
|---|---|---|
| `registerTelegramSection` | `@llblab/pi-telegram/sections` | main menu + settings + per-provider sub-views |
| `ctx.edit` | (same) | re-render after save |
| `ctx.answerCallback` | (same) | save confirmation |
| `ctx.callbackData` | (same) | namespaced callbacks for save/cancel/field-change |

**No new bridge APIs needed.** The section grows; the config schema
and the script invocation are already in place from v0.3.0.

---

## Future expansion (upstream surface inventory)

These are deliberately deferred but **the API is already in v0.1.0's
peer-dep closure**, so adding any of them later is a single-package
change, not a public-API change. The user explicitly noted *"we can
use all the surface/API upstream provides for future expansion"* —
this is the inventory.

| Upstream API | Subpath | What it would enable | Candidate version |
|---|---|---|---|
| `registerTelegramCommand` | `@llblab/pi-telegram/commands` | `/tts_status` (visible, with emoji) and `/tts_test "hello"` (hidden) for in-Telegram smoke tests | v0.5.0 |
| `registerTelegramStatusLineProvider` | `@llblab/pi-telegram/status` | A row in the `/start` menu's compact status (e.g., `🎙️ TTS: minimax / Cantonese_PlayfulMan`) | v0.5.0 |
| `sendTelegramView` | `@llblab/pi-telegram/delivery` | "🎙️ Synthesizing Cantonese…" preview message while the script runs (better UX on slow networks) | v0.5.0 |
| `editTelegramView` | `@llblab/pi-telegram/delivery` | Edit the preview when synthesis finishes (`✅ sent voice`) | v0.5.0 |
| `deleteTelegramView` | `@llblab/pi-telegram/delivery` | Delete the preview on TTS failure | v0.5.0 |
| `registerTelegramActivityHandler` | `@llblab/pi-telegram/activity` | Observe `agent_end` → voice delivery; surface in `/telegram-status` diagnostics alongside the existing `recordTelegramRuntimeEvent` calls | v0.6.0 |
| `registerTelegramInboundHandler` | `@llblab/pi-telegram/inbound` | (Probably not needed; STT is `pi-telegram-stt`'s job) | n/a |
| `registerTelegramUpdateHandler` | `@llblab/pi-telegram/updates` | (Probably not needed; chat-ID stashing is `pi-telegram-stt`'s job) | n/a |
| `recordTelegramRuntimeEvent` | `@llblab/pi-telegram/outbound` | Already used in v0.1.0 for spawn failures | ✅ v0.1.0 |

**v0.1.0 does not hard-block any of these.** Adding a command, a status
line, or a delivery preview in v0.5.0 is a single-file addition to the
package — the bridge APIs and types are already there.

## Open questions deferred

These are real but not blocking v0.1.0.

1. **Concurrency.** Multiple voice-tagged turns in flight spawn
   concurrent TTS scripts. v0.1.0 lets them race — each call is its own
   child process + temp file. If contention is observed, a small
   in-process queue is enough. v0.1.0 has no queue.

2. **Temp file cleanup.** The bridge's `lib/outbound-voice.ts:271-275`
   cleans up the provider's file only if the provider's result was a
   different file than the input; we return a fresh OGG, so the bridge
   does not clean it up. v0.1.0 has no cleanup — temp files linger in
   `<tmp>/`. A `setTimeout(unlink, 30s)` scheduled after the bridge's
   `uploadVoiceFile` is the standard fix; defer to v0.5.0.

3. **Schema versioning.** v0.3.0's per-provider sub-blocks introduce a
   versioned config. Declare `"version": 1` and migrate in
   `loadTelegramConfig()`. Defer to v0.3.0.

4. **Per-profile config.** pi-telegram has profile-scoped config
   (`profiles.<name>.extensions`). Whether `pi-telegram-tts` should
   support per-profile provider choice is an open question; v0.1.0's
   reader is global. Defer until there's a concrete operator need.

5. **Pre-existing migration friction.** The operator's current
   `telegram.json#outboundHandlers[0].template` continues to work in
   v0.1.0+ — the provider is a third-tier fallback in
   `lib/outbound-voice.ts:185-276`. To actually get the
   `sendTranscript: true` behavior, the operator clears the
   `outboundHandlers[0]` entry (so the provider is the sole TTS path)
   or sets a `disabled: true` flag (deferred to v0.2.0). The README
   in v0.1.0 will document the migration.

## File structure (final, after v0.4.0)

```
extensions/pi-telegram-tts/
├── index.ts                 # default export, lifecycle, provider registration
├── synth.ts                 # spawn tts-*.mjs + ffmpeg, return { audioPath, transcriptText? }
├── telegram-config.ts       # read/write extensions["pi-telegram-tts"]
├── section.ts               # registerTelegramSection (main menu + settings + per-provider sub-views)
├── ui-schema.ts             # per-provider form schema (drives the section's settings in v0.4.0)
├── _logger.ts               # stderr logger (per-package self-containment)
├── package.json             # peer deps + pi.extensions
└── README.md                # install + config + migration + provider-arg reference
```

v0.1.0 ships the first 4 files (no `section.ts`, no `ui-schema.ts`).
v0.2.0 adds `section.ts`. v0.4.0 adds `ui-schema.ts`.

## Related docs

- [`docs/PI-TELEGRAM-TTS-DESIGN.md`](./PI-TELEGRAM-TTS-DESIGN.md) —
  the design rationale and implementation context. **Read this when
  starting v0.1.0.** Captures the 3 pipeline paths, the 4 demo
  patterns to copy, the 3 demo patterns that don't apply, the
  implementation sketch, the migration story, the gotchas.
- `docs/UPSTREAM-API-COMPLIANCE.md` — the audit doc this plan extends;
  v0.1.0 will be added to its `Findings` table when shipped.
- `archive/docs/MINIMAX-T2A-FINDINGS.md:72-87` — the documented
  "sendTranscript is dead config" finding that motivates v0.1.0.
- `@llblab/pi-telegram/docs/voice.md` — the bridge's voice integration
  contract (the seam we plug into).
- `@llblab/pi-telegram/api/voice.ts` — the public symbol surface
  (`registerTelegramVoiceSynthesisProvider`,
  `getTelegramVoiceSendTranscript`, …).
- `@llblab/pi-telegram-extension-demo` (`github.com/llblab/pi-telegram-extension-demo`)
  — the pattern reference for section + command + UI patterns.
- `extensions/pi-telegram-stt/` — the sister package we mirror
  (package shape, lifecycle, section UI shape).
- `extensions/pi-openai-stt/index.ts:96-110` — the module-load
  registration pattern.
- `extensions/pi-telegram-stt/telegram-config.ts:71-96` — the atomic
  config write pattern (`saveEchoConfig`).
