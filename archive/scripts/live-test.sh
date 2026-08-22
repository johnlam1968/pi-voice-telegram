#!/usr/bin/env bash
# live-test.sh — run the v0.16.7 live test suite (host and/or container).
#
# Loads the extension into a `pi` runtime and exercises:
#
#   1. The direct transcription provider
#      (`handleTelegramVoiceTranscription` in `echo.ts`) — imports the
#      function from the source, calls it with a real downloaded audio
#      file, asserts a non-empty transcript.
#
#   2. The LLM tool surface — asks the LLM to call the registered
#      `transcribe_audio` tool on the same file, verifies the tool is
#      registered and the LLM gets a transcript back.
#
# Two runtimes are supported:
#
#   host      — the host's `pi` runtime, where the extension is auto-
#               discovered from `~/.pi/agent/extensions/pi-voice-telegram.ts`
#               (re-export of the source). This is the fast dev loop
#               (see scripts/README.md#dev-workflow).
#   container — the cluster's `pi-agent-john` container, where the
#               extension is npm-installed at the version pinned in
#               `Dockerfile.pi` / `docker-entrypoint.sh`. This catches
#               drift between the source tree and the published package,
#               and exercises the production `pi-telegram@0.28.0` bridge
#               (the host has 0.26.10).
#
# Usage:
#   ./scripts/live-test.sh                    # host, both tests
#   ./scripts/live-test.sh --container        # container, both tests
#   ./scripts/live-test.sh --all              # host + container, both tests
#   ./scripts/live-test.sh --provider         # only Test 1 (direct provider)
#   ./scripts/live-test.sh --llm              # only Test 2 (LLM tool)
#   ./scripts/live-test.sh --audio <path>     # host audio file
#   ./scripts/live-test.sh --container-audio <path>  # container audio (default: same file, staged via docker cp)
#   ./scripts/live-test.sh --container-name <name>   # which container (default: pi-agent-john)
#   ./scripts/live-test.sh --no-color         # plain output (for piping)
#   ./scripts/live-test.sh --help
#
# Exit codes:
#   0   all selected tests passed
#   1   at least one test failed
#   2   the script itself errored (bad args, missing prereqs, etc.)

set -euo pipefail

# ---- Defaults ----
SOURCE="${PI_VOICE_TELEGRAM_SOURCE:-/home/john/CodingProjects/pi-voice-telegram}"
TEST_AUDIO="${PI_VOICE_TELEGRAM_TEST_AUDIO:-/home/john/.hermes/audio_cache/audio_1a45d170e3fc.ogg}"
PI_BIN="${PI_BIN:-$(command -v pi 2>/dev/null || echo /home/john/.config/nvm/versions/node/v25.3.0/bin/pi)}"
# Loader for the *production* extension (registers LLM tools, doesn't
# auto-exit). Test 2 uses this so the LLM can actually take a turn.
PROD_LOADER="${PI_VOICE_TELEGRAM_PROD_LOADER:-/home/john/.pi/agent/extensions/pi-voice-telegram.ts}"
PROVIDER_TIMEOUT="${PROVIDER_TIMEOUT:-60}"
LLM_TIMEOUT="${LLM_TIMEOUT:-90}"

# Container defaults. The cluster's `pi-agent-john` is the canonical
# test target — same image as `pi-agent-jane` and `pi-agent-kate`, but
# this script's host-side dev workflow is set up against `john`.
CONTAINER_NAME="${PI_VOICE_TELEGRAM_CONTAINER:-pi-agent-john}"
# In-container agent dir (PI_CODING_AGENT_DIR). Files staged here
# appear in the host's bind-mount, so they're effectively shared.
CONTAINER_PI_DIR="${PI_VOICE_TELEGRAM_CONTAINER_PI_DIR:-/home/pi/.pi/agent}"
# Audio to use in the container. Default: same as the host file,
# staged into the container via `docker cp` (one-shot, leaves the
# staged copy in place for re-runs).
CONTAINER_AUDIO="${PI_VOICE_TELEGRAM_CONTAINER_AUDIO:-$TEST_AUDIO}"
# Where the staged files live inside the container. The test script
# must live next to the extension's source files so its `../config.js`
# relative imports resolve against the npm-installed package.
CONTAINER_STAGED_TEST_SCRIPT="$CONTAINER_PI_DIR/npm/node_modules/pi-voice-telegram/scripts/test-v0.16.7-provider.ts"
CONTAINER_STAGED_AUDIO="$CONTAINER_PI_DIR/tmp/test.ogg"

