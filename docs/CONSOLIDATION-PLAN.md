# Consolidation plan — 4 active packages → 2

> **Status:** DRAFT, awaiting execution. Drafted on 2026-08-23 after
> the v0.7.2 release shipped (`pi-telegram-stt@0.7.2` with the
> `echoEnabled → showTranscript` rename + the callable-contract
> fix from earlier in the session).
>
> **Origin:** brainstorm with the project maintainer on 2026-08-23.
> The current 4-active-package setup (pi-voice-telegram-scripts,
> pi-openai-stt, pi-telegram-stt, pi-telegram-tts) + 1-deprecated
> package (pi-voice-telegram@0.16.12) is over-decomposed for the
> operator's single-backend reality. The user controls the STT
> system service; the registry/plugin abstraction at the npm
> package level is YAGNI.
>
> **Follows the AGENTS.md "every plan bullet → smoke stage or
> explicit deferral" discipline.** Each phase below has its own
> acceptance matrix.

---

## End state

**2 active packages** (from 4):

| Package | Version | Purpose |
|---|---|---|
| `pi-telegram-stt` | 0.8.0 | STT orchestrator + 🎙️ echo section + bundled OpenAI-compatible STT provider (in-code abstraction for future backends) |
| `pi-telegram-tts` | 0.2.0 | TTS synthesis provider + bundled `tts-minimax` / `tts-openai` scripts (via `bin` field) |

**3 deprecated packages** (no source change, just `npm deprecate`):

| Package | Version | Deprecation reason |
|---|---|---|
| `pi-voice-telegram` | 0.16.12 | Old monolithic; split in v0.19.0 |
| `pi-voice-telegram-scripts` | 0.1.2 | Scripts moved into `pi-telegram-tts` |
| `pi-openai-stt` | 0.3.2 | HTTP client moved into `pi-telegram-stt` |

**Repo structure** (after the refactor):
```
extensions/
├── pi-telegram-stt/             # orchestrator + bundled STT provider
│   ├── index.ts
│   ├── echo-handler.ts
│   ├── echo-section.ts
│   ├── telegram-config.ts
│   ├── openai-stt.ts            # ← moved from pi-openai-stt
│   ├── stt-provider.ts          # in-package interface (seam for future backends)
│   ├── _logger.ts
│   ├── package.json             # peer dep on pi-openai-stt REMOVED
│   └── README.md
└── pi-telegram-tts/             # synthesis provider + bundled scripts
    ├── index.ts
    ├── synth.ts
    ├── telegram-config.ts
    ├── _logger.ts
    ├── tts-minimax.mjs          # ← moved from pi-voice-telegram-scripts
    ├── tts-openai.mjs           # ← moved from pi-voice-telegram-scripts
    ├── package.json             # bin field added; peer dep on scripts REMOVED
    └── README.md
```

`extensions/pi-voice-telegram-scripts/` → **deleted**. `extensions/pi-openai-stt/` → **deleted**.

---

## Phase 1: Deprecate the old monolithic (A)

### 1.1 `npm deprecate` command

```bash
npm deprecate pi-voice-telegram@0.16.12 \
  "Deprecated by the v0.19.0 split. Install pi-telegram-stt and pi-telegram-tts instead. The monolithic package has been split into the sister extensions in the repo's extensions/ directory."
```

### 1.2 Update `AGENTS.md`

The "three sister extensions" / "two sister extensions" / runtime-surface intro should reflect the deprecation. See the AGENTS.md changes in the appendix below.

### Acceptance

- `npm view pi-voice-telegram@0.16.12 deprecated` shows the message
- `AGENTS.md` greps confirm the new wording

No code change. No version bump. No commit. No smoke update. The `npm deprecate` command mutates the npm registry directly; it doesn't touch the repo.

---

## Phase 2: Subsume `pi-openai-stt` into `pi-telegram-stt` (Option 2 from the prior brainstorm)

