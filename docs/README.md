# Reference docs

This directory holds technical-investigation write-ups from
`agent-john`'s workspace. The two files here are **untracked** —
they live in `docs/` for local reference but are excluded from
git (see `.gitignore`).

## What's here

| File | Source | Topic |
|---|---|---|
| `MINIMAX-T2A-FINDINGS.md` | `/workspace/` on `pi-agent-john` | MiniMax T2A HTTP endpoint quirks: byte-trap voice IDs, broken `opus` format, model routing between `/v1/text_to_speech` and `/v1/t2a_v2`, the `Cantonese_ProfessionalHost` stoplist, safe fallback voices. |
| `TELEGRAM-VOICE-ECHO-FINDINGS.md` | `/workspace/` on `pi-agent-john` | Telegram voice echo pipeline: bridge template placeholder fix, the `sendTranscript` quirk, programmatic vs template voice handlers. |

## Why untracked

These write-ups were authored by the agent (using the pi coding
agent itself) as a way to capture investigation findings. They
travel with the dev environment — they live in the agent's
`/workspace` mount and rotate as the agent's working dir changes.

The right home for them is somewhere persistent, but committing
them to git would clutter the diffs (these are long, opinionated
write-ups that change as the investigation evolves, not as the
code evolves). Tracking them as untracked is the right trade-off:
- Available locally when working in this repo
- Excluded from version control (no diff noise)
- Easy to refresh: `docker cp` the latest versions from the agent
  when needed

## Refreshing the files

To update with the latest copy from the agent:

```bash
docker cp pi-agent-john:/workspace/MINIMAX-T2A-FINDINGS.md docs/MINIMAX-T2A-FINDINGS.md
docker cp pi-agent-john:/workspace/TELEGRAM-VOICE-ECHO-FINDINGS.md docs/TELEGRAM-VOICE-ECHO-FINDINGS.md
```

The two files are large (~50KB and ~20KB) and contain detailed
endpoint behavior, voice ID catalogs, and bridge template
quirks — useful when debugging TTS or echo pipeline issues.

## When the underlying code is published

When `pi-voice-telegram@0.8.0+` is published and the agent cluster
upgrades, the relevant facts from these write-ups (voice ID
catalog, byte-trap warnings, model routing) should be folded into
the extension's code and docs. At that point these files can be
retired.

Until then, they're the canonical reference for the operator
working on the agent cluster.
