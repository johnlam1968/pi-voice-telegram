#!/usr/bin/env bash
#
# pi-telegram-tts-smoke-test.sh — single live round-trip. The
# tts package is now ~200 lines of `fetch` + `ffmpeg`; the only
# meaningful test is the actual integration with a real provider.
# Module-load, type guards, and the dispatcher fall-throughs are
# implicit in the live round-trip.
#
# Usage:
#   bash scripts/pi-telegram-tts-smoke-test.sh
#   bash scripts/pi-telegram-tts-smoke-test.sh --no-network   # skip the round-trip
#
# Required: node >=22, ffmpeg, `~/.mmx/config.json` (or
# `MINIMAX_API_KEY`) for MiniMax — or `OPENAI_API_KEY` /
# `~/.pi/agent/auth.json` for OpenAI. The provider is picked from
# `~/.mmx/config.json` first (MiniMax), else `OPENAI_API_KEY`.

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
PKG_DIR="$REPO_ROOT/extensions/pi-telegram-tts"
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
# Stage 1 — live TTS round-trip
# ---------------------------------------------------------------------------

if [[ $NO_NETWORK -eq 1 ]]; then
  echo "tts-smoke: stage 1/1 — live TTS round-trip (skipped: --no-network)"
  echo "  re-run without --no-network to exercise the direct fetch"
  exit 0
fi

# Pick the provider: MiniMax if ~/.mmx/config.json exists, else
# OpenAI. The user can override by setting MINIMAX_API_KEY or
# OPENAI_API_KEY in the env.
if [[ -f "$HOME/.mmx/config.json" ]] || [[ -n "${MINIMAX_API_KEY:-}" ]]; then
  PROVIDER="minimax"
elif [[ -n "${OPENAI_API_KEY:-}" ]] || [[ -f "$HOME/.pi/agent/auth.json" ]]; then
  PROVIDER="openai"
else
  echo "FAIL: no API key found" >&2
  echo "  set MINIMAX_API_KEY (or create ~/.mmx/config.json) — or set OPENAI_API_KEY (or write ~/.pi/agent/auth.json)" >&2
  exit 5
fi

cat > "$PI_CODING_AGENT_DIR/telegram.json" <<EOF
{
  "extensions": {
    "pi-telegram-tts": {
      "disabled": false,
      "provider": "$PROVIDER"
    }
  }
}
EOF

echo "tts-smoke: stage 1/1 — live TTS round-trip (provider=$PROVIDER)"

OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "
const jitiMod = require(process.env.JITI_PATH);
const createJiti = jitiMod.default || jitiMod;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { loadSynthConfig } = jiti(process.env.PKG_DIR + '/telegram-config.ts');
const { synthesizeOgg } = jiti(process.env.PKG_DIR + '/synth.ts');
(async () => {
  const cfg = loadSynthConfig();
  if (cfg.disabled || !cfg.provider) { console.error('cfg fall-through:', JSON.stringify(cfg)); process.exit(1); }
  const audioPath = await synthesizeOgg('Smoke test from pi-telegram-tts v0.7.0.', { lang: 'yue' }, cfg);
  if (!audioPath) { console.error('synthesizeOgg returned undefined'); process.exit(1); }
  if (!fs.existsSync(audioPath)) { console.error('audioPath missing:', audioPath); process.exit(1); }
  const stat = fs.statSync(audioPath);
  const fileType = execSync('file ' + JSON.stringify(audioPath), { encoding: 'utf8' }).trim();
  if (!/Ogg data.*Opus audio/.test(fileType)) { console.error('not Ogg/Opus:', fileType); process.exit(1); }
  console.log('audioPath:', audioPath);
  console.log('size:', stat.size, 'bytes');
  console.log('file:', fileType);
})().catch((e) => { console.error('threw:', e); process.exit(1); });
" 2>&1)

if [[ $? -eq 0 ]]; then
  ok "live round-trip produced valid OGG/Opus"
  echo
  echo "  network: exercised (1 stage)"
  echo
  echo "tts-smoke: ALL STAGES PASSED"
else
  fail "live round-trip failed"
  echo "$OUT"
  exit 6
fi
