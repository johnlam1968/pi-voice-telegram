# TTS via `outboundHandlers` — no extension required

Investigation date: 2026-08-21
Last updated: 2026-08-21 (added `scripts/tts-openai.mjs` as a parallel
                  pipeline to `scripts/tts-minimax.mjs`)
Status: **canonical** for both MiniMax and OpenAI TTS

The bridge's `outboundHandlers` (a list of command-template steps, declared in
`telegram.json#outboundHandlers`) is the **canonical integration point for TTS**.
No Pi extension, no orchestrator, no `registerTelegramVoiceSynthesisProvider`
call. The bridge runs each step as a shell command, substitutes placeholders
(`{text}`, `{mp3}`, `{ogg}`, `{lang}`, `{rate}`), and threads the result of one
step into the next via the placeholder file paths.

## TL;DR

We ship two TTS scripts in `scripts/`. Either one is a complete
voice-handler pipeline. Pick by editing `telegram.json#outboundHandlers`
— the operator decides at install time, not at runtime.

### For MiniMax (Cantonese-first, 327-voice catalog)

```json
"outboundHandlers": [
  {
    "type": "voice",
    "template": [
      "/home/john/CodingProjects/pi-voice-telegram/scripts/tts-minimax.mjs --out {mp3}",
      "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 48000 -ac 1 -application voip -vbr on -compression_level 10 -f ogg {ogg}"
    ],
    "output": "ogg"
  }
]
```

### For OpenAI TTS (English-first, 13 voices, `instructions` for Cantonese)

```json
"outboundHandlers": [
  {
    "type": "voice",
    "template": [
      "/home/john/CodingProjects/pi-voice-telegram/scripts/tts-openai.mjs --out {mp3} --instructions 'Speak in Cantonese.'",
      "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 48000 -ac 1 -application voip -vbr on -compression_level 10 -f ogg {ogg}"
    ],
    "output": "ogg"
  }
]
```

For either pipeline, edit `telegram.json`, restart `pi`, and voice
replies just work.

### Picking one vs the other

| Concern | MiniMax | OpenAI |
|---|---|---|
| Default voice quality for Cantonese | High — voices like `Cantonese_CuteGirl` are Cantonese-native | Adequate — voices are English-optimized; need `instructions: "Speak in Cantonese."` to stay in Cantonese |
| Voice catalog | 327 voices across 22 languages | 13 voices (English-first) |
| Configurable per-knob knobs | 27 (every OpenAPI field) | 6 (model, voice, response_format, speed, instructions, +config override) |
| Response shape | JSON with hex-encoded audio (needs decode) | Binary audio directly |
| Streaming | Not implemented in the script | Not implemented in the script |
| Speed of synthesis | ~1.5–2.5 s for a short utterance | ~1.0–1.5 s for the same |
| Pricing (operator cost) | MiniMax T2A rate card | OpenAI TTS rate card |
| Auth | `MINIMAX_API_KEY` or `~/.mmx/config.json` | `OPENAI_API_KEY` or `~/.pi/agent/auth.json` |

For the operator's current setup (Cantonese agent on `pi-telegram`),
**MiniMax is the better default** — `Cantonese_CuteGirl` is a native
Cantonese voice and needs no `instructions` trick to stay in
Cantonese. OpenAI is a useful fallback or for operators who want a
specific OpenAI voice (`marin` / `cedar` / `coral` / etc.).

Both scripts accept the same CLI surface (`--out`, `--text` /
stdin, `--verbose`, `PI_VOICE_TELEGRAM_DEBUG=1`) so swapping is a
one-line `telegram.json` edit.

## Why no extension

Three previous attempts at the same problem, and what each one taught us:

| Attempt | Form | Why it stopped working / was retired |
|---|---|---|
| `pi-voice-telegram` monolithic (v0.1.0–v0.16.x) | One Pi extension that owned everything | Refactored into atomic packages (v0.3.0+); retired by v0.5.0 |
| `pi-telegram-tts-minimax` orchestrator + `pi-minimax-tts` + `pi-openai-tts` (v0.1.0 TTS track) | Three packages: an orchestrator wrapping `registerTelegramVoiceSynthesisProvider`, two provider packages implementing a `TtsProvider` contract | The orchestrator's section UI was the only "weighty" piece. Once that was stripped, the orchestrator was a 50-line shim. And cURL alone — with python3 for the JSON/hex dance — does everything both provider packages did, with no Node.js, no jiti cache, no extension lifecycle |
| `scripts/tts-minimax.sh` + `telegram.json#outboundHandlers` (this doc) | One small shell script + the bridge's command-template mechanism | **Current.** Edit config, no install, no version pin, no extension debugging surface |

