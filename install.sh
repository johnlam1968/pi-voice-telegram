#!/usr/bin/env bash
#
# install.sh — set up the pi-voice-telegram runtime for the host agent.
#
# Usage:
#   ./install.sh [target-dir]
#
# Arguments:
#   target-dir   Where the host agent lives. Default: ~/.pi/agent
#
# What it does:
#   1. Symlinks the runtime shell scripts (tts-minimax, tts-openai, fw-openai-sts)
#      into <target>/bin/ so the bridge's outboundHandlers can call them
#      by absolute path
#   2. Runs `npm install` for the main package's peer dependencies
#      (@earendil-works/pi-coding-agent, @llblab/pi-telegram, etc.)
#   3. Prints the recommended telegram.json#outboundHandlers template
#
# The host agent loads the main extension from the repo directory directly
# (via jiti), so no symlink is needed for the main package itself. The bridge
# also auto-discovers the sister extension packages in extensions/ — see
# AGENTS.md for the runtime model.
#
# This script is idempotent: re-running it just refreshes the symlinks.

set -euo pipefail

TARGET_DIR="${1:-$HOME/.pi/agent}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing pi-voice-telegram"
echo "  from: $SCRIPT_DIR"
echo "  to:   $TARGET_DIR"
echo ""

# 1. Symlink runtime shell scripts
mkdir -p "$TARGET_DIR/bin"
echo "→ Linking runtime scripts to $TARGET_DIR/bin/"
for script in tts-minimax.mjs tts-openai.mjs; do
  ln -sfn "$SCRIPT_DIR/scripts/$script" "$TARGET_DIR/bin/$script"
  echo "  ✓ $TARGET_DIR/bin/$script"
done
# fw-openai-sts is a .ts file run via jiti; the agent invokes it as a binary
ln -sfn "$SCRIPT_DIR/scripts/fw-openai-sts.ts" "$TARGET_DIR/bin/fw-openai-sts"
echo "  ✓ $TARGET_DIR/bin/fw-openai-sts (jiti)"

# 2. Run npm install for peer deps
echo ""
echo "→ Running npm install for peer dependencies (this may take a minute)..."
(
  cd "$SCRIPT_DIR"
  # --omit=dev skips the jiti devDep; it's only for editor IntelliSense
  npm install --omit=dev
)

# 3. Print the recommended config
echo ""
echo "✓ Install complete"
echo ""
echo "──────────────────────────────────────────────────────────────────────"
echo "  Add one of these blocks to your telegram.json#outboundHandlers:"
echo "──────────────────────────────────────────────────────────────────────"
echo ""
echo "  // Option A — OpenAI (gpt-4o-mini-tts, $0.015/min, ~3-15s latency):"
cat <<'EOF'
  "outboundHandlers": [
    {
      "type": "voice",
      "template": [
        "~/.pi/agent/bin/tts-openai.mjs --out {mp3} --instructions 'Speak in Cantonese.'",
        "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 48000 -ac 1 -application voip -vbr on -compression_level 10 -f ogg {ogg}"
      ],
      "output": "ogg"
    }
  ]
EOF
echo ""
echo "  // Option B — MiniMax (native Cantonese voices, speech-2.8-hd default):"
cat <<'EOF'
  "outboundHandlers": [
    {
      "type": "voice",
      "template": [
        "~/.pi/agent/bin/tts-minimax.mjs --out {mp3} --voice Cantonese_PlayfulMan --model speech-2.8-hd",
        "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 48000 -ac 1 -application voip -vbr on -compression_level 10 -f ogg {ogg}"
      ],
      "output": "ogg"
    }
  ]
EOF
echo ""
echo "──────────────────────────────────────────────────────────────────────"
echo "  Sister extensions (auto-loaded by the bridge, no install step):"
echo "    - extensions/pi-telegram-echo     (voice echo + STT orchestrator)"
echo "    - extensions/pi-openai-stt        (OpenAI-shaped STT provider)"
echo "    - extensions/pi-telegram-settings (LLM-callable config tools)"
echo "──────────────────────────────────────────────────────────────────────"
echo ""
echo "Restart the host agent (pi) to pick up the new paths."