# ---- Test selection ----
# Default: host only, both tests. Use --container / --all to expand.
RUN_HOST=1
RUN_CONTAINER=0
RUN_PROVIDER=1
RUN_LLM=1
USE_COLOR=1
if [[ -t 1 ]]; then USE_COLOR=1; else USE_COLOR=0; fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)        RUN_PROVIDER=1; RUN_LLM=0 ;;
    --llm)             RUN_PROVIDER=0; RUN_LLM=1 ;;
    --both)            RUN_PROVIDER=1; RUN_LLM=1 ;;
    --container)       RUN_HOST=0; RUN_CONTAINER=1 ;;
    --all)             RUN_HOST=1; RUN_CONTAINER=1 ;;
    --audio)           TEST_AUDIO="$2"; shift ;;
    --audio=*)         TEST_AUDIO="${1#*=}" ;;
    --container-audio) CONTAINER_AUDIO="$2"; shift ;;
    --container-audio=*) CONTAINER_AUDIO="${1#*=}" ;;
    --container-name)  CONTAINER_NAME="$2"; shift ;;
    --container-name=*) CONTAINER_NAME="${1#*=}" ;;
    --no-color)        USE_COLOR=0 ;;
    -h|--help)
      sed -n '2,55p' "$0"
      exit 0 ;;
    *) echo "unknown flag: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# ---- Colors ----
if [[ "$USE_COLOR" == "1" ]]; then
  C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_DIM=$'\e[2m'; C_BOLD=$'\e[1m'; C_RESET=$'\e[m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_BOLD=""; C_RESET=""
fi
say()  { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '%s  PASS%s  %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s==> WARN%s %s\n' "$C_WARN" "$C_RESET" "$*"; }
fail() { printf '%s  FAIL%s  %s\n' "$C_ERR" "$C_RESET" "$*"; }
note() { printf '%s       %s%s\n' "$C_DIM" "$*" "$C_RESET"; }

# ---- Timing helper (works on GNU and BSD date) ----
now_ms() {
  date +%s%3N 2>/dev/null || python3 -c "import time;print(int(time.time()*1000))"
}

# ---- Helpers ----
# Cross-platform stat. Returns file size in bytes, or "?" on failure.
# (GNU stat uses -c%s; BSD/macOS uses -f%z. The fall-through was
# printing "stat: invalid option" on GNU when the file is missing —
# gate on [[ -f ]] to avoid that.)
audio_size() {
  local file="$1"
  [[ -f "$file" ]] || { echo "?"; return; }
  stat -c%s "$file" 2>/dev/null \
    || stat -f%z "$file" 2>/dev/null \
    || echo "?"
}

# ---- Host prerequisites ----
FAILED_PREREQ=0
if [[ "$RUN_HOST" == "1" ]]; then
  say "Prerequisites  (host)"
  [[ -d "$SOURCE" ]]          || { fail "source dir not found: $SOURCE"; FAILED_PREREQ=1; }
  [[ -x "$PI_BIN" ]]          || { fail "pi binary not found: $PI_BIN (set PI_BIN=... to override)"; FAILED_PREREQ=1; }
  [[ -f "$TEST_AUDIO" ]]      || { fail "test audio not found: $TEST_AUDIO (use --audio <path> to override)"; FAILED_PREREQ=1; }
  [[ -f "$SOURCE/scripts/test-v0.16.7-provider.ts" ]] || { fail "test source not found: $SOURCE/scripts/test-v0.16.7-provider.ts"; FAILED_PREREQ=1; }
  [[ -L "$SOURCE/node_modules/@llblab" ]] || { fail "source node_modules symlinks not set up (run scripts/README.md#one-time-setup)"; FAILED_PREREQ=1; }
  [[ -L "$SOURCE/node_modules/@earendil-works" ]] || { fail "source node_modules symlinks not set up (see --audio hint above)"; FAILED_PREREQ=1; }
  if [[ "$RUN_LLM" == "1" ]]; then
    [[ -f "$PROD_LOADER" ]] || { fail "production loader not found: $PROD_LOADER (set PI_VOICE_TELEGRAM_PROD_LOADER=... or run scripts/README.md#one-time-loader)"; FAILED_PREREQ=1; }
  fi
fi