The reason a custom extension exists at all is when the provider's API has
logic that's painful to express in shell. For MiniMax, the pain is:
- JSON body with nested `voice_setting` / `audio_setting` blocks
- JSON response with hex-encoded audio
- Specific `channel` (singular) field name, `speech-2.x` model routing
- `language_boost: "Chinese,Yue"` for Cantonese

All of this is handled in `scripts/tts-minimax.sh` (40 lines of python3 inside
a bash wrapper). The `telegram.json` config stays readable — one template line
per pipeline step.

## How `outboundHandlers` works (bridge contract)

From the bridge's `docs/voice.md` §"Outbound Voice Handlers":

> Voice handlers receive the text on stdin in composed pipelines and can use
> `{text}`, `{lang}`, `{rate}`, `{mp3}`, and `{ogg}` placeholders. Set `output`
> to `"ogg"` or another placeholder name when the template writes to a known
> path.

Delivery order (per the same doc):

1. `outboundHandlers` with `type: "voice"` (this doc)
2. Programmatic `registerTelegramOutboundHandler("voice", ...)` handlers
3. Registered voice synthesis providers (via `registerTelegramVoiceSynthesisProvider`)

So `outboundHandlers` runs **first**. If it returns a valid `.ogg`/`.opus`
file, the bridge sends it and stops. If any step fails (non-zero exit), the
bridge records a runtime event and tries the next fallback. This is the same
fallback chain as registered providers — same error reporting, same
`/telegram-status` view.

The `output: "ogg"` field tells the bridge which placeholder the LAST step
writes to; the bridge reads the file from that path and calls Telegram's
`sendVoice` with it.

## MiniMax: the script

`scripts/tts-minimax.mjs` (~410 lines including comments). Pure Node.js
(uses `https.request` and `node:fs`; no external dependencies). A bash
wrapper with `python3` was tried first and worked, but the heredoc-vs-stdin
interaction (the python heredoc consumes stdin, so the agent text has to
be saved to a temp file first) made it more code than the Node version
and harder to maintain. Node was already on the host (the bridge itself
runs on Node), so the dependency is zero-net.

The script:

- Reads the agent's reply text from stdin (or `--text <arg>` for testing).
  The bridge sends the agent text on stdin to the first template step.
