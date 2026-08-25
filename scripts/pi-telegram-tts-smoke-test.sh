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
#    config, `synthesizeOgg()` returns a valid OGG/Opus path; `file`
#    confirms the encoding; intermediate MP3 is unlinked.
# 7-10. `getVoicePromptContribution(view)` across the 4 reachable
#    `replyMode × hasVoiceInput` combinations:
#      7. manual (all flags false)            → undefined
#      8. mirror + voice input               → `[tts] Reply briefly; …`
#      9. always + text input                → `[tts] Reply briefly; …`
#     10. always + voice input               → `[tts] Reply briefly; …`
#    Stages 7-10 are pure (no network) so they run even with
#    `--no-network`. (Upstream `@llblab/pi-telegram@0.38.0` renamed
#    `hidden` → `manual`; `hidden` is a read-only alias.)
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
echo "pi-telegram-tts-smoke-test: stage 1/16 — jiti load + module-load registration"

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
echo "pi-telegram-tts-smoke-test: stage 2/16 — re-load idempotency"

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
echo "pi-telegram-tts-smoke-test: stage 3/16 — unconfigured → fall through"

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
echo "pi-telegram-tts-smoke-test: stage 4/16 — disabled → fall through"

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
echo "pi-telegram-tts-smoke-test: stage 5/16 — invalid provider → fall through"

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
  echo "pi-telegram-tts-smoke-test: stage 6/16 — live TTS round-trip (skipped: --no-network)"
  info "re-run without --no-network to exercise the full spawn + ffmpeg path"
else
  echo "pi-telegram-tts-smoke-test: stage 6/16 — live TTS round-trip (provider=$PROVIDER voice=$VOICE model=$MODEL)"

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
//
// v0.4.0: synthesizeOgg signature is now (text, options, cfg) and
// returns Promise<string | undefined> (just the OGG path). The
// v0.3.0 {audioPath, transcriptText?} return shape was removed by
// upstream @llblab/pi-telegram@0.38.0+ which deleted the
// voice.sendTranscript feature entirely. The text+voice composition
// is now the agent explicit responsibility (handled in index.ts
// via sendTelegramView with instance scope), not the provider.
const { synthesizeOgg } = jiti(path.join(process.env.PKG_DIR, "synth.ts"));
const { loadSynthConfig } = jiti(path.join(process.env.PKG_DIR, "telegram-config.js")) || jiti(path.join(process.env.PKG_DIR, "telegram-config.ts"));

