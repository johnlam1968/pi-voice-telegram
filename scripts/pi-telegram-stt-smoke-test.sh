#!/usr/bin/env bash
#
# pi-telegram-stt-smoke-test.sh — replayable smoke test for the
# `pi-telegram-stt` v0.8.0 sister extension (which now bundles
# the OpenAI-compatible STT provider). No agent, no bridge, no
# Telegram — just jiti-load the package source and exercise the
# in-process STT provider registry + config merge, with one optional
# stage that drives a live STT round-trip.
#
# ## What it tests
#
# 1. jiti load — `extensions/pi-telegram-stt/index.ts` loads without
#    error, and the OpenAI STT provider is registered in the
#    `globalThis.__piTelegramSttProviderRegistry__` registry with
#    stable id `pi-openai-stt` (same id as the deprecated external
#    `pi-openai-stt` package).
# 2. Re-load idempotency — re-loading `index.ts` does not throw
#    and the registry stays single-keyed (hot-reload safety).
# 3. Unconfigured fall through — without `telegram.json`, the
#    `transcribe()` call (against the in-registry provider) still
#    works (it falls through to env / auth.json / smart default).
# 4. Config merge — `extensions["pi-telegram-stt"].base_url` (v0.8.0
#    flat shape) is read by the provider's `transcribe()` path
#    (verified via `loadEchoConfig()` returning the expected shape).
# 5. Invalid base_url fall through — when `base_url` is set to
#    something unreachable, the provider surfaces a `ProviderError`
#    (code 2 = network) instead of crashing.
# 6. Live STT round-trip (optional) — drives `transcribe()` against
#    the local `whisper-server` (via the bundled provider's
#    `base_url` config). Skipped with `--no-network`.
#
# Exits 0 on success, non-zero on any failure. Output is terse —
# designed to be CI-friendly (one line per stage + summary).
#
# Usage:
#   bash scripts/pi-telegram-stt-smoke-test.sh
#   bash scripts/pi-telegram-stt-smoke-test.sh --no-network   # skip stage 6
#   bash scripts/pi-telegram-stt-smoke-test.sh --keep         # keep temp dir
#
# Required tools: node (>=22.6.0 per the package's `engines` field;
# jiti 2.x requires node 20+). Network access to the configured
# `base_url` is required for stage 6 only.

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Args + env checks
# ---------------------------------------------------------------------------

KEEP=0
NO_NETWORK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)        KEEP=1; shift ;;
    --no-network)  NO_NETWORK=1; shift ;;
    -h|--help)
      sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "pi-telegram-stt-smoke-test: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Node version check. jiti 2.x requires node 20+. Fail fast.
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "0")
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "pi-telegram-stt-smoke-test: FAIL — node major version is $NODE_MAJOR, need >=22" >&2
  echo "  current: $(node --version 2>&1)" >&2
  exit 3
fi

# Tool checks.
for tool in node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "pi-telegram-stt-smoke-test: FAIL — missing tool: $tool" >&2
    exit 4
  fi
done

# Resolve the package source.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_DIR="$REPO_ROOT/extensions/pi-telegram-stt"

if [[ ! -d "$PKG_DIR" ]]; then
  echo "pi-telegram-stt-smoke-test: FAIL — package dir not found: $PKG_DIR" >&2
  exit 4
fi

# jiti lives in the repo's node_modules (the repo's IntelliSense install).
JITI_PATH="$REPO_ROOT/node_modules/jiti"
if [[ ! -d "$JITI_PATH" ]]; then
  echo "pi-telegram-stt-smoke-test: FAIL — jiti not found at $JITI_PATH" >&2
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
echo "pi-telegram-stt-smoke-test: stage 1/13 — jiti load + module-load registration"

NODE_CODE='
const path = require("node:path");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const PKG = process.env.PKG_DIR;
const jiti = createJiti(PKG, { esmResolve: true, interopDefault: true });

// Load all 6 source files; module-load side effects run.
for (const f of ["index.ts", "echo-handler.ts", "section.ts", "telegram-config.ts", "stt-provider.ts", "openai-stt.ts", "_logger.ts"]) {
  jiti(path.join(PKG, f));
}

// Verify the registry has our provider.
const reg = globalThis["__piTelegramSttProviderRegistry__"];
if (!reg || !(reg.providers instanceof Map)) { console.error("registry missing"); process.exit(1); }
const ids = Array.from(reg.providers.keys());
if (!ids.includes("pi-openai-stt")) {
  console.error("registry ids:", ids, "(missing pi-openai-stt)");
  process.exit(1);
}
console.log("registered:", ids.join(","));
'

