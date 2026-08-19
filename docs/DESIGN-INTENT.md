# `pi-voice-telegram` — design intent

A reader's digest of *why* the code looks the way it does. The authoritative
design history is [`PLAN.md`](../PLAN.md) (version-by-version, ~666 lines);
this doc condenses the *why* into one file for someone reading the code
without that context. Pair with:

- [`CODE-FLOW.md`](./CODE-FLOW.md) — code-level walkthroughs of the two main flows
- [`PI-TELEGRAM-BRIDGE-NOTES.md`](./PI-TELEGRAM-BRIDGE-NOTES.md) — bridge-vs-extension ownership split and the integration surface
- [`TELEGRAM-VOICE-ECHO-FINDINGS.md`](./TELEGRAM-VOICE-ECHO-FINDINGS.md), [`MINIMAX-T2A-FINDINGS.md`](./MINIMAX-T2A-FINDINGS.md) — empirical findings behind specific decisions

## 1. The elevator pitch

A **companion extension** for the [Pi coding agent](https://github.com/earendil-works/pi-mono)
that gives it a voice channel on Telegram. Sits in the agent's npm tree next
to the `@llblab/pi-telegram` bridge and registers itself via the bridge's
public API. Three responsibilities, all driven by separate concerns.

The extension does **not** ship its own daemon, socket, settings UI, or
deployment artifact. The bridge's `telegram.json` is the operator-facing
policy surface; the companion's own `pi-voice-telegram.json` is a strictly
opt-in capability dial. The cluster's existing `docker-compose.yaml` did not
need to change for the v0.6.0+ feature set, because the env-var fallback
layer was preserved (`PLAN.md:128-144`).

## 2. Three responsibilities, orthogonal gates

| Pillar | What it does | Gate | Registration |
|---|---|---|---|
| Outbound TTS | Synthesize the LLM's reply to OGG/Opus when the bridge says so | None | Always on (`index.ts:263-268`) |
| Inbound STT + echo | Transcribe every voice msg via whisper-server; send `🎙️ "..."` to the user; inject transcript into the agent prompt | `inbound.echoEnabled` (default **true**) | Opt-out (`index.ts:282-290`) |
| LLM tool surface | Up to 7 tools the LLM can call: `synthesize_voice`, `transcribe_audio`, `pi_voice_telegram_schema`, `pi_voice_telegram_config_{read,write,reset}`, `pi_voice_telegram_list_voices` | `llm_tools.exposed` (master) + `llm_tools.tools.<name>` (per-tool, v0.16.12+) | Opt-in, individually trimable (`index.ts:299-337`) |

The split is intentional. An operator might want `synthesize_voice` available
even when `voice.replyMode = "always"` (for ad-hoc voice, e.g. reading a file
aloud), and per-tool gates let them trim the LLM's prompt to reduce
decision-space confusion without disabling the whole surface
(`PLAN.md:34-40`, `pi-voice-telegram.schema.json:26-72`).

## 3. Configuration architecture: JSON > env > hardcoded, schema-driven

- **`pi-voice-telegram.json`** (companion) is the operator's primary dial;
  `$PI_MM_TTS_*` env vars are the cluster-deployment fallback; hardcoded
  constants are the floor. Every new release preserves defaults that match
  the previous release's effective behavior, so an operator who doesn't
  touch the new file gets the same experience as the prior version
  (`PLAN.md:128-144`).
- **`pi-voice-telegram.schema.json`** is the **source of truth** for field
  names, types, defaults. The `_hint` + `$schema` fields in the seeded file
  give editors (VS Code / IntelliJ) inline validation. The `config_reset`
  tool is **schema-driven** (v0.13.0+): it walks the schema, fills missing
  fields with schema defaults, and preserves operator values. The schema is
  bundled in the npm `files` so the LLM's `pi_voice_telegram_schema` tool
  can return it (`PLAN.md:146-188`, `index.ts:331-333`).
- **Hot-reload** via `fs.watch` on the **directory** (not the file) at 200ms
  debounce, because file-level watching detaches on Linux overlay / Docker
  FS. The watcher tears down all current registrations and re-registers from
  scratch, so every change is end-to-end consistent. Best-effort: if
  `fs.watch` fails (sandboxed env, no inotify), it logs and falls back to
  `session_start`-only behavior (`index.ts:354-389`, `PLAN.md:270-302`).

## 4. The headline recent change: v0.16.7 single-transcription redesign

Pre-v0.16.7, the inbound path had **two handlers** — an update handler that
downloaded + transcribed + cached, and an inbound handler that re-transcribed
on cache miss. The same audio could be transcribed twice, and the update
handler's own download could fail silently (an empty 200-OK from Telegram's
file endpoint → empty transcript → dropped echo).

