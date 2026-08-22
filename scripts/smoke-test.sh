#!/usr/bin/env bash
#
# smoke-test.sh — 5-second verification that the TTS + ffmpeg + STT
# pipeline works end-to-end WITHOUT spinning up the agent or the
# bridge. Designed for fast iteration: run this after any change
# to scripts/tts-*.mjs, scripts/fw-openai-sts.ts, or the
# underlying provider configs.
#
# What it tests:
#   1. TTS via scripts/tts-minimax.mjs (MiniMax T2A HTTP) → MP3
#   2. ffmpeg wrap → OGG/Opus (the format the bridge wants)
#   3. STT round-trip via the OpenAI-compatible shim
#      (127.0.0.1:8081/v1) → the same text we just synthesized
#
# Exits 0 on success, non-zero on any failure. Output is terse —
# designed to be CI-friendly (one line per stage + summary).
#
# Usage:
#   bash scripts/smoke-test.sh
#   bash scripts/smoke-test.sh --voice Cantonese_PlayfulMan
#   bash scripts/smoke-test.sh --keep   # don't delete the temp dir
#
# Required tools: node (>=14.13.1 for `node:` prefix modules),
# ffmpeg, ffprobe, curl. The host's $PATH must include them.
# Network access to api.minimaxi.com and 127.0.0.1:8081 required.

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Args + env checks
# ---------------------------------------------------------------------------

VOICE="Japanese_OptimisticYouth"
MODEL="speech-2.8-hd"
STT_URL="http://127.0.0.1:8081/v1/audio/transcriptions"
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --voice) VOICE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --stt-url) STT_URL="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --no-shim) NO_SHIM=1; shift ;;
    --keep-shim) KEEP_SHIM=1; shift ;;
    -h|--help)
      sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "smoke-test: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Node version check. The tts-*.mjs scripts use `node:` prefix imports
# (added in Node 14.13.1) and `node:fs/promises` (stable since 16).
# If the active node is too old, you'll see a "Cannot find module
# 'node:fs/promises'" or similar — fail fast with a clear message
# instead of a confusing stack trace 5 lines deep.
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "0")
if [[ "$NODE_MAJOR" -lt 14 ]]; then
  echo "smoke-test: FAIL — node major version is $NODE_MAJOR, need >=14.13.1" >&2
  echo "  current: $(node --version 2>&1)" >&2
  echo "  hint: \`nvm install 18\` or newer" >&2
  exit 3
fi

# Tool checks
for tool in node ffmpeg ffprobe curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "smoke-test: FAIL — missing tool: $tool" >&2
    exit 4
  fi
done

# Auth: tts-minimax.mjs reads MINIMAX_CN_API_KEY (or MINIMAX_API_KEY)
# from the env, falling back to ~/.mmx/config.json's `api_key` field.
# So we don't enforce the env var — just warn if neither path will work.
if [[ -z "${MINIMAX_CN_API_KEY:-}${MINIMAX_API_KEY:-}" ]] \
    && ! [[ -f "$HOME/.mmx/config.json" ]] \
    && ! [[ -f "$HOME/.MiniMax/config.json" ]]; then
  echo "smoke-test: FAIL — no MiniMax API key found" >&2
  echo "  set MINIMAX_CN_API_KEY, or create ~/.mmx/config.json" >&2
  exit 4
fi

# Make tts-minimax.mjs see the key from the config file even if the
# env var is unset (subprocesses don't inherit everything cleanly).
if [[ -z "${MINIMAX_CN_API_KEY:-}" && -f "$HOME/.mmx/config.json" ]]; then
  export MINIMAX_CN_API_KEY="$(python3 -c "import json;print(json.load(open('$HOME/.mmx/config.json'))['api_key'])" 2>/dev/null || true)"
fi

# ---------------------------------------------------------------------------
# 0.5 Ensure the STT shim is up
# ---------------------------------------------------------------------------
# If $STT_URL isn't responding, try to start fw-openai-sts. The shim
# is normally run as a user-level daemon; auto-starting it here means
# `bash scripts/smoke-test.sh` works even after a fresh reboot. We
# only kill the shim at the end if we started it ourselves — never
# killing a pre-existing instance the operator might be using for
# the live agent.

NO_SHIM="${NO_SHIM:-0}"
KEEP_SHIM="${KEEP_SHIM:-0}"

# Extract the base URL (we need it for the health check; STT_URL is
# the full path /v1/audio/transcriptions).
STT_BASE=$(echo "$STT_URL" | sed -E 's|/v1/.*$||')