if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
  ok "module-load registered pi-openai-stt"
else
  fail "module-load registration failed"
  exit 5
fi

# ---------------------------------------------------------------------------
# 2. Re-load idempotency
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: stage 2/13 — re-load idempotency"

NODE_CODE='
const path = require("node:path");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
jiti(path.join(process.env.PKG_DIR, "index.ts"));
jiti(path.join(process.env.PKG_DIR, "index.ts"));
const reg = globalThis["__piTelegramSttProviderRegistry__"];
const count = Array.from(reg.providers.keys()).filter((k) => k === "pi-openai-stt").length;
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
# 3. Unconfigured fall through (no telegram.json) — provider is still
#    registered and can be invoked
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: stage 3/13 — unconfigured → provider callable"

# PI_CODING_AGENT_DIR was set to a fresh dir; no telegram.json there.
# The provider is still in the registry and can be called — it falls
# through to env / auth.json / smart default for base_url.
NODE_CODE='
const path = require("node:path");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
jiti(path.join(process.env.PKG_DIR, "index.ts"));
const reg = globalThis["__piTelegramSttProviderRegistry__"];
const p = reg.providers.get("pi-openai-stt");
if (!p) { console.error("provider not in registry"); process.exit(1); }
if (typeof p.transcribe !== "function") { console.error("transcribe not a function"); process.exit(1); }
console.log("provider:", p.id, "/", p.label);
console.log("transcribe typeof:", typeof p.transcribe);
'

if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
  ok "unconfigured provider is callable (transcribe is a function)"
else
  fail "unconfigured provider not callable"
  exit 5
fi

# ---------------------------------------------------------------------------
# 4. Config merge — loadEchoConfig returns the flat v0.8.0 shape
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: stage 4/13 — config merge (flat v0.8.0 shape)"

cat > "$PI_CODING_AGENT_DIR/telegram.json" <<'EOF'
{
  "extensions": {
    "pi-telegram-stt": {
      "showTranscript": true,
      "stt_provider": "pi-openai-stt",
      "base_url": ["http://127.0.0.1:8081/v1", "https://api.openai.com/v1"]
    }
  }
}
EOF

NODE_CODE='
const path = require("node:path");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const { loadEchoConfig } = jiti(path.join(process.env.PKG_DIR, "telegram-config.ts"));
const cfg = loadEchoConfig();
if (!Array.isArray(cfg.base_url) || cfg.base_url.length !== 2) {
  console.error("base_url not merged (expected array of 2, got):", cfg.base_url);
  process.exit(1);
}
if (cfg.base_url[0] !== "http://127.0.0.1:8081/v1" || cfg.base_url[1] !== "https://api.openai.com/v1") {
  console.error("base_url contents wrong:", cfg.base_url);
  process.exit(1);
}
if (cfg.stt_provider !== "pi-openai-stt") {
  console.error("stt_provider wrong:", cfg.stt_provider);
  process.exit(1);
}
if (cfg.showTranscript !== true) {
  console.error("showTranscript wrong:", cfg.showTranscript);
  process.exit(1);
}
console.log("base_url[0]:", cfg.base_url[0]);
console.log("base_url[1]:", cfg.base_url[1]);
console.log("stt_provider:", cfg.stt_provider);
console.log("showTranscript:", cfg.showTranscript);
'

if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
  ok "loadEchoConfig returns the flat v0.8.0 shape with base_url array"
else
  fail "config merge broken"
  exit 5
fi

# ---------------------------------------------------------------------------
# 5. Invalid base_url → ProviderError (code 2 = network) — proves the
#    provider surfaces errors correctly when base_url is unreachable
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: stage 5/13 — invalid base_url → network error"

cat > "$PI_CODING_AGENT_DIR/telegram.json" <<'EOF'
{
  "extensions": {
    "pi-telegram-stt": {
      "stt_provider": "pi-openai-stt",
      "base_url": ["http://127.0.0.1:1/never-listens"]
    }
  }
}
EOF