This is the bigger change. The user picked **Option 2** (in-code abstraction, no separate npm package): the `SttProvider` interface stays as a thin in-package seam, the in-process registry stays, but the OpenAI provider is bundled inside `pi-telegram-stt` (not a separate npm package).

### 2a. The code move

| Step | Action | File | Acceptance |
|---|---|---|---|
| 2a.1 | Move `extensions/pi-openai-stt/openai-stt.ts` → `extensions/pi-telegram-stt/openai-stt.ts` | both | New file exists; old file removed |
| 2a.2 | Move the `OpenAiStt` class's logger — either reuse the existing `extensions/pi-telegram-stt/_logger.ts` (preferred; one logger per package) or co-locate. Reuse the existing one. | both | No new logger file; `openai-stt.ts` imports from `./_logger.js` |
| 2a.3 | Update `extensions/pi-telegram-stt/openai-stt.ts`: change all relative-path imports to use `pi-telegram-stt`'s neighbors | the moved file | `import { makeLogger } from "./_logger.js"` (not from elsewhere) |
| 2a.4 | Update `extensions/pi-telegram-stt/index.ts`: at module load, instantiate `new OpenAiStt()` and `registerSttProvider(provider, { id: "pi-openai-stt" })`. The same id as before, so any operator with `stt_provider: "pi-openai-stt"` in their config keeps working without change. | index.ts | Registry contains the OpenAI provider after module load |
| 2a.5 | Update `extensions/pi-telegram-stt/echo-handler.ts`: the `transcribeAndMaybeEcho` function continues to look up via `getSttProvider(cfg.stt_provider)`. The provider now resolves to the in-package OpenAI client (id `"pi-openai-stt"`). No code change to the lookup path. | echo-handler.ts | Voice transcription still works end-to-end |
| 2a.6 | Move the `readTelegramJsonSttConfig` / `readOpenAiKeyFromAuthJson` logic from `extensions/pi-openai-stt/openai-stt.ts` into a new `loadOpenAiSttConfig()` function in `extensions/pi-telegram-stt/telegram-config.ts` | telegram-config.ts | Function exists; same `getAgentDir()` + `auth.json` resolution |
| 2a.7 | Update `extensions/pi-telegram-stt/telegram-config.ts` to merge the OpenAI config (`base_url`, `apiKey`) into the echo config. Two reasonable shapes: (a) flatten into `EchoConfig` directly, or (b) keep a nested `openaiStt: { base_url, apiKey }` sub-block. Pick (a) for simpler config — the operator's mental model is "pi-telegram-stt has these settings", and a flat shape matches that. | telegram-config.ts | `EchoConfig` has `base_url?: string \| string[]` and `apiKey?: string` |
| 2a.8 | Update `extensions/pi-telegram-stt/package.json`: remove `"pi-openai-stt": "*"` from `peerDependencies`; bump `version: "0.7.2" → "0.8.0"`; update the `description` to mention the bundled provider | package.json | `pi-openai-stt` not in peerDeps; version 0.8.0 |
| 2a.9 | Update `extensions/pi-telegram-stt/README.md`: document the new flat config shape (`base_url`, `apiKey` directly under `extensions["pi-telegram-stt"]`); add a "Migration from 0.7.2" section showing the old vs new config | README.md | New shape documented; migration shown |
| 2a.10 | **Add a smoke test for `pi-telegram-stt`**: a new `scripts/pi-telegram-stt-smoke-test.sh` mirroring the shape of `scripts/pi-telegram-tts-smoke-test.sh` (jiti-load, idempotency, fall-through paths, optional live round-trip). 6 stages: (1) jiti load + module-load registration, (2) provider in registry, (3) unconfigured fall-through, (4) disabled fall-through, (5) invalid base_url fall-through, (6) live round-trip against the system service if reachable (gated by `--no-network`) | `scripts/pi-telegram-stt-smoke-test.sh` (new) | All 6 stages pass locally; `--no-network` mode passes 5/6 with stage 6 skipped |

### 2b. Cleanup