# ---- Container prerequisites ----
if [[ "$RUN_CONTAINER" == "1" ]]; then
  say "Prerequisites  (container)"
  command -v docker >/dev/null 2>&1 || { fail "docker CLI not found in PATH"; FAILED_PREREQ=1; }
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then
    fail "container '$CONTAINER_NAME' is not running (set --container-name or PI_VOICE_TELEGRAM_CONTAINER)"
    FAILED_PREREQ=1
  fi
  [[ -f "$CONTAINER_AUDIO" ]] || { fail "container audio not found on host: $CONTAINER_AUDIO (use --container-audio <path>)"; FAILED_PREREQ=1; }
  [[ -f "$SOURCE/scripts/test-v0.16.7-provider.ts" ]] || { fail "test script not found: $SOURCE/scripts/test-v0.16.7-provider.ts"; FAILED_PREREQ=1; }
  # In-container checks (only safe to run if the container is up)
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then
    CTR_PKG_JSON=$(docker exec "$CONTAINER_NAME" cat "$CONTAINER_PI_DIR/npm/node_modules/pi-voice-telegram/package.json" 2>/dev/null || echo "{}")
    CTR_VERSION=$(echo "$CTR_PKG_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).version||'?')}catch{console.log('?')}})" 2>/dev/null || echo "?")
    # Staging: re-stages only if missing or source is newer. Fast
    # (docker cp is cheap for our small files); idempotent.
    #
    # The test script must live next to the extension's source files so
    # its relative imports (`../config.js`, `../echo.js`, etc.) resolve
    # against the npm-installed package. The agent's tmp/ dir is wrong
    # for this — we put it in the extension's scripts/ dir instead.
    if ! docker exec "$CONTAINER_NAME" test -f "$CONTAINER_STAGED_TEST_SCRIPT" 2>/dev/null \
       || [[ "$SOURCE/scripts/test-v0.16.7-provider.ts" -nt "$CONTAINER_STAGED_TEST_SCRIPT" ]]; then
      docker exec "$CONTAINER_NAME" mkdir -p "$(dirname "$CONTAINER_STAGED_TEST_SCRIPT")" >/dev/null 2>&1 || true
      docker cp "$SOURCE/scripts/test-v0.16.7-provider.ts" "$CONTAINER_NAME:$CONTAINER_STAGED_TEST_SCRIPT" >/dev/null \
        || { fail "docker cp of test script failed"; FAILED_PREREQ=1; }
    fi
    if ! docker exec "$CONTAINER_NAME" test -f "$CONTAINER_STAGED_AUDIO" 2>/dev/null; then
      docker exec "$CONTAINER_NAME" mkdir -p "$(dirname "$CONTAINER_STAGED_AUDIO")" >/dev/null 2>&1 || true
      docker cp "$CONTAINER_AUDIO" "$CONTAINER_NAME:$CONTAINER_STAGED_AUDIO" >/dev/null \
        || { fail "docker cp of audio failed"; FAILED_PREREQ=1; }
    fi
  fi
fi

# ---- Summary line for the run ----
if [[ "$FAILED_PREREQ" == "1" ]]; then
  echo
  fail "prerequisites missing — see scripts/README.md for the one-time setup"
  exit 2
fi

# Now that all prereqs pass, print the informational notes for each
# runtime. (Done after the prereq check so the FAIL output isn't
# interleaved with size + version info.)
if [[ "$RUN_HOST" == "1" ]]; then
  note "source:  $SOURCE"
  note "audio:   $TEST_AUDIO  ($(audio_size "$TEST_AUDIO") bytes)"
  note "pi:      $($PI_BIN --version 2>&1 | head -1)"
  if [[ "$RUN_LLM" == "1" ]]; then
    note "loader:  $PROD_LOADER"
  fi
fi
if [[ "$RUN_CONTAINER" == "1" ]]; then
  note "container: $CONTAINER_NAME  (pi-voice-telegram@${CTR_VERSION} installed inside)"
  note "staged:    $CONTAINER_STAGED_TEST_SCRIPT  $CONTAINER_STAGED_AUDIO"
  # If the source tree's version doesn't match what's installed in the
  # container, the container tests are exercising different code than
  # what the user is editing. Warn (non-fatal — the test still runs).
  SOURCE_VERSION=$(node -e "console.log(require('$SOURCE/package.json').version)" 2>/dev/null || echo "?")
  if [[ "$CTR_VERSION" != "$SOURCE_VERSION" && "$CTR_VERSION" != "?" ]]; then
    warn "version mismatch: SOURCE is $SOURCE_VERSION but $CONTAINER_NAME has $CTR_VERSION installed"
    note "  run pi-cluster/scripts/deploy-pi-voice-telegram.sh $SOURCE_VERSION to redeploy"
  fi
