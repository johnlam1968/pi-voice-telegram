# Archive

Historical and reference material for `pi-voice-telegram`, kept in
the repo for traceability but excluded from `npm install` (see
`package.json#files`).

This directory exists to keep the runtime repo small while preserving
investigation findings, superseded test artifacts, and design history
that would otherwise clutter the working tree.

## What's here

### `archive/PLAN.md`

The full design history of the project, including the TTS
orchestrator-vs-`outboundHandlers` refactor, the OpenAI 2000-token
bug investigation, the MiniMax three-endpoint discovery, the
upstream issue (llblab/pi-telegram#222), and the early extension
iterations. Superseded as a working document by `docs/PLAN.md`
additions, but kept here for the full chronology.

### `archive/UPSTREAM-ISSUES/`

Bug filings against the upstream bridge
(`llblab/pi-telegram`). One entry: the
"Telegram update journal has a revision gap" issue
(`pi-telegram-journal-revision-gap.md`), filed as upstream
issue #222. Kept for reference; the fix lives in the upstream repo.

### `archive/docs/`

**Tracked** investigation write-ups that used to live in `docs/`:

| File | Topic |
|---|---|
| `MINIMAX-T2A-OPENAPI.md` | Verbatim MiniMax T2A OpenAPI spec, captured 2026-08-21. Can be regenerated from the upstream API reference. |
| `OPENAI-TTS-OPENAPI.md` | Verbatim OpenAI `/v1/audio/speech` page, captured 2026-08-21. |
| `OPENAI-TTS-FINDINGS.md` | Operator's findings on the 2000-token input limit, the 6 output formats, and the auto-retry implementation. The 2000-token fix is the most important fact here. |

**Untracked** (gitignored) — these are reflections of the agent-john
workspace's investigation notes, replaced locally from the agent's
`/workspace` mount as needed:

| File | Topic |
|---|---|
| `MINIMAX-T2A-FINDINGS.md` | MiniMax T2A HTTP endpoint quirks: byte-trap voice IDs, broken `opus` format, model routing between `/v1/text_to_speech` and `/v1/t2a_v2`, the `Cantonese_ProfessionalHost` stoplist, safe fallback voices. |
| `TELEGRAM-VOICE-ECHO-FINDINGS.md` | Telegram voice echo pipeline: bridge template placeholder fix, the `sendTranscript` quirk, programmatic vs template voice handlers. |
| `CODE-FLOW.md` | End-to-end code flow: how an inbound Telegram voice becomes an STT transcript echo back to the user. |
| `PI-TELEGRAM-BRIDGE-NOTES.md` | Notes on the bridge's public API contract: `registerTelegramVoiceTranscriptionProvider`, `registerTelegramVoiceSynthesisProvider`, `outboundHandlers`, `recordTelegramRuntimeEvent`. |

The untracked files are gitignored via `.gitignore` and replaced
locally with `docker cp` from the agent's workspace when refreshed.

### `archive/scripts/`

**Tracked** dev-only scripts that are not part of the runtime
contract:

| File | Topic |
|---|---|
| `build-voice-catalog.py` | Parses the MiniMax system-voice catalog markdown into `voices.json`. Run only when regenerating the voice catalog. |
| `live-test.sh` | End-to-end test of the v0.16.7 voice transcription provider against a real downloaded audio file. Superseded by the new `scripts/tts-*.mjs` smoke tests. |
| `test-v0.16.7-provider.ts` | Targeted unit test for the v0.16.7 provider. Superseded. |

## What's NOT here (kept in the working tree)

- All root `.ts` files — runtime entry and core logic
- `pi-voice-telegram.schema.json` — runtime config validation
- `voices.json` — runtime voice catalog
- `scripts/tts-minimax.mjs`, `scripts/tts-openai.mjs` — called by
  the bridge's `outboundHandlers[0].template` by absolute path
- `scripts/fw-openai-sts.ts` — installed to `~/.pi/agent/bin/`
  as the local STT shim; runtime-essential
- `scripts/dev-status.sh`, `scripts/dev-watch.sh` — daily debug kit
- `docs/DEBUGGING.md`, `docs/DESIGN-INTENT.md`,
  `docs/TTS-VIA-OUTBOUND-HANDLERS.md`, `docs/README.md` —
  operator-facing or actively-used docs
- `extensions/` — 3 sister extension packages
  (`pi-telegram-echo`, `pi-openai-stt`, `pi-telegram-settings`),
  each with its own `package.json`; installed independently

## Why the `files` field matters

`package.json#files` is a whitelist for what `npm install` / `npm pack`
will include. The current list is:

```json
"files": [
  "*.ts",
  "pi-voice-telegram.schema.json",
  "voices.json",
  "package.json",
  "README.md",
  "LICENSE"
]
```

Anything not listed is excluded by default. So this `archive/`
directory, the `extensions/` sister packages, `scripts/`, and
`docs/` are all **excluded from `npm install`** — even before this
reorganization. The cleanup here is about keeping the working tree
lean, not about npm-install behavior.

## Adding to the archive

If a new file is non-runtime (investigation notes, superseded
artifacts, design history), drop it under the appropriate
subdirectory and commit. No `package.json` or `.gitignore` change
needed — the whitelist already excludes the archive.
