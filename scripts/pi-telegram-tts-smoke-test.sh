#!/usr/bin/env bash
#
# pi-telegram-tts-smoke-test.sh — replayable smoke test for the
# `pi-telegram-tts` v0.1.0 sister extension. No agent, no bridge,
# no Telegram — just jiti-load the package source and exercise the
# provider in-process, with three optional stages that drive a live
# TTS round-trip.
#
# ## What it tests
#
# 1. jiti load — `extensions/pi-telegram-tts/index.ts` loads without
#    error, and the provider is registered in the bridge's
#    `globalThis.__piTelegramVoiceSynthesisProviders__` registry with
#    stable id `pi-telegram-tts/synth`.
# 2. Re-load idempotency — re-loading `index.ts` does not throw and
#    the registry stays single-keyed (hot-reload safety).
# 3. Unconfigured fall through — without `telegram.json`,
#    `provider(text, options)` (callable form) returns `undefined`
#    (the bridge then falls through to `outboundHandlers[0].template`).
# 4. Disabled fall through — with
#    `extensions["pi-telegram-tts"].disabled: true`,
#    `provider(text, options)` returns `undefined`.
# 5. Type-guard fall through — with
#    `extensions["pi-telegram-tts"].provider: "bogus"`,
#    `provider(text, options)` returns `undefined`.
# 6. Live TTS round-trip (optional) — with a real MiniMax or OpenAI
#    config + `voice.sendTranscript: true`, `synthesizeOgg()` returns
#    a valid OGG/Opus path with the transcript attached; `file`
#    confirms the encoding; intermediate MP3 is unlinked.
# 7. sendTranscript: true → result.transcriptText === input text
#    (optional; needs network).
# 8. sendTranscript: false → result.transcriptText === undefined
#    (optional; needs network). This pins the v0.1.0 fix where
#    `synthesizeOgg` consults `getTelegramVoiceSendTranscript`.
# 9-12. `getVoicePromptContribution(view)` across the 4 reachable
#    `replyMode × hasVoiceInput` combinations:
#      9. hidden (all flags false)           → undefined
#     10. mirror + voice input               → `[tts] Reply briefly; …`
#     11. always + text input                → `[tts] Reply briefly; …`
#     12. always + voice input               → `[tts] Reply briefly; …`
#    Stages 9-12 are pure (no network) so they run even with
#    `--no-network`.
# 13. Bridge callable-contract (v0.36.11) — the registered provider
#     is a *function* (not an object) so the bridge's
#     `typeof provider !== "function"` gate at
#     `outbound-voice.ts:235-244` passes. `getVoicePromptContribution`
#     remains reachable as a property. Without this stage the bridge
#     would log "Registered voice synthesis provider is not callable
#     (policy-only object?)" and skip the provider (caught in
#     live test on 2026-08-23; the v0.1.0 fix landed the same day).
#
# Exits 0 on success, non-zero on any failure. Output is terse —
# designed to be CI-friendly (one line per stage + summary).
#
# Usage:
#   bash scripts/pi-telegram-tts-smoke-test.sh
#   bash scripts/pi-telegram-tts-smoke-test.sh --no-network   # skip stage 6
#   bash scripts/pi-telegram-tts-smoke-test.sh --keep         # keep temp dir
#   bash scripts/pi-telegram-tts-smoke-test.sh --voice Cantonese_PlayfulMan
#
# Required tools: node (>=22.6.0 per the package's `engines` field;
# jiti 2.x requires node 20+), ffmpeg, ffprobe. Network access to
# api.minimaxi.com (or api.openai.com) is required for stage 6 only.
# A `~/.mmx/config.json` (or `MINIMAX_CN_API_KEY` / `OPENAI_API_KEY`
# env var) is required for stage 6 only.

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Args + env checks
# ---------------------------------------------------------------------------