v0.16.7 fixes both by registering as a single **transcription provider**
(`registerTelegramVoiceTranscriptionProvider`). The bridge now downloads the
file once (its well-tested path), calls our provider, and we return the
transcript — which the bridge includes in the agent's user message. The
update handler is reduced to a minimal stasher for the chat ID (which the
provider hook doesn't get, but the echo needs).

**Net effect**: one transcription, blocking UX (echo before LLM reply), no
double work, no silent failure (`echo.ts:1-62`, `index.ts:282-290`,
`docs/PI-TELEGRAM-BRIDGE-NOTES.md:91-120`).

## 5. The "synthesize → attach" two-step pattern for LLM-initiated voice

`synthesize_voice` writes an OGG/Opus file and returns the path. The agent
then calls the bridge's `telegram_attach` tool to deliver. The intent: keep
chat-target resolution, captioning, and multipart-upload concerns in the
bridge, where they belong. The extension does not try to know the chat ID.

This was a deliberate simplification over v0.1.0's plan for the extension
to ship its own outbound pipeline (`PLAN.md:38-40`, `PLAN.md:442`).

## 6. Self-describing config + LLM-friendly ergonomics

The LLM should never have to **guess** — guessing returns `2054` (a known
TTS error) and the agent has no recovery path. The surface area:

- `pi_voice_telegram_schema` — returns the bundled JSON Schema as text
  (v0.10.0+). The LLM can call it to discover knobs before suggesting edits
  (`PLAN.md:169-188`).
- `pi_voice_telegram_list_voices` — returns the embedded 327-voice × 24-language
  TTS catalog (v0.15.0+). Updated to nudge the LLM to call `list_voices`
  first when the user asks about voice/TTS/language changes
  (`index.ts:67-74`).
- `pi_voice_telegram_config_read` / `_write` / `_reset` — read/modify/reset
  the companion file. **Safety model**: `config_write` refuses to touch
  `$schema`, `_hint`, or any key not in the schema. v0.12.0 dropped the
  v0.11.0 `tools.writable` opt-in (it was operator-preference dressed up as
  a security boundary — a sufficiently capable LLM with `bash` + `write` can
  edit the file regardless; the container's filesystem permissions are the
  real boundary, not a JSON flag). v0.13.0 made `_reset` schema-driven.
  (`PLAN.md:223-238`)
- **Per-tool gates (v0.16.12)**: each of the 7 LLM tools is individually
  toggleable under `llm_tools.tools.<name>`. The intent is token economy
  and decision-space reduction. Defaults: all `true` when `exposed: true`,
  for back-compat with the v0.16.10 "everything on when exposed" behavior
  (`pi-voice-telegram.schema.json:37-46`).

## 7. Known design issues (the v0.16.7+ candidates)

`PLAN.md:469-573` is a self-critical review with 10 real issues. The three
most likely to surface in any code review that doesn't read PLAN:

- **`synthesis-provider.ts:137` — doc-vs-code drift on `rate`.** The
  docstring at the top of the file claims the layered default resolution
  includes `telegram.json.outboundHandlers[voice].defaults.rate`, but the
  code resolves speed as `Number(options?.rate ?? 1.0)`. The `defaults.rate`
  field is read off the file but never used. An operator who sets
  `defaults.rate = 1.5` gets `1.0`. Fix is 1 line in either direction.
- **`synthesis-provider.ts` — silent caption truncation.** When
  `text.length > 1024` and `voice.sendTranscript === true`, the caption is
  clipped to 1023 chars + `…` while the audio is the full text. The user
  sees a truncated caption but hears the full narration — a confusing
  mismatch. The truncation is silent (no runtime event). Fix: record
  `recordTelegramRuntimeEvent("pi-voice-telegram/tts", null, { phase: "caption-truncated", ... })`.
- **`echo.ts:163-165` + `echo.ts:269` — chat-ID lookup fragility.** The
  update handler stashes the chat ID by `voice-<message_id>.<ext>` (built
  from `fileNameFor(msg.message_id, ext)`). The provider looks it up by
  `file.fileName` (the name the bridge actually uses). If the bridge's
  naming convention differs from the deterministic name the update handler
  assumed, the echo is silently dropped. The v0.16.7 design moved the
  silent-failure mode from "empty transcript" (v0.16.6) to "name mismatch"
  — same shape, different root cause. **Verify empirically** before
  relying on the v0.16.7 e2e test.

Other candidates (deferred until observed at scale): no retry on transient
5xx; no STT result cache; `telegram.json` re-read on every call (cheap, but
cacheable by mtime if it ever matters).

## 8. Open design questions (deferred, not abandoned)

`PLAN.md:438-450` lists six. Worth knowing they exist before reviewing:

1. Should tool `promptGuidelines` adapt to `voice.replyMode` (different
   guidance for `hidden` vs `mirror`/`always`)?
2. Should there be a one-step TTS delivery if the bridge ever exposes
   `sendTelegramVoice(filePath, chatId?)` directly?
3. Should `inbound.echoTemplate` be configurable (currently hard-coded
   `🎙️ "<i>{transcript}</i>"`)?
4. Should there be a `/voice-status` slash command for debugging without
   a restart?
5. Finer-grained "silent mode" (transcript yes, echo no)?
6. Per-extension TTS defaults (model / voiceId / format) — could move
   from env vars into the JSON; not blocking.

## 9. Test & release flow

There is **no automated test runner** in the repo. Coverage is integration-only
and manual:

- `scripts/live-test.sh` — end-to-end against a running agent + bridge
  (requires `ffmpeg`, `whisper-server`, valid TTS creds). The maintainer's
  pre-publish gate.
- `scripts/test-v0.16.7-provider.ts` — provider-shape smoke test.
- Per-release verification on `pi-agent-john` and `pi-agent-jane` (the two
  running pi-cluster containers; see `PLAN.md:138-144`, `PLAN.md:213-224`,
  `PLAN.md:392-398` for the verification matrix).

The release/cluster-upgrade flow (`PLAN.md:426-436`):

1. `git tag -a vX.Y.Z` in this repo.
2. `npm publish` from the local repo root (auth via `~/.npmrc`).
3. Edit `pi-cluster/Dockerfile.pi` to bump `PI_VOICE_TELEGRAM_VERSION`.
4. Edit `pi-cluster/docker-entrypoint.sh` to bump the `npm:pi-voice-telegram@X.Y.Z`
   entry in `REQUIRED_PACKAGES`.
5. `docker build --no-cache` (the layer cache is a landmine here).
6. Stop the cluster, wipe the npm bind-mount dir, restart with the new image.
7. Remove obsolete `patches/v0.X.Y/` directories that the new version supersedes.

Caveat: `/home/john/pi-cluster/` is not a git repo, so Dockerfile + entrypoint
changes are local-only. Consider `git init`-ing it before the next upgrade
cycle.

## 10. How to use this doc

- **For a code review**: read §1–§3 first (intent), then §4 (the headline
  recent change) and §7 (the self-acknowledged issues). §6 is where most
  "is this a bug or a feature?" questions resolve.
- **For onboarding**: read §1, then jump to `docs/CODE-FLOW.md` for code-level
  walks, then `PLAN.md` for the version history.
- **For understanding the bridge integration**: `docs/PI-TELEGRAM-BRIDGE-NOTES.md`
  is authoritative; this doc only summarizes the split.
- **For extending the extension**: §3 (config layering) and §6 (LLM tool
  ergonomics) are the constraints. New config keys go in the schema first;
  `config-io.ts` migration must handle older files missing the new field.
  New LLM tools follow the per-tool gate pattern from v0.16.12.