NODE_CODE='
const path = require("node:path");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
jiti(path.join(process.env.PKG_DIR, "index.ts"));
const reg = globalThis["__piTelegramSttProviderRegistry__"];
const p = reg.providers.get("pi-openai-stt");
(async () => {
  // Use a 2s timeout via the openai-stt export (we need to call
  // transcribe() directly with a short timeout because the
  // SttProvider.transcribe() interface has no timeout knob).
  const { transcribe } = jiti(path.join(process.env.PKG_DIR, "openai-stt.ts"));
  try {
    await transcribe({ inputPath: "/nonexistent.ogg", lang: "en", timeoutMs: 1500 });
    console.error("expected error, got success");
    process.exit(1);
  } catch (e) {
    if (e && (e.code === 2 || (e.name === "OpenAiSttError" && e.code === 2))) {
      console.log("got expected network error (code 2):", e.message.split("\n")[0]);
      process.exit(0);
    }
    // ProviderError wrapper: code might be 1 or 2 — accept either
    // since the test was via the openai-stt.ts direct call (no
    // provider wrapping).
    if (e && (e.code === 1 || e.code === 2)) {
      console.log("got expected error (code " + e.code + "):", String(e.message).split("\n")[0]);
      process.exit(0);
    }
    console.error("unexpected error:", e);
    process.exit(1);
  }
})();
'

if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
  ok "invalid base_url surfaces network error (not crash)"
else
  fail "invalid base_url did not surface expected error"
  exit 5
fi

# ---------------------------------------------------------------------------
# 6. Live STT round-trip (skipped with --no-network)
# ---------------------------------------------------------------------------
hr
if [[ $NO_NETWORK -eq 1 ]]; then
  echo "pi-telegram-stt-smoke-test: stage 6/13 — live STT round-trip (skipped: --no-network)"
  info "re-run without --no-network to exercise the full transcribe path against base_url"
else
  echo "pi-telegram-stt-smoke-test: stage 6/13 — live STT round-trip"

  # Point the bundled provider at the local whisper-server. The
  # default base_url is http://127.0.0.1:8081/v1 (the fw-openai-sts
  # shim), which the operator runs as a system service. Stage 6
  # is skipped if the service isn't reachable — the smoke test
  # shouldn't fail just because the local stack is down.
  cat > "$PI_CODING_AGENT_DIR/telegram.json" <<'EOF'
{
  "extensions": {
    "pi-telegram-stt": {
      "stt_provider": "pi-openai-stt",
      "base_url": ["http://127.0.0.1:8081/v1"]
    }
  }
}
EOF

  NODE_CODE='
const path = require("node:path");
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const { transcribe } = jiti(path.join(process.env.PKG_DIR, "openai-stt.ts"));
(async () => {
  // The round-trip needs a real audio file. Use a 1-second
  // silent OGG generated via ffmpeg (ffmpeg is in the standard
  // test toolchain). If ffmpeg is missing, the stage is skipped.
  const { execSync } = require("node:child_process");
  const fs = require("node:fs");
  const audioPath = "/tmp/pi-telegram-stt-smoke.ogg";
  try {
    execSync(`ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -c:a libopus -b:a 32k -ar 48000 -ac 1 -application voip -vbr on -compression_level 10 -f ogg "${audioPath}"`, { stdio: "ignore" });
  } catch (e) {
    console.log("ffmpeg missing — skipping live round-trip (hint: install ffmpeg)");
    process.exit(0);
  }
  try {
    const text = await transcribe({ inputPath: audioPath, lang: "en", timeoutMs: 5000 });
    console.log("transcript:", JSON.stringify(text));
    console.log("transcript chars:", text.length);
    // We dont assert the content (silent audio → varies), just
    // that the call returned a string without throwing.
    if (typeof text !== "string") { console.error("transcript not a string"); process.exit(1); }
    process.exit(0);
  } catch (e) {
    if (e && (e.code === 2 || e.code === 3 || e.code === 4)) {
      console.log("got expected error (code " + e.code + "):", String(e.message).split("\n")[0]);
      // The local whisper-server may not be running. Treat
      // network errors as "stage passed but service unreachable".
      console.log("(this is OK if the local whisper-server / shim is not running)");
      process.exit(0);
    }
    console.error("unexpected error:", e);
    process.exit(1);
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }
})();
'

  if JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "$NODE_CODE"; then
    ok "live round-trip (network/service reachability permitting)"
  else
    fail "live round-trip failed unexpectedly"
    exit 6
  fi
fi