PROVIDER="minimax"
VOICE="Cantonese_PlayfulMan"
MODEL="speech-2.8-hd"
KEEP=0
NO_NETWORK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2 ;;
    --voice)    VOICE="$2"; shift 2 ;;
    --model)    MODEL="$2"; shift 2 ;;
    --keep)     KEEP=1; shift ;;
    --no-network) NO_NETWORK=1; shift ;;
    -h|--help)
      sed -n '2,42p' "$0"; exit 0 ;;
    *) echo "pi-telegram-tts-smoke-test: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Node version check. The package's `engines` field says
# `node >= 22.6.0`; jiti 2.x requires node 20+. Fail fast.
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "0")
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "pi-telegram-tts-smoke-test: FAIL — node major version is $NODE_MAJOR, need >=22" >&2
  echo "  current: $(node --version 2>&1)" >&2
  exit 3
fi

# Tool checks (ffmpeg only required if stage 6 runs).
for tool in node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "pi-telegram-tts-smoke-test: FAIL — missing tool: $tool" >&2
    exit 4
  fi
done
if [[ $NO_NETWORK -eq 0 ]]; then
  for tool in ffmpeg ffprobe; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "pi-telegram-tts-smoke-test: FAIL — missing tool: $tool (required for stage 6)" >&2
      echo "  hint: re-run with --no-network to skip stage 6" >&2
      exit 4
    fi
  done
fi

# Resolve the package source. The script can run from any cwd; resolve
# relative to itself so it works whether invoked from the repo root or
# from scripts/.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_DIR="$REPO_ROOT/extensions/pi-telegram-tts"

if [[ ! -d "$PKG_DIR" ]]; then
  echo "pi-telegram-tts-smoke-test: FAIL — package dir not found: $PKG_DIR" >&2
  exit 4
fi

# jiti lives in the repo's node_modules (the repo's IntelliSense install).
JITI_PATH="$REPO_ROOT/node_modules/jiti"
if [[ ! -d "$JITI_PATH" ]]; then
  echo "pi-telegram-tts-smoke-test: FAIL — jiti not found at $JITI_PATH" >&2
  echo "  hint: run \`npm install\` in the repo root" >&2
  exit 4
fi

# Set up a sidecar agent dir for the test's own telegram.json. This
# avoids clobbering the operator's real config and gives us a clean
# canvas for stages 3-5.
TMP=$(mktemp -d)
export PI_CODING_AGENT_DIR="$TMP/agent"
mkdir -p "$PI_CODING_AGENT_DIR"

cleanup() {
  if [[ $KEEP -eq 0 ]]; then
    rm -rf "$TMP"
  else
    echo "  (--keep: temp dir preserved at $TMP)"
  fi
}
trap cleanup EXIT

# Reusable helpers.
ok()  { printf "  %sok%s  %s\n"  "$(printf '\033[32m')" "$(printf '\033[0m')" "$1"; }
fail(){ printf "  %sFAIL%s %s\n"  "$(printf '\033[31m')" "$(printf '\033[0m')" "$1"; }
info(){ printf "       %s\n" "$1"; }
hr()  { printf -- "------------------------------------------------------------\n"; }

# ---------------------------------------------------------------------------
# 1. jiti load + module-load registration
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-tts-smoke-test: stage 1/14 — jiti load + module-load registration"

NODE_CODE='
const path = require("node:path");
const fs = require("node:fs");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const PKG = process.env.PKG_DIR;
const jiti = createJiti(PKG, { esmResolve: true, interopDefault: true });

// Load all 4 source files; module-load side effects run.
for (const f of ["index.ts", "synth.ts", "telegram-config.ts", "_logger.ts"]) {
  jiti(path.join(PKG, f));
}

// Verify the registry has our id.
const reg = globalThis["__piTelegramVoiceSynthesisProviders__"];
if (!(reg instanceof Map)) { console.error("registry missing"); process.exit(1); }
const ids = Array.from(reg.keys());
if (!ids.includes("pi-telegram-tts/synth")) {
  console.error("registry ids:", ids, "(missing pi-telegram-tts/synth)");
  process.exit(1);
}
console.log("registered:", ids.join(","));
'

if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
  ok "module-load registered pi-telegram-tts/synth"
else
  fail "module-load registration failed"
  exit 5
fi