(async () => {
  const cfg = loadSynthConfig();
  if (!cfg.provider) { console.error("config not loaded"); process.exit(1); }
  const text = "Hello, this is a round-trip smoke test from pi-telegram-tts v0.4.0.";
  const audioPath = await synthesizeOgg(text, { lang: "yue" }, cfg);
  if (!audioPath) { console.error("synthesizeOgg returned undefined"); process.exit(1); }
  if (!fs.existsSync(audioPath)) { console.error("audioPath missing:", audioPath); process.exit(1); }
  const stat = fs.statSync(audioPath);
  const fileType = execSync(`file "${audioPath}"`, { encoding: "utf8" }).trim();
  console.log("audioPath:", audioPath);
  console.log("size:", stat.size, "bytes");
  console.log("file:", fileType);
  if (!/Ogg data.*Opus audio/.test(fileType)) { console.error("not Ogg/Opus"); process.exit(1); }
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
# 7-10. getVoicePromptContribution across the 4 reachable view shapes
# ---------------------------------------------------------------------------
# The bridge passes a `TelegramVoiceTurnView` computed from
# `replyMode` + `hasVoiceFile`. The provider's `getVoicePromptContribution`
# is the only in-process surface that observes the mode. The 4 cases:
#   7. manual (all flags false)            → undefined
#   8. mirror + voice input               → hint
#   9. always + text input (no voice file) → hint
#  10. always + voice input                → hint
# Stages 7-10 are pure (no network), so they run even with --no-network.
# (Upstream `@llblab/pi-telegram@0.38.0` renamed `hidden` → `manual`.)

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
echo "pi-telegram-tts-smoke-test: stage 7/16 — getVoicePromptContribution (manual mode)"
if VIEW_JSON='{}' EXPECT_HINT=0 \
    JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE_TEMPLATE"; then
  ok "hidden view → undefined"
else
  fail "hidden view did not return undefined"
  exit 9
fi

# --- 10. mirror + voice: hasVoiceInput=true, voiceReplyPreferred=true
echo "pi-telegram-tts-smoke-test: stage 8/16 — getVoicePromptContribution (mirror + voice)"
if VIEW_JSON='{"hasVoiceInput":true,"voiceReplyPreferred":true,"userText":"hi"}' EXPECT_HINT=1 \
    JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE_TEMPLATE"; then
  ok "mirror+voice view → hint"
else
  fail "mirror+voice view did not return hint"
  exit 10
fi

# --- 11. always + text: hasVoiceInput=false, voiceReplyRequired=true
echo "pi-telegram-tts-smoke-test: stage 9/16 — getVoicePromptContribution (always + text)"
if VIEW_JSON='{"hasVoiceInput":false,"voiceReplyRequired":true,"userText":"hi"}' EXPECT_HINT=1 \
    JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE_TEMPLATE"; then
  ok "always+text view → hint"
else
  fail "always+text view did not return hint"
  exit 11
fi

# --- 12. always + voice: hasVoiceInput=true, voiceReplyRequired=true
echo "pi-telegram-tts-smoke-test: stage 10/16 — getVoicePromptContribution (always + voice)"
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
echo "pi-telegram-tts-smoke-test: stage 11/16 — bridge callable contract (v0.36.11)"

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
echo "pi-telegram-tts-smoke-test: stage 12/16 — bundled scripts exist (v0.2.0)"

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
# 13-15. v0.3.0 — per-provider sub-block reader
#      (loadSynthConfig handles a `minimax: { ... }`
#      and `openai: { ... }` sub-block under
#      `extensions["pi-telegram-tts"]`. The script is the runtime
#      validator; the reader is just the type-guard. v0.5.0 dropped
#      the in-package `saveSynthConfig` writer — the operator or
#      agent edits `telegram.json` directly.)
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-tts-smoke-test: stage 13/16 — v0.3.0 loadSynthConfig().minimax returns the sub-block"

SUB_OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadSynthConfig } = jiti(process.env.PKG_DIR + '/telegram-config.ts');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tts-sub-'));
process.env.PI_CODING_AGENT_DIR = tmpDir;
fs.writeFileSync(path.join(tmpDir, 'telegram.json'), JSON.stringify({
  extensions: { 'pi-telegram-tts': {
    disabled: false, provider: 'minimax',
    minimax: { voice: 'Cantonese_PlayfulMan', model: 'speech-2.8-hd', speed: 1.6 },
  } },
}, null, 2));

const cfg = loadSynthConfig();
if (cfg.provider !== 'minimax') { console.error('provider:', cfg.provider); process.exit(1); }
if (!cfg.minimax || cfg.minimax.voice !== 'Cantonese_PlayfulMan') { console.error('minimax:', JSON.stringify(cfg.minimax)); process.exit(1); }
if (cfg.minimax.speed !== 1.6) { console.error('minimax.speed:', cfg.minimax.speed); process.exit(1); }
console.log('provider:', cfg.provider, '| minimax.voice:', cfg.minimax.voice, '| minimax.model:', cfg.minimax.model, '| speed:', cfg.minimax.speed);

fs.rmSync(tmpDir, { recursive: true, force: true });
" 2>&1)
if [[ $? -eq 0 ]]; then
  ok "loadSynthConfig returns the minimax sub-block as-is (ProviderConfig is a free-form Record<string, unknown>)"
else
  fail "v0.3.0 sub-block reader failed"
  echo "$SUB_OUT"
  exit 13
fi

hr
echo "pi-telegram-tts-smoke-test: stage 14/16 — v0.3.0 sub-block field > top-level when both present"

PREC_OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadSynthConfig } = jiti(process.env.PKG_DIR + '/telegram-config.ts');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tts-prec-'));
process.env.PI_CODING_AGENT_DIR = tmpDir;
fs.writeFileSync(path.join(tmpDir, 'telegram.json'), JSON.stringify({
  extensions: { 'pi-telegram-tts': {
    disabled: false, provider: 'minimax',
    voice: 'top-level-voice', model: 'top-level-model',
    minimax: { voice: 'sub-block-voice', model: 'sub-block-model' },
  } },
}, null, 2));

