# Consolidation plan execution prompt — copy-paste into a new session

> Drop this entire block as the first message in a new session.
> The session has no context from the brainstorm session, so the
> briefing is fully self-contained. The session should run the
> pre-flight, then the 5 phases, then live-test, then report
> results — no new design decisions are expected; the plan is
> already locked in.

---

I'm about to execute the consolidation plan in
`docs/CONSOLIDATION-PLAN.md` in the repo at
`/home/john/CodingProjects/pi-voice-telegram/`. The plan reduces
the active npm-package count from 4 to 2 by:

1. Subsuming `pi-openai-stt` into `pi-telegram-stt` (in-code
   abstraction; the `SttProvider` interface stays as a private
   seam inside `pi-telegram-stt`).
2. Merging `pi-voice-telegram-scripts` into `pi-telegram-tts`
   (the `tts-minimax` and `tts-openai` scripts become
   `pi-telegram-tts`'s `bin` field).
3. Deprecating the 3 superseded packages on npm
   (`pi-voice-telegram@0.16.12`, `pi-openai-stt`,
   `pi-voice-telegram-scripts`).

End state: 2 active packages (`pi-telegram-stt@0.8.0`,
`pi-telegram-tts@0.2.0`) + 3 deprecated. The repo loses 2
extension directories (`pi-openai-stt/`, `pi-voice-telegram-scripts/`)
and gains 1 smoke test (`scripts/pi-telegram-stt-smoke-test.sh`).

Your job is to execute the plan and report findings — no new
design decisions are expected. If the live test surfaces a real
bug, add a row to the relevant matrix (per the AGENTS.md
discipline) and propose a fix scope.

## What to read first (in this order)

1. `docs/CONSOLIDATION-PLAN.md` — the full plan, with phase-by-phase
   acceptance matrices, the file-by-file change list (Appendix C),
   and the exact `npm deprecate` messages (Appendix B). This is
   the spec.
2. `docs/PI-TELEGRAM-TTS-PLAN.md` (just the "Progress" table) —
   the latest shipped state (v0.1.0, v0.1.1, v0.1.2, the
   `echoEnabled → showTranscript` rename, the consolidation next).
3. `AGENTS.md` — the runtime surface, the testing instructions,
   and the development methodology (especially the
   "checklist/matrix discipline" section).

## Current state (pre-execution)

- `master` is at the v0.7.2 / v0.7.2-shipping commits from the
  prior session:
  - `feat(pi-telegram-tts): v0.1.0 — TTS synthesis provider,
    closes sendTranscript gap` (with the in-session callable-contract
    fix)
  - `chore(release): v0.7.1 — bump 4 sister packages`
  - `ci(workflow): publish 4 sister packages` (workflow fix
    adding the `pi-telegram-tts` step)
  - `feat(pi-telegram-stt): rename echoEnabled → showTranscript (v0.7.2)`
  - `ci(workflow): skip already-published versions` (the rerun
    fix that lets the publish workflow handle partial-publishes)
- Working tree is clean.
- `~/.pi/agent/telegram.json` is on the live-test config
  (cleared `outboundHandlers` + `extensions["pi-telegram-tts"]`
  block + `pi-telegram-stt.showTranscript: false` from the prior
  session's last test).
- The host's GitHub PAT has the `workflow` scope (added via
  `gh auth refresh -s workflow` in the prior session), so
  workflow-file changes push cleanly.
- The npm publish workflow uses OIDC trusted publishing; the
  first publish of a new package (or the first publish after
  trusted-publisher setup) may need a one-time npm OTP
  handshake. If EOTP errors appear, the user will configure the
  trusted publisher on npmjs.com; you re-run the workflow with
  `gh run rerun`.

## Pre-flight (run before Phase 1)

```bash
cd /home/john/CodingProjects/pi-voice-telegram

# 1. Working tree is clean
git status

# 2. All 4 active + 1 deprecated packages are on npm
for pkg in pi-voice-telegram pi-voice-telegram-scripts pi-openai-stt \
           pi-telegram-stt pi-telegram-tts; do
  v=$(npm view "$pkg" version 2>/dev/null)
  echo "  $pkg: $v"
done
# Expected: 0.16.12 / 0.1.2 / 0.3.2 / 0.7.2 / 0.1.2

# 3. The v0.7.2-era smoke tests still pass
bash scripts/pi-telegram-tts-smoke-test.sh --no-network
# Expected: 13/13 green

# 4. The publish workflow's OIDC re-run is healthy
unset GITHUB_TOKEN
gh run list --workflow=publish.yml --limit 3
# Expected: most recent run = v0.7.2 success
```

If any of the above fail, stop and report. The plan assumes the
v0.7.2 state is healthy.

## Execute the plan

Follow `docs/CONSOLIDATION-PLAN.md` phase by phase:

- **Phase 1** (5 min): `npm deprecate pi-voice-telegram@0.16.12`
  with the message in Appendix B. Update `AGENTS.md` to reflect
  the deprecation. No commit, no tag — `npm deprecate` mutates
  the registry directly.

- **Phase 2** (1-2 hours): the big one. Move
  `extensions/pi-openai-stt/openai-stt.ts` into
  `extensions/pi-telegram-stt/`, flatten the OpenAI config into
  `EchoConfig`, register the provider at module load in
  `pi-telegram-stt/index.ts`, write the new
  `scripts/pi-telegram-stt-smoke-test.sh` (6 stages), delete
  `extensions/pi-openai-stt/`, `npm deprecate pi-openai-stt`,
  update `AGENTS.md` + `docs/PI-TELEGRAM-TTS-PLAN.md` +
  `docs/UPSTREAM-API-COMPLIANCE.md`. Commit, bump
  `pi-telegram-tts@0.1.2 → 0.1.3` (no-content), tag `v0.8.0`,
  `git push --follow-tags`. Watch the workflow; if `pi-telegram-tts`
  fails with EOTP, ask the user to configure trusted publishing on
  npmjs.com and re-run.

- **Phase 3** (1-2 hours): the smaller one. Move
  `tts-minimax.mjs` and `tts-openai.mjs` from
  `extensions/pi-voice-telegram-scripts/` into
  `extensions/pi-telegram-tts/`, drop `fw-openai-sts.ts` and
  `bin/fw-openai-sts` (replaced by the system service), add the
  `bin` field to `pi-telegram-tts/package.json`, simplify
  `resolveScriptPath` in `synth.ts`, add smoke stage 14 (bundled
  scripts exist), delete `extensions/pi-voice-telegram-scripts/`,
  `npm deprecate pi-voice-telegram-scripts`, update `AGENTS.md`
  and `docs/PI-TELEGRAM-TTS-PLAN.md`. Commit, bump
  `pi-telegram-stt@0.8.0 → 0.8.1` (no-content), tag `v0.8.1`,
  `git push --follow-tags`.

- **Phase 4** (30 min): live test. After both releases, restart
  `pi` on the host (the dev shim at
  `~/.pi/agent/extensions/pi-telegram-tts.ts` re-exports the
  source, so no npm install is needed for the live test — just
  restart `pi`). Send a voice message to
  `@pimon_on_host_2026bot`. Verify:
  - STT works (now in `pi-telegram-stt`, the in-package OpenAI
    client) — check `tail -f /tmp/pi.stderr.log` for
    `[pi-telegram-stt/stt] transcribe ok chars=N`
  - TTS works (now in `pi-telegram-tts`, with the bundled scripts) —
    check for `[pi-telegram-tts/synth] tts ok … sendTranscript=true`
  - The new `base_url` config is read (the operator's
    `~/.pi/agent/telegram.json` still has
    `extensions["pi-telegram-tt"]` set; verify
    `extensions["pi-telegram-stt"]` works after restart)

- **Phase 5** (30 min): documentation. Update the AGENTS.md
  "Migration" section. Confirm the deprecations are visible on
  npm (`npm view pi-voice-telegram deprecated`,
  `npm view pi-openai-stt deprecated`,
  `npm view pi-voice-telegram-scripts deprecated`).

## Acceptance criteria (per phase)

The plan has its own acceptance matrices in
`docs/CONSOLIDATION-PLAN.md` (one per phase, "every bullet →
smoke stage or deferral" per AGENTS.md). The summary:

- **Phase 1**: `npm deprecate` exit 0; `npm view … deprecated`
  shows the message; AGENTS.md greps confirm.
- **Phase 2**: all 6 stages of the new
  `pi-telegram-stt-smoke-test.sh` pass; `pi-telegram-stt@0.8.0`
  published to npm; `pi-openai-stt` deprecated; no
  `pi-openai-stt` directory in the repo.
- **Phase 3**: all 14 stages of the updated
  `pi-telegram-tts-smoke-test.sh` pass; `pi-telegram-tts@0.2.0`
  published to npm; `pi-voice-telegram-scripts` deprecated; no
  `pi-voice-telegram-scripts` directory in the repo.
- **Phase 4**: live test passes end-to-end on the host (voice in,
  voice reply with caption out).
- **Phase 5**: all 3 deprecations visible on npm; AGENTS.md
  updated.

## Reference

- **Plan**: `docs/CONSOLIDATION-PLAN.md` (the spec — read this
  first, before anything else)
- **Plan doc history**: `docs/PI-TELEGRAM-TTS-PLAN.md` (the
  v0.1.0 → v0.4.0 plan; the "Progress" table has the latest
  shipped state)
- **AGENTS.md**: repo-root runtime surface + testing instructions
- **Latest published state**: `pi-telegram-tts@0.1.2` (TTS
  provider, with the bridge callable-contract fix from the
  v0.1.1 in-session fix), `pi-telegram-stt@0.7.2` (STT
  orchestrator, with the `echoEnabled → showTranscript` rename),
  `pi-openai-stt@0.3.2`, `pi-voice-telegram-scripts@0.1.2`,
  `pi-voice-telegram@0.16.12` (deprecated v0.19.0 split).
- **Live-test prompt from prior session**:
  `/tmp/live-test-prompt.md` — useful as a template; the live
  test for the consolidation uses the same shape.

## How to do the work

- The host has the OIDC trusted publishing set up for all 4
  active packages (configured on npmjs.com during the v0.7.2
  session). New releases publish via the workflow on tag push.
- The host's GitHub PAT has the `workflow` scope (added via
  `gh auth refresh -s workflow` in the v0.7.2 session). Changes
  to `.github/workflows/publish.yml` push cleanly.
- The publish workflow already has the "skip if version already
  on npm" logic from the v0.7.2 session, so no-content
  re-bumps publish cleanly (the 3 already-published packages
  get a skip notice; the new one publishes).
- Smoke tests: `bash scripts/<pkg>-smoke-test.sh [--no-network]`.
  Use `--no-network` for fast CI runs; full mode for the
  pre-publish gate.
- The host's `pi` is currently running (last restart was for the
  v0.7.2 tests). After Phase 2 + Phase 3 are committed, restart
  `pi` to pick up the new source.
- The `~/.pi/agent/telegram.json` still has the prior session's
  live-test config (cleared `outboundHandlers` +
  `extensions["pi-telegram-tts"]` block +
  `extensions["pi-telegram-stt"].showTranscript: false` +
  `voice.sendTranscript: true` + `voice.replyMode: "always"`).
  After the consolidation, the operator's running pi will use
  the new flat config shape. For the live test, just restart `pi`
  and send a voice message — the new code reads the existing
  config.

## When to stop and report

- Any of the 4 phases produces a red signal (smoke failure,
  publish failure that you can't resolve, live-test failure that
  you can't diagnose). Add a row to the relevant matrix
  (per AGENTS.md "second gap caught" precedent) and propose a
  fix scope.
- The deprecation messages need clarification (e.g., the
  operator wants different wording).
- The live test surfaces a bug that needs a design decision
  (call the user).

Otherwise, just execute the plan and report a summary at the end:
"Phase 1 ✓, Phase 2 ✓, Phase 3 ✓, Phase 4 ✓, Phase 5 ✓ — 2
active packages on npm, 3 deprecated, all smoke + live tests
green, AGENTS.md migration section added."