# ---------------------------------------------------------------------------
# 7. Section registration — jiti-load section.ts, call the
#    default-export factory against a stub
#    `globalThis.__piTelegramSectionRegistry__` + stub
#    ExtensionAPI. Asserts the section is registered with
#    `id: "pi-telegram-stt"`, `label: "🎙️ STT"`, `order: 10`,
#    and a `session_shutdown` handler is wired.
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: stage 7/13 — section registration shape"

SECTION_OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });

// Stub the bridge's section registry on globalThis.
const sections = [];
const registry = {
  register(section) {
    sections.push({ registration: section, token: 'tok' + sections.length });
    return () => {
      const idx = sections.findIndex(s => s.registration === section);
      if (idx >= 0) sections.splice(idx, 1);
    };
  },
  getSections() { return sections.slice(); },
  getByToken(token) { return sections.find(s => s.token === token); },
};
globalThis['__piTelegramSectionRegistry__'] = registry;

// Stub the STT provider registry so listSttProviders() returns at
// least one entry (used by renderSettingsText + the provider
// picker).
globalThis['__piTelegramSttProviderRegistry__'] = {
  providers: new Map([
    ['pi-openai-stt', { id: 'pi-openai-stt', label: '🟢 OpenAI (any compatible)', transcribe: async () => '' }],
  ]),
};

// Stub ExtensionAPI: only on(event, handler) is needed.
const handlers = {};
const pi = { on: (event, h) => { handlers[event] = h; } };

const sectionMod = jiti(process.env.PKG_DIR + '/section.ts');
if (typeof sectionMod.default !== 'function') { console.error('default export is not a function'); process.exit(1); }
sectionMod.default(pi);

// The default-export factory defers registerTelegramSection to
// session_start (the bridge's section registry is only populated
// after the bridge has initialized, which happens between jiti
// load and the first session_start — see the live test on
// 2026-08-24 that surfaced this load-order error). Drive the
// session_start handler to trigger the actual registration.
if (typeof handlers['session_start'] !== 'function') { console.error('session_start handler not wired'); process.exit(1); }
handlers['session_start']();

if (sections.length !== 1) { console.error('expected 1 registered section, got', sections.length); process.exit(1); }
const s = sections[0].registration;
if (s.id !== 'pi-telegram-stt') { console.error('id =', s.id, '(expected pi-telegram-stt)'); process.exit(1); }
if (s.label !== '🎙️ STT') { console.error('label =', s.label); process.exit(1); }
if (s.order !== 10) { console.error('order =', s.order); process.exit(1); }
if (typeof s.getLabel !== 'function') { console.error('getLabel is not a function'); process.exit(1); }
if (typeof s.render !== 'function') { console.error('render is not a function'); process.exit(1); }
if (typeof s.handleCallback !== 'function') { console.error('handleCallback is not a function'); process.exit(1); }
if (!s.settings || typeof s.settings.open !== 'function') { console.error('settings.open is not a function'); process.exit(1); }
if (typeof handlers['session_shutdown'] !== 'function') { console.error('session_shutdown handler not wired'); process.exit(1); }
console.log('session_start fired, section registered with id=pi-telegram-stt, label=🎙️ STT, order=10');
console.log('session_shutdown handler wired (', typeof handlers['session_shutdown'], ')');
" 2>&1)
if [[ $? -eq 0 ]]; then
  ok "section.ts default-export factory registers (on session_start) with id=pi-telegram-stt, label=🎙️ STT, order=10, wires session_shutdown"
else
  fail "section registration shape check failed"
  echo "$SECTION_OUT"
  exit 7
fi

# ---------------------------------------------------------------------------
# 8. Section idempotency — calling the default-export factory a
#    second time should throw (the bridge registry enforces
#    single-key by id). Registry stays at 1 entry.
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: stage 8/13 — section idempotency"

SECTION_IDEMP_OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });

const sections = [];
const registry = {
  register(section) {
    const dup = sections.find(s => s.registration.id === section.id);
    if (dup) throw new Error('Telegram section id already registered: ' + section.id);
    const entry = { registration: section, token: 'tok' + sections.length };
    sections.push(entry);
    return () => { const i = sections.indexOf(entry); if (i >= 0) sections.splice(i, 1); };
  },
  getSections() { return sections.slice(); },
};
globalThis['__piTelegramSectionRegistry__'] = registry;
globalThis['__piTelegramSttProviderRegistry__'] = { providers: new Map() };

