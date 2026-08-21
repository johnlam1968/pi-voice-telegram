#!/usr/bin/env bash
# dev-watch.sh — live tail of the Pi + Telegram stack.
#
# Two modes:
#
#   scripts/dev-watch.sh            # refresh the status snapshot every 2s
#   scripts/dev-watch.sh tail       # tail the bridge log + session log + stderr in parallel
#
# Mode 1 is for "what's the state right now". Mode 2 is for "what just
# happened, line by line". Pick the one that matches your question.

set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TG="$AGENT_DIR/tmp/telegram"

mode="${1:-refresh}"

if [[ "$mode" == "tail" ]]; then
  echo "[dev-watch] tailing bridge log + session + stderr (Ctrl-C to stop)"
  echo "[dev-watch] bridge log: $TG/logs.jsonl"
  echo "[dev-watch] session:    $AGENT_DIR/sessions/--home-john--/*.jsonl (latest)"
  echo "[dev-watch] stderr:     /tmp/pi.stderr.log or /tmp/pi.log (whichever exists)"
  echo

  # Pick the most-recently-modified session file
  LATEST_SESS=$(ls -1t "$AGENT_DIR/sessions/--home-john--"/*.jsonl 2>/dev/null | head -1 || true)

  # Build a list of inputs to tail. Missing files are silently ignored.
  inputs=()
  [[ -f "$TG/logs.jsonl" ]] && inputs+=("$TG/logs.jsonl")
  [[ -n "${LATEST_SESS:-}" && -f "$LATEST_SESS" ]] && inputs+=("$LATEST_SESS")
  for cand in /tmp/pi.stderr.log /tmp/pi.log "$AGENT_DIR/pi.stderr.log"; do
    [[ -f "$cand" ]] && inputs+=("$cand")
  done

  if (( ${#inputs[@]} == 0 )); then
    echo "[dev-watch] no log files found. Start the agent with stderr captured:"
    echo "            pi 2>/tmp/pi.stderr.log"
    exit 1
  fi

  # Use sed to prefix each line with the basename of the file it came
  # from. tail -F follows rotated files.
  tail -F "${inputs[@]}" 2>/dev/null | while IFS= read -r line; do
    # We can't tell which file a line came from when tail multiplexes
    # them, so just print as-is. If you want file-prefixed lines, use
    # `multitail` (separate package) or `tail -F file1 file2 -F file3`
    # with explicit prefixes.
    printf '%s\n' "$line"
  done
  exit 0
fi

# ============================================================================
# Default mode: refresh the status snapshot every 2 seconds.
# ============================================================================

INTERVAL="${DEV_WATCH_INTERVAL:-2}"
echo "[dev-watch] refreshing status every ${INTERVAL}s (Ctrl-C to stop)"
echo "[dev-watch] for line-by-line tail: scripts/dev-watch.sh tail"
echo

# If stdout is a TTY, use clear; otherwise just print sequentially.
if [[ -t 1 ]]; then
  CLEAR="clear"
else
  CLEAR=""
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

while true; do
  if [[ -n "$CLEAR" ]]; then
    "$CLEAR"
  fi
  printf '\033[36m[dev-watch] %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo
  "$SCRIPT_DIR/dev-status.sh"
  sleep "$INTERVAL"
done