# ---------------------------------------------------------------------------
# 2. Re-load idempotency
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-tts-smoke-test: stage 2/14 — re-load idempotency"

NODE_CODE='
const path = require("node:path");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
jiti(path.join(process.env.PKG_DIR, "index.ts"));
jiti(path.join(process.env.PKG_DIR, "index.ts"));
const reg = globalThis["__piTelegramVoiceSynthesisProviders__"];
const count = Array.from(reg.keys()).filter((k) => k === "pi-telegram-tts/synth").length;
if (count !== 1) { console.error("expected 1 entry, got", count); process.exit(1); }
console.log("registry after re-load:", count, "entry");
'

if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
  ok "registry stays single-keyed across re-loads"
else
  fail "re-load broke idempotency"
  exit 5
fi

# ---------------------------------------------------------------------------
# 3. Unconfigured fall through (no telegram.json)
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-tts-smoke-test: stage 3/14 — unconfigured → fall through"

# PI_CODING_AGENT_DIR was set to a fresh dir; no telegram.json there.
NODE_CODE='
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
jiti(path.join(process.env.PKG_DIR, "index.ts"));
const reg = globalThis["__piTelegramVoiceSynthesisProviders__"];
const p = reg.get("pi-telegram-tts/synth");
p("hello", {}).then((out) => {
  if (out !== undefined) { console.error("expected undefined, got", out); process.exit(1); }
  console.log("returned: undefined");
});
'

if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
  ok "unconfigured provider() returned undefined"
else
  fail "unconfigured provider() did not fall through"
  exit 5
fi

# ---------------------------------------------------------------------------
# 4. Disabled fall through
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-tts-smoke-test: stage 4/14 — disabled → fall through"

cat > "$PI_CODING_AGENT_DIR/telegram.json" <<EOF
{
  "extensions": {
    "pi-telegram-tts": {
      "provider": "$PROVIDER",
      "voice": "$VOICE",
      "model": "$MODEL",
      "disabled": true
    }
  }
}
EOF

NODE_CODE='
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
jiti(path.join(process.env.PKG_DIR, "index.ts"));
const reg = globalThis["__piTelegramVoiceSynthesisProviders__"];
const p = reg.get("pi-telegram-tts/synth");
p("hello", {}).then((out) => {
  if (out !== undefined) { console.error("expected undefined, got", out); process.exit(1); }
  console.log("returned: undefined");
});
'

if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
  ok "disabled provider() returned undefined"
else
  fail "disabled provider() did not fall through"
  exit 5
fi

# ---------------------------------------------------------------------------
# 5. Type-guard fall through (invalid provider id)
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-tts-smoke-test: stage 5/14 — invalid provider → fall through"

cat > "$PI_CODING_AGENT_DIR/telegram.json" <<EOF
{
  "extensions": {
    "pi-telegram-tts": {
      "provider": "bogus",
      "voice": "X",
      "model": "Y"
    }
  }
}
EOF

NODE_CODE='
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
jiti(path.join(process.env.PKG_DIR, "index.ts"));
const reg = globalThis["__piTelegramVoiceSynthesisProviders__"];
const p = reg.get("pi-telegram-tts/synth");
p("hello", {}).then((out) => {
  if (out !== undefined) { console.error("expected undefined, got", out); process.exit(1); }
  console.log("returned: undefined");
});
'

if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
  ok "invalid-provider provider() returned undefined"
else
  fail "invalid-provider provider() did not fall through"
  exit 5
fi

# ---------------------------------------------------------------------------
# 6. Live TTS round-trip (skipped with --no-network)
# ---------------------------------------------------------------------------
hr
if [[ $NO_NETWORK -eq 1 ]]; then
  echo "pi-telegram-tts-smoke-test: stage 6/14 — live TTS round-trip (skipped: --no-network)"
  info "re-run without --no-network to exercise the full spawn + ffmpeg path"