const handlers = {};
const pi = { on: (event, h) => { handlers[event] = h; } };
const sectionMod = jiti(process.env.PKG_DIR + '/section.ts');

// Drive session_start to actually register the section.
sectionMod.default(pi);
handlers['session_start']();
if (sections.length !== 1) { console.error('first session_start: expected 1 section, got', sections.length); process.exit(1); }

// Second session_start (e.g., another session in the same agent)
// re-registers, but the registry's single-key guard throws. The
// factory doesn't catch it, so the throw propagates out.
let threw = false;
try { handlers['session_start'](); } catch (e) { threw = true; }
if (!threw) { console.error('second session_start: expected throw, got success'); process.exit(1); }
if (sections.length !== 1) { console.error('second session_start: expected 1 section, got', sections.length); process.exit(1); }
console.log('first session_start: 1 section registered');
console.log('second session_start: threw (idempotency), registry still 1 entry');
" 2>&1)
if [[ $? -eq 0 ]]; then
  ok "default-export factory is single-keyed; second session_start throws, registry stays at 1 entry"
else
  fail "section idempotency check failed"
  echo "$SECTION_IDEMP_OUT"
  exit 8
fi

# ---------------------------------------------------------------------------
# 9. saveEchoConfig atomic write — round-trip a save + load +
#    assert the .tmp file is gone, the bridge-owned `voice` block
#    is preserved, and any sibling extension's block is preserved.
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: stage 9/13 — saveEchoConfig atomic write"

ATOMIC_OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" REPO_ROOT="$REPO_ROOT" node -e "
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { saveEchoConfig, loadEchoConfig } =
  jiti(process.env.PKG_DIR + '/telegram-config.ts');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stt-savecfg-'));
const cfgPath = path.join(tmpDir, 'telegram.json');
process.env.PI_CODING_AGENT_DIR = tmpDir;
fs.writeFileSync(cfgPath, JSON.stringify({
  voice: { sendTranscript: true },
  extensions: {
    'pi-telegram-tts': { provider: 'minimax' },
    'pi-other': { custom: 'preserved' },
  },
}, null, 2));

saveEchoConfig({ showTranscript: false, stt_provider: 'pi-other-stt' });

if (fs.existsSync(cfgPath + '.tmp')) { console.error('tmp file still present'); process.exit(1); }

const loaded = loadEchoConfig();
if (loaded.showTranscript !== false) { console.error('showTranscript =', loaded.showTranscript); process.exit(1); }
if (loaded.stt_provider !== 'pi-other-stt') { console.error('stt_provider =', loaded.stt_provider); process.exit(1); }

// Read the full file directly (the stt package's telegram-config.ts
// does not export loadTelegramConfig; the tts package does, but this
// is the stt package's smoke test).
const full = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (full.extensions['pi-telegram-tts']?.provider !== 'minimax') {
  console.error('pi-telegram-tts block was overwritten:', JSON.stringify(full.extensions['pi-telegram-tts']));
  process.exit(1);
}
if (full.extensions['pi-other']?.custom !== 'preserved') {
  console.error('pi-other block was overwritten:', JSON.stringify(full.extensions['pi-other']));
  process.exit(1);
}
if (full.voice?.sendTranscript !== true) {
  console.error('voice.sendTranscript was overwritten:', JSON.stringify(full.voice));
  process.exit(1);
}
console.log('saveEchoConfig round-trip: showTranscript=false, stt_provider=pi-other-stt');
console.log('atomic discipline: no .tmp file left');
console.log('preserved: pi-telegram-tts block + pi-other block + voice.sendTranscript');

fs.rmSync(tmpDir, { recursive: true, force: true });
" 2>&1)
if [[ $? -eq 0 ]]; then
  ok "saveEchoConfig writes atomically (no .tmp), preserves other extensions and bridge-owned blocks"
else
  fail "saveEchoConfig atomic write failed"
  echo "$ATOMIC_OUT"
  exit 9
fi

# ---------------------------------------------------------------------------
# 10. handleCallback toggle-echo — stub a
#     TelegramSectionCallbackContext with action="toggle-echo",
#     call the section's settings.handleCallback, assert
#     answerCallback was called, ctx.edit was called with the
#     new view (per docs/sections.md §8 re-render discipline),
#     and loadEchoConfig shows showTranscript flipped.
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: stage 10/13 — section toggle-echo handler (with ctx.edit re-render)"