- Resolves the API key from `$MINIMAX_API_KEY` env, then
  `~/.mmx/config.json` (mmx-cli's canonical key store). The base URL
  comes from `$MINIMAX_BASE_URL` env, else from `$MINIMAX_REGION` /
  `region` field, else the cn default
  (`https://api.minimaxi.com`).
- Builds the request body from built-in defaults, deep-merges a
  `--config <json>` file if provided, then applies CLI flag overrides.
  Every field in the OpenAPI `TextToAudioRequest` schema is reachable
  (see "100% adjustability" below).
- Validates every field against the OpenAPI constraints (enums, ranges)
  before sending; rejects with a clear error on the first violation.
- POSTs to `/v1/t2a_v2` with the modern `speech-2.x` request body.
- Parses the JSON response, decodes the hex `data.audio` field, writes
  the bytes to `--out <path>` (the `{mp3}` placeholder).
- Exits non-zero on cURL failure, JSON-parse failure, or upstream
  `base_resp.status_code != 0`. The bridge records the exit code via
  `recordTelegramRuntimeEvent` and falls through to the next handler (or
  falls back to text delivery if no provider succeeds).

### 100% adjustability

Every field in `docs/MINIMAX-T2A-OPENAPI.md` `TextToAudioRequest` (and its
nested `voice_setting`, `audio_setting`, `pronunciation_dict`, `timbre_weights`,
`voice_modify`) is reachable through one of two channels:

1. **CLI flag** for scalars and enums — direct invocation, or set in the
   `telegram.json#outboundHandlers` template.
2. **`--config <json>`** for arrays (`pronunciation_dict.tone`,
   `timbre_weights`) and any future field the API adds before the CLI
   is updated.

Precedence: built-in defaults → `--config` file (deep merge) → CLI flags.

### CLI reference (covers every OpenAPI field)

```text
Usage: tts-minimax.mjs --out <path> [options]

Required:
  --out <path>                  path to write the decoded audio (the {mp3} placeholder)

Source (one of):
  --text "<string>"             the text to synthesize (test path)
  (or read stdin)                the bridge's default — agent reply text

Top-level:
  --model <id>                  default: speech-2.8-hd
                                enum: speech-2.6-hd, speech-2.6-turbo, speech-2.8-hd,
                                speech-2.8-turbo, speech-01-hd, speech-01-turbo,
                                speech-2.5-hd-preview, speech-2.5-turbo-preview, speech-02
  --lang <id>                   default: Chinese,Yue
                                (MiniMax language_boost: auto | Chinese | Chinese,Yue |
                                 English | Japanese | Korean | French | German | Spanish |
                                 Portuguese | Italian | Arabic | Russian | <custom>)
  --subtitle-type <id>          default: (unset) | enum: word, sentence
  --output-format <id>          default: (unset) | enum: hex, url
  --stream                      boolean flag (positive). Rejected — not implemented.
  --subtitle-enable             boolean flag (positive)
  --emoji-event                 boolean flag (positive)
  --no-watermark                boolean flag (negative; default aigc_watermark=true)
  --no-text-filter              boolean flag (negative; default apply_text_filter=true)
  --no-text-normalization       boolean flag (negative; default text_normalization=false)
  --no-latex-read               boolean flag (negative; default latex_read=false)

voice_setting:
  --voice <id>                  default: Cantonese_CuteGirl
  --speed <0.5..2.0>            default: 1
  --vol <0.1..10.0>             default: 1
  --pitch <-12..12>             default: 0
  --emotion <id>                default: (unset) | enum: neutral, happy, sad, angry,
                                fearful, disgusted, surprised (modern models only)
  --text-normalization          boolean flag (positive)
  --latex-read                  boolean flag (positive)

audio_setting:
  --sample-rate <hz>            default: 32000 | enum: 8000, 16000, 22050, 24000, 32000, 44100
  --bitrate <bps>               default: 128000 | enum: 32000, 64000, 128000, 256000 (mp3 only)
  --format <id>                 default: mp3 | enum: mp3, pcm, flac, wav, pcmu_raw, pcmu_wav, opus
  --channel <1-2>               default: 1
  --force-cbr                   boolean flag (positive; only for streaming mp3)

voice_modify (post-processing effects — built only if any of these is set):
  --modify-pitch <-100..100>    default: (unset) | range: -100..100
  --modify-intensity <-100..100> default: (unset) | range: -100..100
  --modify-timbre <-100..100>   default: (unset) | range: -100..100
  --sound-effects <id>          default: (unset) | enum: spacious_echo, auditorium_echo,
                                lofi_telephone, robotic

pronunciation_dict.tone + timbre_weights: --config file only
  These are arrays (strings; objects with voice_id+weight). The CLI is the
  wrong shape for them. Set them via a JSON config file:

  {
    "pronunciation_dict": { "tone": ["处理/(chu3)(li3)", "危险/dangerous"] },
    "timbre_weights": [
      { "voice_id": "female-shaonv", "weight": 70 },
      { "voice_id": "male-qn-qingse", "weight": 30 }
    ]
  }

  ...then pass --config /path/to/file.json on the CLI.

Auth (priority order):
  $MINIMAX_API_KEY              env var (operator-set)
  $MINIMAX_BASE_URL             env var (overrides region)
  $MINIMAX_REGION               env var (overrides ~/.mmx/config.json)
  ~/.mmx/config.json            mmx-cli's canonical key store → `api_key` + `region`
```

### CLI reference — `tts-openai.mjs` (OpenAI)

```text
Usage: tts-openai.mjs --out <path> [options]

Required:
  --out <path>                  path to write the decoded audio (the {mp3} placeholder)

Source (one of):
  --text "<string>"             the text to synthesize (test path)
  (or read stdin)                the bridge's default — agent reply text

Top-level:
  --model <id>                  default: gpt-4o-mini-tts
                                enum: gpt-4o-mini-tts, tts-1, tts-1-hd
  --voice <id>                  default: coral
                                13 voices for gpt-4o-mini-tts (alloy, ash, ballad, coral,
                                  echo, fable, marin, nova, onyx, sage, shimmer, verse, cedar)
                                9 voices for tts-1 / tts-1-hd (no ballad, cedar, marin, verse)
  --response-format <id>        default: mp3
                                enum: mp3, opus, aac, flac, wav, pcm
  --speed <0.25..4.0>           default: 1
  --instructions <string>       no default; only sent when set. Required for Cantonese
                                on voices that fall back to English/Mandarin by default
                                (e.g. "Speak in Cantonese." for gpt-4o-mini-tts)
  --config <path>               full request body in JSON (overrides + extends; for
                                forward-compat with fields the CLI doesn't cover)
  --max-chars <n>               default: 3000. Hard-cap input length (chars) to stay under
                                OpenAI's 2000-token limit. Set to 0 to disable (not
                                recommended — the request will likely fail).
  --max-attempts <n>            default: 3. Max retry count when OpenAI returns a
                                token-limit error. On retry, input is halved at a
                                sentence boundary.
  --verbose / -v                DEBUG-level logging
  PI_VOICE_TELEGRAM_DEBUG=1     same, via env

Auth (priority order):
  $OPENAI_API_KEY               env var (operator-set)
  ~/.pi/agent/auth.json          → `openai.key` (the LLM key, reused for TTS)
```

### Exit codes

- `2` — caller config error (missing `--out`, missing API key, empty
  text, invalid enum, out-of-range numeric, malformed `--config` JSON,
  `--stream` not implemented)
- `3` — API / parse / response error (cURL, JSON, `base_resp.status_code !== 0`)
- `4` — write to `--out` failed (permissions, disk full, etc.)

The bridge's `recordTelegramRuntimeEvent` picks up non-zero exits and
falls back to text delivery if no handler succeeds.

### Logging

Every run prints structured lines to **stderr** (the bridge's `execCommand`
captures these into the runtime event log):

```text
2026-08-21T20:57:04.124Z [DEBUG] [tts-minimax] verbose mode enabled argv=--out /tmp/x.mp3 --verbose
2026-08-21T20:57:04.124Z [DEBUG] [tts-minimax] request body assembled body={"model":"speech-2.8-hd",...}
2026-08-21T20:57:04.130Z [DEBUG] [tts-minimax] text source source=stdin length=7
2026-08-21T20:57:04.130Z [DEBUG] [tts-minimax] auth resolved apiKeySource=~/.mmx/config.json region=cn host=api.minimaxi.com
2026-08-21T20:57:04.130Z [INFO]  [tts-minimax] synthesizing host=api.minimaxi.com model=speech-2.8-hd voice=Cantonese_CuteGirl lang=Chinese,Yue textChars=7
2026-08-21T20:57:06.085Z [DEBUG] [tts-minimax] http response status=200 bytes=41790 contentType=application/json
2026-08-21T20:57:06.086Z [DEBUG] [tts-minimax] parsed response keys=["data","extra_info","trace_id","base_resp"]
2026-08-21T20:57:06.086Z [INFO]  [tts-minimax] ok trace_id=06d7eea1fb4c8f4618114c059b070f5e audio_length_ms=1188 bytes=20724 durationMs=1956 out=/tmp/x.mp3
```

Levels: **DEBUG** (only with `--verbose` / `-v` or `PI_VOICE_TELEGRAM_DEBUG=1`),
**INFO** (default), **WARN**, **ERROR**. Format:
`<iso-ts> [<LEVEL>] [tts-minimax] <msg> [k=v k=v ...]`.

This is the canonical observability channel for the script — the
bridge's own runtime-event log file (`~/.pi/agent/tmp/telegram/logs.jsonl`)
is occasionally stale or frozen, so don't rely on it for TTS diagnostics.

### Worked examples

```bash
# Defaults (Cantonese_CuteGirl, speech-2.8-hd, mp3, 32kHz mono)
echo "今日天氣好好" | tts-minimax.mjs --out /tmp/x.mp3

# Custom voice + emotion + sound effect
echo "今日天氣好好" | tts-minimax.mjs --out /tmp/x.mp3 \
  --voice male-qn-jingying --emotion happy --sound-effects auditorium_echo

# Pronunciation dict + timbre weights via config
cat > /tmp/cfg.json <<EOF
{ "pronunciation_dict": { "tone": ["处理/(chu3)(li3)"] } }
EOF
echo "處理" | tts-minimax.mjs --out /tmp/x.mp3 --config /tmp/cfg.json

# Stereo WAV at 24 kHz
echo "test" | tts-minimax.mjs --out /tmp/x.wav --format wav --channel 2 --sample-rate 24000

# CLI override beats --config
echo "x" | tts-minimax.mjs --out /tmp/x.mp3 \
  --config /tmp/cfg.json --voice Cantonese_CuteGirl
```

## OpenAI: the script

`scripts/tts-openai.mjs` (~430 lines including comments). Pure Node.js
(uses `https.request` and `node:fs`; no external dependencies).
The OpenAI endpoint returns the audio BYTES DIRECTLY (no JSON, no
hex) — much simpler than MiniMax. The next template step wraps the
result in OGG/Opus via ffmpeg, the same as the MiniMax pipeline.

### Cantonese caveat

Voices are English-optimized. For Cantonese, use:
```
--model gpt-4o-mini-tts --voice coral \
  --instructions 'Speak in Cantonese.'
```
(verified in `docs/OPENAI-TTS-FINDINGS.md` §1.)

### Input limit (IMPORTANT)

OpenAI's `/v1/audio/speech` limits `input` to **2000 tokens** (not
chars — the older "4096 chars" figure is misleading). Verified
2026-08-21: a 4071-char mixed Cantonese/English reply was rejected as
"Input of 2484 tokens is over the maximum input limit of 2000 tokens".
Token density varies by language:
- Mixed Cantonese/English: ~1.5–1.7 chars/token
- English-only: ~4 chars/token
- Pure CJK: ~1–1.5 chars/token

