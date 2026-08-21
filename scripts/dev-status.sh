#!/usr/bin/env bash
# dev-status.sh — one-shot status snapshot of the Pi + Telegram stack.
#
# Run this when something feels off. It checks:
#   - is `pi` running? how long? CPU? cwd?
#   - bridge lock state and polling
#   - recent bridge runtime events (and warns if the log is stale)
#   - the most-recent session activity
#   - last few structured stderr lines from the agent's TTY (if
#     captured to a file via `pi 2>/tmp/pi.stderr.log`)
#
# Designed for "what's the state right now, what was the last thing
# that happened". Pair with `dev-watch.sh` for live tail.

set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TG="$AGENT_DIR/tmp/telegram"

# Color helpers (only when stdout is a TTY)
if [[ -t 1 ]]; then
  C_OK=$'\033[32m'
  C_WARN=$'\033[33m'
  C_ERR=$'\033[31m'
  C_DIM=$'\033[2m'
  C_BOLD=$'\033[1m'
  C_RESET=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_BOLD=""; C_RESET=""
fi

hr() { printf "${C_DIM}%s${C_RESET}\n" "─────────────────────────────────────────────────────────────"; }
hdr() { printf "\n${C_BOLD}%s${C_RESET}\n" "$1"; }
ok()  { printf "  ${C_OK}✓${C_RESET} %s\n" "$1"; }
warn(){ printf "  ${C_WARN}!${C_RESET} %s\n" "$1"; }
err() { printf "  ${C_ERR}✗${C_RESET} %s\n" "$1"; }
info(){ printf "  %s\n" "$1"; }
kv()  { printf "  ${C_DIM}%s${C_RESET}  %s\n" "$1" "$2"; }

# ============================================================================
# 1. The `pi` process
# ============================================================================
hdr "pi process"

# Find the active bridge leader. owners.json has the canonical pid;
# fall back to pgrep if the file is stale.
if [[ -f "$TG/owners.json" ]]; then
  PI_PID=$(python3 -c "import json; print(json.load(open('$TG/owners.json'))['default']['pid'])" 2>/dev/null || echo "")
  PI_CWD=$(python3 -c "import json; print(json.load(open('$TG/owners.json'))['default']['cwd'])" 2>/dev/null || echo "?")
  PI_INST=$(python3 -c "import json; print(json.load(open('$TG/owners.json'))['default']['instanceId'])" 2>/dev/null || echo "?")
  PI_HB=$(python3 -c "import json; print(json.load(open('$TG/owners.json'))['default']['heartbeatMs'])" 2>/dev/null || echo "0")
  PI_HB_AGO=$(python3 -c "import json,time; print(int((time.time()*1000 - $PI_HB)/1000))" 2>/dev/null || echo "?")
else
  PI_PID=""; PI_CWD="?"; PI_INST="?"; PI_HB_AGO="?"
fi

if [[ -n "$PI_PID" ]] && kill -0 "$PI_PID" 2>/dev/null; then
  ok "alive (pid=$PI_PID, cwd=$PI_CWD)"
  kv "instance" "$PI_INST"
  kv "heartbeat" "${PI_HB_AGO}s ago"
  PSLINE=$(ps -o etime=,pcpu= -p "$PI_PID" 2>/dev/null | tr -s ' ' | sed 's/^ //')
  kv "uptime/cpu" "$PSLINE"
  # Network: is the bridge connected to Telegram?
  NCONN=$(ss -tnp 2>/dev/null | grep -c "pid=$PI_PID" || echo 0)
  kv "open sockets" "$NCONN"
  TGCONN=$(ss -tnp 2>/dev/null | grep "$PI_PID" | grep -c ":443" || echo 0)
  if [[ "$TGCONN" -ge 1 ]]; then
    ok "Telegram connection live ($TGCONN ESTABLISHED :443)"
  else
    warn "no Telegram :443 ESTABLISHED — bridge may be reconnecting"
  fi
else
  err "no live process for pid=$PI_PID (is pi running?)"
  info "Start with: pi"
fi

# ============================================================================
# 2. Bridge state
# ============================================================================
hdr "bridge state"
if [[ -f "$TG/state.json" ]]; then
  # All in one Python call so we don't fight with bash pipe subshells
  python3 -c "
import json, sys, time
d = json.load(open('$TG/state.json'))
p = d.get('runtime', {}).get('polling', {})
now = int(time.time() * 1000)
print('  polling   phase={} started={}s ago lastOk={}s ago updatesSeen={}'.format(
    p.get('phase', '?'),
    int((now - p.get('startedAtMs', 0)) / 1000),
    int((now - p.get('lastSuccessfulResponseAtMs', 0)) / 1000),
    p.get('lastSuccessfulResponseUpdateCount', 0),
))
print('  lock      state={}'.format(d.get('runtime', {}).get('lockState', '?')))
r = d.get('liveRoster', {})
fb = r.get('busFollowers', [])
lb = r.get('localBus', {})
print('  roster    followers={} followerRegistered={}'.format(
    len(fb), lb.get('followerRegistered', '?'),
))
" || err "failed to parse state.json"
  # Check bus.sock
  if [[ -S "$TG/bus.sock" ]]; then
    ok "bus.sock present (leader/follower IPC up)"
  else
    warn "bus.sock MISSING — leader/follower IPC is broken (bridge can queue but not send)"
  fi
  # Check followers dir
  if [[ -d "$TG/followers" ]]; then
    FCOUNT=$(ls -1 "$TG/followers" 2>/dev/null | wc -l)
    info "followers dir: $FCOUNT socket(s)"
  fi