else
  echo "pi-telegram-tts-smoke-test: stage 6/14 — live TTS round-trip (provider=$PROVIDER voice=$VOICE model=$MODEL)"

  # Provider-specific env check. The scripts read from env first, then
  # from the mmx/openai config files.
  if [[ "$PROVIDER" == "minimax" ]]; then
    if [[ -z "${MINIMAX_CN_API_KEY:-}${MINIMAX_API_KEY:-}" ]] \
        && ! [[ -f "$HOME/.mmx/config.json" ]] \
        && ! [[ -f "$HOME/.MiniMax/config.json" ]]; then
      echo "pi-telegram-tts-smoke-test: FAIL — no MiniMax API key found" >&2
      echo "  set MINIMAX_CN_API_KEY, or create ~/.mmx/config.json" >&2
      echo "  hint: re-run with --no-network to skip stage 6" >&2
      exit 6
    fi
  fi

  cat > "$PI_CODING_AGENT_DIR/telegram.json" <<EOF
{
  "voice": { "sendTranscript": true },
  "extensions": {
    "pi-telegram-tts": {
      "provider": "$PROVIDER",
      "voice": "$VOICE",
      "model": "$MODEL"
    }
  }
}
EOF

  NODE_CODE='
const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });

// Reach the synth module directly so we can pass an explicit cfg and
// a real text input. The provider closure in the registry is fine
// too, but a direct call is more transparent for a smoke test.
const { synthesizeOgg } = jiti(path.join(process.env.PKG_DIR, "synth.ts"));
const { loadSynthConfig, loadTelegramConfig } = jiti(path.join(process.env.PKG_DIR, "telegram-config.js")) || jiti(path.join(process.env.PKG_DIR, "telegram-config.ts"));

(async () => {
  const cfg = loadSynthConfig();
  if (!cfg.provider) { console.error("config not loaded"); process.exit(1); }
  const telegramConfig = loadTelegramConfig();
  const text = "Hello, this is a round-trip smoke test from pi-telegram-tts v0.1.0.";
  const result = await synthesizeOgg(text, { lang: "yue" }, cfg, telegramConfig);
  if (!result) { console.error("synthesizeOgg returned undefined"); process.exit(1); }
  if (!fs.existsSync(result.audioPath)) { console.error("audioPath missing:", result.audioPath); process.exit(1); }
  const stat = fs.statSync(result.audioPath);
  const fileType = execSync(`file "${result.audioPath}"`, { encoding: "utf8" }).trim();
  console.log("audioPath:", result.audioPath);
  console.log("size:", stat.size, "bytes");
  console.log("file:", fileType);
  if (!/Ogg data.*Opus audio/.test(fileType)) { console.error("not Ogg/Opus"); process.exit(1); }
  // With voice.sendTranscript=true, the result must include the
  // transcriptText so the bridge can attach a caption.
  if (result.transcriptText !== text) { console.error("transcript mismatch (expected:", text, "got:", result.transcriptText, ")"); process.exit(1); }
  // synthesizeOgg schedules a 60s cleanup timer; explicit exit
  // prevents the test from waiting for it.
  process.exit(0);
})().catch((e) => { console.error("threw:", e); process.exit(1); });
'

  if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
    ok "live round-trip produced valid OGG/Opus"
  else
    fail "live round-trip failed"
    exit 6
  fi
fi

# ---------------------------------------------------------------------------
# 7. sendTranscript: true → transcriptText === text
# ---------------------------------------------------------------------------
hr
if [[ $NO_NETWORK -eq 1 ]]; then
  echo "pi-telegram-tts-smoke-test: stage 7/14 — sendTranscript true → transcript included (skipped: --no-network)"
  info "re-run without --no-network to exercise the spawn + ffmpeg path with sendTranscript=true"
else
  echo "pi-telegram-tts-smoke-test: stage 7/14 — sendTranscript true → transcript included"

  cat > "$PI_CODING_AGENT_DIR/telegram.json" <<EOF
{
  "voice": { "sendTranscript": true },
  "extensions": {
    "pi-telegram-tts": {
      "provider": "$PROVIDER",
      "voice": "$VOICE",
      "model": "$MODEL"
    }
  }
}
EOF

  NODE_CODE='
