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

## Companion repo

The repo's `AGENTS.md` is the canonical "how to work on this
package" guide for AI coding agents. Start there.