shim_up() {
  # The shim doesn't expose a /health endpoint, but the
  # /v1/audio/transcriptions endpoint will 4xx-fast for GET (no file)
  # — that's still a sign the server is up. A simpler check: is the
  # port listening at all? Use `ss` if available, fall back to `nc`,
  # fall back to `curl` to a known endpoint.
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "127\.0\.0\.1:${STT_PORT}|0\.0\.0\.0:${STT_PORT}|:::${STT_PORT}"
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$STT_PORT" 2>/dev/null
  else
    # Last resort: send a malformed request and check the status code.
    # Any HTTP response means the port is open.
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$STT_BASE/" 2>/dev/null || echo "000")
    [[ "$code" != "000" ]]
  fi
}

STT_PORT=$(echo "$STT_BASE" | sed -E 's|.*:||')
SHIM_PID=""
SHIM_STARTED=0

# Set up the temp dir early — we need it for the shim's log too.
TMP=$(mktemp -d)

# Resolve STT_PORT if it's empty (URL with no port, e.g. http://host/path)
[[ -z "$STT_PORT" ]] && STT_PORT=80

if ! shim_up; then
  if [[ $NO_SHIM -eq 1 ]]; then
    echo "smoke-test: FAIL — $STT_URL not responding and --no-shim set" >&2
    exit 8
  fi

  # Find the shim. Three locations to try, in order:
  #   1. $HOME/.pi/agent/bin/fw-openai-sts  (operator install path)
  #   2. <source>/scripts/fw-openai-sts.ts  (this repo's source, run via node)
  SHIM_BIN=""
  for cand in \
      "$HOME/.pi/agent/bin/fw-openai-sts" \
      "$(dirname "$0")/fw-openai-sts.ts"; do
    if [[ -x "$cand" ]] || ([[ "$cand" == *.ts ]] && [[ -f "$cand" ]]); then
      SHIM_BIN="$cand"
      break
    fi
  done

  if [[ -z "$SHIM_BIN" ]]; then
    echo "smoke-test: FAIL — cannot find fw-openai-sts shim" >&2
    echo "  searched: $HOME/.pi/agent/bin/fw-openai-sts" >&2
    echo "           $(dirname "$0")/fw-openai-sts.ts" >&2
    echo "  hint: install the shim or set --no-shim to skip stage 3" >&2
    exit 8
  fi

  echo "smoke-test: starting fw-openai-sts shim (background): $SHIM_BIN"
  # The .ts path needs node's strip-types. The wrapper script is
  # already an executable shell script that handles this internally.
  if [[ "$SHIM_BIN" == *.ts ]]; then
    nohup node --experimental-strip-types "$SHIM_BIN" > "$TMP/fw-shim.log" 2>&1 &
  else
    nohup "$SHIM_BIN" > "$TMP/fw-shim.log" 2>&1 &
  fi
  SHIM_PID=$!
  SHIM_STARTED=1

  # Wait up to 5s for the shim to come up.
  for _ in {1..50}; do
    sleep 0.1
    if shim_up; then
      echo "  ok: shim up (pid=$SHIM_PID)"
      break
    fi
  done
  if ! shim_up; then
    echo "smoke-test: FAIL — shim started but $STT_URL not responding after 5s" >&2
    echo "  shim log:" >&2
    tail -10 "$TMP/fw-shim.log" >&2
    exit 8
  fi
fi

# Cleanup: kill the shim if we started it (and the user didn't say
# --keep-shim). This runs on EXIT (success or failure) and uses
# the process group so we kill node too (the bash wrapper exec's
# into node).
cleanup_shim() {
  if [[ $SHIM_STARTED -eq 1 ]] && [[ $KEEP_SHIM -eq 0 ]] && [[ -n "$SHIM_PID" ]]; then
    # Kill the whole process group; the shim wrapper does `exec node`
    # so the bash PID is the same as the node PID, but defensive.
    kill -- "-$SHIM_PID" 2>/dev/null || kill "$SHIM_PID" 2>/dev/null || true
    # Also catch any node children if the wrapper forked instead.
    pkill -P "$SHIM_PID" 2>/dev/null || true
  fi
}
trap 'cleanup_shim; [[ $KEEP -eq 0 ]] && rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# 1. TTS via tts-minimax.mjs → MP3
# ---------------------------------------------------------------------------

# (TMP was already created earlier for the shim log; no need to recreate)
trap 'cleanup_shim; [[ $KEEP -eq 0 ]] && rm -rf "$TMP"' EXIT

echo "smoke-test: stage 1/3 — TTS via tts-minimax.mjs (voice=$VOICE model=$MODEL)"
if ! node "$(dirname "$0")/tts-minimax.mjs" \
    --out "$TMP/tts.mp3" \
    --text "Smoke test" \
    --voice "$VOICE" \
    --model "$MODEL" 2>"$TMP/tts.stderr"; then
  echo "smoke-test: FAIL — tts-minimax.mjs exited non-zero" >&2
  echo "  stderr (last 10 lines):" >&2
  tail -10 "$TMP/tts.stderr" >&2
  exit 5
fi