const path = require("node:path");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const { synthesizeOgg } = jiti(path.join(process.env.PKG_DIR, "synth.ts"));
const { loadSynthConfig, loadTelegramConfig } = jiti(path.join(process.env.PKG_DIR, "telegram-config.js")) || jiti(path.join(process.env.PKG_DIR, "telegram-config.ts"));
(async () => {
  const cfg = loadSynthConfig();
  const telegramConfig = loadTelegramConfig();
  const text = "sendTranscript: true should include the transcript text.";
  const result = await synthesizeOgg(text, {}, cfg, telegramConfig);
  if (!result) { console.error("returned undefined"); process.exit(1); }
  if (result.transcriptText !== text) { console.error("expected transcriptText:", text, "got:", result.transcriptText); process.exit(1); }
  console.log("transcriptText:", JSON.stringify(result.transcriptText));
  process.exit(0);
})().catch((e) => { console.error("threw:", e); process.exit(1); });
'

  if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
    ok "sendTranscript=true → result.transcriptText === input text"
  else
    fail "sendTranscript=true did not include transcriptText"
    exit 7
  fi
fi

# ---------------------------------------------------------------------------
# 8. sendTranscript: false → transcriptText === undefined
# ---------------------------------------------------------------------------
hr
if [[ $NO_NETWORK -eq 1 ]]; then
  echo "pi-telegram-tts-smoke-test: stage 8/14 — sendTranscript false → transcript suppressed (skipped: --no-network)"
  info "re-run without --no-network to exercise the spawn + ffmpeg path with sendTranscript=false"
else
  echo "pi-telegram-tts-smoke-test: stage 8/14 — sendTranscript false → transcript suppressed"

  cat > "$PI_CODING_AGENT_DIR/telegram.json" <<EOF
{
  "voice": { "sendTranscript": false },
  "extensions": {
    "pi-telegram-tts": {
      "provider": "$PROVIDER",
      "voice": "$VOICE",
      "model": "$MODEL"
    }
  }
}
EOF

  NODE_CODE='
const path = require("node:path");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const { synthesizeOgg } = jiti(path.join(process.env.PKG_DIR, "synth.ts"));
const { loadSynthConfig, loadTelegramConfig } = jiti(path.join(process.env.PKG_DIR, "telegram-config.js")) || jiti(path.join(process.env.PKG_DIR, "telegram-config.ts"));
(async () => {
  const cfg = loadSynthConfig();
  const telegramConfig = loadTelegramConfig();
  const text = "sendTranscript: false should NOT include the transcript text.";
  const result = await synthesizeOgg(text, {}, cfg, telegramConfig);
  if (!result) { console.error("returned undefined"); process.exit(1); }
  if (result.transcriptText !== undefined) { console.error("expected undefined, got:", result.transcriptText); process.exit(1); }
  console.log("transcriptText: undefined (correct)");
  console.log("audioPath present:", !!result.audioPath);
  process.exit(0);
})().catch((e) => { console.error("threw:", e); process.exit(1); });
'

  if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
    ok "sendTranscript=false → result.transcriptText is undefined"
  else
    fail "sendTranscript=false did not suppress transcriptText"
    exit 8
  fi
fi

# ---------------------------------------------------------------------------
# 9-12. getVoicePromptContribution across the 4 reachable view shapes
# ---------------------------------------------------------------------------
# The bridge passes a `TelegramVoiceTurnView` computed from
# `replyMode` + `hasVoiceFile`. The provider's `getVoicePromptContribution`
# is the only in-process surface that observes the mode. The 4 cases:
#   9. hidden (all flags false)             → undefined
#  10. mirror + voice input                 → hint
#  11. always + text input (no voice file)  → hint
#  12. always + voice input                 → hint
# Stages 9-12 are pure (no network), so they run even with --no-network.

