# User-facing docs

This directory holds the **operator-facing** reference docs for
`pi-voice-telegram`. Investigation notes, superseded artifacts,
and design history live in `../archive/` — see
`../archive/README.md` for the full index.

## What's here

| File | Topic |
|---|---|
| `DEBUGGING.md` | Full log surface map, daily `dev-status.sh` / `dev-watch.sh` usage, correlation tips. The first stop when a voice test fails. |
| `DESIGN-INTENT.md` | Why the package is shaped the way it is: single-shell-script-per-provider TTS pipeline, install-time provider decision, observability via stderr. The "we said no to X because Y" record. |
| `TTS-VIA-OUTBOUND-HANDLERS.md` | The integration doc for swapping TTS providers in `telegram.json#outboundHandlers[0].template`. Shows both MiniMax and OpenAI examples. |
| `UPSTREAM-API-COMPLIANCE.md` | Periodic audit: which stable public APIs of `@llblab/pi-telegram` and `@earendil-works/pi-coding-agent` the extensions use, and where local code diverges. Re-run when an upstream ships a new public API membrane. |
| `PI-TELEGRAM-TTS-PLAN.md` | Forward-looking build plan for the `pi-telegram-tts` sister extension (v0.1.0 → v0.5.0), and the inventory of upstream surfaces we have access to for future expansion. The plan's `## Progress` table + the per-version Acceptance matrices are the live source of truth. v0.1.0 / v0.2.0 / v0.23.0 are SHIPPED; v0.3.0 is drafted (per-provider sub-block via `--config` tempfile, no script changes). |
| `PI-TELEGRAM-TTS-DESIGN.md` | Companion to the plan: design rationale, the 4 patterns to copy from `pi-telegram-extension-demo`, the 3 things the demo doesn't show, the v0.1.0 implementation sketch, the migration story, the gotchas. **Historical** (v0.1.0; updated 2026-08-23 to reflect the v0.2.0 scripts-bundle + a v0.3.0 context note). The live design lives in the plan. |
| `PROVIDER-METADATA-ARCHITECTURE.md` | Design notes from the 2026-08-24 architecture review: the upstream is intentionally minimal ("provider is opaque"); the right long-term answer is a `PiMediaProvider` abstraction at the pi-coding-agent layer; the v0.3.0 work ships without upstream changes. File the upstream issue when the v0.4.0 form-driven UI needs metadata. |
| `PUBLISHING.md` | Full setup walkthrough for publishing the **2 active sister packages** (`pi-telegram-stt@0.8.x` + `pi-telegram-tts@0.2.x`) to npm via GitHub Actions OIDC trusted publishing (plus the 2FA OTP fallback). The 3 deprecated packages (`pi-voice-telegram`, `pi-openai-stt`, `pi-voice-telegram-scripts`) are de-deprecated only via the npm web UI, not via the workflow. |

## Companion repo

The repo's `AGENTS.md` is the canonical "how to work on this
package" guide for AI coding agents. Start there.
