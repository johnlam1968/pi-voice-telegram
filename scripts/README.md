# `scripts/` — local dev + maintenance scripts

Scripts that support the `pi-voice-telegram` development workflow.

| Script | Purpose |
| --- | --- |
| [`live-test.sh`](#live-testsh) | One-command live test of the v0.16.7 extension on the host. |
| [`test-v0.16.7-provider.ts`](#test-v0167-providerts) | Host-side unit test for the v0.16.7 voice transcription provider. |
| [`build-voice-catalog.py`](#build-voice-catalogpy) | Re-build `voices.json` from the upstream MiniMax TTS page. |
| [`README.md`](#dev-workflow-host-side-pi--e) | (this file) How to iterate on the extension without rebuilding the cluster image. |

---

## Dev workflow: host-side `pi -e`

Editing the source and re-deploying through Docker takes 2-3 minutes per
iteration: rebuild `pi-sandbox:latest --no-cache` + `docker compose up -d`
+ re-seed the entrypoint. For most changes (whisper-stt tweaks, the
echo path, tool prompt text, schema additions), you can iterate in
under a second by loading the source directly into the **host's** `pi`
runtime via `pi -e`.

### One-time setup (~30s)

The host's `pi` and the cluster's `pi` resolve peer-deps differently:

- The cluster's `pi-voice-telegram@0.16.7` is installed under
  `~/.pi/agent/npm/node_modules/`, so peer-deps resolve from the same
  tree.
- The source tree at `~/CodingProjects/pi-voice-telegram/` has no
  `node_modules/` of its own, so we need to bridge the gap.

```bash
cd ~/CodingProjects/pi-voice-telegram

# Symlink the three scoped packages the source imports, pointing at
# what's already installed on the host. (All three are read-only refs
# — no files are copied, nothing is downloaded.)
mkdir -p node_modules/@sinclair
ln -s /home/john/.pi/agent/npm/node_modules/@llblab          node_modules/@llblab
ln -s /home/john/.config/nvm/versions/node/v25.3.0/lib/node_modules/@earendil-works  node_modules/@earendil-works
ln -s /home/john/.config/nvm/versions/node/v25.3.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox  node_modules/@sinclair/typebox
```

The third line is the only slightly tricky one. The source imports
`@sinclair/typebox` (the modern scoped form), but the host's pi-core
ships the **dual-published unscoped form** of the same package
(`typebox@1.3.7`, by the same author — `sinclairzx81`). The
unscoped package exports the same `Type` API and is API-compatible
for the `Type.Object / Type.String / Type.Optional / Type.Number`
calls used in `tools.ts`. If the host ever upgrades to `@sinclair/typebox`
(a scoped modern version), point this symlink at the scoped location
instead.

The source's `.gitignore` already excludes `node_modules/`, so the
symlinks will never be committed.

### One-time loader at `~/.pi/agent/extensions/pi-voice-telegram.ts`

`pi` auto-discovers `*.ts` files in `~/.pi/agent/extensions/` on
every invocation. The loader is a single-line re-export:

```bash
cat > ~/.pi/agent/extensions/pi-voice-telegram.ts <<'EOF'
// pi-voice-telegram — host-side dev loader.
//
// Points the host's `pi` at the source repo at
// /home/john/CodingProjects/pi-voice-telegram/. Edit the source and
// re-run `pi -e ~/.pi/agent/extensions/pi-voice-telegram.ts` — no
// rebuild, no npm install, no Docker. For the rebuild + redeploy
// path, see /home/john/pi-cluster/scripts/deploy-pi-voice-telegram.sh.
export { default } from "/home/john/CodingProjects/pi-voice-telegram/index.ts";
EOF
```

A symlink doesn't work here (`pi` resolves `@*` peer-deps against
the loader's *parent directory*, which is `~/.pi/agent/extensions/`,
where the bridge isn't installed — so `@llblab/pi-telegram/voice`
fails to resolve). The absolute path re-export works because Node
resolves the imported file's own relative imports from the imported
file's *real* location (the source dir), where the local
`node_modules/` symlinks are.

### The dev loop

```bash
# Edit a file in the source repo:
vim ~/CodingProjects/pi-voice-telegram/echo.ts

# Re-run pi (any mode). No build, no install, no Docker:
cd ~/.pi/agent/extensions
pi --print -e ./pi-voice-telegram.ts "describe the v0.16.7 design"

# Or interactively:
cd ~/.pi/agent/extensions
pi -e ./pi-voice-telegram.ts
```

`pi -e` re-loads the file every time, so any edit to the source
takes effect on the next invocation. The host's `pi` auto-discovers
the same loader even without `-e`, so `pi --print "..."` (with no
flags) also works after the loader is in place.

### What this catches vs. what only the cluster catches

| Bug class | Caught by host-side `pi -e`? | Why |
| --- | --- | --- |
| TypeScript type errors | ✅ | Same `tsc` / `node --experimental-strip-types` runs. |
| Import resolution | ✅ | Same Node module resolution (via the local `node_modules/` symlinks). |
| `whisper-stt.transcribe()` | ✅ | Talks to `127.0.0.1:8080` (whisper-server) directly. |
| `mm-tts.synthesize()` (TTS) | ✅ | Talks to the MiniMax TTS API directly. |
| LLM tool registration | ✅ | Same `pi.registerTool()` API. |
| Hot-reload of `pi-voice-telegram.json` | ✅ | Same `fs.watch` + `reconfigure()` path. |
| **Bridge provider hook** | ⚠️ partial | The provider function can be called directly (see `test-v0.16.7-provider.ts`), but the bridge's call site (`@llblab/pi-telegram/lib/inbound.ts → processTelegramInboundHandlers → transcribeTelegramVoiceFileWithProviders`) only runs when a real Telegram update arrives. |
| **End-to-end Telegram flow** (echo + LLM reply) | ❌ | Requires the bridge's polling loop + a real bot. The cluster is the only place that has both. |

So the host-side loop catches ~95% of bugs at ~1s iteration cost. The
cluster redeploy (via
[`/home/john/pi-cluster/scripts/deploy-pi-voice-telegram.sh`](/home/john/pi-cluster/scripts/deploy-pi-voice-telegram.sh))
is reserved for the final e2e verification + version bump.

### When to fall back to the cluster rebuild

- Changes to `pi-voice-telegram`'s own `package.json` peer-dep
  declarations (the cluster's image bakes them in; the host's
  auto-discovery doesn't).
- Changes that depend on the bridge's behavior in a real
  update-dispatch sequence (e.g. how the bridge orders update
  handlers vs. transcription providers — see
  `@llblab/pi-telegram/lib/inbound.ts`).
- Changes to the `Dockerfile.pi` / `docker-entrypoint.sh`
  seed list (those files live in the cluster repo, not the
  source).

For all of those, the deploy script's
[`--dry-run`](/home/john/pi-cluster/scripts/README.md#deploy-pi-voice-telegramsh)
mode is the cheapest preview.

---

## `live-test.sh`

One-command test suite for the v0.16.7 extension. Two runtimes are
supported — `host` (fast dev loop) and `container` (production
npm-installed package in `pi-agent-john`). Same two tests on each:

1. **Direct provider** — imports `handleTelegramVoiceTranscription`
   from `echo.ts` via `test-v0.16.7-provider.ts`, calls it on a real
   audio file, asserts a non-empty transcript.
2. **LLM tool** — uses the production extension (auto-discovered on
   the host, auto-loaded from npm in the container), asks the LLM to
   call the registered `transcribe_audio` tool on the same file,
   captures the LLM's transcript.

```bash
./scripts/live-test.sh                         # host, both tests (default)
./scripts/live-test.sh --container             # container (pi-agent-john), both tests
./scripts/live-test.sh --all                   # host + container, all 4 tests
./scripts/live-test.sh --provider              # only the direct provider test
./scripts/live-test.sh --llm                   # only the LLM tool test
./scripts/live-test.sh --audio <path>          # override host audio file
./scripts/live-test.sh --container-audio <path># override container audio (default: same as host, staged via docker cp)
./scripts/live-test.sh --container-name <name> # which container (default: pi-agent-john)
./scripts/live-test.sh --no-color              # plain output (for piping)
```

### Host vs container — what each catches

| | host (default) | container (`--container`) |
| --- | --- | --- |
| **What's running** | Auto-discovered `pi` + extension at `~/.pi/agent/extensions/pi-voice-telegram.ts` (re-exports source) | `pi-agent-john` container with extension npm-installed at `pi-voice-telegram@0.16.7` |
| **Bridge version** | `pi-telegram@0.26.10` (host) | `pi-telegram@0.28.0` (cluster) |
| **Tests against** | The source tree (your edits) | The published package (what's actually deployed) |
| **Catches** | TS errors, import resolution, whisper-stt, mm-tts, tool registration, hot-reload, JSON config | All of the above **plus** drift between source and the published package, install/image-build issues, and bridge-version compatibility |
| **Use when** | Iterating on the source between commits | Validating that the published version still works as expected |
| **Iteration cost** | ~10s for both tests (LLM dominates) | ~70s for both tests (container `pi` startup is slow) |

A `WARN version mismatch` line appears in the container prereq block
if the source tree's `package.json` version doesn't match what's
installed in the container — useful when you've bumped the source but
forgotten to redeploy. The script suggests the redeploy command.

### How the container test works

The container test has three sub-phases:

1. **Prereqs** — `docker` CLI is in PATH, the target container is
   running, the audio file exists on the host, the test script exists
   in the source. Reports the container's installed
   `pi-voice-telegram@<version>` for the version-mismatch check.
2. **Staging** — `docker cp` the test script into
   `/home/pi/.pi/agent/npm/node_modules/pi-voice-telegram/scripts/`
   (so its `../config.js` relative imports resolve against the
   npm-installed package) and the audio into
   `/home/pi/.pi/agent/tmp/`. Idempotent: re-stages only if missing
   or newer.
3. **Tests** — `docker exec pi-agent-john pi --print -e <staged script> ...`
   for Test 1, `docker exec pi-agent-john pi --print "..."` for Test 2
   (no `-e` for Test 2 — the npm-installed extension auto-loads).

The container's `network_mode: "host"` (set in `docker-compose.yaml`)
means the container's `127.0.0.1:8080` is the host's whisper-server,
so the STT call works without any extra configuration.

### Typical run (`--all`)

```
==> Prerequisites  (host)
       source:  /home/john/CodingProjects/pi-voice-telegram
       audio:   /home/john/.hermes/audio_cache/audio_1a45d170e3fc.ogg  (30224 bytes)
       pi:      0.84.2
       loader:  /home/john/.pi/agent/extensions/pi-voice-telegram.ts
==> Prerequisites  (container)
       container: pi-agent-john  (pi-voice-telegram@0.16.7 installed inside)
       staged:    /home/pi/.pi/agent/npm/node_modules/pi-voice-telegram/scripts/test-v0.16.7-provider.ts  /home/pi/.pi/agent/tmp/test.ogg
==> Tests: host+container

==> Test H1 / host direct provider  (handleTelegramVoiceTranscription in echo.ts)
  PASS  transcript returned  (1634ms)
       [test-v0.16.7] provider returned: "你能喺呢個系統裡面開一個新嘅繪畫嘎"  (439ms)

==> Test H2 / host LLM tool  (transcribe_audio via the registered tool surface)
  PASS  transcript returned  (7636ms)
       transcript: 你能喺呢個系統裡面開一個新嘅繪畫嘎

==> Test C1 / container direct provider  (npm-installed pi-voice-telegram@0.16.7)
  PASS  transcript returned  (1593ms)
       [test-v0.16.7] provider returned: "你能喺呢個系統裡面開一個新嘅繪畫嘎"  (425ms)

==> Test C2 / container LLM tool  (auto-loaded extension via npm)
  PASS  transcript returned  (5995ms)
       transcript: 你能喺呢個系統裡面開一個新嘅繪畫嘎

==> ALL TESTS PASSED
```

The audio path is the one the v0.16.x work in `hermes` produced —
30KB Cantonese ogg/opus that round-trips through whisper-server
cleanly. Override with `--audio` / `--container-audio` to test a
different sample.

The script checks all prereqs up front and exits with a clear
`FAIL prerequisites missing` message if anything is off (instead of
failing mid-test with a cryptic module-resolution error). Exit codes:
`0` on pass, `1` on test failure, `2` on prereq error.

### Environment overrides (all optional)

- `PI_VOICE_TELEGRAM_SOURCE` — source dir (default `~/CodingProjects/pi-voice-telegram`)
- `PI_VOICE_TELEGRAM_TEST_AUDIO` — host audio file
- `PI_VOICE_TELEGRAM_PROD_LOADER` — host production loader path
- `PI_VOICE_TELEGRAM_CONTAINER` — target container (default `pi-agent-john`)
- `PI_VOICE_TELEGRAM_CONTAINER_AUDIO` — container audio (default: same as host, staged via `docker cp`)
- `PI_VOICE_TELEGRAM_CONTAINER_PI_DIR` — in-container agent dir (default `/home/pi/.pi/agent`)
- `PI_BIN` — `pi` binary (default `$(command -v pi)`)
- `PROVIDER_TIMEOUT` / `LLM_TIMEOUT` — per-test timeouts in seconds (default 60 / 90). Bump `LLM_TIMEOUT` if the container LLM test feels slow; ~65s is typical, but the network can stretch it.

---

## `test-v0.16.7-provider.ts`

A self-contained unit test for the v0.16.7 voice transcription
provider (`handleTelegramVoiceTranscription` in `echo.ts`). Runs on
the host via `pi -e`, no Telegram or bridge required. `live-test.sh`
wraps this with an LLM-tool test and prereq checks; use the
underlying command directly when you want a single fast test without
the LLM round-trip.

```bash
cd ~/CodingProjects/pi-voice-telegram
pi --print -e ./scripts/test-v0.16.7-provider.ts "run the test"
```

What it verifies:

1. `loadCompanionConfig()` reads `~/.pi/agent/pi-voice-telegram.json`
   correctly and `resolveSttDefaults()` returns the expected
   `lang / baseUrl / timeoutMs`.
2. `setSttDefaults()` + `clearSttState()` are callable exports
   (the wiring in `index.ts` exercises these on every
   `session_start`).
3. `handleTelegramUpdateForEcho()` runs against a synthetic
   Telegram update and returns `"pass"` (it stashes a chat ID
   keyed by file name — no side effect if the chat ID is `0`).
4. `handleTelegramVoiceTranscription()` transcribes the file
   passed in (a real ogg/opus from
   `/home/john/.hermes/audio_cache/audio_1a45d170e3fc.ogg` by
   default — override with `PI_VOICE_TELEGRAM_TEST_AUDIO=...`)
   and returns a non-empty string transcript.
5. The end-to-end latency (warm whisper-server, large-v3 model) is
   printed for performance regression tracking.

A typical output:

```
[test-v0.16.7] start  audio=/home/john/.hermes/audio_cache/audio_1a45d170e3fc.ogg  exists=true  size=30224
[test-v0.16.7] config loaded  stt.lang=yue  stt.baseUrl=http://127.0.0.1:8080  stt.timeoutMs=60000
[test-v0.16.7] update handler returned: pass
[test-v0.16.7] provider returned: "你能喺呢個系統裡面開一個新嘅繪畫嘎"  (438ms)
[test-v0.16.7] PASS  transcript is non-empty (17 chars)
[test-v0.16.7] done  total 439ms
```

The transcript is Cantonese ("Can you open a new drawing in this
system?" in 粵語) — `lang: yue` was correctly applied via the
JSON-driven STT defaults.

To use a different audio file, point the env var at it:

```bash
PI_VOICE_TELEGRAM_TEST_AUDIO=/path/to/your/test.ogg \
  pi --print -e ./scripts/test-v0.16.7-provider.ts "run the test"
```

---

## `build-voice-catalog.py`

Re-builds the embedded `voices.json` catalog (327 MiniMax TTS voices
across 24 languages) from the upstream MiniMax TTS voice page. Run
this when MiniMax adds / renames voices, then re-deploy via the
cluster's `deploy-pi-voice-telegram.sh` script.

```bash
python3 scripts/build-voice-catalog.py
# → writes ../voices.json
```

The output is committed to the source repo and shipped in the npm
package, so the LLM tool `pi_voice_telegram_list_voices` has a
stable, offline catalog to query (no network call at tool time).
