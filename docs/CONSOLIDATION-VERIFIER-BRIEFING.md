# Consolidation verifier briefing — for the verifier agent

> This is the briefing the orchestrator hands to the **verifier**
> agent after the worker finishes. The verifier's job is to read
> the worker's output (the repo state, the npm state, the smoke
> results, the live-test logs) and report whether the acceptance
> criteria in `docs/CONSOLIDATION-PLAN.md` are met.
>
> **The verifier does NOT fix anything.** It reports findings
> only. The orchestrator decides what to do with the report
> (e.g., dispatch another worker to address gaps).

---

## Your scope

You are verifying the execution of the consolidation plan at
`docs/CONSOLIDATION-PLAN.md` in the repo at
`/home/john/CodingProjects/pi-voice-telegram/`.

The plan has 5 phases. Verify each phase against its acceptance
matrix. Report each finding with:
- **Pass / Fail / Partial** (clear status)
- **Evidence** (the file path, the npm query result, the smoke
  test output — anything concrete)
- **Suggestion** (what to do if Failed or Partial; do not
  implement it)

## What you have access to

- The repo at `/home/john/CodingProjects/pi-voice-telegram/`
  (read-only verification — do not edit).
- The npm registry (read-only via `npm view <pkg> [field]`).
- The GitHub Actions workflow runs (via `gh run list` /
  `gh run view <id> --log-failed`).
- The live-test logs at `/tmp/pi.stderr.log` and
  `~/.pi/agent/tmp/telegram/logs.jsonl` (read-only).
- The plan at `docs/CONSOLIDATION-PLAN.md` (the spec).

## What you should NOT do

- Do not edit any files.
- Do not run `npm publish`, `npm deprecate`, or any registry-
  mutating command. (Reading is fine.)
- Do not push to git, create tags, or dispatch GitHub Actions.
- Do not start, restart, or stop the `pi` agent process.
- Do not "fix" any failure. Just report.

## Verification checklist (per phase)

### Phase 1: deprecate `pi-voice-telegram@0.16.12`