fi

TEST_DESC=""
[[ "$RUN_HOST" == "1" ]]      && TEST_DESC+="host"
[[ "$RUN_HOST" == "1" && "$RUN_CONTAINER" == "1" ]] && TEST_DESC+="+"
[[ "$RUN_CONTAINER" == "1" ]] && TEST_DESC+="container"
[[ "$RUN_PROVIDER" == "0" ]]  && TEST_DESC+="/provider-off"
[[ "$RUN_LLM" == "0" ]]       && TEST_DESC+="/llm-off"
say "Tests: $TEST_DESC"
echo

# ---- HOST: Test 1 / direct provider ----
OVERALL=0
if [[ "$RUN_HOST" == "1" && "$RUN_PROVIDER" == "1" ]]; then
  say "Test H1 / host direct provider  (handleTelegramVoiceTranscription in echo.ts)"
  T0=$(now_ms)
  set +e
  OUT=$(cd "$SOURCE" && PI_VOICE_TELEGRAM_TEST_AUDIO="$TEST_AUDIO" \
        timeout "$PROVIDER_TIMEOUT" "$PI_BIN" --print \
          -e ./scripts/test-v0.16.7-provider.ts "run the test" 2>&1)
  PROVIDER_EXIT=$?
  set -e
  T1=$(now_ms)
  ELAPSED=$((T1 - T0))

  # Show the test's own [test-v0.16.7] log lines, and the final line
  # of the test's own summary as a note under our PASS / FAIL.
  echo "$OUT" | grep '^\[test-v0.16.7\]' | sed 's/^\[test-v0.16.7\] /  /' | head -20

  TRANSCRIPT_LINE=$(echo "$OUT" | grep 'provider returned:' | head -1)
  if [[ $PROVIDER_EXIT -ne 0 ]]; then
    fail "exit=$PROVIDER_EXIT  (${ELAPSED}ms)"
    OVERALL=1
  elif echo "$OUT" | grep -q 'PASS  transcript is non-empty'; then
    ok "transcript returned  (${ELAPSED}ms)"
    note "$TRANSCRIPT_LINE"
  else
    fail "no PASS marker in output  (${ELAPSED}ms)"
    note "$TRANSCRIPT_LINE"
    OVERALL=1
  fi
  echo
fi