The script defaults to `--max-chars 3000` (safe for the worst-case
mixed CJK text). If OpenAI still rejects with a token-limit error
during the request, the script **auto-halves the input and retries**
up to `--max-attempts` (default 3) — so the bridge's `outboundHandlers`
template never has to know about the limit. Set `--max-chars 0` to
disable the guard entirely (not recommended; the request will likely
fail for any non-trivial text).

### 100% knob adjustability

Every field in the OpenAI TTS request body is reachable via CLI flags:
`--model`, `--voice`, `--response-format`, `--speed`, `--instructions`.
`--config <json>` is also accepted for forward-compat with fields
the CLI doesn't cover. Precedence: built-in defaults → `--config` → CLI.

### Auth chain

1. `$OPENAI_API_KEY` env var
2. `~/.pi/agent/auth.json` → `openai.key` (the LLM key, reused for TTS)

No smart default — won't talk to OpenAI without a key.

### Error model (matches tts-minimax.mjs)

- Exit 2 = caller config (missing `--out`, missing API key, empty
  text, invalid enum, out-of-range numeric, malformed `--config` JSON)
- Exit 3 = API / HTTP error (network, 4xx, 5xx — including the
  token-limit error after `--max-attempts` retries are exhausted)
- Exit 4 = write to `--out` failed