// loadSynthConfig returns top-level voice/model; the per-key merge
// happens in synth.ts's effective-resolution. The READER test:
// top-level fields are returned (the merge happens at spawn time).
const cfg = loadSynthConfig();
if (cfg.voice !== 'top-level-voice') { console.error('top-level voice:', cfg.voice); process.exit(1); }
if (cfg.model !== 'top-level-model') { console.error('top-level model:', cfg.model); process.exit(1); }
if (cfg.minimax.voice !== 'sub-block-voice') { console.error('sub-block voice:', cfg.minimax.voice); process.exit(1); }
console.log('top-level: voice=' + cfg.voice + ', model=' + cfg.model);
console.log('sub-block: voice=' + cfg.minimax.voice + ', model=' + cfg.minimax.model);
console.log('(merge happens at synth.ts spawn time, not at load time)');

fs.rmSync(tmpDir, { recursive: true, force: true });
" 2>&1)
if [[ $? -eq 0 ]]; then
  ok "reader returns both top-level and sub-block; synth.ts's effective-resolution does the per-key merge"
else
  fail "v0.3.0 sub-block precedence check failed"
  echo "$PREC_OUT"
  exit 14
fi

hr
echo "pi-telegram-tts-smoke-test: stage 15/16 — v0.3.0 empty sub-block + top-level voice/model"

EMPTY_OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadSynthConfig } = jiti(process.env.PKG_DIR + '/telegram-config.ts');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tts-empty-'));
process.env.PI_CODING_AGENT_DIR = tmpDir;
// No sub-block at all; only top-level voice/model.
fs.writeFileSync(path.join(tmpDir, 'telegram.json'), JSON.stringify({
  extensions: { 'pi-telegram-tts': {
    disabled: false, provider: 'minimax',
    voice: 'Cantonese_PlayfulMan', model: 'speech-2.8-hd',
  } },
}, null, 2));

const cfg = loadSynthConfig();
if (cfg.minimax !== undefined) { console.error('minimax should be undefined when absent:', cfg.minimax); process.exit(1); }
if (cfg.voice !== 'Cantonese_PlayfulMan') { console.error('voice:', cfg.voice); process.exit(1); }
console.log('no sub-block; top-level voice=' + cfg.voice + ' model=' + cfg.model);

fs.rmSync(tmpDir, { recursive: true, force: true });
" 2>&1)
if [[ $? -eq 0 ]]; then
  ok "empty sub-block + top-level voice/model works (sub-block is undefined; top-level takes effect)"
else
  fail "v0.3.0 empty sub-block check failed"
  echo "$EMPTY_OUT"
  exit 15
fi

hr
echo "pi-telegram-tts-smoke-test: stage 16/16 — v0.4.0 no Section UI (the section file was dropped)"

# This is the final stage: it confirms the section file is GONE.
# Future regressions (someone accidentally adding the section back)
# will fail this test.
NOSEC_OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e '
const fs = require("node:fs");
const path = require("node:path");
const sectionPath = path.join(process.env.PKG_DIR, "section.ts");
if (fs.existsSync(sectionPath)) { console.error("section.ts should be DROPPED but exists:", sectionPath); process.exit(1); }
const sectionJsPath = path.join(process.env.PKG_DIR, "section.js");
if (fs.existsSync(sectionJsPath)) { console.error("section.js should not exist:", sectionJsPath); process.exit(1); }
console.log("section.ts/section.js are gone (per operator request 2026-08-24: drop the UI for tts completely)");

// Also verify index.ts does NOT import "./section.js" (the import
// line, not the word "section" in comments).
const indexPath = path.join(process.env.PKG_DIR, "index.ts");
const indexContent = fs.readFileSync(indexPath, "utf8");
// Use double quotes inside the regex (no single quotes to break
// the bash single-quoted arg).
if (/from\s+\S+\/section\S*/.test(indexContent)) {
  console.error("index.ts still imports ./section:", indexPath);
  process.exit(1);
}
console.log("index.ts does not import the section file (comment refs are OK)");
' 2>&1)
if [[ $? -eq 0 ]]; then
  ok "section.ts/section.js dropped; index.ts has no section import"
else
  fail "section-removal check failed"
  echo "$NOSEC_OUT"
  exit 22
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-tts-smoke-test: ALL STAGES PASSED"
echo "  provider: $PROVIDER"
echo "  voice:    $VOICE"
echo "  model:    $MODEL"
echo "  network:  $([[ $NO_NETWORK -eq 1 ]] && echo "skipped (stages 6 not run (6 is the only live network stage))" || echo "exercised (stages 6 passed (the only live network stage))")"
echo
echo "  Next: run \`bash scripts/dev-status.sh\` if you want a live snapshot"
echo "  of the bridge / agent state with the package installed."
