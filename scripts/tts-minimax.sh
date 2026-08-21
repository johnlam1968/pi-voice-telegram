#!/usr/bin/env bash
# tts-minimax.sh — voice handler for the MiniMax T2A HTTP API.
#
# pi-telegram's `outboundHandlers` runs this with:
#   - text on stdin
#   - $1 = the {mp3} placeholder path (writes the synthesized MP3 here)
#
# Reference: https://platform.minimaxi.com/docs/api-reference/speech-t2a-http
# The modern endpoint `/v1/t2a_v2` (speech-2.x) returns JSON with
# hex-encoded audio. cURL alone can fetch the response, but to get
# the audio bytes we need JSON-parsing + hex-decoding — both done
# here via python3 (always present on a Pi agent host). ffmpeg
# (also required by the STT side) wraps the result in OGG/Opus in
# the next template step.
#
# ## Auth resolution (priority order)
#
#   1. $MINIMAX_API_KEY env var (operator-set)
#   2. ~/.mmx/config.json → `api_key` (mmx-cli's canonical key store)
#
# ## Why this script
#
#   - The T2A request body has nested `voice_setting` / `audio_setting`
#     blocks plus a top-level `model` / `text` / `stream`. Encoding
#     all of that in a single inline `telegram.json#outboundHandlers`
#     command is unreadable. A small file is much easier to maintain.
#   - Replaces the previous `pi-minimax-tts` Pi extension (now
#     retired). All the API logic lives here; the bridge's
#     `outboundHandlers` is the canonical integration point.

set -euo pipefail

OUT="$1"

# --- Auth ----------------------------------------------------------------

API_KEY="${MINIMAX_API_KEY:-$(python3 -c 'import json; print(json.load(open("/home/john/.mmx/config.json"))["api_key"])' 2>/dev/null || true)}"
if [ -z "${API_KEY:-}" ]; then
	echo "tts-minimax: missing API key (set MINIMAX_API_KEY or write ~/.mmx/config.json)" >&2
	exit 2
fi

# --- Stash the agent text from stdin ------------------------------------
# The bridge sends the spoken text on stdin. We need to save it to a
# file because the python call below uses a heredoc, which would
# otherwise consume stdin as the script body and lose the text.
TEXT_FILE="$(mktemp -t tts-minimax-text.XXXXXX)"
trap 'rm -f "$TEXT_FILE"' EXIT
cat > "$TEXT_FILE"

# --- Synthesize ----------------------------------------------------------

python3 - "$OUT" "$API_KEY" "$TEXT_FILE" <<'PYEOF'
import json
import subprocess
import sys

out_path, api_key, text_path = sys.argv[1], sys.argv[2], sys.argv[3]

with open(text_path, encoding="utf-8") as f:
	text = f.read()
if not text:
	raise SystemExit("tts-minimax: empty text on stdin")

body = json.dumps({
	"model": "speech-2.8-hd",
	"text": text,
	"stream": False,
	"voice_setting": {
		"voice_id": "Cantonese_CuteGirl",
		"speed": 1,
		"vol": 1,
		"pitch": 0,
	},
	"audio_setting": {
		"sample_rate": 32000,
		"bitrate": 128000,
		"format": "mp3",
		"channel": 1,
	},
})

result = subprocess.run(
	[
		"curl", "-sS", "-X", "POST",
		"-H", f"Authorization: Bearer {api_key}",
		"-H", "Content-Type: application/json",
		"-d", body,
		"https://api.minimaxi.com/v1/t2a_v2",
	],
	capture_output=True,
	check=False,
)
if result.returncode != 0:
	raise SystemExit(f"tts-minimax: curl exit {result.returncode}: {result.stderr.decode('utf-8', errors='replace').strip()[:500]}")

try:
	data = json.loads(result.stdout)
except json.JSONDecodeError as e:
	raise SystemExit(f"tts-minimax: non-JSON response ({e}): {result.stdout[:200]!r}")

base = data.get("base_resp", {})
if base.get("status_code") not in (0, None):
	raise SystemExit(
		f"tts-minimax: upstream error status_code={base.get('status_code')}: {base.get('status_msg', '(no message)')}"
	)

audio_hex = (data.get("data") or {}).get("audio")
if not audio_hex:
	raise SystemExit("tts-minimax: no `data.audio` in response")

with open(out_path, "wb") as f:
	f.write(bytes.fromhex(audio_hex))

trace_id = data.get("trace_id", "")
extra = data.get("extra_info", {})
print(
	"tts-minimax: ok",
	f"trace_id={trace_id}",
	f"audio_length_ms={extra.get('audio_length', '?')}",
	f"bytes={len(audio_hex) // 2}",
)
PYEOF