The bridge's `recordTelegramRuntimeEvent` picks up non-zero exits
and falls back to text delivery if no handler succeeds.

## Switching providers

To switch from MiniMax to OpenAI (or vice versa), edit `telegram.json#outboundHandlers`.
No `pi install`, no `pi remove`, no version bump. The provider decision is
made at edit time, not at agent run time.

This is the "decided at install time, not at runtime" property the user
asked for — except here the "install" is just a `telegram.json` edit. The
operator can keep multiple `outboundHandlers` entries in `telegram.json` and
toggle them by commenting/uncommenting.

For a side-by-side comparison of the two scripts, see the table
in the TL;DR above.

## The STT side is unchanged

`pi-telegram-echo` (orchestrator) + `pi-openai-stt` (provider) are
unchanged. The STT pipeline still uses the bridge's
`registerTelegramVoiceTranscriptionProvider` seam because the transcription
needs the agent to receive the text via the normal prompt machinery (not
a shell command). cURL for STT would mean the agent never sees the
transcript.

## What was removed

When the v0.1.0 TTS-track packages were retired (this commit), the
following were deleted from the repo:

- `extensions/pi-telegram-tts-minimax/` — orchestrator + section UI
- `extensions/pi-minimax-tts/` — provider package
- `extensions/pi-openai-tts/` — OpenAI-compatible provider package
- `~/.pi/agent/extensions/{pi-telegram-tts-minimax,pi-minimax-tts,pi-openai-tts}.ts` — on-host shims

What stayed:

- `extensions/pi-telegram-echo/` — STT orchestrator
- `extensions/pi-openai-stt/` — STT provider (works against local whisper-server or OpenAI's `/v1/audio/transcriptions` via `base_url` config)
- `extensions/pi-telegram-settings/` — LLM-callable `config_read` / `config_write` / `config_reset` tools (independent of voice; useful for editing `telegram.json` itself)
- `scripts/list-tts-voices.ts` — CLI to enumerate MiniMax voices (was useful when the section UI was the picker; now mostly historical — keep the script for catalog inspection)
- `docs/MINIMAX-T2A-FINDINGS.md` — 1723-line investigation of the T2A API. The
  endpoints, response shapes, and ffmpeg settings in the script come from
  this doc; it's still the authoritative reference.
- `docs/OPENAI-TTS-FINDINGS.md` — 479-line investigation of OpenAI's TTS.
  Same: the cURL template uses the verified parameters from this doc.
