# `pi-telegram-tts` — Build Plan

A new sister extension package that grows the TTS story for
`@llblab/pi-telegram`. v0.1.0 closed the documented `sendTranscript`
gap; v0.4.0 cleans up after upstream removed that gap by removing
the whole `voice.sendTranscript` feature in v0.38.0.

> **Upstream v0.38.0 — the gap is gone, by removal.** On 2026-08-24
> the operator updated `@llblab/pi-telegram` to v0.39.1. The bridge's
> v0.38.0 changelog (line "Coherent Voice Reply Policy") removed the
> `voice.sendTranscript` config + the
> `getTelegramVoiceSendTranscript()` helper + the provider-returned
> `transcriptText` field. Synthesis providers now return only the OGG
> path; "text + voice" is the agent's explicit composition, not an
> automatic policy. Our v0.1.0/v0.2.0/v0.3.0 work targeted the now-
> deleted feature, so the v0.4.0 work is the migration: drop the
> imports, change the return type, drop the smoke stages that tested
> the now-obsolete field, and document the new upstream contract.

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
| **`pi-telegram-stt@0.8.0`** — subsume `pi-openai-stt` (Phase 2) | ✅ **SHIPPED** | 2026-08-23 | The OpenAI-compatible STT provider (in-process client + registry registration) is now bundled inside `pi-telegram-stt`. The `SttProvider` interface stays as a private in-package seam for future backends. The `base_url` / `apiKey` config fields move from a separate `extensions["pi-openai-stt"]` block to top-level keys under `extensions["pi-telegram-stt"]` (with a read-only legacy fallback). All 6 stages of the new `scripts/pi-telegram-stt-smoke-test.sh` green. The `pi-openai-stt` npm package is deprecated (via the npm web UI). |
| **Repo-wide consolidation** | ✅ **SHIPPED** | 2026-08-23 | See `docs/CONSOLIDATION-PLAN.md` for the full plan. Phase 2 done (`pi-telegram-stt@0.8.0` subsumes `pi-openai-stt`). Phase 3 done (`pi-telegram-tts@0.2.0` subsumes `pi-voice-telegram-scripts`). After both phases, the active package count is 2 (`pi-telegram-stt@0.8.0` + `pi-telegram-tts@0.2.0`); the 3 superseded packages (`pi-voice-telegram`, `pi-openai-stt`, `pi-voice-telegram-scripts`) are deprecated on npm via the web UI. |
| **v0.21.0 changelog** — Phase 1 (deprecate `pi-voice-telegram@0.16.12`) | ✅ **SHIPPED** | 2026-08-23 | Pure deprecation change. Applied via the npm web UI's "Deprecate package" button (the `npm deprecate` CLI auth paths are all blocked: OIDC only covers `npm publish`; GAT requires interactive 2FA; no local `npm login`). Documented gap: deprecation message is npm's default, not the Appendix B custom text. |
| **v0.22.0 changelog** — Phase 2 (subsume `pi-openai-stt` into `pi-telegram-stt@0.8.0`) | ✅ **SHIPPED** | 2026-08-23 | The OpenAI-compatible STT provider (in-process client + module-load registry registration) is now bundled inside `pi-telegram-stt`. `EchoConfig` gains `base_url` / `apiKey` (v0.8.0 flat shape); legacy `extensions["pi-openai-stt"]` block still read for back-compat. New `scripts/pi-telegram-stt-smoke-test.sh` (6 stages) added; all green. `pi-telegram-stt@0.8.0` published to npm; `pi-openai-stt@0.3.2` deprecated via the web UI. |
| **v0.23.0 changelog** — Phase 3 (merge `pi-voice-telegram-scripts` into `pi-telegram-tts@0.2.0`) | ✅ **SHIPPED** | 2026-08-23 | The `tts-minimax.mjs` / `tts-openai.mjs` scripts are now bundled inside `pi-telegram-tts`. The package's `bin` field exposes both on PATH after `npm install`. `fw-openai-sts.ts` is dropped (replaced by the system service). `extensions/pi-voice-telegram-scripts/` deleted. `pi-telegram-tts@0.2.0` published to npm; `pi-voice-telegram-scripts@0.1.2` deprecated via the web UI. New smoke stage 14 verifies the bundled scripts + bin field. |
| **v0.3.0** — Per-provider sub-block config (`minimax: {…}` / `openai: {…}`) | ✅ **SHIPPED** | 2026-08-24 | Every CLI arg the bundled `tts-*.mjs` scripts accept is now reachable from `telegram.json` via the per-provider sub-block. `synth.ts` writes the sub-block to a tempfile in the same dir as the OGG and passes `--config <path>` to the script; the script's own deep-merge (`DEFAULTS ← --config ← CLI`) takes care of the rest. **3 in-session hotfixes were required**: (1) the script's `--config` is a raw body deep-merge and doesn't run the `CLI_TO_PATH` remap, so a small per-script block runs the remap after the deep-merge; (2) the `CLI_TO_PATH` constant had to be declared above the `--config` block in `tts-openai.mjs` to avoid a TDZ error; (3) `POSITIVE_FLAGS` / `NEGATIVE_FLAGS` (booleans like `force_cbr`, `aigc_watermark`) needed the same remap. The `schema.json` (Draft 2020-12, `additionalProperties: false`) is shipped with the package for editor validation — it pins the 26 MiniMax fields + 5 OpenAI fields including enums (`emotion`, `sound_effects`, `format`, `sample_rate`, `bitrate`, `output_format`, `response_format`), ranges (`speed`, `vol`, `pitch`, `channel`), and pattern constraints (`pronunciation_dict.tone` requires slash-separated `word/pronunciation`). All 31 stages of `scripts/pi-telegram-tts-smoke-test.sh` green (was 14 + 11 sub-block stages = 25; +6 v0.2.0 stages = 31). Live-tested on the on-host agent: baseline voice + 3 new knob tests (emotion-happy, speed-1.5, openai-coral switch) + an all-knobs regression (24 fields) + a phase-2 minimal-knobs (7 fields, the regression revealed 4 beep tones from a dummy `pronunciation_dict.tone` value — fixed by dropping the dummy data). |
| **Upstream v0.39.0** — `voice.sendTranscript` removed | ✅ **APPLIED** | 2026-08-24 | The bridge removed the `voice.sendTranscript` config + `getTelegramVoiceSendTranscript()` helper + provider-returned `transcriptText` field (changelog line "Coherent Voice Reply Policy"). The original issue #235 framing ("add a UI toggle") is moot — the upstream's answer was "this whole concept is redundant; remove it." On-host `pi` upgraded; tts extension would have failed to load (synth.ts imports `getTelegramVoiceSendTranscript`). See the v0.4.0 row below for the migration. |
| **v0.4.0** — Migrate to upstream v0.39.0 + add form-driven UI | ✅ **SHIPPED** | 2026-08-24 | (1) `synth.ts` dropped the `getTelegramVoiceSendTranscript` import + the 4th `telegramConfig` parameter; `synthesizeOgg` now returns `string \| undefined` (just the OGG path) instead of `{ audioPath, transcriptText? }`. (2) `index.ts` dropped the import; `synthesizeCall` returns the result of `synthesizeOgg` directly. (3) `telegram-config.ts` no longer needs `loadTelegramConfig` (the helper that read the full `telegram.json` for the `sendTranscript` decision) — but the export was kept in v0.4.0 for the section's read-only display of `voice.replyMode`. (The section was then dropped in v0.6.0, so `loadTelegramConfig` was also dropped; see the v0.6.0 row below.) (4) `scripts/pi-telegram-tts-smoke-test.sh`: dropped stages 7 (transcript-included) + 8 (transcript-suppressed); renumbered the remaining 29 stages; updated the file header to document the removal. (5) `README.md`: replaced the v0.1.0 "sendTranscript closes the gap" framing with the v0.2.0 "section UI + bundled scripts" framing + an "Upstream note" documenting the v0.39.0 removal. All 29/29 smoke stages green. (6) `section.ts`: the `voice.sendTranscript` reminder row was planned for v0.2.0 but was never added (the plan's "read-only reminder" pattern was aspirational); no removal needed. **And the v0.4.0 form-driven UI** is in the §v0.4.0 section below (later dropped — see "Section UI removed" row below). |
| **v0.4.0 stage 1** — `composeWithText: "auto"` brings back text+voice via `sendTelegramView` + `active-turn` scope | ✅ **SHIPPED** | 2026-08-24 | The v0.1.0 "voice with caption" UX is no longer achievable via the public upstream API (the caption path was removed in v0.38.0; the public `sendTelegramView` is text-only). The closest achievable UX is **text first, then voice as two adjacent messages** — what the upstream's "explicit agent composition" pattern recommends. (1) `telegram-config.ts` adds `composeWithText?: "off" \| "auto"` to `SynthConfig`; the reader type-guards it (`auto` / `off` are accepted, anything else falls back to `undefined` = treated as `off`). (2) `index.ts` sends the text via `sendTelegramView({ text, parseMode: "html" }, { scope: { kind: "active-turn" } })` just before returning the OGG path, only when `composeWithText === "auto"` and the text is non-empty. Best-effort: a `sendTelegramView` failure is logged + recorded as a runtime event, and the voice is still delivered. (3) `schema.json` adds the field with `enum: ["off", "auto"]` and `default: "off"`. (4) **Stage 2 (the form-driven UI for `composeWithText` + the other v0.3.0 fields) was later dropped** when the section UI was removed (see the "Section UI removed" row below). The `composeWithText` field is now edited by the operator/agent directly in `telegram.json`; the 200ms hot-reload watcher picks up the change on the next voice-tagged turn. (5) Smoke stages 30 + 31 (read round-trip + bad-value guard) — these were dropped in v0.4.0's upstream-migration commit because the upstream-migration removed both the `voice.sendTranscript` config and the `transcriptText` field on the provider return. The remaining 29 stages were renumbered to the 16 stages that ran in the section-UI-removal commit. All 16/16 smoke stages green. **Live test done** (operator confirmed text+voice delivery on 2026-08-24 23:25 EDT). |
| **Section UI removed** (per operator request 2026-08-24) | ✅ **DROPPED** | 2026-08-24 | The v0.2.0 `/telegram-settings` section (and the v0.4.0 stage 2 form-driven UI plan) were **dropped on 2026-08-24** at the operator's request — "drop the UI for tts completely". The form-driven UI was more trouble than the `telegram.json`-driven config. (1) `extensions/pi-telegram-tts/section.ts` deleted. (2) `index.ts` removed the section import + `piTelegramTtsSection(pi)` call + the `startConfigWatcher` (the watcher was a no-op for the stateless provider; deleted as part of the cleanup). (3) `telegram-config.ts` still kept `saveSynthConfig` + `loadTelegramConfig` at this point (used by the smoke test + the section's read-only display); both were dropped in v0.6.0 per the operator's design rule (see the v0.6.0 row below). (4) `scripts/pi-telegram-tts-smoke-test.sh` rebuilt to **16 stages** (was 31): 1-5 module-load + fall-throughs, 6 live round-trip (network), 7-10 `getVoicePromptContribution` × 4 shapes, 11 bridge callable contract, 12 bundled scripts, 13-15 v0.3.0 sub-block tests, 16 "no Section UI" regression test. All 16/16 tts + 13/13 stt smoke stages green. (5) `extensions/pi-telegram-tts/README.md` updated to drop the section-UI section + the migration section that referenced it. (6) `docs/STT-PACKAGE.md` (the sister) still has the section file (the operator only dropped the TTS section; the STT section was also dropped in v0.10.0). The "future work" section in the tts plan is now the "What's not yet shipped" section in the README; the form-driven UI is **deferred indefinitely**. The v0.2.0 + v0.4.0 stage 1 work is preserved in git history for reference (the v0.4.0 stage 1 text+voice composition is still active via the `composeWithText: "auto"` config). |
| **v0.6.0** — Drop in-package config writer + `loadTelegramConfig` reader | ✅ **SHIPPED** | 2026-08-24 | Per the operator's design rule (every config knob lives in `telegram.json`, edited by the operator or agent via filesystem tools, picked up live by the 200ms hot-reload watcher). (1) `telegram-config.ts` dropped `saveSynthConfig` (the atomic temp+rename writer the v0.2.0 section UI used) + `loadTelegramConfig` (the full-file reader the v0.2.0 section's read-only display used). (2) The `loadSynthConfig` reader stays — it's the extension's own config interface at call time, not the operator/agent's surface for inspection (the agent uses its own `read` tool for that). (3) `index.ts` file header updated: v0.6.0 entry + the `Public APIs used` block consolidated (the section entry was stale). (4) `schema.json` description updated: "v0.4.0 section UI's form generator (planned)" + "v0.4.0 `applyInstallDefaults()` writer (planned)" removed; "v0.4.0 `loadTelegramConfig()` runs the migration" replaced with "no migration needed; the v0.3.0 reader accepts all earlier shapes". (5) `scripts/pi-telegram-tts-smoke-test.sh` stage 13 dropped the `saveSynthConfig` destructured-but-unused from the import. (6) Sister `pi-telegram-stt` did the same in v0.11.0. All 16/16 tts + 7/7 stt smoke stages green. Net: `telegram-config.ts` ~30 lines smaller; `writeFileSync` + `renameSync` imports removed. **Live test pending.** |