# ---- HOST: Test 2 / LLM tool ----
if [[ "$RUN_HOST" == "1" && "$RUN_LLM" == "1" ]]; then
  say "Test H2 / host LLM tool  (transcribe_audio via the registered tool surface)"
  T0=$(now_ms)
  set +e
  OUT=$(cd "$(dirname "$PROD_LOADER")" && \
        timeout "$LLM_TIMEOUT" "$PI_BIN" --print \
          -e "$PROD_LOADER" \
          "Use the transcribe_audio tool to transcribe the file at $TEST_AUDIO with language yue. Print ONLY the transcript text — no other commentary, no quotes, no markdown." 2>&1)
  LLM_EXIT=$?
  set -e
  T1=$(now_ms)
  ELAPSED=$((T1 - T0))

  TRANSCRIPT=$(echo "$OUT" \
    | grep -v '^\[test-v0.16.7\]' \
    | grep -v '^\[pi-voice-telegram\]' \
    | grep -v '^Goodbye' \
    | grep -v '^Hi' \
    | grep -v '^=' \
    | grep -v '^$' \
    | tail -3 \
    | head -1 \
    | sed 's/^[[:space:]]*//' \
    | sed 's/[[:space:]]*$//')

  if [[ $LLM_EXIT -ne 0 ]]; then
    fail "exit=$LLM_EXIT  (${ELAPSED}ms)"
    OVERALL=1
  elif [[ -z "$TRANSCRIPT" ]]; then
    fail "empty transcript  (${ELAPSED}ms)"
    note "raw output: $(echo "$OUT" | tail -5 | tr '\n' '|')"
    OVERALL=1
  elif [[ ${#TRANSCRIPT} -lt 2 ]]; then
    fail "transcript too short: $TRANSCRIPT  (${ELAPSED}ms)"
    OVERALL=1
  else
    ok "transcript returned  (${ELAPSED}ms)"
    note "transcript: $TRANSCRIPT"
  fi
  echo
fi

# ---- CONTAINER: Test 1 / direct provider ----
# The container's `pi` is at /usr/local/bin/pi (0.84.2, Node 24). The
# extension is npm-installed at $CONTAINER_PI_DIR/npm/node_modules/
# pi-voice-telegram/, with `npm:pi-voice-telegram@0.16.7` in
# settings.json — so it's auto-loaded without -e. The staged test
# script is in $CONTAINER_PI_DIR/tmp/.
if [[ "$RUN_CONTAINER" == "1" && "$RUN_PROVIDER" == "1" ]]; then
  say "Test C1 / container direct provider  (npm-installed pi-voice-telegram@0.16.7)"
  T0=$(now_ms)
  set +e
  OUT=$(docker exec "$CONTAINER_NAME" \
        env PI_VOICE_TELEGRAM_TEST_AUDIO="$CONTAINER_STAGED_AUDIO" \
        timeout "$PROVIDER_TIMEOUT" pi --print \
          -e "$CONTAINER_STAGED_TEST_SCRIPT" "run the test" 2>&1)
  PROVIDER_EXIT=$?
  set -e
  T1=$(now_ms)
  ELAPSED=$((T1 - T0))

  echo "$OUT" | grep '^\[test-v0.16.7\]' | sed 's/^\[test-v0.16.7\] /  /' | head -20

  TRANSCRIPT_LINE=$(echo "$OUT" | grep 'provider returned:' | head -1)
  if [[ $PROVIDER_EXIT -ne 0 ]]; then
    fail "exit=$PROVIDER_EXIT  (${ELAPSED}ms)"
    OVERALL=1
  elif echo "$OUT" | grep -q 'PASS  transcript is non-empty'; then
    ok "transcript returned  (${ELAPSED}ms)"
    note "$TRANSCRIPT_LINE"
  else
    fail "no PASS marker in output  (${ELAPSED}ms)"
    note "$TRANSCRIPT_LINE"
    OVERALL=1
  fi
  echo
fi

# ---- CONTAINER: Test 2 / LLM tool ----
# Uses the auto-loaded production extension (npm-installed). The LLM
# takes a turn, calls transcribe_audio (which goes via the container's
# `pi` → whisper-stt → 127.0.0.1:8080 → host's whisper-server, since
# the container uses network_mode: "host"), and returns the transcript.
if [[ "$RUN_CONTAINER" == "1" && "$RUN_LLM" == "1" ]]; then
  say "Test C2 / container LLM tool  (auto-loaded extension via npm)"
  T0=$(now_ms)
  set +e
  OUT=$(docker exec "$CONTAINER_NAME" \
        timeout "$LLM_TIMEOUT" pi --print \
          "Use the transcribe_audio tool to transcribe the file at $CONTAINER_STAGED_AUDIO with language yue. Print ONLY the transcript text — no other commentary, no quotes, no markdown." 2>&1)
  LLM_EXIT=$?
  set -e
  T1=$(now_ms)
  ELAPSED=$((T1 - T0))

  TRANSCRIPT=$(echo "$OUT" \
    | grep -v '^\[test-v0.16.7\]' \
    | grep -v '^\[pi-voice-telegram\]' \
    | grep -v '^Goodbye' \
    | grep -v '^Hi' \
    | grep -v '^=' \
    | grep -v '^$' \
    | tail -3 \
    | head -1 \
    | sed 's/^[[:space:]]*//' \
    | sed 's/[[:space:]]*$//')

  if [[ $LLM_EXIT -ne 0 ]]; then
    fail "exit=$LLM_EXIT  (${ELAPSED}ms)"
    OVERALL=1
  elif [[ -z "$TRANSCRIPT" ]]; then
    fail "empty transcript  (${ELAPSED}ms)"
    note "raw output: $(echo "$OUT" | tail -5 | tr '\n' '|')"
    OVERALL=1
  elif [[ ${#TRANSCRIPT} -lt 2 ]]; then
    fail "transcript too short: $TRANSCRIPT  (${ELAPSED}ms)"
    OVERALL=1
  else
    ok "transcript returned  (${ELAPSED}ms)"
    note "transcript: $TRANSCRIPT"
  fi
  echo
fi

# ---- Summary ----
if [[ "$OVERALL" == "0" ]]; then
  say "ALL TESTS PASSED"
  exit 0
else
  say "SOME TESTS FAILED"
  exit 1
fi
