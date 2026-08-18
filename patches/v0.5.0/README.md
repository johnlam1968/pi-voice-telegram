# v0.5.0 patch: synthesis provider reads from pi-voice-telegram.json

> **⚠️ DEPRECATED as of 2026-08-17 (v0.15.0+)**
>
> This patch is **fully superseded** by `pi-voice-telegram@0.15.0+`. The v0.15.0
> release ships the JSON-reading design natively in `synthesis-provider.ts` —
> no patch required on the cluster. The `pi-agent-john` cluster was
> upgraded from v0.5.0 + this patch to v0.16.1 on 2026-08-17 (see commit
> history on master). The patch is kept in git history for forensic
> reference; **do not apply it to any new cluster**.
>
> If you need to support an older cluster that can't be upgraded, see the
> "When to remove the patch" section below — but the cluster's
> `pi-sandbox` image rebuild + npm install is the right long-term fix.

## What this patches

In the published `pi-voice-telegram@0.5.0` (the version baked into the
`pi-sandbox` image), `synthesis-provider.ts` reads TTS defaults
(`tts.lang`, `tts.voice`, `tts.model`) only from environment
variables (`PI_MM_TTS_LANG`, `PI_MM_TTS_VOICE`, `PI_MM_TTS_MODEL`).
The companion settings file `~/.pi/agent/pi-voice-telegram.json` is
not consulted for TTS defaults.

This contradicts the design intent — the JSON file is the
operator-facing dial, env vars are a host-side runtime fallback.
The v0.8.0+ code (in the local repo) implements `JSON > env >
hardcoded`. v0.5.0 predates this and has only `env > hardcoded`.

This patch backports the v0.8.0+ design to v0.5.0. Apply it to
`pi-agent-jane` and `pi-agent-kate` (also on v0.5.0) for parity
with `pi-agent-john`.

## How to apply

```bash
# Find the agent's npm dir (usually the bind-mount target)
AGENT_NPM=~/.pi/agent/npm/node_modules/pi-voice-telegram

# Back up the original
cp "$AGENT_NPM/synthesis-provider.ts" "$AGENT_NPM/synthesis-provider.ts.bak"

# Copy the patched file
cp patches/v0.5.0/synthesis-provider.ts "$AGENT_NPM/synthesis-provider.ts"

# Restart the agent
docker restart <agent-name>
```

## What the patch does

Adds a 3rd resolution tier in the synthesis provider's default-fallback
chain. The full chain becomes:

1. Per-call option (e.g., `options.lang` from the agent's `synthesize_voice` tool call)
2. `telegram.json` `outboundHandlers[voice].defaults.{voice,lang,rate}` (bridge's per-handler defaults)
3. **`pi-voice-telegram.json` `tts.{voice,lang,model}` (NEW — the operator's preferred TTS defaults)**
4. `PI_MM_TTS_*` env vars (host-side runtime config)
5. Hardcoded constants (Cantonese_PlayfulMan / Chinese,Yue / speech-2.8-hd)

The JSON file is read on every synthesis call (same pattern as
`telegram.json`), so operator edits to the file take effect on the
NEXT bridge-driven voice reply, with no session restart. This is the
v0.14.0 hot-reload behavior for the synthesis path, available
without deploying v0.14.0.

## Why this is needed

If the operator wants to change TTS defaults (e.g., switch to
Japanese voice for language learning), they expect to edit the
companion settings file. But with the unpatched v0.5.0, the
synthesis provider ignores the file. The only way to make the
change is:
- Edit `docker-compose.yaml` and add the env var, OR
- Restart the agent with the env var set in the container

Both are intrusive. The patch makes the JSON file the source of
truth, matching the v0.8.0+ design.

## When to remove the patch

When `pi-voice-telegram@0.8.0+` is published to npm and the cluster
image is rebuilt with that version, the patch is no longer needed —
v0.8.0+ has the JSON-reading logic baked in. Until then, this
patch is the cleanest way to get the v0.8.0+ TTS-defaults behavior
on a v0.5.0 cluster.

## Verification

After applying the patch, send a voice message to the agent. The
bridge will auto-synthesize the agent's text reply. The synthesized
audio will use:

- Voice: from `pi-voice-telegram.json` `tts.voice` (or env var if absent, or hardcoded)
- Language: from `pi-voice-telegram.json` `tts.lang` (or env var if absent, or hardcoded)

Edit the JSON, send another voice message, and the audio should
reflect the new defaults without restarting the agent.

Check the synthesis path in the bridge's runtime events:
`~/.pi/agent/tmp/telegram/logs.jsonl` — entries under
`category: "pi-voice-telegram/tts"` should show successful
synthesizes with the new voice/lang.

## Voice ID catalog (from `MINIMAX-T2A-FINDINGS.md` §2b-bis + the official system voice ID catalog at `https://platform.minimaxi.com/docs/faq/system-voice-id`)

Verified-safe voices against `api.minimaxi.com/v1/t2a_v2` with
`model=speech-2.8-hd`:

| Voice ID | Notes |
|---|---|
| `Cantonese_PlayfulMan` | All-ASCII, no parens. **Default — safe.** |
| `Cantonese_GentleLady` | No parens, safe. |
| `Cantonese_CuteGirl` | No parens, safe. |
| `Cantonese_KindWoman` | No parens, safe. |
| `English_expressive_narrator` | Safe. |
| `Cantonese_ProfessionalHost（M）` (and other paren forms) | **DELETED FROM CATALOG** as of 2026-08-15 — returns 2054 even with byte-correct IDs. Do not use. |

### Japanese voices (15, all-ASCII, safe — 2026-08-17 catalog)

All Japanese voice IDs are pure ASCII (no parens, no §2a byte-trap
risk). The user can pick any of these for true Japanese TTS:

| Voice ID | Voice Name |
|---|---|
| `Japanese_IntellectualSenior` | Intellectual Senior |
| `Japanese_DecisivePrincess` | Decisive Princess |
| `Japanese_LoyalKnight` | Loyal Knight |
| `Japanese_DominantMan` | Dominant Man |
| `Japanese_SeriousCommander` | Serious Commander |
| `Japanese_ColdQueen` | Cold Queen |
| `Japanese_DependableWoman` | Dependable Woman |
| `Japanese_GentleButler` | Gentle Butler |
| `Japanese_KindLady` | Kind Lady |
| `Japanese_CalmLady` | Calm Lady |
| `Japanese_OptimisticYouth` | Optimistic Youth |
| `Japanese_GenerousIzakayaOwner` | Generous Izakaya Owner |
| `Japanese_SportyStudent` | Sporty Student |
| `Japanese_InnocentBoy` | Innocent Boy |
| `Japanese_GracefulMaiden` | Graceful Maiden |

For "true" Japanese TTS, the operator can set:
- `tts.voice: "Japanese_OptimisticYouth"` (or any from the table above)
- `tts.lang: "Japanese"`

The synthesis uses a Japanese speaker with Japanese pronunciation.
This is what `pi-agent-john` is configured with for the live test.