| Step | Action | Acceptance |
|---|---|---|
| 2b.1 | `git rm -r extensions/pi-openai-stt/` | Directory gone; not tracked by git |
| 2b.2 | `npm deprecate pi-openai-stt "Subsumed into pi-telegram-stt@0.8.0+. Install only pi-telegram-stt; the OpenAI-compatible STT provider is now bundled. Existing configs: move the \`extensions[\\\"pi-openai-stt\\\"]\` block into \`extensions[\\\"pi-telegram-stt\\\"]\`."` | npm shows deprecation |
| 2b.3 | Update `AGENTS.md`: remove `pi-openai-stt` from the active extension list; add it to a "Deprecated" section near the v0.19.0 changelog | grep confirms |
| 2b.4 | Update `docs/PI-TELEGRAM-TTS-PLAN.md` v0.1.0 (or whichever section references the 4-package layout) to reflect the new 2-package layout | Plan reflects the new architecture |
| 2b.5 | Update `docs/UPSTREAM-API-COMPLIANCE.md` to drop `pi-openai-stt` from the cross-extension peer-dep audit | Compliance doc current |

### 2c. Release

| Step | Action | Tag |
|---|---|---|
| 2c.1 | Commit the code move (Phase 2a + 2b) | `feat(pi-telegram-stt): subsume pi-openai-stt@0.8.0 (bundled STT provider)` |
| 2c.2 | Commit the smoke test (Phase 2a.10) as a separate commit | `test(pi-telegram-stt): add 6-stage smoke test` |
| 2c.3 | Bump `pi-telegram-tts@0.1.2 → 0.1.3` (no-content bump, only to keep the publish workflow happy with this release) | (in either of the above commits, as a `chore:` commit) |
| 2c.4 | Tag `v0.8.0` | `v0.8.0` |
| 2c.5 | `git push --follow-tags` | Workflow publishes `pi-telegram-stt@0.8.0` + re-bumps others |

### 2d. Migration for existing operators

The `pi-openai-stt` config block in their `telegram.json` should move into `extensions["pi-telegram-stt"]`:

```diff
 "extensions": {
   "pi-telegram-stt": {
-    "showTranscript": true,
-    "stt_provider": "pi-openai-stt"
+    "showTranscript": true,
+    "base_url": ["http://127.0.0.1:8081/v1", "https://api.openai.com/v1"]
   },
-  "pi-openai-stt": {
-    "base_url": ["http://127.0.0.1:8081/v1", "https://api.openai.com/v1"]
-  }
 }
```

The migration is a 5-minute operator action: move the `base_url` block. The deprecated `pi-openai-stt` package can stay installed (no harm), but the new install path is just `pi install npm:pi-telegram-stt@latest`.

### 2e. Acceptance matrix

| Plan reference | What it requires | Smoke stage | Defer? |
|---|---|---|---|
| Phase 2 step 2a.1 | `openai-stt.ts` moved into `pi-telegram-stt/` | (file existence, not a smoke stage) | covered |
| Phase 2 step 2a.4 | OpenAI provider registered in the registry at module load | new smoke stage 1 (jiti load → registry has "pi-openai-stt") | covered |
| Phase 2 step 2a.5 | Voice transcription still works end-to-end | new smoke stage 6 (live round-trip against the system service) | covered |
| Phase 2 step 2a.6 | `loadOpenAiSttConfig()` returns base_url + apiKey | new smoke stage 2 (config merge) | covered |
| Phase 2 step 2a.7 | Echo config + OpenAI config merged (flat shape) | new smoke stage 2 | covered |
| Phase 2 step 2a.10 | Smoke test exists and runs | (the script itself, 6 stages) | covered |
| Phase 2 step 2b.2 | `pi-openai-stt` deprecated on npm | (npm registry, not a smoke stage) | covered |
| Section UI (stt_provider picker) | (no longer needed — only one provider; the section can drop the picker) | — | **deferred** (keep the picker for future backends; no action this release) |

---

## Phase 3: Merge `pi-voice-telegram-scripts` into `pi-telegram-tts` (B)

### 3a. The code move