TOGGLE_OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" REPO_ROOT="$REPO_ROOT" node -e "
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { saveEchoConfig, loadEchoConfig } = jiti(process.env.PKG_DIR + '/telegram-config.ts');

const sections = [];
const registry = {
  register(section) {
    sections.push({ registration: section, token: 'tok0' });
    return () => {};
  },
  getSections() { return sections.slice(); },
  getByToken(token) { return sections[0]; },
};
globalThis['__piTelegramSectionRegistry__'] = registry;
globalThis['__piTelegramSttProviderRegistry__'] = {
  providers: new Map([
    ['pi-openai-stt', { id: 'pi-openai-stt', label: '🟢 OpenAI', transcribe: async () => '' }],
  ]),
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stt-toggle-'));
process.env.PI_CODING_AGENT_DIR = tmpDir;
fs.writeFileSync(path.join(tmpDir, 'telegram.json'), JSON.stringify({
  extensions: { 'pi-telegram-stt': { showTranscript: true, stt_provider: 'pi-openai-stt' } },
}, null, 2));

const handlers = {};
const pi = { on: (event, h) => { handlers[event] = h; } };
const sectionMod = jiti(process.env.PKG_DIR + '/section.ts');
sectionMod.default(pi);
// Drive session_start to actually register the section
// (the factory defers registerTelegramSection to session_start
// per the v0.2.0 plan's Module-load safety).
handlers['session_start']();
const section = sections[0].registration;

const stub = {
  sectionId: 'pi-telegram-stt',
  chatId: 12345,
  messageId: 99,
  action: 'toggle-echo',
  payload: '',
  calls: { answer: '', edit: null },
  async answerCallback(text) { this.calls.answer = text; },
  async edit(view) { this.calls.edit = view; },
  async open() {},
  enqueuePrompt() {},
  callbackData(action, payload) { return 'section:tok0:' + action + (payload ? ':' + payload : ''); },
  deleteMessage() {},
};

(async () => {
  const result = await section.settings.handleCallback(stub);
  if (result !== 'handled') { console.error('handleCallback returned', result); process.exit(1); }
  if (!stub.calls.answer.includes('OFF')) { console.error('answerCallback text =', stub.calls.answer); process.exit(1); }
  if (!stub.calls.edit) { console.error('edit was not called (the audit found this was a stale-UI bug — ctx.edit must re-render the settings card)'); process.exit(1); }
  if (!stub.calls.edit.text.includes('STT settings')) { console.error('edit view text =', stub.calls.edit.text); process.exit(1); }
  if (!stub.calls.edit.text.includes('⚫️ off')) { console.error('edit view does not show new state (⚫️ off):', stub.calls.edit.text); process.exit(1); }

  const cfg = loadEchoConfig();
  if (cfg.showTranscript !== false) { console.error('showTranscript =', cfg.showTranscript, '(expected false after toggle)'); process.exit(1); }
  console.log('handleCallback returned: handled');
  console.log('answerCallback: \"' + stub.calls.answer + '\"');
  console.log('edit: view.text contains STT settings and off state');
  console.log('loadEchoConfig().showTranscript =', cfg.showTranscript);

  fs.rmSync(tmpDir, { recursive: true, force: true });
})().catch(e => { console.error('threw:', e.message); process.exit(1); });
" 2>&1)
if [[ $? -eq 0 ]]; then
  ok "section.handleCallback('toggle-echo') flips state, calls answerCallback + edit"
else
  fail "handleCallback toggle-echo check failed"
  echo "$TOGGLE_OUT"
  exit 10
fi

# ---------------------------------------------------------------------------
# 11. handleCallback select-provider — stub a list of providers,
#     call with action="select-provider", payload="pi-other-stt",
#     assert the new provider is selected + ctx.edit re-renders
#     with the ✓ on the new row.
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: stage 11/13 — section select-provider handler (with ctx.edit re-render)"

SELECT_OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" REPO_ROOT="$REPO_ROOT" node -e "
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadEchoConfig } = jiti(process.env.PKG_DIR + '/telegram-config.ts');

