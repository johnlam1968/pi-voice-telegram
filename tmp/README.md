# `tmp/` — local-only code analysis artifacts

This directory holds **local-only** code-analysis artifacts that
should **NOT** be tracked in git. The convention:

- Anything in this directory matches `*` in `tmp/.gitignore` and is
  ignored. The gitignore file itself and this README are exceptions
  (tracked).
- Files here survive `/tmp/` cleanups (so future iterations can
  find the analysis) but don't pollute the git history.
- They're regenerable: the test scripts in `scripts/test-*.mjs` (the
  "real" tests) supersede anything in this directory.

## What's here

| File | What it is | Origin |
| --- | --- | --- |
| `test-merge.mjs` | Inline test of the schema-driven merge algorithm | v0.13.0 dev (Aug 17) |
| `test-reset.mjs` | Inline probe of `resetConfig` helper | v0.13.0 dev (Aug 17) |
| `test-config-io.mjs` | Inline probe of `config-io.ts` writeKey fix | v0.13.0 dev (Aug 17) |
| `pi-voice-telegram-v0.12.json` | Config snapshot at v0.12.0 baseline | v0.12→v0.13 dev (Aug 17) |
| `pi-voice-telegram-v0.14.json` | Config snapshot at v0.14.0 (hot-reload) | v0.14.0 dev (Aug 17) |
| `pi-voice-telegram-partial.json` | Partial config from an intermediate state | v0.14.0 dev (Aug 17) |

These are pre-v0.15 leftovers from when the test infrastructure was
ad-hoc. v0.15.0+ uses the structured tests in `scripts/`.

## Convention going forward

For new analysis that doesn't fit the structured test pattern (e.g.
a one-off investigation, a manual probe, a config snapshot from a
specific version):

1. Save it here with a descriptive name.
2. Don't worry about cleanup — `/tmp/` is a hot path for transient
   work, this dir is the cooler one for "I might want this later".
3. If a pattern repeats enough to be a real test, promote it to
   `scripts/test-<name>.ts` (the structured form, runnable via
   `live-test.sh`).