| Step | Action | File | Acceptance |
|---|---|---|---|
| 3a.1 | Move `extensions/pi-voice-telegram-scripts/tts-minimax.mjs` → `extensions/pi-telegram-tts/tts-minimax.mjs` | both | New file exists; old file removed |
| 3a.2 | Move `extensions/pi-voice-telegram-scripts/tts-openai.mjs` → `extensions/pi-telegram-tts/tts-openai.mjs` | both | Same |
| 3a.3 | **Skip** `extensions/pi-voice-telegram-scripts/fw-openai-sts.ts` (replaced by the system service) — drop it entirely | the file | Not moved; just dropped |
| 3a.4 | **Skip** `extensions/pi-voice-telegram-scripts/bin/fw-openai-sts` (the bash wrapper) | the file | Dropped with the .ts above |
| 3a.5 | Update `extensions/pi-telegram-tts/package.json`: add `"bin": { "tts-minimax": "./tts-minimax.mjs", "tts-openai": "./tts-openai.mjs" }`; remove `"pi-voice-telegram-scripts": "*"` from `peerDependencies`; bump `version: "0.1.2" → "0.2.0"`; update the `files` field to include `*.mjs`; update the `description` to mention the bundled scripts | package.json | Bins exposed; peer dep removed; 0.2.0; mjs files in `files` |
| 3a.6 | Update `extensions/pi-telegram-tts/synth.ts`: `resolveScriptPath` switches from "walk up to `../pi-voice-telegram-scripts/tts-*.mjs`" to "look in the same dir as synth.ts". The npm-install fallback (`tts-minimax` / `tts-openai` on PATH) stays. Both paths continue to work. | synth.ts | Both dev and npm-install paths work; no walk-up |
| 3a.7 | Update `extensions/pi-telegram-tts/README.md`: document the new `bin` exposure (operators can run `tts-minimax --help` after install); add a "Migration from 0.1.2" section showing old vs new config / template path | README.md | New install path documented; migration shown |
| 3a.8 | Update `docs/PI-TELEGRAM-TTS-PLAN.md`: drop the `pi-voice-telegram-scripts` peer dep mention; document the bundled scripts | plan | Plan reflects the new architecture |
| 3a.9 | Add a new smoke stage to `scripts/pi-telegram-tts-smoke-test.sh` that verifies the bundled scripts exist (a small `existsSync` check at the new path) | smoke test | New stage passes |

### 3b. Cleanup

| Step | Action | Acceptance |
|---|---|---|
| 3b.1 | `git rm -r extensions/pi-voice-telegram-scripts/` | Directory gone; not tracked by git |
| 3b.2 | `npm deprecate pi-voice-telegram-scripts "Subsumed into pi-telegram-tts@0.2.0+. The TTS scripts are now bundled in the package; the \`tts-minimax\` and \`tts-openai\` bin names still work on PATH. Existing operators using \`outboundHandlers[0].template\`: update the absolute path to point at \`extensions/pi-telegram-tts/tts-minimax.mjs\` (or just use the bin name)."` | npm shows deprecation |
| 3b.3 | Update `AGENTS.md` accordingly | grep confirms |

### 3c. Release

| Step | Action | Tag |
|---|---|---|
| 3c.1 | Commit the code move (Phase 3a + 3b) | `feat(pi-telegram-tts): bundle tts-{minimax,openai}.mjs (v0.2.0)` |
| 3c.2 | Commit the smoke stage 14 addition (Phase 3a.9) as a separate commit | `test(pi-telegram-tts): add stage 14 — bundled scripts exist` |
| 3c.3 | Bump `pi-telegram-stt@0.8.0 → 0.8.1` (no-content bump for the publish workflow) | (in either of the above commits, as a `chore:` commit) |
| 3c.4 | Tag `v0.8.1` | `v0.8.1` |
| 3c.5 | `git push --follow-tags` | Workflow publishes `pi-telegram-tts@0.2.0` + re-bumps others |

### 3d. Migration for existing operators

The `outboundHandlers[0].template` references the script by absolute path. After this release, the path changes. Two options for the operator:

```diff
 "outboundHandlers": [
   {
     "type": "voice",
     "template": [
-      "/path/to/extensions/pi-voice-telegram-scripts/tts-minimax.mjs --out {mp3} --voice ... --model ...",
+      "/path/to/extensions/pi-telegram-tts/tts-minimax.mjs --out {mp3} --voice ... --model ...",
       "ffmpeg -y -i {mp3} ..."
     ]
   }
 ]
```

Or, since `pi-telegram-tts` now exposes the bins:

```diff
 "template": [
-  "/path/to/extensions/pi-voice-telegram-scripts/tts-minimax.mjs --out {mp3} ...",
+  "tts-minimax --out {mp3} ...",
   "ffmpeg -y -i {mp3} ..."
 ]
```

### 3e. Acceptance matrix

| Plan reference | What it requires | Smoke stage | Defer? |
|---|---|---|---|
| Phase 3 step 3a.1 + 3a.2 | `tts-minimax.mjs` + `tts-openai.mjs` moved into `pi-telegram-tts/` | (file existence) | covered |
| Phase 3 step 3a.5 | `bin` field in package.json exposes both names | (file existence) | covered |
| Phase 3 step 3a.6 | `resolveScriptPath` finds scripts in the new layout (dev + npm paths) | smoke stages 6-8 (the existing live round-trip stages) — should still pass | covered |
| Phase 3 step 3a.9 | New smoke stage 14 verifies bundled scripts exist | smoke stage 14 | covered |
| Phase 3 step 3b.1 | `pi-voice-telegram-scripts/` deleted | (file existence) | covered |
| Phase 3 step 3b.2 | `pi-voice-telegram-scripts` deprecated on npm | (npm registry) | covered |

---

## Phase 4: Live test the new architecture

After both releases (Phase 2 + Phase 3), restart `pi` with the new packages and run a 6-stage matrix on the host. The host has the dev shims; we don't need a fresh `pi install` for the live test — we just need to restart `pi` after the source code is updated.

| Test | What it verifies |
|---|---|
| Voice message → STT (now in `pi-telegram-stt`, the in-package OpenAI client) → agent → TTS (now in `pi-telegram-tts` with bundled scripts) → voice reply with caption | The new architecture works end-to-end |
| `base_url` config moved from `pi-openai-stt` to `pi-telegram-stt` block | The new config shape is read correctly |
| `tts-minimax` / `tts-openai` bins work on PATH (smoke stage 14) | The bundled scripts are callable by name |
| `pi install npm:pi-telegram-tts@0.2.0` test in a separate `~/.pi/agent/npm-test/` dir | The bin field actually exposes the scripts on PATH after npm install |

If the live test fails, add a row to the relevant matrix + a fix scope (per the AGENTS.md "second gap caught" precedent from the v0.1.0 session).

---

## Phase 5: Operator-facing deprecation messaging

| Step | Action |
|---|---|
| 5.1 | `npm deprecate pi-voice-telegram@0.16.12` (Phase 1) |
| 5.2 | `npm deprecate pi-openai-stt` (Phase 2) |
| 5.3 | `npm deprecate pi-voice-telegram-scripts` (Phase 3) |
| 5.4 | Add a "Migration" section to `AGENTS.md` (current vs new) so the operator's next session can find it |

