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
| `PI-TELEGRAM-TTS-PLAN.md` | Forward-looking build plan for the `pi-telegram-tts` sister extension (v0.1.0 → v0.4.0), and the inventory of upstream surfaces we have access to for future expansion. |
| `PI-TELEGRAM-TTS-DESIGN.md` | Companion to the plan: design rationale, the 4 patterns to copy from `pi-telegram-extension-demo`, the 3 things the demo doesn't show, the v0.1.0 implementation sketch, the migration story, the gotchas. Read this when starting v0.1.0. |
| `PUBLISHING.md` | Full setup walkthrough for publishing the 3 sister packages to npm via GitHub Actions OIDC trusted publishing (plus the 2FA OTP fallback). |

## Companion repo

The repo's `AGENTS.md` is the canonical "how to work on this
package" guide for AI coding agents. Start there.