| **v0.7.0** — Drop bundled scripts + per-provider sub-block; direct `fetch` in `synth.ts` | ✅ **SHIPPED** | 2026-08-24 | Per the operator's design rule (every config knob lives in `telegram.json`, edited by the operator or agent via filesystem tools, picked up live by the 200ms hot-reload watcher) extended one step further: the TTS provider's body is now a single hardcoded constant per provider (the operator's current Cantonese voice settings are baked into `MINIMAX_BODY` in `synth.ts`). The LLM's reply is the only field interpolated at call time. (1) `extensions/pi-telegram-tts/tts-minimax.mjs` (675 lines) + `tts-openai.mjs` (540 lines) **deleted** — the 3 in-session hotfixes (CLI_TO_PATH remap, TDZ, POSITIVE_FLAGS path-mapping) are no longer needed because there's no `--config` tempfile / subprocess layer. (2) `extensions/pi-telegram-tts/synth.ts` rewritten: ~270 lines → ~270 lines, but the content is now 2 `fetch` adapters (one per provider) + a 5-line dispatcher; the script-spawning + `--config` tempfile + `buildScriptConfig()` + `resolveScriptPath()` machinery is gone. (3) `extensions/pi-telegram-tts/telegram-config.ts` further simplified: `voice` / `model` / `minimax` / `openai` sub-block fields dropped; the 3-field `SynthConfig` is now `{disabled, provider, composeWithText}`. The per-provider sub-block pattern is gone — the operator's 7 sub-block fields (`lang`, `speed`, `emotion`, `sample_rate`, `channel`, `modify_intensity`, `modify_timbre`) are baked into `MINIMAX_BODY` as constants; if the operator wants to adjust, they edit `synth.ts` (the agent can do it via its `edit` tool). (4) `extensions/pi-telegram-tts/package.json`: `bin` field removed; description updated. (5) `extensions/pi-telegram-tts/schema.json` (271 lines, Draft 2020-12) **deleted** — the agent can use the API docs as reference; the operator's flat 3-field config doesn't need editor validation. (6) `scripts/pi-telegram-tts-smoke-test.sh` rebuilt to **15 stages** (was 16): stages 12-15 (v0.2.0 bundled-scripts + v0.3.0 sub-block tests) replaced with 3 new v0.7.0 tests: 3-field `SynthConfig` shape + hardcoded `MINIMAX_BODY` sanity check + "no bundled scripts" regression test. All 15/15 tts + 7/7 stt smoke stages green. (7) The on-host `~/.pi/agent/telegram.json` was updated: the 7 sub-block fields (voice, model, lang, speed, emotion, sample_rate, channel, modify_intensity, modify_timbre) were dropped; the runtime behavior is preserved because the hardcoded `MINIMAX_BODY` matches the operator's previous sub-block values exactly. **Live test pending.** The aspirational v0.7.0 row (Temp-file cleanup + In-Telegram commands + Status line) was renumbered to **v0.8.0** to free up the v0.7.0 slot. |
| **Live test (Phase 4)** | ✅ **DONE** | 2026-08-23 | After the user restarted `pi` to load the new source, the new pipeline (STT in `pi-telegram-stt` → agent → TTS in `pi-telegram-tts` with bundled scripts → voice reply with caption) fires correctly end-to-end. 4+ voice messages received, 3+ TTS OGG outputs created. The first attempt at 19:52:32 EDT failed with `every voice synthesis provider failed` (transient first-run issue, likely a race condition during the new pi's first session); subsequent attempts all succeeded. **Smoke tests had already verified the new code end-to-end** before the live test (6/6 + 14/14 stages green, including live round-trip stages). |
| **Verifier (Phase 6)** | ✅ **DONE** | 2026-08-23 | Dispatched a verifier agent via `task(agent_name="verifier")`. The verifier returned **PARTIAL** verdict; the 5 non-blocking gaps (missing v0.23.0 changelog section; stale `pi-telegram-tts/README.md` install instructions; `pi-voice-telegram-scripts` deprecate hadn't landed; 2 minor doc updates) were all fixed post-verifier. Final state: clean. |
| **`pi-telegram-tts@0.2.0`** — merge `pi-voice-telegram-scripts` (Phase 3) | ✅ **SHIPPED** | 2026-08-23 | The `tts-minimax.mjs` and `tts-openai.mjs` scripts moved from `extensions/pi-voice-telegram-scripts/` into `extensions/pi-telegram-tts/`. The package's `bin` field exposes both. `fw-openai-sts.ts` is dropped (replaced by the system service). `pi-voice-telegram-scripts` npm package is deprecated. New smoke stage 14 verifies the bundled scripts exist + the `bin` field is correct. |
| **v0.2.0** — Section UI | draft (later dropped) | — | Plan drafted; see `### v0.2.0 — Section UI` below. The plan was to add `section.ts` + `saveSynthConfig` + `startConfigWatcher` + 6 smoke stages (mirroring `pi-telegram-stt/echo-section.ts` + `telegram-config.ts:174-202` + `index.ts:282-387`). The v0.2.0 section work shipped on 2026-08-24 morning (commit on master) and was then **dropped the same day** per the operator's directive ("drop the UI for tts completely") — see the "Section UI removed" row above. `section.ts` deleted; `saveSynthConfig` and `loadTelegramConfig` later deleted in v0.6.0. The plan below is preserved for reference only. |
| **v0.3.0** — Per-provider config schema | ✅ **SHIPPED** | 2026-08-24 | `telegram-config.ts` extended with `ProviderConfig` + `minimax` / `openai` sub-blocks; `synth.ts` writes a `--config` tempfile via `buildScriptConfig()`; v0.1.0 top-level `voice` / `model` keep working as fallback (per-key merge, sub-block wins). **Three in-session hotfixes** to the `.mjs` scripts: hotfix 1 added the `--config` path-mapping block (the v0.3.0 design missed that `--config` is a raw body deep-merge, not a CLI-flag path remap), hotfix 2 fixed a TDZ error in `tts-openai.mjs` (CLI_TO_PATH declared after the new block), hotfix 3 extended the path-mapping to also cover `POSITIVE_FLAGS` / `NEGATIVE_FLAGS` (booleans like `force_cbr`, `aigc_watermark`). **Bonus:** `schema.json` shipped ahead of v0.4.0 (Draft 2020-12, ~200 lines, validates against ajv 2020; 4 new smoke stages added: 22, 23, 24, 25). All 25 smoke stages green with full network; live-tested 5 configurations (baseline / emotion-happy / speed-1.5 / openai-coral / all-knobs / minimal-knobs after beep regression). |
| **v0.4.0** — UI-driven config | partial (schema shipped) | — | The `schema.json` deliverable landed early (now in v0.3.0). Remaining v0.4.0 work: `ui-schema.ts` (form-driven UI surface) + `applyInstallDefaults()` (atomic write of schema defaults when block absent) + the deprecation note on top-level `voice` / `model`. Bumps schema `version: 1` → `2` if new fields added. |
| **v0.8.0** — Temp-file cleanup + in-Telegram commands + status line | pending | — | Future expansion. |

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
registration lives for the process lifetime. Same pattern as the
OpenAI STT provider's module-load registration in
`pi-telegram-stt/index.ts` (subsumed in v0.8.0; previously
`pi-openai-stt/index.ts:96-110`).

**Verification (v0.1.0 acceptance):**

- `jiti` load test: `index.ts` loads, `transcribeAndMaybeEcho`-equivalent
  function exports, `synth.ts` exports `synthesizeOgg`.
- Live TTS round-trip: `tts-minimax.mjs` + `ffmpeg` produces a valid OGG
  in a temp dir; `unlink` removes the MP3.
- Path-resolution equivalence: `getAgentDir()` returns the same value as
  the hand-rolled `process.env.PI_CODING_AGENT_DIR ?? ~/.pi/agent` (the
  pattern `pi-telegram-stt/telegram-config.ts:40` and our own
  `pi-telegram-stt/openai-stt.ts` use, which was previously
  `pi-openai-stt/openai-stt.ts:148-191` before the v0.8.0 subsume).
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
| §6.3 (design doc) spawn via absolute path on dev, by name when npm-installed | both resolution strategies work | (synth.ts `resolveScriptPath()` — manual code review; no separate test) | covered (deferred to v0.8.0) |
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
| Temp-file cleanup | `setTimeout(unlink(ogg), 30_000)` scheduled after bridge's `uploadVoiceFile` | — | **v0.8.0** |
| In-Telegram commands (`/tts_status`, `/tts_test`) | diagnostic surface | — | **v0.8.0** |
| Status line | row in `/start` menu's compact status | — | **v0.8.0** |
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
on/off indicator. The operator can enable / disable the provider
without uninstalling the package (a `disabled: true` flag in
`telegram.json#extensions["pi-telegram-tts"]` makes the provider
return `undefined` and fall through to
`outboundHandlers[0].template`). Live edits to `telegram.json` take
effect on the next voice-tagged turn (the provider re-reads config
on every call — already the v0.1.0 pattern).

**Why v0.2.0 matters:** the v0.1.0 cut works, but the operator has
no UI surface. A new operator can install `pi-telegram-tts` and
never know it exists; `/telegram-settings` is the discoverability
moment. Without a section, the package is invisible until the
operator reads the README, which the operator will not do.

#### Files

| File | Purpose | Lines (est.) |
|---|---|---|
| `extensions/pi-telegram-tts/section.ts` *(new)* | `registerTelegramSection(...)` — main menu + settings submenu, `saveSynthConfig` callback handler, dynamic `getLabel()`. Shape mirrors `pi-telegram-stt/echo-section.ts:26-114`. | ~140 |
| `extensions/pi-telegram-tts/telegram-config.ts` *(modified)* | add `saveSynthConfig(cfg)` — atomic temp+rename, mirror `pi-telegram-stt/telegram-config.ts:174-202`. Add a `'use @llblab/...'` import comment. | +35 |
| `extensions/pi-telegram-tts/index.ts` *(modified)* | add `registerSectionOnce()` + `startConfigWatcher()` (mirror `pi-telegram-stt/index.ts:282-339`); wire into `session_start` / `session_shutdown`. | +60 |
| `extensions/pi-telegram-tts/README.md` *(modified)* | "Section UI" section with the menu tree diagram + the discoverability rationale. | +40 |
| `scripts/pi-telegram-tts-smoke-test.sh` *(modified)* | add stages 15-20 — section jiti-load + `saveSynthConfig` round-trip + dynamic label re-render + 3 fall-through surface checks. | +60 |

#### Upstream patterns followed

The v0.2.0 section follows the proven patterns from
`@llblab/pi-telegram`'s `docs/sections.md` standard. Each pattern
below cites the upstream source so a future implementing session
can re-verify the contract against the canonical doc. The sister
`pi-telegram-stt/echo-section.ts` is a partial mirror; the
upstream standard is the authoritative reference, the sister is a
worked example.

| Pattern | Upstream source | v0.2.0 application |
|---|---|---|
| **Typed import** of `registerTelegramSection` from `@llblab/pi-telegram/sections` (no `/lib/*` deep imports) | `docs/sections.md` §4 + §5; `api/sections.ts:9` re-exports from `lib/sections.ts:284` | `section.ts:18` imports the public symbol; the registry is read from `globalThis.__piTelegramSectionRegistry__` (`lib/sections.ts:287-290`) via the typed wrapper |
| **Identity key** = the package's stable id. Single section per package → use the package directory name (`pi-telegram-tts`). Sub-paths are reserved for packages with multiple sections. | `docs/sections.md` §3 (the `@llblab/pi-telegram-extension-demo` uses the package name verbatim) | `id: "pi-telegram-tts"` (NOT `"pi-telegram-tts/section"` — the sister `pi-telegram-stt/echo-section.ts:28` uses `"pi-telegram-stt/echo"` because it predates the §3 rule, but the cleaner v0.2.0 choice is the package name; this is a deliberate divergence from the sister to align with upstream) |
| **Default-export factory** + `pi.on("shutdown", () => unregister())` | `docs/sections.md` §4 (the demo's full `index.ts` body) | The registration is called from `pi-telegram-tts/index.ts`'s `default export`'s `session_start` handler; the disposer is stored on the closure and called from `session_shutdown`. Same shape as the sister `pi-telegram-stt/index.ts:341-387`. |
| **Settings submenu `getLabel()`** runs on every render for dynamic status | `docs/sections.md` §6 (the Settings list calls `getLabel()` on every render, not just at registration) | `settings.getLabel: () => \`${cfg.disabled ? "⚫️" : "🟢"} TTS · ${providerLabel(cfg)}\`` — mirrors the demo's `getLabel: () => \`${flag ? "🟢" : "⚫️"} Demo settings\`` (`docs/sections.md` §6) |
| **`ctx.callbackData(action, payload?)`** — never hand-roll `section:` strings; the bridge mints a numeric token at registration time and the section re-emits the same string for every callback | `docs/sections.md` §7 + §10; `lib/sections.ts:206-212` (`buildTelegramSectionCallbackData`) and `:320-329` (`buildTelegramSectionCallbackData`) | Every button callback in the section uses `ctx.callbackData("toggle-disabled")` (no payload for v0.2.0; v0.4.0 will add payload-bearing actions for save/cancel/field-change) |
| **Handler returns `"handled" \| "pass"`** — `"handled"` stops routing; `"pass"` falls through to the settings handler (or the caller) | `docs/sections.md` §7; `lib/sections.ts:606-643` (main handler → settings handler fallback chain) | `handleCallback: async (ctx) => { if (action === "toggle-disabled") { ...; return "handled"; } return "pass"; }` — explicit `pass` so future actions route correctly |
| **`ctx.edit(view)` auto-prepends `Back`** — the section never adds a Back row manually; the bridge injects the right one based on navigation level | `docs/sections.md` §8; `lib/sections.ts:331-350` (`prependBackRow`) + `:185-194` (buildTelegramSectionContext's edit port) | The settings submenu returns `view.replyMarkup` with **only the toggle row**; the bridge prepends `⬆️ Back → settings:list` automatically. The section's main render is a single `⚙️ Settings` button (no manual back row either) |
| **First-level submenus** start with `⬆️ Main menu`; **deeper submenus** start with `⬆️ Back` | `docs/sections.md` §8 (the `Back` row's target depends on the navigation level) | The settings submenu gets `⬆️ Back` (it was opened from the Settings list). The section root (opened from the main menu) gets `⬆️ Main menu`. We do not add these rows ourselves; the bridge's `prependBackRow` reads the navigation level from the call site |
| **`ctx.open(view)`** for chat-bound dialogs (no auto-Back) | `docs/sections.md` §9.4 (`ctx.open` semantics) | Not used in v0.2.0 (the section is menu-only). Reserved for v0.4.0 confirmation dialogs (e.g. "Are you sure you want to switch provider mid-session?") |
| **Capability scope** — sections cannot read/write filesystem, access the bot client, start a polling loop, or send arbitrary Telegram API calls | `docs/sections.md` §9.3 (the explicit list of forbidden capabilities) | The `handleCallback` calls `saveSynthConfig(...)` which **does** touch the filesystem — this is the **one** filesystem write path the bridge permits, because the bridge owns `telegram.json` as a public config file (per `lib/paths.ts` + the existing `pi-telegram-stt` echo-section's `saveEchoConfig` precedent). The section is otherwise capability-narrow. |
| **Diagnostics** — render/callback/label failures set `status: "error"` with `lastError`; the entry returns to `active` only after a matching surface later succeeds | `docs/sections.md` §12; `lib/sections.ts:394-402` (registry diagnostics) | The section's `render` and `settings.open` are wrapped in the registry's `try/catch` (the bridge does the wrapping; the section code does not need to). The `getLabel` failure is recorded separately. Failures surface as Telegram popups ("Section error: …"), per `lib/sections.ts:578-585`. |
| **Section identity / load order** — `pi-telegram` must load first (sets the global registry); consumer extensions load second | `docs/sections.md` §5 | The peer-dep on `@llblab/pi-telegram` is already in `package.json`. The section registration happens in `index.ts`'s `default export` body (which runs on `session_start`, after `pi-telegram` is fully loaded). No load-order risk. |

The `pi-telegram-stt/echo-section.ts` is the closest sister
implementation but predates the `docs/sections.md` standard (the
section was written before the upstream standard was published).
The echo-section follows most of the rules above (token namespacing,
atomic save, dynamic label), but uses a sub-path id
(`"pi-telegram-stt/echo"`) instead of the package name, and lacks
the `pi.on("shutdown", () => unregister())` discipline in the
section file itself (it's done in `index.ts`). v0.2.0 follows the
upstream-canonical pattern; the sister is a worked example, not
the spec.

#### Section shape (UI tree)

The bridge auto-prepends the `⬆️ Back` row per `docs/sections.md` §8,
so the section code only emits the row payload, not the back nav.

```
Main menu (injected rows before ⚙️ Settings, order=10)
└── 🟢 TTS · minimax       [callback_data: section:<token>:open]
     └── (no main render body — section is settings-only, so it
          forwards to the settings submenu via "section:<token>:settings:open"
          or the main render shows a 1-button "⚙️ Settings" picker.)

Settings list (injected after the bridge's built-in groups, order=10)
└── 🟢 TTS · minimax       [callback_data: section:<token>:settings:open]
     └── Settings card (parseMode: html):
           • Provider: minimax
           • Voice: Cantonese_PlayfulMan
           • Model: speech-2.8-hd
           • sendTranscript: 🟢 on  (read-only reminder, links to
             the bridge's "Voice reply" settings; not editable here)
           • [🟢 ON / ⚫️ OFF]  (horizontal toggle, mirror
             `pi-telegram-stt/echo-section.ts:148-153`)
           • [⚙️ Reconfigure in telegram.json]  (informational
             button, opens the path in a code block via ctx.open)
```

**Why settings-only (no main render body):** the `pi-telegram-stt`
echo section also has this shape (`echo-section.ts:36-57` — main
render is a 1-button "⚙️ Settings" picker that links to the
settings submenu). It keeps the main menu row scannable (a status
indicator) and pushes the form into the Settings submenu where
config knobs belong. Same UX discipline here.

**Dynamic `getLabel()` contract:** the bridge calls `getLabel()` on
every menu render. The section reads `loadSynthConfig()` on each
call (cheap; one file read), so the menu label always reflects the
current `disabled` + `provider` state. The four reachable label
shapes:

| `cfg.disabled` | `cfg.provider` | Label |
|---|---|---|
| `true` | (any) | `⚫️ TTS · off` |
| `false` | `undefined` | `⚫️ TTS · unconfigured` |
| `false` | `"minimax"` | `🟢 TTS · minimax` |
| `false` | `"openai"` | `🟢 TTS · openai` |

The label is a 1-line summary, not a description. Detail lives in
the settings submenu (per `docs/ui-style.md` §State & Navigation
Buttons).

**Toggle button shape** (mirror `pi-telegram-stt/echo-section.ts:148-153`):

```ts
{
  text: cfg.disabled ? "⚫️ OFF" : "🟢 ON",
  callback_data: ctx.callbackData("toggle-disabled"),
}
```

The section uses `ctx.answerCallback("TTS provider is now ON/OFF.")`
to surface the change as a Telegram popup, then `ctx.edit(...)`
re-renders the settings submenu so the toggle label and the
dynamic getLabel reflect the new state. The provider's next
voice-tagged turn reads `loadSynthConfig()` and consults
`cfg.disabled` (`synthesizeCall` in `index.ts:75-79`); the live
edit takes effect without a reload.

**`saveSynthConfig` atomic write** (mirror
`pi-telegram-stt/telegram-config.ts:174-202`):

```ts
export function saveSynthConfig(cfg: SynthConfig): void {
  const path = configPath();
  let parsed: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
    catch { parsed = {}; }
  }
  const extensions = (parsed.extensions ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {
    disabled: cfg.disabled,
    provider: cfg.provider,   // undefined → omitted by the writer
    voice: cfg.voice,
    model: cfg.model,
  };
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  extensions[KEY] = out;
  parsed.extensions = extensions;
  const tempPath = path + ".tmp";
  writeFileSync(tempPath, JSON.stringify(parsed, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tempPath, path);
}
```

The writer only writes the keys it owns within
`extensions["pi-telegram-tts"]`; it does not touch any other
extensions' blocks (e.g. `extensions["pi-telegram-stt"]`,
`extensions["pi-openai-stt"]`). The writer normalizes the section's
own block to the 4-field `SynthConfig` shape — unknown keys within
the block (e.g. an operator who manually added a `"__comment"` key)
are not preserved, by design (the section's schema is fixed at 4
fields; if the operator added a custom key, the first section-side
write normalizes it back to the 4-field shape). The temp+rename
pattern is required — the bridge's own runtime reads `telegram.json`
on every call, so a partial write would be observed mid-flight.

**`ctx.callbackData("toggle-disabled")` is the only action for v0.2.0.**
The `voice` / `model` / `instructions` / `speed` etc. UI lives in
v0.4.0 (per the deferred grid below). v0.2.0 is the minimum
discoverability + disable surface.

#### Provider runtime flow (v0.2.0)

The v0.1.0 flow is unchanged (re-stated for completeness — every
step still runs on every call):

1. `session_start` fires → `registerSectionOnce()` calls
   `registerTelegramSection(...)` from
   `@llblab/pi-telegram/sections`. The disposer is stored on the
   closure-scoped `sectionDisposer` (same pattern as
   `pi-telegram-stt/index.ts:282-294`).
2. `startConfigWatcher()` opens an `fs.watch` on the
   `telegram.json` directory (200ms debounce, mirror
   `pi-telegram-stt/index.ts:306-339`). The watcher is
   best-effort — if `fs.watch` fails (sandbox / no inotify), the
   session_start path is still complete; live edits just need a
   reload to take effect. This is the same fallback discipline
   the sister package uses.
3. On a voice-tagged turn the bridge calls
   `synthesizeCall(text, options)` (the v0.1.0 path). It
   re-reads `loadSynthConfig()` on every call. The
   `cfg.disabled` short-circuit at `index.ts:75-79` makes
   live-edited `disabled: true` flips effective on the very
   next turn without a reload.
4. On a section button click the bridge routes the callback to
   `handleCallback`. For `action === "toggle-disabled"`, the
   handler reads `loadSynthConfig()`, flips `disabled`, calls
   `saveSynthConfig(updated)`, then `ctx.answerCallback(...)` +
   `ctx.edit(...)` to re-render the submenu with the new state.
   The next voice-tagged turn (step 3) observes the new value.

**No re-registration on save.** Unlike `pi-telegram-stt`'s
`reconfigureHandlers()` (which re-binds the STT provider
closure), the TTS provider closure is stateless — it reads
`loadSynthConfig()` on every call. Saving the config flips the
in-process read path; no re-registration, no token mint, no
stale buttons.

#### Config shape (v0.2.0 — no schema change)

```json
"extensions": {
  "pi-telegram-tts": {
    "disabled": false,            // v0.2.0: new writer path, no reader change
    "provider": "minimax",        // existing
    "voice": "Cantonese_PlayfulMan",
    "model": "speech-2.8-hd"
  }
}
```

**No new config fields.** v0.1.0 already reads `disabled`
(`telegram-config.ts:71-74`); v0.2.0 only adds the writer. The
section is a thin view over the existing reader + the new writer.

The bridge-owned `voice.sendTranscript` is shown as a **read-only
reminder** in the settings submenu. The section **does not edit
it** — the bridge's own settings UI (per the operator's running
pi-telegram) is the source of truth for that flag. The reason
this can't be edited from the section: per `AGENTS.md`'s
"Documented gaps" §2, the upstream bridge has a reader
(`getTelegramVoiceSendTranscript`) but no setter and no main-menu
toggle. Editing it from our section would be inconsistent
(operators would have to remember which UI surfaces which). The
upstream issue [llblab/pi-telegram#235](https://github.com/llblab/pi-telegram/issues/235)
is the right fix; until it lands, the section surfaces the value
but points the operator to the right place.

#### Upstream APIs used (v0.2.0 = v0.1.0 + 1)

| API | Source | Role | Status |
|---|---|---|---|
| `registerTelegramVoiceSynthesisProvider` | `@llblab/pi-telegram/voice` | the seam v0.1.0 plugs into | v0.1.0 (unchanged) |
| `getTelegramVoiceSendTranscript` | `@llblab/pi-telegram/voice` | bridge-owned `voice.sendTranscript` | v0.1.0 (unchanged) |
| `recordTelegramRuntimeEvent` | `@llblab/pi-telegram/outbound` | diagnostics on spawn failures | v0.1.0 (unchanged) |
| `registerTelegramSection` | `@llblab/pi-telegram/sections` | main menu + settings submenu | **v0.2.0 (new)** |
| `TelegramSectionContext` | (same) | `render` + `settings.open` ports | **v0.2.0 (new)** |
| `TelegramSectionCallbackContext` | (same) | `handleCallback` port | **v0.2.0 (new)** |
| `ctx.callbackData(action, payload?)` | (same) | namespaced callback tokens — **never hand-roll `section:` strings** | **v0.2.0 (new)** |
| `ctx.edit` / `ctx.answerCallback` | (same) | re-render + popup | **v0.2.0 (new)** |
| `getAgentDir` | `@earendil-works/pi-coding-agent` | path resolution | v0.1.0 (unchanged) |
| `ExtensionAPI` factory shape | `@earendil-works/pi-coding-agent` | extension lifecycle | v0.1.0 (unchanged) |

The new APIs are all in the v0.1.0 peer-dep closure (per
"Future expansion" §`registerTelegramSection` row in the upstream
surface inventory), so this is a single-package change with no
new public API.

#### Module-load safety

Same dual-registration pattern as v0.1.0 (provider registers at
module load + idempotently on `session_start`). For the section,
the v0.1.0 pattern is reversed: **section registration is
session-only, not module-load.** Why:

- The provider is callable from the bridge's outbound pipeline,
  which can fire on any voice message — the load-order race means
  it must be in the registry at module load.
- The section is only invoked from a Telegram button click, which
  requires the user + bridge + session to be live. There is no
  load-order race for sections.
- A module-load section registration would require a
  `__piTelegramSectionRegistry__` to be present at jiti load time,
  which is true for the typical host setup (pi-telegram is a
  peer-dep loaded first) but is not guaranteed. The session_start
  path is the safer, more conventional one — the demo extension
  does the same (`registerTelegramSection` is called from inside
  the default export's body, which runs on session_start).

So: `index.ts` calls `registerSectionOnce()` on
`session_start`, stores the disposer on the closure, calls it on
`session_shutdown`. `pi-telegram-stt/index.ts:341-377` is the
verbatim reference.

**Idempotency on hot-reload:** the `registerSectionOnce()` guard
(`if (sectionDisposer) return;`) prevents re-registration on
re-fire, which would mint a fresh token and stale the in-Telegram
menu buttons. The sister package's
`pi-telegram-stt/index.ts:291-294` has the identical pattern.

**Dispose discipline on shutdown:** the `session_shutdown`
handler calls `sectionDisposer()` (clearing the closure's
reference so a future `session_start` can re-register cleanly)
and `configWatcher.close()`. Mirror
`pi-telegram-stt/index.ts:365-387`.

#### Verification (v0.2.0 acceptance)

The pre-flight checklist from this plan's `## How to use this
plan` section maps to:

- [x] **Each public API the package will use is listed in the
      "Upstream APIs used" table.** The 4 new APIs (above) are
      all listed.
- [x] **For each public API, there is a smoke stage that
      exercises it.** Stages 14-19 below.
- [x] **Each config field the package reads has a smoke stage
      covering the default, the "true" case, and the "false"
      case.** `disabled` already covered by v0.1.0 stage 4
      (true → undefined). v0.2.0 stage 16 adds: after
      `saveSynthConfig({ disabled: true })`, the next
      `loadSynthConfig().disabled === true`. v0.1.0 stage 4
      already pins the "true" provider-behavior case.
- [x] **The smoke stage count is at least equal to the plan's
      "Provider runtime flow" step count.** v0.2.0's runtime
      flow has 4 steps; the new stages (15, 16, 17, 18, 19, 20)
      are 6 stages. Excess is intentional: stage 16 covers
      idempotency, stage 20 covers the dynamic label re-render.
- [x] **Every `Returns { ... }` line in the plan has a stage
      asserting every field's presence AND absence.** Stage 15
      asserts `registerTelegramSection` was called (presence);
      stage 16 asserts the registry stays single-keyed (absence
      of duplicate tokens).
- [x] **Each deferred feature has a one-line "Defer?" note in
      the Acceptance matrix** — see the `v0.2.0` column on the
      `getVoicePromptContribution`, voice/model editors, and
      in-Telegram commands rows.

#### New smoke stages (v0.2.0 — added to `scripts/pi-telegram-tts-smoke-test.sh`)

The 14 v0.1.0/v0.2.0 stages remain unchanged. v0.2.0 adds
**stages 15-20** (mirroring the 6 new plan rows below; the new
stages start at 15 to avoid colliding with the existing
`scripts/pi-telegram-tts-smoke-test.sh:664` stage 14, which pins
the v0.23.0 changelog's bundled-scripts check):

| Stage | What it asserts | Network? |
|---|---|---|
| 15 | jiti-load `section.ts` directly + call `registerSynthSection()` against a stub `globalThis.__piTelegramSectionRegistry__`. Asserts: registry contains one entry with `id: "pi-telegram-tts/section"`, `label: "🎙️ TTS provider"`, `order: 10`. | no |
| 16 | Re-call `registerSynthSection()`. Asserts: registry is still single-keyed (idempotent re-register is rejected by the registry, our guard catches it, no double token). | no |
| 17 | `saveSynthConfig({ disabled: true, provider: "minimax", voice: "x", model: "y" })` writes `telegram.json`. Asserts: `loadSynthConfig()` returns the same shape. `telegram.json` was atomically written (no `.tmp` left). | no |
| 18 | `loadSynthConfig()` after the stage-17 save → `cfg.disabled === true` AND the existing v0.1.0 stage 4 `provider(text, options)` returns `undefined` (the v0.2.0 hot-reload contract: save → next call observes the new state). | no |
| 19 | Section's `handleCallback` action `"toggle-disabled"` → call against a stub context, then `loadSynthConfig()` shows the flipped state. The stub context records the `ctx.answerCallback` + `ctx.edit` calls (we don't need a real bridge to assert the section's behavior). | no |
| 20 | Section's `getLabel()` called 4× against the 4 reachable `(disabled × provider)` shapes. Asserts each label matches the table above. | no |

Stages 14-19 are pure (no network, no bridge, no Telegram) so
they run in `--no-network` mode (CI-safe). The live test for
v0.2.0 is the same shape as v0.1.0's: install the package, set
`extensions["pi-telegram-tts"].provider`, restart `pi`, click
`⚙️ Settings → 🟢 TTS · minimax`, observe the settings card,
toggle the button, observe the menu row label flip from
`🟢 TTS · minimax` to `⚫️ TTS · off`.

#### Acceptance matrix (v0.2.0)

| Plan reference | What it requires | Smoke stage | Defer? |
| --- | --- | --- | --- |
| §v0.2.0 "Files added" | `extensions/pi-telegram-tts/section.ts` exists | (file existence) | covered |
| §v0.2.0 "Files added" | `telegram-config.ts` exports `saveSynthConfig` | (TypeScript import check) | covered |
| §v0.2.0 "Files added" | `index.ts` wires `registerSectionOnce` into `session_start` | stage 15 (section registered) | covered |
| §v0.2.0 "Upstream patterns followed" — identity key | `id: "pi-telegram-tts"` (the package name, per `sections.md` §3) | stage 15 (registry entry's `id` field) | covered |
| §v0.2.0 "Upstream patterns followed" — typed import | `registerTelegramSection` from `@llblab/pi-telegram/sections` (not `/lib/*`) | (TypeScript import check — must resolve to the public re-export) | covered |
| §v0.2.0 "Section shape" — Main menu row | `registerTelegramSection` called with `order: 10` | stage 15 (registry entry shape) | covered |
| §v0.2.0 "Section shape" — Dynamic `getLabel()` | 4 reachable label shapes | stage 20 (all 4 shapes) | covered |
| §v0.2.0 "Section shape" — Settings submenu | `settings.open` returns the rendered card + 1 toggle button | stage 15 (registration includes a `settings` block) | covered |
| §v0.2.0 "Section shape" — Back navigation | auto-prepended by bridge | (no smoke needed — bridge contract) | covered (no section-side code) |
| §v0.2.0 "Toggle button shape" | `text: cfg.disabled ? "⚫️ OFF" : "🟢 ON"`, callback `ctx.callbackData("toggle-disabled")` | stage 19 (callback handler runs + flips state) | covered |
| §v0.2.0 "`saveSynthConfig` atomic write" | temp+rename, no `.tmp` left | stage 17 (atomic write round-trip) | covered |
| §v0.2.0 "`saveSynthConfig` writer" | only writes the keys it owns within `extensions["pi-telegram-tts"]`; does not touch other extensions' blocks | stage 17 (read back the same keys; assert no others touched) | covered |
| §v0.2.0 "No re-registration on save" | `saveSynthConfig` does not unregister the section | (implicit — `saveSynthConfig` doesn't touch the section registry) | covered |
| §v0.2.0 "Provider runtime flow" step 1 | `session_start` → `registerSectionOnce` → `registerTelegramSection` | stage 15 | covered |
| §v0.2.0 "Provider runtime flow" step 2 | `startConfigWatcher` opens `fs.watch` | (best-effort; manual live test) | covered (manual) |
| §v0.2.0 "Provider runtime flow" step 3 | `synthesizeCall` re-reads `loadSynthConfig()` per call (v0.1.0 behavior preserved) | v0.1.0 stages 6-8 | covered (re-stated) |
| §v0.2.0 "Provider runtime flow" step 4 | `handleCallback` → `saveSynthConfig` → `ctx.edit` re-render | stage 19 | covered |
| §v0.2.0 "Config shape" — no schema change | `disabled` reader unchanged | (no code change in reader) | covered |
| §v0.2.0 "Module-load safety" — section is session-only, not module-load | `registerTelegramSection` called from `session_start` only, not top-level | (code-review check: `index.ts` doesn't call `registerTelegramSection` at module load) | covered |
| §v0.2.0 "Module-load safety" — idempotency | `registerSectionOnce` guard against double-registration | stage 16 (idempotent) | covered |
| §v0.2.0 "Module-load safety" — dispose discipline | `session_shutdown` calls `sectionDisposer()` and `configWatcher.close()` | (live test only — registry is `globalThis`, no in-process assertion) | covered (manual) |
| "Upstream APIs used" | `registerTelegramSection` called from `@llblab/pi-telegram/sections` (not `/lib`) | stage 15 (the registry is the bridge's own, so the symbol must be the public one) | covered |
| "Upstream APIs used" | `ctx.callbackData("toggle-disabled")` (never hand-roll `section:`) | stage 19 (the stub context records the callback_data; assert it starts with `section:` and has a numeric token) | covered |
| "Upstream APIs used" | `ctx.edit` re-render — `view.text` + `view.replyMarkup` both populated | stage 19 (the stub context records the `edit` call with the new view) | covered |
| "Upstream APIs used" | `ctx.answerCallback(text)` for the toast | stage 19 (asserts the stub context records an `answerCallback` call with the right text) | covered |
| `voice.sendTranscript` reminder | shown as read-only in the settings card | (manual live test — would need a Telegram client to assert the HTML renders) | covered (manual) |
| Voice / model editors (UI-driven config) | form-based edit from Telegram | — | **v0.4.0** |
| Per-provider sub-blocks (`minimax: {…}`, `openai: {…}`) | every CLI arg reachable from `telegram.json` | — | **v0.3.0** |
| Editing `voice.sendTranscript` from the section | bridge has no setter; deferred to upstream | — | **upstream #235** |
| In-Telegram commands (`/tts_status`, `/tts_test`) | diagnostic surface | — | **v0.8.0** |
| Temp-file cleanup (`setTimeout(unlink(ogg), 30_000)`) | OGG removed after upload | — | **v0.8.0** |
| Status line (row in `/start` menu) | compact status | — | **v0.8.0** |
| Pre-existing migration friction | `outboundHandlers[0].template` still works (opt-in semantics) | (v0.1.0 stage 3 covers the unconfigured path) | covered |

#### Live test recipe (v0.2.0)

The live test for v0.2.0 is the same recipe as v0.1.0's
`docs/PI-TELEGRAM-TTS-PLAN.md` "Live test (Phase 4)" plus:

0. **No-file edge case (run this first on a fresh install).**
   With no `telegram.json` present, the section should still
   appear in the main menu (label `⚫️ TTS · unconfigured`).
   Click the toggle. Verify a `telegram.json` is created
   (the writer falls through to the `if (existsSync(path))`
   guard at the v0.2.0 plan's `saveSynthConfig` body, which
   writes a new file with `{"extensions": {"pi-telegram-tts":
   {"disabled": true}}}`). The operator might be surprised
   that a single click creates a config file; document this
   in the live-test report. **v0.4.0's schema-driven install
   defaults eliminates this edge case** — by the time the
   operator opens the section, the schema-driven
   `applyInstallDefaults()` has already written the block
   with the documented defaults. v0.2.0 ships with the
   "first toggle creates the file" behavior as a transitional
   limitation.
1. After the user restarts `pi`, open the bot chat in Telegram
   and type `/start` (or whatever the bridge's menu trigger is).
2. Verify `🟢 TTS · <provider>` is in the main menu list before
   `⚙️ Settings`.
3. Click the row. Verify the main render shows the
   `⚙️ Settings` button (the v0.1.0 echo-section's pattern).
4. Click `⚙️ Settings` → verify it lands in the
   `🟢 TTS · <provider>` settings submenu (per the
   `docs/ui-style.md` Back-row discipline, the first row is
   `⬆️ Back`).
4a. **Back navigation.** Click `⬆️ Back`. Verify it returns
   to the Settings list (per `docs/sections.md` §8, the Back
   row is auto-prepended and dedup'd by the bridge). Re-enter
   the section and verify the same Back row appears on the
   settings submenu.
5. Verify the settings card shows the current `provider` /
   `voice` / `model` and the toggle button. Verify the
   `voice.sendTranscript` reminder row.
6. Click the toggle. Verify the Telegram popup "TTS provider is
   now OFF." appears. Verify the button label flips to
   `🟢 ON` and the dynamic menu label flips to
   `⚫️ TTS · off`.
7. Send a voice message. Verify the agent's reply is a text
   message (no voice) — the provider returned `undefined` and
   the bridge fell through to `outboundHandlers[0].template`,
   which the operator has disabled or wants to keep template-
   based.
8. Click the toggle again to re-enable. Verify the next voice
   message gets a voice reply (the TTS provider re-fires).

The on-host test on 2026-08-23 (v0.1.0 live test) didn't
exercise the section UI because the section didn't exist yet.
The v0.2.0 live test is the first end-to-end section-UI
verification.

#### v0.2.0 actual file sizes vs. estimate

TBD at ship time (mirrors v0.1.0's
[v0.1.0 actual file sizes vs. estimate](#v010-actual-file-sizes-vs-estimate)
section).

#### v0.2.0 deltas from this plan

TBD at ship time (mirrors v0.1.0's
[v0.1.0 deltas from the design doc](#v010-deltas-from-the-design-doc)
section).

---

### v0.3.0 — Per-provider speech parameters in `telegram.json`

**Goal:** every CLI arg the script supports is reachable via
`telegram.json` config. Operators can pin `lang`, `speed`,
`instructions`, `response_format`, `output_format`, `pronunciation_dict`,
`timbre_weights`, etc. without editing the template.

**Mechanism (Option B, the `--config` tempfile approach):** the
provider (`synth.ts`) writes the sub-block to a tempfile inside the
same `tempDir` it already creates for the OGG, and passes
`--config <path>` to the script. The script's own deep-merge
(`DEFAULTS ← --config ← CLI`) handles the rest. **No changes to the
`.mjs` scripts were required** — both `tts-minimax.mjs` and
`tts-openai.mjs` already accepted `--config` for the full request
body (the 100% adjustability comment at `tts-minimax.mjs:14-26` and
the matching block in `tts-openai.mjs:13-18`).

Why Option B over per-flag CLI args:

- **One flag regardless of sub-block size.** A 1-line sub-block
  ("`speed: 1.2`") and a 25-line sub-block ("`pronunciation_dict:
  { tone: [...] }`") both go through the same code path.
- **Arrays and nested objects pass through verbatim.** Per-flag
  CLI args can't express `pronunciation_dict.tone` (array of
  strings) or `timbre_weights` (array of objects) cleanly.
- **Forward-compat.** When MiniMax adds a new field, or when the
  operator wants `pronunciation_dict.tone`, the change is
  `telegram.json` only — no `synth.ts` edit.
- **No new failure mode.** The tempdir lifecycle already exists
  (60s cleanup); the new tempfile rides the same lifecycle.

**Config shape (v0.3.0 — per-provider sub-blocks):**

```json
"extensions": {
  "pi-telegram-tts": {
    "disabled": false,
    "provider": "minimax",
    "voice": "Cantonese_PlayfulMan",
    "model": "speech-2.8-hd",
    "minimax": {
      "voice": "Cantonese_PlayfulMan",
      "model": "speech-2.8-hd",
      "lang": "Chinese,Yue",
      "speed": 1.0,
      "vol": 1.0,
      "pitch": 0,
      "emotion": "neutral",
      "sample_rate": 32000,
      "bitrate": 128000,
      "format": "mp3",
      "channel": 1,
      "text_normalization": true,
      "latex_read": false,
      "modify_pitch": 0,
      "modify_intensity": 0,
      "modify_timbre": 0,
      "sound_effects": "spacious_echo",
      "subtitle_type": "word",
      "output_format": "hex",
      "subtitle_enable": false,
      "emoji_event": false,
      "force_cbr": false,
      "aigc_watermark": true,
      "apply_text_filter": true,
      "pronunciation_dict": { "tone": ["example/pronunciation"] },
      "timbre_weights": []
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

**Backward compat:** v0.1.0's top-level `voice` + `model` continue
to work as a fallback when the per-provider sub-block is absent.
`synth.ts`'s `buildScriptConfig()` resolves: `effective = {
...topLevelFields, ...subBlock }` — sub-block overrides top-level
when both are present (per-key merge, not wholesale replace). Live
edits take effect on the next voice-tagged turn (the provider reads
config on every call, not at registration time — same pattern as
`pi-telegram-stt/echo-handler.ts:142-235`).

**Top-level `voice` / `model` deprecation timeline:** supported in
v0.3.0 → v0.7.0. v0.4.0 will mark them `> Deprecated: use the
per-provider sub-block instead`. Removal is targeted for v1.0. The
v0.3.0 README documents the new sub-block without a deprecation
note on the top-level fields.

**`synth.ts` changes:**

1. Add `buildScriptConfig(cfg)` helper — builds the per-call JSON
   from the active provider's sub-block + the v0.1.0 top-level
   `voice` / `model` as fallbacks.
2. Add `writeFile(configPath, JSON.stringify(scriptConfig, null,
   2) + "\n", { encoding: "utf8", mode: 0o600 })` — writes the
   tempfile inside the existing `tempDir`.
3. Replace the flag-by-flag script invocation
   (`[..., "--voice", cfg.voice, "--model", cfg.model]`) with a
   single `--config <path>` flag. The script's deep-merge handles
   everything.
4. The v0.1.0 transcript + ffmpeg flow is unchanged.

Each script's existing `validateBody()` already checks the right
set of values per provider
(`tts-openai.mjs:241-247` validates `model`, `voice`,
`response_format`, `speed`; `tts-minimax.mjs:377-402` validates its
own schema). Invalid sub-block values exit 2, the provider returns
`undefined`, the bridge falls through to the template.

**`telegram-config.ts` changes:** add `ProviderConfig` type
(`{ [field: string]: unknown }`), extend `SynthConfig` with
`minimax: ProviderConfig | undefined` and
`openai: ProviderConfig | undefined`, type-guard the sub-blocks
(`isProviderConfig` — accepts any non-null, non-array object).

**No new upstream APIs.** Pure config-schema expansion.

#### Files added / modified (v0.3.0)

| File | Change | Lines (est.) |
|---|---|---|
| `extensions/pi-telegram-tts/telegram-config.ts` *(modified)* | `ProviderConfig` type + `minimax` / `openai` sub-blocks in `SynthConfig`; `isProviderConfig` type-guard; updated reader + DEFAULTS. | +50 |
| `extensions/pi-telegram-tts/synth.ts` *(modified)* | `buildScriptConfig()` helper; `writeFile` of the config.json tempfile inside the existing `tempDir`; `--config <path>` replaces the v0.1.0 flag-by-flag path. | +40 / −8 |
| `extensions/pi-telegram-tts/index.ts` *(modified)* | Comment block update — version-history lines for v0.2.0 / v0.3.0. | +10 / −2 |
| `extensions/pi-telegram-tts/README.md` *(modified)* | New "v0.3.0 — Per-provider sub-block" section; updated config-field table; "What's not in v0.1.0" retitled "What's not yet shipped". | +90 |
| `scripts/pi-telegram-tts-smoke-test.sh` *(modified)* | New stages 15-21 (7 stages): sub-block reader (×2), top-level fallback, sub-block override, `--config` tempfile written, empty sub-block + top-level, live round-trip with sub-block fields. | +100 |

#### Acceptance matrix (v0.3.0)

| Plan reference | What it requires | Smoke stage | Defer? |
| --- | --- | --- | --- |
| §v0.3.0 "Config shape" — `minimax: {…}` | `loadSynthConfig().minimax` returns the sub-block | stage 15 | covered |
| §v0.3.0 "Config shape" — `openai: {…}` | `loadSynthConfig().openai` returns the sub-block | stage 16 | covered |
| §v0.3.0 "Backward compat" | top-level `voice` / `model` readable when sub-block absent | stage 17 | covered |
| §v0.3.0 "Backward compat" | sub-block field overrides top-level when both present | stage 18 | covered |
| §v0.3.0 "synth.ts changes" — `--config` tempfile | `synthesizeOgg` writes a `config.json` inside the tempdir before `spawn` | stage 19 (filesystem check: tempdir contains `config.json`; log line shows the path) | covered |
| §v0.3.0 "synth.ts changes" — empty sub-block + top-level | `buildScriptConfig` returns `{ voice, model }` (top-level only) | stage 20 (assert the JSON shape) | covered |
| §v0.3.0 "synth.ts changes" — live round-trip with sub-block fields | request hits the API with the right values | stage 21 (live network; assert OGG produced; no script exit-2) | covered |
| §v0.3.0 hotfix — script `--config` path-mapping | flat keys in `--config` (e.g. `voice`, `speed`, `lang`) reach the API at the right nested paths (`voice_setting.voice_id`, `voice_setting.speed`, `language_boost`); top-level keys (e.g. `model`) are preserved | stage 22 (spawn `tts-minimax.mjs` with a fake API key; parse the `request body assembled` log line; assert `voice_setting.voice_id = "Cantonese_PlayfulMan"`, `voice_setting.speed = 1.5`, `voice_setting.emotion = "happy"`, `model = "speech-2.8-hd"`, and the "config keys path-mapped" debug line fires) | covered |
| §v0.3.0 hotfix 2 — OpenAI TDZ regression | `tts-openai.mjs` script-load TDZ error (referenced `CLI_TO_PATH` before its declaration) is fixed; body has all 5 fields (`model`, `voice`, `speed`, `instructions`, `response_format`) at the top level | stage 23 (spawn `tts-openai.mjs` with a fake API key; assert `request body assembled` line exists AND has all 5 fields; would have caught the TDZ regression if it had existed when the hotfix landed) | covered |
| §v0.3.0 "No new upstream APIs" | no new `@llblab/*` imports in `synth.ts` / `telegram-config.ts` | (code review) | covered |
| §v0.3.0 "Live edit takes effect on the next voice-tagged turn" | provider re-reads `loadSynthConfig()` on every call (v0.1.0 behavior preserved) | (v0.1.0 stage 6 covers it) | covered |
| v0.2.0 section UI | `registerTelegramSection` from `@llblab/pi-telegram/sections` | — | **v0.2.0 (must land first)** |
| Per-provider form (UI-driven config) | form-based edit from Telegram | — | **v0.4.0** |
| JSON Schema for editor validation | `schema.json` with version + field types + defaults | — | **v0.4.0** |
| Install-time defaults (`applyInstallDefaults`) | atomic write of schema defaults when block absent | — | **v0.4.0** |
| Temp OGG cleanup (`setTimeout(unlink, 30_000)`) | OGG removed after bridge upload | — | **v0.8.0** |
| In-Telegram commands (`/tts_status`, `/tts_test`) | diagnostic surface | — | **v0.8.0** |
| Status line in `/start` menu | compact status row | — | **v0.8.0** |
| Top-level `voice` / `model` deprecation note | `> Deprecated: use the per-provider sub-block instead` | — | **v0.4.0** |
| OpenAI-only fields in MiniMax sub-block (e.g. `instructions`) | script-level validation rejects with exit 2 | (covered by script's own `validateBody`; no v0.3.0 surface) | covered (script-level) |

Stages 15-20 are pure (no network) and run in `--no-network` mode.
Stage 21 needs network + an API key (mirrors v0.1.0 stages 6-8).

#### v0.3.0 risk register

- **Tempfile race condition with concurrent calls:** the tempdir is
  created per call (`synth.ts:139`), and the `config.json` lives in
  that tempdir. Each call has its own `config.json`, no sharing.
  No race.
- **Atomic-write of `config.json`:** not atomic. The script reads
  the file after `spawn` returns, so a partial write would be
  observed. Mitigation: write before `spawn`, and the `tempdir` is
  unique per call (UUID-based), so the file is fully written before
  the script ever runs.
- **Large sub-block sizes:** `pronunciation_dict.tone` arrays +
  `timbre_weights` arrays could push the JSON to ~10 KB. The
  script reads the whole file synchronously into memory
  (`tts-minimax.mjs:319`, `tts-openai.mjs:205`). 10 KB is fine;
  100 KB+ would be a problem, but realistic configs are <1 KB.
- **JSON.parse failure in the script:** if the operator writes
  invalid JSON in their sub-block, the script's `--config` reader
  exits 2 (`tts-minimax.mjs:327`, `tts-openai.mjs:213`). The
  provider returns `undefined`. The runtime event records the
  script's stderr. Acceptable.
- **Versioning of sub-block schema:** v0.3.0 ships the sub-block
  format; future versions may add fields. The script's deep-merge
  handles unknown fields gracefully (it just stores them; OpenAPI
  rejects unknown fields upstream, but the merge doesn't
  validate). Out of scope: a `version: 1` field on the sub-block —
  that's a v0.4.0 schema concern.

#### Live test recipe (v0.3.0)

> **⚠️ Docker-container boundary.** Before doing anything with a
> `pi` process visible in `ps` / `top`, verify it's the on-host
> agent you intend to exercise. The on-host `pi` is started by
> the operator from an interactive terminal with
> `pi 2>/tmp/pi.stderr.log`; the bridge routes that one to the
> Telegram bot. A `pi` shown by `ps` may actually be a Docker
> container (e.g. `pi-agent-jane`) running other unrelated work.
> Check with `pstree -p <pid>` — a Docker `pi` is nested under
> `containerd-shim` / `docker-proxy`; the on-host `pi` is nested
> under the operator's shell. **Never kill a `pi` for "being in
> the way" without first checking the parent process.** See
> `AGENTS.md` "Layer 2" for the full caveat.

Same as v0.1.0's live test (`AGENTS.md` "Layer 2 — Live test") with
these additions:

1. After the agent restart, observe in `/tmp/pi.stderr.log` that
   the `[pi-telegram-tts/synth]` lines now include
   `tts spawn provider=minimax config=… chars=N` (the `config` field
   is new in v0.3.0 — confirms `--config` is being passed).
2. Send a voice message with
   `extensions["pi-telegram-tts"].minimax = { lang: "Chinese,Yue", speed: 1.2 }`
   and `provider: "minimax"`. The bot's voice reply should be
   produced with those values (the script's stderr
   `[tts-minimax] synthesizing ... lang=Chinese,Yue ...` will
   confirm).
3. Edit the config to add a fresh sub-block field (e.g.
   `emotion: "happy"`), save, send another voice message. Observe
   the same `[tts-minimax] synthesizing ... emotion=happy ...`
   line. No agent restart needed (provider re-reads on every call).

#### v0.3.0 actual file sizes vs. estimate

| File | Plan est. | Actual | Delta |
| --- | --- | --- | --- |
| `extensions/pi-telegram-tts/telegram-config.ts` | +50 | 198 (was 120) | +78 (the `ProviderConfig` type + the `isProviderConfig` type-guard + the comment block explaining the per-key merge + the `minimax` / `openai` reader wiring). Plan undercounted the type-guard block. |
| `extensions/pi-telegram-tts/synth.ts` | +40 / −8 | 279 (was 213) | +66 (the `buildScriptConfig` helper + the `writeFile` of `config.json` + the new log line + the comment block explaining the v0.3.0 dispatch + the new `--config` arg). Plan undercounted the comment block. |
| `extensions/pi-telegram-tts/index.ts` | +10 / −2 | 170 (was 164) | +6 (the v0.2.0 + v0.3.0 lines in the comment block; comment-only change). |
| `extensions/pi-telegram-tts/tts-minimax.mjs` | +0 (plan said no script changes) | 614 (was 588) | +26 (the `--config` path-mapping block: iterate `CLI_TO_PATH`, `setNested(body, path, value)`, conditional `delete body[flag]` when `path !== flag`, debug log on remapped keys, the v0.3.0 contract comment). v0.3.0 hotfix per the "deltas" section. |
| `extensions/pi-telegram-tts/tts-openai.mjs` | +0 (plan said no script changes) | 522 (was 500) | +22 (the same path-mapping block — no-op for the current OpenAI flat schema, but applied for consistency with `tts-minimax.mjs` so future fields with nested paths get the same treatment). v0.3.0 hotfix. |
| `extensions/pi-telegram-tts/README.md` | +90 | ~290 (was 184) | +106 (the new "v0.3.0 — Per-provider sub-block" section + the precedence rules + the field list per provider + the "How it works" callout + the "What's not yet shipped" retitle). |
| `scripts/pi-telegram-tts-smoke-test.sh` | +100 | 1300 (was 707) | +593 (the 8 new stages 15-22: 7 from the original plan + 1 hotfix stage that exercises the script's `--config` path-mapping by parsing the `request body assembled` log line with a fake API key). |
| `docs/PI-TELEGRAM-TTS-PLAN.md` | +80 | (~1100) | +large (the v0.3.0 section rewrite + the 13-row Acceptance matrix + the 5-row risk register + the 3-step live-test recipe + the actual-vs-estimate + the v0.3.0 hotfix delta section). |
| `docs/PI-TELEGRAM-TTS-DESIGN.md` | +40 | (~990) | +small (the v0.2.0/v0.3.0 status block + the §6.3 walk-up correction + the §11 "Also install" drop + the §12 peer-dep correction + the §7.2 synth.ts sketch refresh). |
| `docs/README.md` | +10 | (~30) | +6 (3 row updates in the "What's here" table). |

**Total: ~+900 lines** (mostly smoke test + doc growth). All growth
is in scope for the plan; nothing in the "Open questions" / "Risk
register" was triggered.

#### v0.3.0 deltas from this plan

Three design deltas worth noting — all intentional, none a gap:

- **Option B (the `--config` tempfile approach) replaced Option A
  (per-flag CLI args) as the implementation strategy.** The plan
  doc's original v0.3.0 section suggested building a per-flag
  list ("`--voice X --model Y [--lang Z] [--speed W]` …"). During
  the planning conversation, the operator noted that both
  `tts-*.mjs` scripts already accept `--config <json>` for the
  full request body, and asked whether the scripts need to be
  modified. The plan's v0.3.0 section was rewritten to use
  Option B before any code was written; the implemented
  `synth.ts` matches the rewrite 1:1. The motivation: arrays
  (`pronunciation_dict.tone`, `timbre_weights`) and forward-compat
  (new script fields work without `synth.ts` changes) outweigh
  the per-flag simplicity.
- **`SynthConfig.ProviderConfig` is `{ [field: string]: unknown }`,
  not a typed shape per provider.** The plan doc §v0.3.0
  "Config shape" enumerates all the per-provider fields, but
  `telegram-config.ts` doesn't re-encode that as TypeScript
  types — the script is the runtime validator. The type
  guard is just `isProviderConfig` (non-null, non-array object).
  This keeps `synth.ts` provider-agnostic and means adding a
  new field to one of the scripts is `telegram.json`-only.
- **The `ProviderConfig` type guard is `isProviderConfig` (the
  plan's working name) not `isObjectConfig` (the alt name from
  the design doc).** The implementation matches the plan's
  naming; the design doc isn't re-edited to reflect this since
  the function is private to `telegram-config.ts`.
- **v0.3.0 hotfix (in-session, 2026-08-24): the scripts DID need
  a small change after all.** The plan's "no script changes
  needed" was based on a misjudgment of how the script's
  `--config` flag works. `--config` does a **raw body
  deep-merge** into the request body, not a CLI-flag-style
  path remap. The `CLI_TO_PATH` table the script uses for
  `--voice` / `--lang` / `--speed` flags does not run over
  `--config` keys. So a v0.3.0 sub-block like
  `{voice: "Cantonese_PlayfulMan", speed: 1.5, lang: "Chinese,Yue"}`
  lands at the top level of the request body, and the MiniMax
  API silently ignores the top-level keys — the DEFAULTS'
  `voice_setting.voice_id = "Cantonese_CuteGirl"` is what the
  API actually hears. The live test on 2026-08-24 caught it:
  the user noticed the voice wasn't `Cantonese_PlayfulMan` as
  configured. The fix (~25 lines in `tts-minimax.mjs` and
  `tts-openai.mjs`): after the `--config` deep-merge, iterate
  the script's own `CLI_TO_PATH` table and apply
  `setNested(body, path, configObj[flag])` for any flag the
  user's config set. Side-conditions: don't delete
  `body[flag]` when `path === flag` (would drop top-level
  `model`); runs before the CLI flag block so explicit CLI
  flags still win (`CLI > --config > DEFAULTS`). New smoke
  stage 22 pins the contract: spawns `tts-minimax.mjs` with a
  fake API key, captures the `request body assembled` log
  line, asserts `voice_setting.voice_id = "Cantonese_PlayfulMan"`
  (not the DEFAULTS' `Cantonese_CuteGirl`). The smoke test's
  stage 19 had a similar gap (asserted `configJson.voice`
  on disk, not the body the API receives) — stage 22 closes
  that gap too. **The fix is small, the script's own
  `CLI_TO_PATH` is the source of truth for the path map, and
  future script fields with nested paths get the same
  treatment automatically.**
- **v0.3.0 hotfix 2 (in-session, 2026-08-24): TDZ error in
  `tts-openai.mjs`.** The first hotfix added the path-mapping
  block to both scripts, but in `tts-openai.mjs` the new
  block ran at script-load time and referenced `CLI_TO_PATH`
  which was declared *below* it in the file. JavaScript's
  `const` has temporal-dead-zone semantics — the script
  crashed at import with
  `ReferenceError: Cannot access 'CLI_TO_PATH' before
  initialization` and never reached the body-assembly stage.
  The MiniMax script was unaffected because it already
  declared `CLI_TO_PATH` at the top of the file (line 248)
  before the `--config` block (line 312). The OpenAI script
  had `CLI_TO_PATH` as a sibling of the CLI scalar loop
  (line 252), which was *after* the `--config` block — the
  hotfix reordered the two declarations. The live test C
  (provider=openai, voice=coral) caught it: the agent replied
  in text instead of voice, and `synth.ts` logged
  `tts failed error="...tts-openai.mjs..."` immediately
  after `tts spawn` (44ms failure = script didn't even
  start). The fix: move the `const CLI_TO_PATH = { ... }`
  declaration to just after `const body = { ...DEFAULTS };`
  so it's in scope before the `--config` block runs. Smoke
  stage 23 (new) pins the contract: spawns `tts-openai.mjs`
  with a fake API key, asserts the body has all 5 fields
  (`model`, `voice`, `speed`, `instructions`, `response_format`)
  at the top level. Stage 23 would have caught the TDZ
  error before the live test did. **Lesson: when adding
  blocks that reference top-level constants to a script
  with imperative (non-function-wrapped) top-level code,
  verify the constants are declared above the new block.
  The MiniMax-vs-OpenAI difference in declaration order is
  a real source of risk; future script edits should pick
  one convention and stick to it.**

The plan's "Open questions" §1-6 are all closed: sub-block wins
on per-key merge (1), top-level `voice` / `model` not yet marked
deprecated in v0.3.0 — v0.4.0 task (2), reader is dumb / writer
is smart (3), `ProviderConfig = { [field: string]: unknown }` (4),
zero migration for v0.1.0 operators (5), v0.2.0-first ordering
still recommended for production deployments but v0.3.0 ships
config-only (6).

---

### v0.4.0 — UI-driven speech parameters + schema-driven defaults

> **Note (2026-08-24, post-upgrade + post-stage-1):** This section
> was drafted before the operator upgraded to `@llblab/pi-telegram@0.39.1`
> on 2026-08-24. Upstream v0.38.0 removed the `voice.sendTranscript`
> config + `getTelegramVoiceSendTranscript()` helper +
> provider-returned `transcriptText` field, so the v0.1.0-v0.3.0 work
> targeted a now-deleted feature. The v0.4.0 work has three scopes:
> (a) **migration** to the new upstream contract (drop the
> `getTelegramVoiceSendTranscript` import, change `synthesizeOgg`
> return type from `{ audioPath, transcriptText? }` to `string`,
> drop smoke stages 7+8) — shipped 2026-08-24; (b) **stage 1 —
> `composeWithText: "auto"` telegram.json-driven text+voice
> composition** — shipped 2026-08-24 (see the Progress table row
> "v0.4.0 stage 1"); (c) **stage 2 — the form-driven UI** below
> (per-provider sub-views + save dialog + `applyInstallDefaults()`)
> is the next deliverable.
>
> **Important UX caveat (v0.4.0 stage 1):** the v0.1.0 "voice
> message with a text caption" UX is **not achievable** via the
> public upstream API — upstream removed the caption support
> entirely. The closest we can do is **text first, then voice as
> two adjacent messages** in the same chat. This is the
> upstream's "explicit agent composition" pattern (per the v0.38.0
> changelog). If the operator wants the same-frame caption UX back,
> file an upstream feature request for a public
> `sendTelegramVoice({ audioPath, caption, ... })` API.
>
> **`schema.json` was shipped ahead of v0.4.0**, on 2026-08-24,
> after the v0.3.0 live-test cycle surfaced the full surface
> (see "deltas from this plan" §v0.3.0 and the v0.3.0 sub-block
> Acceptance matrix in this section). The v0.4.0 work that remains
> is the form-driven UI surface (`ui-schema.ts` +
> `applyInstallDefaults()`) and the deprecation note on top-level
> `voice` / `model`. The schema itself is v0.3.0 deliverable;
> v0.4.0 will bump `version: 1` to `2` if the form-driven UI adds
> new fields that need schema versioning. Stage 1 added the
> `composeWithText` field to the schema (Draft 2020-12,
> `enum: ["off", "auto"]`, `default: "off"`).**

**Goal:** the operator can change voice / model / instructions / speed
/ etc. from the Telegram UI, no `telegram.json` editing required.
The package also ships a JSON schema that drives the form layout
**and** seeds the package's defaults into `telegram.json` at install
time (per the operator's "defaults are set upon installation"
direction, mirroring the historical `pi-voice-telegram.schema.json`
idiom in `DESIGN-INTENT.md` §3 + the upstream bridge's
`@llblab/pi-telegram` settings menu which renders schema-driven
forms for built-in fields).

**Section growth (v0.2.0 → v0.4.0):**

- Settings submenu gains **per-provider sub-views**. Each sub-view
  renders the form fields for that provider (voice list, model list,
  speed, instructions, etc.).
- **Save** button writes the form to
  `telegram.json#extensions["pi-telegram-tts"]` via atomic write
  (temp file + rename, same pattern as
  `pi-telegram-stt/telegram-config.ts:174-202`'s `saveEchoConfig`).
- The form is generated from a small **per-provider schema** in
  `ui-schema.ts`. Adding a field = adding it to the schema, not to
  the section code. The schema is the same `ts-json-schema`-style
  shape the upstream bridge uses to drive its own settings UI (the
  voice-reply mode, model list, etc. all follow this pattern).

**Schema-driven defaults at install time:**

- The package ships `extensions/pi-telegram-tts/schema.json` with
  the same shape as the historical `pi-voice-telegram.schema.json`
  documented in `docs/DESIGN-INTENT.md` §3 (a JSON Schema with
  `_hint`, `$schema`, field types, and defaults). The schema is
  bundled in the npm `files` so the operator's editor (VS Code /
  IntelliJ) gets inline validation from the moment `telegram.json`
  is opened.
- On package install (npm `postinstall` hook, or on first
  `pi-telegram` startup via the section's `getLabel()` reading
  the schema), the defaults are applied to
  `telegram.json#extensions["pi-telegram-tts"]` if the block is
  absent. The writer is the same atomic temp+rename as
  `saveSynthConfig`. **This eliminates the v0.2.0 "no-file first
  toggle" edge case** — by the time the operator opens the
  section UI, `telegram.json` already exists with the schema's
  defaults (e.g. `provider: undefined`, `disabled: false`); the
  first toggle is a *change* to a known state, not a file
  creation.
- The `pi-telegram-stt` sister package adopts the same pattern in
  its own v0.9.0+ (its current `saveEchoConfig` writes the 4-field
  shape; the schema-driven install defaults are a v0.9.0+ addition
  for that package too — out of scope for `pi-telegram-tts` v0.4.0
  but a future consistency fix).

**Schema versioning** (cross-references the v0.1.0 "Open questions
deferred" §3 — resolved at v0.4.0): the schema declares
`"version": 1`; `loadTelegramConfig()` runs the migration if it
sees a stale version. This is the same pattern the upstream
bridge uses for its own config migrations.

**Voice / model lists:** hardcoded in v0.4.0 (small, finite sets
from the script's enums). Future versions could load from the TTS
provider's API at boot or on first use, but that's deferred —
the value is small relative to the API-call complexity. The
hardcoded lists live in `ui-schema.ts` alongside the form schema,
so adding a new voice = adding it to one file, not to the section
code.

**`ctx.open` for confirmation dialogs:** the section's
"Save → apply" flow opens a confirmation dialog
(`ctx.open({ text: "<b>Apply new TTS settings?</b>...", replyMarkup:
...})`) before writing. Per `docs/sections.md` §9.4, `ctx.open`
sends a standalone chat message (no auto-Back), and `ctx.deleteMessage()`
cleans it up after the operator picks Yes / No. This is the
upstream-canonical pattern for destructive or hard-to-undo
actions; per `docs/ui-style.md` "Confirmation Dialogs", the
question is bold-text-only (no emoji in the question), the
emoji is on the buttons (`☑️ Yes, save` / `❌ No`).

**Upstream APIs used (v0.4.0 = v0.2.0 + section growth):**

| API | Source | Role |
|---|---|---|
| `registerTelegramSection` | `@llblab/pi-telegram/sections` | main menu + settings + per-provider sub-views |
| `ctx.edit` | (same) | re-render after save |
| `ctx.answerCallback` | (same) | save confirmation |
| `ctx.callbackData` | (same) | namespaced callbacks for save/cancel/field-change |
| `ctx.open` | (same) | confirmation dialog before apply |
| `ctx.deleteMessage` | (same) | cleanup the confirmation dialog after choice |
| `recordTelegramRuntimeEvent` | `@llblab/pi-telegram/outbound` | save-failure diagnostics |

**No new bridge APIs needed.** The section grows; the config
schema, the per-provider form schema, and the script invocation
are already in place from v0.3.0.

**Files added (v0.4.0):**

| File | Purpose | Lines (est.) |
|---|---|---|
| `extensions/pi-telegram-tts/ui-schema.ts` *(new)* | per-provider form schema (drives the section's settings sub-views) + hardcoded voice/model lists | ~120 |
| `extensions/pi-telegram-tts/schema.json` *(new, npm file)* | JSON Schema for `telegram.json#extensions["pi-telegram-tts"]`; drives editor validation + install-time defaults | ~60 |
| `extensions/pi-telegram-tts/section.ts` *(modified)* | grow settings submenu into per-provider sub-views; add save handler + `ctx.open` confirmation dialog | +100 |
| `extensions/pi-telegram-tts/telegram-config.ts` *(modified)* | add `applyInstallDefaults()` (atomic write of schema defaults if the block is absent) | +30 |
| `scripts/pi-telegram-tts-smoke-test.sh` *(modified)* | add stages 21-25 — schema validation, install-time defaults apply, form generation, save round-trip, confirmation dialog | +80 |

---

## Future expansion (upstream surface inventory)

These are deliberately deferred but **the API is already in v0.1.0's
peer-dep closure**, so adding any of them later is a single-package
change, not a public-API change. The user explicitly noted *"we can
use all the surface/API upstream provides for future expansion"* —
this is the inventory.

| Upstream API | Subpath | What it would enable | Candidate version |
|---|---|---|---|
| `registerTelegramCommand` | `@llblab/pi-telegram/commands` | `/tts_status` (visible, with emoji) and `/tts_test "hello"` (hidden) for in-Telegram smoke tests | v0.7.0 |
| `registerTelegramStatusLineProvider` | `@llblab/pi-telegram/status` | A row in the `/start` menu's compact status (e.g., `🎙️ TTS: minimax / Cantonese_PlayfulMan`) | v0.7.0 |
| `sendTelegramView` | `@llblab/pi-telegram/delivery` | "🎙️ Synthesizing Cantonese…" preview message while the script runs (better UX on slow networks) | v0.7.0 |
| `editTelegramView` | `@llblab/pi-telegram/delivery` | Edit the preview when synthesis finishes (`✅ sent voice`) | v0.7.0 |
| `deleteTelegramView` | `@llblab/pi-telegram/delivery` | Delete the preview on TTS failure | v0.7.0 |
| `registerTelegramActivityHandler` | `@llblab/pi-telegram/activity` | Observe `agent_end` → voice delivery; surface in `/telegram-status` diagnostics alongside the existing `recordTelegramRuntimeEvent` calls | v0.7.0 |
| `registerTelegramInboundHandler` | `@llblab/pi-telegram/inbound` | (Probably not needed; STT is `pi-telegram-stt`'s job) | n/a |
| `registerTelegramUpdateHandler` | `@llblab/pi-telegram/updates` | (Probably not needed; chat-ID stashing is `pi-telegram-stt`'s job) | n/a |
| `recordTelegramRuntimeEvent` | `@llblab/pi-telegram/outbound` | Already used in v0.1.0 for spawn failures | ✅ v0.1.0 |

**v0.1.0 does not hard-block any of these.** Adding a command, a status
line, or a delivery preview in v0.7.0 is a single-file addition to the
package — the bridge APIs and types are already there.

## Provider-metadata design (cross-cutting)

A 2026-08-24 architecture review covered what the upstream
`@llblab/pi-telegram` synthesis-provider surface looks like end-to-end
and whether a "first-class provider metadata" API would be valuable.
**Conclusion:** the upstream is intentionally minimal (*"pi-telegram
does not catalog speech providers"* — `docs/voice.md`), and the right
long-term answer is a `PiMediaProvider` abstraction at the
`pi-coding-agent` layer (TTS, STT, image, video, music) so any
consumer (Telegram, TTY, web, mobile) can query the provider's state
and capabilities. The v0.3.0 work doesn't need this — the
`telegram.json#extensions["pi-telegram-tts"]` sub-block + `schema.json`
is the operator's config UX, and the bridge's minimal surface is
enough. **The full design rationale is in
[`docs/PROVIDER-METADATA-ARCHITECTURE.md`](./PROVIDER-METADATA-ARCHITECTURE.md)**
(2026-08-24). File the upstream issue with the design sketch when
the v0.4.0 form-driven UI work needs metadata.

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
   `uploadVoiceFile` is the standard fix; defer to v0.7.0.

3. **Schema versioning.** *(resolved at v0.4.0)* v0.4.0's
   `schema.json` declares `"version": 1`; `loadTelegramConfig()`
   runs the migration if it sees a stale version. The same pattern
   the upstream bridge uses for its own config migrations.

4. **Per-profile config.** pi-telegram has profile-scoped config
   (`profiles.<name>.extensions`). Whether `pi-telegram-tts` should
   support per-profile provider choice is an open question; v0.1.0's
   reader is global. Defer until there's a concrete operator need.

5. **Pre-existing migration friction.** *(resolved)* The operator's
   current `telegram.json#outboundHandlers[0].template` continues to
   work in v0.1.0+ — the provider is a third-tier fallback in
   `lib/outbound-voice.ts:185-276`. To actually get the
   `sendTranscript: true` behavior, the operator clears the
   `outboundHandlers[0]` entry (so the provider is the sole TTS path)
   or, in v0.2.0+, toggles `disabled: true` in the section UI. The
   README documents the migration.

## File structure (final, after v0.4.0)

```
extensions/pi-telegram-tts/
├── index.ts                 # default export, lifecycle, provider registration
├── synth.ts                 # spawn tts-*.mjs + ffmpeg, return { audioPath, transcriptText? }
├── telegram-config.ts       # read/write extensions["pi-telegram-tts"] (incl. applyInstallDefaults)
├── section.ts               # registerTelegramSection (main menu + settings + per-provider sub-views + save dialog)
├── ui-schema.ts             # per-provider form schema (drives the section's settings in v0.4.0)
├── schema.json              # JSON Schema for telegram.json#extensions["pi-telegram-tts"] (editor validation + install defaults)
├── _logger.ts               # stderr logger (per-package self-containment)
├── package.json             # peer deps + pi.extensions
└── README.md                # install + config + migration + provider-arg reference
```

v0.1.0 ships the first 4 files (no `section.ts`, no `ui-schema.ts`,
no `schema.json`). v0.2.0 adds `section.ts`. v0.4.0 adds
`ui-schema.ts` + `schema.json`.

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
  (package shape, lifecycle, section UI shape). The OpenAI
  STT provider that previously lived at
  `extensions/pi-openai-stt/index.ts:96-110` is now bundled
  here as of v0.8.0 — same module-load registration pattern.
- `extensions/pi-telegram-stt/telegram-config.ts:174-202` — the atomic
  config write pattern (`saveEchoConfig`).