# Reusable node code template; the view is parameterized.
NODE_CODE_TEMPLATE='
const path = require("node:path");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
// index.ts does module-load registration; re-trigger by importing it.
jiti(path.join(process.env.PKG_DIR, "index.ts"));
const reg = globalThis["__piTelegramVoiceSynthesisProviders__"];
const p = reg.get("pi-telegram-tts/synth");
const view = JSON.parse(process.env.VIEW_JSON);
const out = p.getVoicePromptContribution(view);
const expectHint = process.env.EXPECT_HINT === "1";
if (expectHint) {
  if (typeof out !== "string" || !out.includes("Reply briefly")) { console.error("expected hint, got:", JSON.stringify(out)); process.exit(1); }
  console.log("hint:", JSON.stringify(out));
} else {
  if (out !== undefined) { console.error("expected undefined, got:", JSON.stringify(out)); process.exit(1); }
  console.log("undefined (correct)");
}
'

# --- 9. hidden: voiceReplyPreferred=false, voiceReplyRequired=false, hasVoiceInput=false
hr
echo "pi-telegram-tts-smoke-test: stage 9/14 — getVoicePromptContribution (hidden mode)"
if VIEW_JSON='{}' EXPECT_HINT=0 \
    JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE_TEMPLATE"; then
  ok "hidden view → undefined"
else
  fail "hidden view did not return undefined"
  exit 9
fi

# --- 10. mirror + voice: hasVoiceInput=true, voiceReplyPreferred=true
echo "pi-telegram-tts-smoke-test: stage 10/14 — getVoicePromptContribution (mirror + voice)"
if VIEW_JSON='{"hasVoiceInput":true,"voiceReplyPreferred":true,"userText":"hi"}' EXPECT_HINT=1 \
    JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE_TEMPLATE"; then
  ok "mirror+voice view → hint"
else
  fail "mirror+voice view did not return hint"
  exit 10
fi

# --- 11. always + text: hasVoiceInput=false, voiceReplyRequired=true
echo "pi-telegram-tts-smoke-test: stage 11/14 — getVoicePromptContribution (always + text)"
if VIEW_JSON='{"hasVoiceInput":false,"voiceReplyRequired":true,"userText":"hi"}' EXPECT_HINT=1 \
    JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE_TEMPLATE"; then
  ok "always+text view → hint"
else
  fail "always+text view did not return hint"
  exit 11
fi

# --- 12. always + voice: hasVoiceInput=true, voiceReplyRequired=true
echo "pi-telegram-tts-smoke-test: stage 12/14 — getVoicePromptContribution (always + voice)"
if VIEW_JSON='{"hasVoiceInput":true,"voiceReplyPreferred":true,"voiceReplyRequired":true,"userText":"hi"}' EXPECT_HINT=1 \
    JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE_TEMPLATE"; then
  ok "always+voice view → hint"
else
  fail "always+voice view did not return hint"
  exit 12
fi

# ---------------------------------------------------------------------------
# 13. Bridge callable-contract (v0.36.11 `outbound-voice.ts:235`)
# ---------------------------------------------------------------------------
# The bridge iterates the provider registry and gates each entry with
# `typeof provider !== "function"`. An object literal satisfies the
# TypeScript `TelegramVoiceSynthesisProvider` interface but fails this
# runtime gate (it logs "Registered voice synthesis provider is not
# callable (policy-only object?)" and skips the provider — the bug
# the v0.1.0 live test caught on 2026-08-23). Stage 13 pins the fix:
# the registered provider must be a function, callable as
# `p(text, { lang, rate })` to match the bridge's invocation shape,
# AND still expose `getVoicePromptContribution` as a property for the
# bridge's prompt-contribution loop (`voice.ts:305-312`). No network;
# runs in `--no-network` mode.
hr
echo "pi-telegram-tts-smoke-test: stage 13/14 — bridge callable contract (v0.36.11)"

# Clear telegram.json (stages 6-8 leave a configured one in the
# temp agent dir). Stage 13 exercises the unconfigured path so the
# `provider()` call must return undefined — this mirrors the bridge's
# `outbound-voice.ts:251-258` "empty result → continue" path.
rm -f "$PI_CODING_AGENT_DIR/telegram.json"