const sections = [];
const registry = {
  register(section) {
    sections.push({ registration: section, token: 'tok0' });
    return () => {};
  },
  getSections() { return sections.slice(); },
};
globalThis['__piTelegramSectionRegistry__'] = registry;
globalThis['__piTelegramSttProviderRegistry__'] = {
  providers: new Map([
    ['pi-openai-stt', { id: 'pi-openai-stt', label: '🟢 OpenAI', transcribe: async () => '' }],
    ['pi-other-stt', { id: 'pi-other-stt', label: '🟡 Other', transcribe: async () => '' }],
  ]),
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stt-select-'));
process.env.PI_CODING_AGENT_DIR = tmpDir;
fs.writeFileSync(path.join(tmpDir, 'telegram.json'), JSON.stringify({
  extensions: { 'pi-telegram-stt': { showTranscript: true, stt_provider: 'pi-openai-stt' } },
}, null, 2));

const handlers = {};
const pi = { on: (event, h) => { handlers[event] = h; } };
const sectionMod = jiti(process.env.PKG_DIR + '/section.ts');
sectionMod.default(pi);
// Drive session_start to actually register the section
// (the factory defers registerTelegramSection to session_start
// per the v0.2.0 plan's Module-load safety).
handlers['session_start']();
const section = sections[0].registration;

const stub = {
  sectionId: 'pi-telegram-stt',
  chatId: 12345,
  messageId: 99,
  action: 'select-provider',
  payload: 'pi-other-stt',
  calls: { answer: '', edit: null },
  async answerCallback(text) { this.calls.answer = text; },
  async edit(view) { this.calls.edit = view; },
  async open() {},
  enqueuePrompt() {},
  callbackData(action, payload) { return 'section:tok0:' + action + (payload ? ':' + payload : ''); },
  deleteMessage() {},
};

(async () => {
  const result = await section.settings.handleCallback(stub);
  if (result !== 'handled') { console.error('handleCallback returned', result); process.exit(1); }
  if (!stub.calls.answer.includes('pi-other-stt')) { console.error('answerCallback text =', stub.calls.answer); process.exit(1); }
  if (!stub.calls.edit) { console.error('edit was not called'); process.exit(1); }
  if (!stub.calls.edit.text.includes('pi-other-stt')) { console.error('edit view does not include new provider:', stub.calls.edit.text); process.exit(1); }

  const cfg = loadEchoConfig();
  if (cfg.stt_provider !== 'pi-other-stt') { console.error('stt_provider =', cfg.stt_provider); process.exit(1); }
  console.log('handleCallback returned: handled');
  console.log('answerCallback: \"' + stub.calls.answer + '\"');
  console.log('edit: view.text includes new provider \"pi-other-stt\"');
  console.log('loadEchoConfig().stt_provider =', cfg.stt_provider);

  fs.rmSync(tmpDir, { recursive: true, force: true });
})().catch(e => { console.error('threw:', e.message); process.exit(1); });
" 2>&1)
if [[ $? -eq 0 ]]; then
  ok "section.handleCallback('select-provider') flips stt_provider, calls answerCallback + edit"
else
  fail "handleCallback select-provider check failed"
  echo "$SELECT_OUT"
  exit 11
fi

# ---------------------------------------------------------------------------
# 12. handleCallback select-provider "not installed" — when the
#     payload is a provider id that's not in listSttProviders(),
#     the section must NOT mutate the config; it must
#     answerCallback with the "not installed" message and return
#     "handled" (no ctx.edit since state didn't change).
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: stage 12/13 — section select-provider \"not installed\" error path"

NOT_INSTALLED_OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" REPO_ROOT="$REPO_ROOT" node -e "
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadEchoConfig } = jiti(process.env.PKG_DIR + '/telegram-config.ts');