The deprecations are persistent on the npm registry (don't expire), so this is one-time setup. Future `npm install` calls on the deprecated packages will warn the operator.

---

## Estimated timeline

| Phase | Effort | Calendar |
|---|---|---|
| 1: deprecate old monolithic | 5 min | today |
| 2: subsume `pi-openai-stt` | 1-2 hours (code move + smoke test) | today |
| 3: merge scripts | 1-2 hours (file moves + deprecate) | today |
| 4: live test on host | 30 min | after Phase 2 + 3 |
| 5: doc + deprecation messages | 30 min | after live test |

**Total: 4-6 hours of work, all on the Linux host, no MacBook detour.**

The publish workflow (the v0.7.2-era `ci(workflow): publish 4 sister packages` → now publishing 2) already has the `npm view <pkg>@<ver> ... skip` logic in place from the v0.7.2 session, so re-bumps for no-content changes publish cleanly.

---

## Risks and rollbacks

| Risk | Mitigation |
|---|---|
| `pi-telegram-stt@0.8.0` breaks STT on live install | The new `pi-telegram-stt-smoke-test.sh` covers the merge paths; if it fails before publish, don't tag |
| `pi-telegram-tts@0.2.0` breaks TTS on live install | The existing 13-stage smoke covers this; if it fails before publish, don't tag |
| Operator's existing config doesn't migrate | Deprecation messages on the 3 old packages include a pointer to the new install path; no auto-migration script (the operator's config changes are minimal and explicit) |
| The `stt_provider` config field becomes dead weight (only one provider) | Keep it for now (Option 2's promise — the seam is cheap). A future minor version can drop it. |
| `bin` field on the new `pi-telegram-tts` package might conflict with existing PATH entries named `tts-minimax` or `tts-openai` (vanishingly rare) | npm install puts the bin in `node_modules/.bin/`; it's only on PATH if the operator explicitly adds it. The risk is low; if it happens, the operator renames the bin in their local config. |

---

## Decisions made in the brainstorm (2026-08-23)

| Question | Decision |
|---|---|
| Single release vs two releases for Phases 2 + 3? | **Single release per phase** (each phase is a separate `v*` tag: `v0.8.0` for the subsume, `v0.8.1` for the scripts merge). Each is independently revertable. |
| New smoke test in same commit or separate? | **Separate commit** within the same release (per AGENTS.md discipline). |
| Section UI STT provider picker — keep or drop? | **Keep** (cheap, future-proof). |
| `stt_provider` config field — keep or drop? | **Keep** (cheap, future-proof). |
| `pi-voice-telegram` (old monolithic) — keep on npm or unpublish? | **`npm deprecate`** (the npm unpublish flow is gated; deprecation is the correct path for "we don't use this anymore but old operators may"). |
| `pi-openai-stt` and `pi-voice-telegram-scripts` — unpublish or deprecate? | **`npm deprecate`** (same reason). |

---

## Appendix A — AGENTS.md changes (per phase)

### Phase 1: deprecate `pi-voice-telegram`

The runtime-surface intro in `AGENTS.md` currently says "two sister extensions" / "three sister extensions" depending on the section. After Phase 1 + Phase 2 + Phase 3, the active list is:

- **`pi-telegram-stt`** — STT orchestrator + bundled OpenAI-compatible STT provider + 🎙️ echo section
- **`pi-telegram-tts`** — TTS synthesis provider + bundled `tts-minimax` / `tts-openai` scripts (via the package's `bin` field)

The `pi-voice-telegram@0.16.12` monolithic (split in v0.19.0) is deprecated on npm. The `pi-openai-stt` and `pi-voice-telegram-scripts` packages are also deprecated after their respective phases.

### Phase 2: subsume `pi-openai-stt`

The "Pi package peer dependencies" section needs updating. Currently:

```
- `pi-telegram-stt` peer-deps: `@earendil-works/pi-coding-agent`, `@llblab/pi-telegram`, `pi-openai-stt`
```

becomes:

```
- `pi-telegram-stt` peer-deps: `@earendil-works/pi-coding-agent`, `@llblab/pi-telegram` (no external provider peer; the OpenAI-compatible provider is bundled)
```

### Phase 3: merge scripts

The "runtime scripts" section currently has its own bullet for `extensions/pi-voice-telegram-scripts/`. That bullet goes away; the scripts are now mentioned under the `pi-telegram-tts` section.

---

## Appendix B — exact `npm deprecate` messages

```bash
# Phase 1
npm deprecate pi-voice-telegram@0.16.12 \
  "Deprecated by the v0.19.0 split. Install pi-telegram-stt and pi-telegram-tts instead. The monolithic package has been split into the sister extensions in the repo's extensions/ directory."

# Phase 2 (after Phase 2 code is committed and v0.8.0 is published)
npm deprecate pi-openai-stt \
  "Subsumed into pi-telegram-stt@0.8.0+. Install only pi-telegram-stt; the OpenAI-compatible STT provider is now bundled. Existing configs: move the \"pi-openai-stt\" extension block into \"pi-telegram-stt\"."

# Phase 3 (after Phase 3 code is committed and v0.8.1 is published)
npm deprecate pi-voice-telegram-scripts \
  "Subsumed into pi-telegram-tts@0.2.0+. The TTS scripts are now bundled in the package; the \"tts-minimax\" and \"tts-openai\" bin names still work on PATH. Existing operators using outboundHandlers[0].template: update the absolute path to point at extensions/pi-telegram-tts/tts-minimax.mjs (or just use the bin name)."
```

---

## Appendix C — file-by-file change list (for the executor)

This is the single most useful section for the next session. It's a flat list of every file that changes, with the action (move / edit / delete / create) and the target path.

```
# Phase 2 — subsume pi-openai-stt
# Code move
MOVE: extensions/pi-openai-stt/openai-stt.ts   -> extensions/pi-telegram-stt/openai-stt.ts
EDIT: extensions/pi-telegram-stt/index.ts       (register OpenAiStt at module load)
EDIT: extensions/pi-telegram-stt/telegram-config.ts  (add loadOpenAiSttConfig, flatten base_url + apiKey into EchoConfig)
EDIT: extensions/pi-telegram-stt/echo-handler.ts       (no behavior change; lookup path is the same)
EDIT: extensions/pi-telegram-stt/package.json    (bump 0.7.2 -> 0.8.0, drop pi-openai-stt peer dep)
EDIT: extensions/pi-telegram-stt/README.md       (document new config shape, add migration section)
# New test
CREATE: scripts/pi-telegram-stt-smoke-test.sh   (6 stages: jiti load, provider registered, unconfigured fallthrough, disabled, invalid base_url, optional live round-trip)
# Cleanup
DELETE: extensions/pi-openai-stt/               (whole dir: index.ts, _logger.ts, openai-stt.ts, package.json, README.md)
NPM: deprecate pi-openai-stt
EDIT: AGENTS.md                                  (drop pi-openai-stt from active list)
EDIT: docs/PI-TELEGRAM-TTS-PLAN.md              (drop pi-openai-stt references)
EDIT: docs/UPSTREAM-API-COMPLIANCE.md           (drop pi-openai-stt from peer-dep audit)
# Release
COMMIT + TAG: v0.8.0
PUSH: git push --follow-tags

# Phase 3 — merge scripts
# Code move
MOVE: extensions/pi-voice-telegram-scripts/tts-minimax.mjs  -> extensions/pi-telegram-tts/tts-minimax.mjs
MOVE: extensions/pi-voice-telegram-scripts/tts-openai.mjs   -> extensions/pi-telegram-tts/tts-openai.mjs
# (skip fw-openai-sts.ts and bin/fw-openai-sts — replaced by system service)
EDIT: extensions/pi-telegram-tts/synth.ts         (resolveScriptPath: look in same dir, no walk-up)
EDIT: extensions/pi-telegram-tts/package.json     (bump 0.1.2 -> 0.2.0, add bin field, drop scripts peer dep, add *.mjs to files)
EDIT: extensions/pi-telegram-tts/README.md        (document new bin exposure, add migration section)
EDIT: scripts/pi-telegram-tts-smoke-test.sh     (add stage 14: bundled scripts exist)
# Cleanup
DELETE: extensions/pi-voice-telegram-scripts/    (whole dir)
NPM: deprecate pi-voice-telegram-scripts
EDIT: AGENTS.md                                  (drop scripts from runtime scripts section)
EDIT: docs/PI-TELEGRAM-TTS-PLAN.md              (drop scripts peer dep mention)
# Release
COMMIT + TAG: v0.8.1
PUSH: git push --follow-tags
```