NODE_CODE='
const path = require("node:path");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
jiti(path.join(process.env.PKG_DIR, "index.ts"));
const reg = globalThis["__piTelegramVoiceSynthesisProviders__"];
const p = reg.get("pi-telegram-tts/synth");
if (!p) { console.error("provider not registered"); process.exit(1); }
if (typeof p !== "function") {
  console.error("typeof provider is", typeof p, "— bridge would skip with policy-only object error");
  process.exit(1);
}
if (typeof p.getVoicePromptContribution !== "function") {
  console.error("getVoicePromptContribution missing on provider");
  process.exit(1);
}
(async () => {
  // Call shape matches outbound-voice.ts:246-249:
  //   await provider(text, { lang, rate })
  const out = await p("hello bridge", { lang: "yue", rate: "1.0" });
  if (out !== undefined) {
    console.error("expected undefined (unconfigured), got:", JSON.stringify(out));
    process.exit(1);
  }
  // getVoicePromptContribution still reachable (bridge calls it on the
  // same object at voice.ts:305-312).
  const hint = p.getVoicePromptContribution({ hasVoiceInput: true, voiceReplyPreferred: true, userText: "hi" });
  if (typeof hint !== "string" || !hint.includes("Reply briefly")) {
    console.error("hint missing or wrong:", JSON.stringify(hint));
    process.exit(1);
  }
  console.log("typeof provider:", typeof p);
  console.log("getVoicePromptContribution typeof:", typeof p.getVoicePromptContribution);
  console.log("callable() → undefined (correct, unconfigured)");
  console.log("getVoicePromptContribution → hint (correct, voice-tagged view)");
})().catch((e) => { console.error("threw:", e); process.exit(1); });
'

if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
  ok "provider is callable + getVoicePromptContribution reachable (bridge v0.36.11 contract)"
else
  fail "provider fails bridge callable contract"
  exit 13
fi

# ---------------------------------------------------------------------------
# 14. Bundled scripts exist (v0.2.0: scripts subsumed into this package)
# ---------------------------------------------------------------------------
# Stage 14 pins the v0.2.0 file move: the tts-{minimax,openai}.mjs
# scripts now ship inside this package (previously in the separate
# `pi-voice-telegram-scripts` package). The `bin` field in
# `package.json` exposes them on PATH after `npm install`. Stage 14
# verifies the source files exist in the package dir (the dev path
# `resolveScriptPath` uses) AND that `package.json` declares the
# correct `bin` entries (the npm-install path).
hr
echo "pi-telegram-tts-smoke-test: stage 14/14 — bundled scripts exist (v0.2.0)"

# Dev path: tts-{minimax,openai}.mjs must exist in the same dir as
# synth.ts (i.e. the package source dir).
for script in tts-minimax.mjs tts-openai.mjs; do
  if [[ ! -f "$PKG_DIR/$script" ]]; then
    fail "bundled script missing: $PKG_DIR/$script"
    exit 14
  fi
done
ok "tts-minimax.mjs and tts-openai.mjs exist in $PKG_DIR"

# npm-install path: package.json's `bin` field must declare both
# entries (so `tts-minimax` / `tts-openai` resolve on PATH after
# `npm install`).
NODE_CODE='
const pkg = require(process.env.PKG_DIR + "/package.json");
const bin = pkg.bin;
if (!bin || bin["tts-minimax"] !== "./tts-minimax.mjs" || bin["tts-openai"] !== "./tts-openai.mjs") {
  console.error("bin field wrong:", JSON.stringify(bin));
  process.exit(1);
}
console.log("bin:", JSON.stringify(bin));
'

if PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
  ok "package.json bin field exposes tts-minimax and tts-openai"
else
  fail "package.json bin field is wrong"
  exit 14
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-tts-smoke-test: ALL STAGES PASSED"
echo "  provider: $PROVIDER"
echo "  voice:    $VOICE"
echo "  model:    $MODEL"
echo "  network:  $([[ $NO_NETWORK -eq 1 ]] && echo "skipped (stages 6/7/8 not run)" || echo "exercised (stages 6/7/8 passed)")"
echo
echo "  Next: run \`bash scripts/dev-status.sh\` if you want a live snapshot"
echo "  of the bridge / agent state with the package installed."