else
  err "no state.json — bridge not started?"
fi

# ============================================================================
# 3. Bridge runtime event log
# ============================================================================
hdr "bridge runtime event log"
LOG="$TG/logs.jsonl"
if [[ -f "$LOG" ]]; then
  SIZE=$(stat -c %s "$LOG")
  LINES=$(wc -l < "$LOG")
  MTIME=$(stat -c %Y "$LOG")
  AGE=$(($(date +%s) - MTIME))
  kv "path" "$LOG"
  kv "size" "$SIZE bytes, $LINES lines, mtime $AGE s ago"
  if (( AGE > 300 )); then
    # The log is "frozen" if nothing's been written in 5 minutes
    # (typical poll-timeout cadence is 40 s).
    warn "log is STALE (${AGE}s without an update) — bridge may not be recording events"
    info "(the bridge can still be synthesizing + sending; check state.json + stderr for liveness)"
  fi
  if (( LINES > 0 )); then
    info "last 8 events:"
    tail -n 8 "$LOG" | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: d = json.loads(line)
    except: continue
    at = d.get('at', '?')
    cat = d.get('category', '')
    msg = d.get('message', '')
    print(f'    [{at}] {cat:>12}: {msg[:100]}')
"
  fi
else
  err "no logs.jsonl — bridge has not written any events"
fi

# ============================================================================
# 4. Session activity
# ============================================================================
hdr "session activity"
SESS_DIR="$AGENT_DIR/sessions/--home-john--"
if [[ -d "$SESS_DIR" ]]; then
  LATEST=$(ls -1t "$SESS_DIR"/*.jsonl 2>/dev/null | head -1)
  if [[ -n "$LATEST" ]]; then
    SIZE=$(stat -c %s "$LATEST")
    MTIME=$(stat -c %Y "$LATEST")
    AGE=$(($(date +%s) - MTIME))
    kv "file" "$(basename "$LATEST")"
    kv "size" "$SIZE bytes, mtime $AGE s ago"
    if (( AGE > 600 )); then
      info "(idle for ${AGE}s — agent may be waiting for input or external event)"
    else
      ok "active within last ${AGE}s"
    fi
    # Last user + last assistant
    python3 - "$LATEST" <<'PYEOF'
import json, sys
last_user, last_assistant, last_event = None, None, None
with open(sys.argv[1]) as f:
    for line in f:
        try: rec = json.loads(line)
        except: continue
        last_event = rec.get('timestamp', '?')
        if rec.get('type') != 'message': continue
        msg = rec.get('message', {})
        role = msg.get('role', '?')
        ts = rec.get('timestamp', '?')
        if role == 'user':
            text = ''
            for c in msg.get('content', []):
                if c.get('type') == 'text': text = c.get('text', '')[:120]; break
            last_user = (ts, text)
        elif role == 'assistant':
            text = ''
            for c in msg.get('content', []):
                if c.get('type') == 'text': text = c.get('text', '')[:120]; break
                if c.get('type') == 'toolUse':
                    text = '[toolUse] ' + (c.get('input', {}).get('command') or c.get('name', ''))[:80]
            last_assistant = (ts, text)
if last_user:
    print(f'    last user  [{last_user[0]}]: {last_user[1]!r}')
if last_assistant:
    print(f'    last asst  [{last_assistant[0]}]: {last_assistant[1]!r}')
print(f'    last event [{last_event}]')
PYEOF
  else
    err "no session files in $SESS_DIR"
  fi
else
  info "no $SESS_DIR (cwd not /home/john?)"
fi

# ============================================================================
# 5. Our extension's structured stderr (if captured to a file)
# ============================================================================
hdr "extension stderr"
for cand in /tmp/pi.stderr.log /tmp/pi.log "$AGENT_DIR/pi.stderr.log"; do
  if [[ -f "$cand" ]]; then
    info "$cand:"
    tail -n 6 "$cand" | sed 's/^/    /'
    break
  fi
done | head -10

# ============================================================================
# 6. Agent debug log (only present if /debug was invoked)
# ============================================================================
hdr "agent debug log (pi-debug.log)"
if [[ -f "$AGENT_DIR/pi-debug.log" ]]; then
  SIZE=$(stat -c %s "$AGENT_DIR/pi-debug.log")
  MTIME=$(stat -c %Y "$AGENT_DIR/pi-debug.log")
  AGE=$(($(date +%s) - MTIME))
  info "size=$SIZE, mtime $AGE s ago (overwritten on each /debug)"
  info "Tip: type /debug in the pi REPL to capture a fresh snapshot"
else
  info "no pi-debug.log — type /debug in the pi REPL to create one"
fi

# ============================================================================
# Summary
# ============================================================================
hr
echo
info "scripts/dev-watch.sh — live tail of all streams"
info "scripts/dev-status.sh — this snapshot, rerun any time"