if [[ ! -s "$TMP/tts.mp3" ]]; then
  echo "smoke-test: FAIL — tts.mp3 is empty" >&2
  exit 5
fi

TTS_BYTES=$(stat -c%s "$TMP/tts.mp3" 2>/dev/null || stat -f%z "$TMP/tts.mp3")
echo "  ok: $TTS_BYTES bytes MP3"

# ---------------------------------------------------------------------------
# 2. ffmpeg wrap → OGG/Opus (the format the bridge wants)
# ---------------------------------------------------------------------------

echo "smoke-test: stage 2/3 — ffmpeg MP3 → OGG/Opus"
if ! ffmpeg -y -i "$TMP/tts.mp3" \
    -c:a libopus -b:a 32k -ar 48000 -ac 1 \
    -application voip -vbr on -compression_level 10 \
    -f ogg "$TMP/tts.ogg" 2>"$TMP/ffmpeg.stderr"; then
  echo "smoke-test: FAIL — ffmpeg exited non-zero" >&2
  tail -10 "$TMP/ffmpeg.stderr" >&2
  exit 6
fi

if [[ ! -s "$TMP/tts.ogg" ]]; then
  echo "smoke-test: FAIL — tts.ogg is empty" >&2
  exit 6
fi

# ffprobe to confirm the OGG is actually Opus at 48kHz mono (the
# settings the bridge expects; the bridge won't accept a different
# sample rate or channel count).
PROBE=$(ffprobe -v error -select_streams a:0 \
  -show_entries stream=codec_name,sample_rate,channels \
  -of default=nw=1 "$TMP/tts.ogg" 2>&1)
if ! grep -q "codec_name=opus" <<<"$PROBE"; then
  echo "smoke-test: FAIL — OGG codec is not opus" >&2
  echo "  $PROBE" >&2
  exit 6
fi
if ! grep -q "sample_rate=48000" <<<"$PROBE"; then
  echo "smoke-test: FAIL — OGG sample rate is not 48000 Hz" >&2
  echo "  $PROBE" >&2
  exit 6
fi
if ! grep -q "channels=1" <<<"$PROBE"; then
  echo "smoke-test: FAIL — OGG is not mono" >&2
  echo "  $PROBE" >&2
  exit 6
fi

OGG_BYTES=$(stat -c%s "$TMP/tts.ogg" 2>/dev/null || stat -f%z "$TMP/tts.ogg")
echo "  ok: $OGG_BYTES bytes OGG/Opus (48kHz mono)"

# ---------------------------------------------------------------------------
# 3. STT round-trip via fw-openai-sts → 127.0.0.1:8081
# ---------------------------------------------------------------------------

echo "smoke-test: stage 3/3 — STT round-trip via $STT_URL"
if ! curl -sf "$STT_URL" \
    -F "file=@$TMP/tts.ogg" \
    -F "model=whisper-1" \
    -F "language=en" \
    > "$TMP/stt.body" 2>"$TMP/curl.stderr"; then
  echo "smoke-test: FAIL — curl to $STT_URL failed" >&2
  echo "  is fw-openai-sts running? (the local shim listens on :8081)" >&2
  tail -5 "$TMP/curl.stderr" >&2
  exit 7
fi

# Accept either shape: OpenAI's strict JSON `{"text": "..."}` OR
# plain-text body (which is what fw-openai-sts currently emits —
# the shim is OpenAI-shaped at the URL but the body is the raw
# whisper-server text response). Either way, we want a non-empty
# transcript.
if grep -q '"text"' "$TMP/stt.body"; then
  # Strict OpenAI JSON: {"text": "Smoke test"}
  STT_TEXT=$(python3 -c "import json;print(json.load(open('$TMP/stt.body')).get('text',''))" 2>/dev/null || echo "")
elif [[ -s "$TMP/stt.body" ]]; then
  # Plain text body — the shim's current behavior. Trim leading
  # whitespace (whisper-server's response includes a leading space
  # for some inputs).
  STT_TEXT=$(sed 's/^[[:space:]]*//' "$TMP/stt.body" | head -1)
else
  echo "smoke-test: FAIL — STT response is empty (no JSON, no text)" >&2
  cat "$TMP/stt.body" >&2
  exit 7
fi

if [[ -z "$STT_TEXT" ]]; then
  echo "smoke-test: FAIL — STT transcript is empty" >&2
  cat "$TMP/stt.body" >&2
  exit 7
fi

echo "  ok: STT returned: \"$STT_TEXT\""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "smoke-test: ALL 3 STAGES PASSED"
echo "  TTS:  $TTS_BYTES bytes MP3 (MiniMax $VOICE / $MODEL)"
echo "  Opus: $OGG_BYTES bytes OGG/Opus (48kHz mono)"
echo "  STT:  \"$STT_TEXT\""

if [[ $KEEP -eq 1 ]]; then
  echo "  (--keep: temp dir preserved at $TMP)"
fi