- [ ] `npm view pi-voice-telegram@0.16.12 deprecated` returns the
      deprecation message from `docs/CONSOLIDATION-PLAN.md`
      Appendix B (paraphrased: "Deprecated by the v0.19.0 split.
      Install pi-telegram-stt and pi-telegram-tts instead…").
- [ ] `AGENTS.md` mentions the deprecation. Search for
      "deprecated" and "pi-voice-telegram" — at least one
      deprecation note should be present.

### Phase 2: subsume `pi-openai-stt` into `pi-telegram-stt`

**Code state**:
- [ ] `extensions/pi-openai-stt/` does NOT exist (directory
      gone, not tracked by git).
- [ ] `extensions/pi-telegram-stt/openai-stt.ts` exists.
- [ ] `extensions/pi-telegram-stt/index.ts` registers the OpenAI
      provider at module load: contains a `registerSttProvider`
      call (or equivalent) that registers an `OpenAiStt` (or
      equivalent) instance with id `"pi-openai-stt"`.
- [ ] `extensions/pi-telegram-stt/telegram-config.ts` exposes
      `loadEchoConfig()` (or equivalent) that returns a flat
      `EchoConfig` shape with `base_url?: string | string[]` and
      `apiKey?: string` fields.
- [ ] `extensions/pi-telegram-stt/package.json` has
      `version: "0.8.0"`.
- [ ] `extensions/pi-telegram-stt/package.json` does NOT have
      `"pi-openai-stt"` in `peerDependencies`.
- [ ] `extensions/pi-telegram-stt/README.md` documents the new
      flat config shape and includes a "Migration from 0.7.2"
      section showing the old vs new `telegram.json` block.

**Smoke test**:
- [ ] `scripts/pi-telegram-stt-smoke-test.sh` exists.
- [ ] It has 6 stages (count the `stage` references; should be
      1, 2, 3, 4, 5, 6 or equivalent).
- [ ] `bash scripts/pi-telegram-stt-smoke-test.sh --no-network`
      runs and exits 0.
- [ ] `bash scripts/pi-telegram-stt-smoke-test.sh` (full mode,
      needs network) runs and exits 0 — OR fails only on stage 6
      (the live round-trip) with a documented reason (e.g.,
      "no network" if the system service is unreachable, which
      is acceptable for a CI run).

**npm state**:
- [ ] `npm view pi-telegram-stt@latest version` is `"0.8.0"`
      (or higher — the workflow may publish a re-bump too).
- [ ] `npm view pi-openai-stt deprecated` returns the message
      from Appendix B.

**Live test** (if the operator did a Phase 4 test):
- [ ] `/tmp/pi.stderr.log` shows the STT pipeline firing under
      the new code: `[pi-telegram-stt/stt] transcribe start` →
      `[pi-telegram-stt/stt] transcribe ok` → `[pi-telegram-stt/stt] echo sent`
      (or `echo disabled, skipping` if `showTranscript: false`).
- [ ] The TTS pipeline still fires: `[pi-telegram-tts/synth] tts spawn` →
      `[pi-telegram-tts/synth] tts ok`.

### Phase 3: merge `pi-voice-telegram-scripts` into `pi-telegram-tts`

**Code state**:
- [ ] `extensions/pi-voice-telegram-scripts/` does NOT exist.
- [ ] `extensions/pi-telegram-tts/tts-minimax.mjs` exists.
- [ ] `extensions/pi-telegram-tts/tts-openai.mjs` exists.
- [ ] `fw-openai-sts.ts` and `bin/fw-openai-sts` are gone (the
      operator confirmed the system service replaces this).
- [ ] `extensions/pi-telegram-tts/package.json` has a `bin` field
      with both `"tts-minimax"` and `"tts-openai"` entries.
- [ ] `extensions/pi-telegram-tts/package.json` has
      `version: "0.2.0"`.
- [ ] `extensions/pi-telegram-tts/package.json` does NOT have
      `"pi-voice-telegram-scripts"` in `peerDependencies`.
- [ ] `extensions/pi-telegram-tts/package.json` has `"*.mjs"` (or
      equivalent) in the `files` field so the bundled scripts
      ship in the npm tarball.
- [ ] `extensions/pi-telegram-tts/synth.ts`'s `resolveScriptPath`
      no longer walks up to `../pi-voice-telegram-scripts/`. It
      should resolve `./tts-*.mjs` (dev) or fall back to PATH
      lookup (npm install).
- [ ] `extensions/pi-telegram-tts/README.md` documents the new
      `bin` exposure and includes a "Migration from 0.1.2"
      section.

**Smoke test**:
- [ ] `scripts/pi-telegram-tts-smoke-test.sh` has a stage 14
      that verifies the bundled scripts exist (a `test -f
      tts-minimax.mjs` or `existsSync` check at the new path).
- [ ] `bash scripts/pi-telegram-tts-smoke-test.sh --no-network`
      runs and exits 0 (14 stages now, with stages 6/7/8 skipped
      in this mode).
- [ ] `bash scripts/pi-telegram-tts-smoke-test.sh` (full mode)
      runs and exits 0 (14 stages, with all 3 network stages
      exercised).

**npm state**:
- [ ] `npm view pi-telegram-tts@latest version` is `"0.2.0"` (or
      higher).
- [ ] `npm view pi-voice-telegram-scripts deprecated` returns
      the message from Appendix B.

### Phase 4: live test on host

- [ ] The host's `pi` process was restarted at least once during
      Phase 4 (the operator's run history in the bridge state
      should show a fresh `pid` for the current session).
- [ ] The operator's `~/.pi/agent/telegram.json` has the new
      flat `extensions["pi-telegram-stt"]` shape (with `base_url`
      and `apiKey` at the top level, no separate
      `extensions["pi-openai-stt"]` block).
- [ ] A voice message was sent to `@pimon_on_host_2026bot` and
      `/tmp/pi.stderr.log` shows the full pipeline (STT → agent →
      TTS → voice reply with caption).

### Phase 5: documentation

- [ ] `AGENTS.md` has a "Migration" section (or similar)
      describing the v0.7.x → v0.8.0 / v0.1.2 → v0.2.0 move.
- [ ] `docs/PI-TELEGRAM-TTS-PLAN.md` Progress table reflects the
      new shipped state (v0.8.0 for pi-telegram-stt, v0.2.0 for
      pi-telegram-tts, consolidation row marked SHIPPED).
- [ ] `docs/UPSTREAM-API-COMPLIANCE.md` no longer lists
      `pi-openai-stt` as a separate peer dep.
- [ ] The 3 deprecations are visible on npm
      (`npm view <pkg> deprecated` returns the message for each).

## Output format

Write your findings to a markdown file at
`/tmp/consolidation-verification-report.md` AND print the
summary to stdout. The report should be structured as:

```markdown
# Consolidation verification report

**Worker run date**: <date>
**Verifier run date**: <date>
**Verdict**: PASS | FAIL | PARTIAL

## Summary

<one-paragraph verdict>

## Phase 1: deprecate pi-voice-telegram

**Status**: PASS / FAIL / PARTIAL

### Findings
- ✅ / ❌ / ⚠️ <finding>
  - Evidence: <concrete>
  - Suggestion: <what to do>

## Phase 2: subsume pi-openai-stt

<same structure>

## Phase 3: merge scripts

<same structure>

## Phase 4: live test

<same structure>

## Phase 5: documentation

<same structure>

## Overall recommendation

<orchestrator's next step: ship / fix N issues / escalate to user>
```

Then print a short version to stdout (one line per phase) and
exit. The orchestrator reads the file and decides what to do.

## What "verdict" means

- **PASS**: all checkboxes are green. The plan executed cleanly.
  Ship.
- **PARTIAL**: some checkboxes are yellow (warning) or red but
  non-blocking. The orchestrator can decide to ship with
  documented gaps, or dispatch a fix worker.
- **FAIL**: a critical checkbox is red (e.g., the live test
  failed, a required file is missing, the deprecation didn't
  land). The orchestrator should dispatch a fix worker; do not
  ship.

## What you should NOT include in the report

- Code suggestions (the orchestrator and worker handle code).
- New design ideas (the plan is locked).
- Restating the plan (the orchestrator already has it).
- Verbose explanations of how something works (a one-line
  description is enough).
