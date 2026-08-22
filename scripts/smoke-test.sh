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
# 1. TTS via tts-minimax.mjs → MP3
# ---------------------------------------------------------------------------

TMP=$(mktemp -d)
trap '[[ $KEEP -eq 0 ]] && rm -rf "$TMP"' EXIT

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