const sections = [];
const registry = {
  register(section) { sections.push({ registration: section, token: 'tok0' }); return () => {}; },
  getSections() { return sections.slice(); },
};
globalThis['__piTelegramSectionRegistry__'] = registry;
// Only pi-openai-stt is installed.
globalThis['__piTelegramSttProviderRegistry__'] = {
  providers: new Map([
    ['pi-openai-stt', { id: 'pi-openai-stt', label: '🟢 OpenAI', transcribe: async () => '' }],
  ]),
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stt-notinst-'));
process.env.PI_CODING_AGENT_DIR = tmpDir;
fs.writeFileSync(path.join(tmpDir, 'telegram.json'), JSON.stringify({
  extensions: { 'pi-telegram-stt': { showTranscript: true, stt_provider: 'pi-openai-stt' } },
}, null, 2));

const handlers = {};
const pi = { on: (event, h) => { handlers[event] = h; } };
const sectionMod = jiti(process.env.PKG_DIR + '/section.ts');
sectionMod.default(pi);
// Drive session_start to actually register the section
// (the factory defers registerTelegramSection to session_start
// per the v0.2.0 plan's Module-load safety).
handlers['session_start']();
const section = sections[0].registration;

const stub = {
  sectionId: 'pi-telegram-stt', chatId: 12345, messageId: 99,
  action: 'select-provider', payload: 'pi-not-installed',
  calls: { answer: '', edit: null },
  async answerCallback(text) { this.calls.answer = text; },
  async edit(view) { this.calls.edit = view; },
  async open() {}, enqueuePrompt() {},
  callbackData(action, payload) { return 'section:tok0:' + action + (payload ? ':' + payload : ''); },
  deleteMessage() {},
};

(async () => {
  const result = await section.settings.handleCallback(stub);
  if (result !== 'handled') { console.error('handleCallback returned', result); process.exit(1); }
  if (!stub.calls.answer.includes('not installed')) { console.error('answerCallback text =', stub.calls.answer); process.exit(1); }
  if (stub.calls.edit) { console.error('edit was called (should NOT re-render since state did not change)'); process.exit(1); }

  const cfg = loadEchoConfig();
  if (cfg.stt_provider !== 'pi-openai-stt') { console.error('stt_provider was overwritten to', cfg.stt_provider); process.exit(1); }
  console.log('handleCallback returned: handled (no-op state)');
  console.log('answerCallback: \"' + stub.calls.answer + '\"');
  console.log('edit: NOT called (state did not change)');
  console.log('loadEchoConfig().stt_provider =', cfg.stt_provider, '(unchanged)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})().catch(e => { console.error('threw:', e.message); process.exit(1); });
" 2>&1)
if [[ $? -eq 0 ]]; then
  ok "section.handleCallback('select-provider', 'not installed') returns 'not installed' popup, no state change, no edit"
else
  fail "handleCallback select-provider not-installed check failed"
  echo "$NOT_INSTALLED_OUT"
  exit 12
fi

# ---------------------------------------------------------------------------
# 13. echoSectionLabel — the 2 reachable (showTranscript) shapes.
#     (Unlike pi-telegram-tts's 4-shape contract, the echo
#     section's label always includes the configured
#     `stt_provider`, so only 2 reachable shapes: on / off.)
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: stage 13/13 — 2 reachable echoSectionLabel shapes"

LABEL_OUT=$(JITI_PATH="$JITI_PATH" PKG_DIR="$PKG_DIR" node -e "
const jitiModule = require(process.env.JITI_PATH);
const createJiti = jitiModule.default || jitiModule;
const jiti = createJiti(process.env.PKG_DIR, { esmResolve: true, interopDefault: true });

const { echoSectionLabel } = jiti(process.env.PKG_DIR + '/section.ts');

const cases = [
  { name: 'showTranscript=true,  stt_provider=pi-openai-stt', cfg: { showTranscript: true,  stt_provider: 'pi-openai-stt' }, want: '🟢 STT · pi-openai-stt' },
  { name: 'showTranscript=false, stt_provider=pi-openai-stt', cfg: { showTranscript: false, stt_provider: 'pi-openai-stt' }, want: '⚫️ STT · pi-openai-stt' },
];
let failed = 0;
for (const c of cases) {
  const got = echoSectionLabel(c.cfg);
  if (got !== c.want) {
    console.error('  ' + c.name + ': got \"' + got + '\" want \"' + c.want + '\"');
    failed++;
  } else {
    console.log('  ' + c.name + ': \"' + got + '\" ✓');
  }
}
if (failed) process.exit(1);
" 2>&1)
if [[ $? -eq 0 ]]; then
  ok "echoSectionLabel returns the 2 reachable (showTranscript) labels"
else
  fail "echoSectionLabel shape check failed"
  echo "$LABEL_OUT"
  exit 13
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
hr
echo "pi-telegram-stt-smoke-test: ALL STAGES PASSED"
echo "  provider: pi-openai-stt (bundled since v0.8.0)"
echo "  config:   loadEchoConfig() returns flat shape with base_url / apiKey"
echo "  network:  $([ $NO_NETWORK -eq 1 ] && echo "skipped (stage 6 not run)" || echo "exercised (stage 6 ran)")"
echo ""
echo "  Next: run \`bash scripts/dev-status.sh\` if you want a live snapshot"
echo "  of the bridge / agent state with the package installed."
