#!/usr/bin/env bash
#
# pi-telegram-stt-smoke-test.sh — single live round-trip. The
# stt package is small; the only meaningful test is the actual
# integration with the local whisper-server (or a fallback
# OpenAI-compatible gateway). Module-load + type guards are
# implicit in the live round-trip.
#
# Usage:
#   bash scripts/pi-telegram-stt-smoke-test.sh
#   bash scripts/pi-telegram-stt-smoke-test.sh --no-network   # skip the round-trip
#
# Required: node >=22, ffmpeg, a reachable `whisper-server` at
# http://127.0.0.1:8081/v1 (or another OpenAI-compatible gateway
# — set `base_url` in `telegram.json` if not on the default).

set -euo pipefail

NO_NETWORK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-network) NO_NETWORK=1; shift ;;
    -h|--help)     echo "usage: $0 [--no-network]"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "FAIL: node >=22 required (got $NODE_MAJOR)" >&2
  exit 3
fi
command -v node >/dev/null || { echo "FAIL: missing node" >&2; exit 4; }
command -v ffmpeg >/dev/null || { echo "FAIL: missing ffmpeg" >&2; exit 4; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_DIR="$REPO_ROOT/extensions/pi-telegram-stt"
JITI_PATH="$REPO_ROOT/node_modules/jiti"
[[ -d "$PKG_DIR" ]] || { echo "FAIL: pkg not at $PKG_DIR" >&2; exit 4; }
[[ -d "$JITI_PATH" ]] || { echo "FAIL: jiti not at $JITI_PATH (run npm install)" >&2; exit 4; }

TMP=$(mktemp -d)
export PI_CODING_AGENT_DIR="$TMP/agent"
mkdir -p "$PI_CODING_AGENT_DIR"
trap "rm -rf $TMP" EXIT

ok()   { printf "  \033[32mok\033[0m   %s\n" "$1"; }
fail() { printf "  \033[31mFAIL\033[0m %s\n" "$1"; }

# ---------------------------------------------------------------------------
# Stage 1 — live STT round-trip
# ---------------------------------------------------------------------------

if [[ $NO_NETWORK -eq 1 ]]; then
  echo "stt-smoke: stage 1/1 — live STT round-trip (skipped: --no-network)"
  echo "  re-run without --no-network to exercise the direct fetch"
  exit 0
fi

# Default to the local whisper-server. The operator can change
# `base_url` in `telegram.json` to point at a different gateway.
cat > "$PI_CODING_AGENT_DIR/telegram.json" <<EOF
{
  "extensions": {
    "pi-telegram-stt": {
      "showTranscript": true,
      "stt_provider": "pi-openai-stt",
      "base_url": ["http://127.0.0.1:8081/v1"]
    }
  }
}
EOF

echo "stt-smoke: stage 1/1 — live STT round-trip"

# Generate a 1-second silent OGG via ffmpeg. This is enough
# audio to exercise the round-trip; we don't assert on the
# transcript content (silent audio → varies).
AUDIO="$TMP/smoke.ogg"
if ! ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -c:a libopus -b:a 32k -ar 48000 -ac 1 -application voip -vbr on -compression_level 10 -f ogg "$AUDIO" 2>/dev/null; then
  fail "ffmpeg failed to generate test audio"
  exit 5
fi

OUT=$(AUDIO_PATH="$AUDIO" JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "
const jitiMod = require(process.env.JITI_PATH);
const createJiti = jitiMod.default || jitiMod;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });

// Load index.ts to trigger the module-load side effect:
// \`registerOpenAiSttProvider()\` puts the provider in the registry
// before any session_start fires (load-order safety, v0.3.1).
jiti(process.env.PKG_DIR + '/index.ts');

const reg = globalThis['__piTelegramSttProviderRegistry__'];
if (!reg) { console.error('no stt provider registry'); process.exit(1); }
const p = reg.providers.get('pi-openai-stt');
if (!p) { console.error('pi-openai-stt not in registry'); process.exit(1); }
p.transcribe({ inputPath: process.env.AUDIO_PATH, lang: 'en', timeoutMs: 10000 })
  .then((text) => {
    if (typeof text !== 'string') { console.error('transcribe did not return a string:', typeof text); process.exit(1); }
    console.log('transcript chars:', text.length);
    console.log('transcript:', JSON.stringify(text));
  })
  .catch((e) => { console.error('threw:', e?.message ?? e); process.exit(1); });
" 2>&1)

if [[ $? -eq 0 ]]; then
  ok "live round-trip returned a transcript string"
  echo
  echo "  network: exercised (1 stage)"
  echo
  echo "stt-smoke: ALL STAGES PASSED"
else
  fail "live round-trip failed"
  echo "$OUT"
  exit 6
fi
