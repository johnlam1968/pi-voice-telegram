# TTS via `outboundHandlers` — no extension required

Investigation date: 2026-08-21
Status: **canonical** for both MiniMax and OpenAI-compatible TTS

The bridge's `outboundHandlers` (a list of command-template steps, declared in
`telegram.json#outboundHandlers`) is the **canonical integration point for TTS**.
No Pi extension, no orchestrator, no `registerTelegramVoiceSynthesisProvider`
call. The bridge runs each step as a shell command, substitutes placeholders
(`{text}`, `{mp3}`, `{ogg}`, `{lang}`, `{rate}`), and threads the result of one
step into the next via the placeholder file paths.

## TL;DR

For MiniMax:

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

For OpenAI-compatible TTS (uses binary response, no JSON parsing needed):

```json
"outboundHandlers": [
  {
    "type": "voice",
    "template": [
      "API_KEY=\"${OPENAI_API_KEY:-$(python3 -c 'import json; print(json.load(open(\"/home/john/.pi/agent/auth.json\")).get(\"openai\",{}).get(\"key\",\"\"))' 2>/dev/null)}\"; curl -sS -X POST -H \"Authorization: Bearer $API_KEY\" -H 'Content-Type: application/json' -d '{\"model\":\"gpt-4o-mini-tts\",\"voice\":\"cedar\",\"input\":\"{text}\",\"response_format\":\"mp3\"}' https://api.openai.com/v1/audio/speech -o {mp3}",
      "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 48000 -ac 1 -f ogg {ogg}"
    ],
    "output": "ogg"
  }
]
```

That's the whole TTS pipeline. Edit `telegram.json`, restart `pi`, and voice
replies just work.

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

`scripts/tts-minimax.mjs` (~140 lines including comments). Pure Node.js
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
- POSTs to `/v1/t2a_v2` with the modern `speech-2.x` request body
  (`voice_setting` / `audio_setting` nested, `channel` singular, hardcoded
  `format: "mp3"`, `language_boost` from the `--lang` arg). See
  `docs/MINIMAX-T2A-OPENAPI.md` for the full schema and
  `docs/MINIMAX-T2A-FINDINGS.md` §2 for which fields matter and which to
  ignore.
- Parses the JSON response, decodes the hex `data.audio` field, writes
  the bytes to `--out <path>` (the `{mp3}` placeholder).
- Exits non-zero on cURL failure, JSON-parse failure, or upstream
  `base_resp.status_code != 0`. The bridge records the exit code via
  `recordTelegramRuntimeEvent` and falls through to the next handler (or
  falls back to text delivery if no provider succeeds).

Tunable knobs are at the top of the script (CLI args: `--model`,
`--voice`, `--lang`, `--region`, `--speed`, `--vol`, `--pitch`,
`--emotion`, `--bitrate`, `--sample-rate`, `--stream`). To change the
default voice, edit the script or pass `--voice <id>` via the template.

### CLI quick reference

```text
Usage: tts-minimax.mjs --out <path> [options]

Required:
  --out <path>            where to write the decoded audio (the {mp3} placeholder)

Source (one of):
  --text "<string>"       the text to synthesize (test path)
  (or read stdin)          the bridge's default — agent reply text

Tunable defaults (override via the script or extend the template):
  --model <id>            default: speech-2.8-hd
  --voice <id>            default: Cantonese_CuteGirl
  --lang <id>             default: Chinese,Yue
  --region <cn|global>    default: cn (api.minimaxi.com)
  --speed <0.5..2.0>      default: 1
  --vol <0.1..10.0>       default: 1
  --pitch <-12..12>       default: 0
  --emotion <id>          default: (empty) — neutral
  --bitrate <bps>         default: 128000 (mp3 only)
  --sample-rate <hz>      default: 32000
  --stream                default: false (non-streaming JSON response)

Auth (priority order):
  $MINIMAX_API_KEY        env var (operator-set)
  $MINIMAX_BASE_URL       env var (overrides region)
  $MINIMAX_REGION         env var (overrides ~/.mmx/config.json)
  ~/.mmx/config.json      mmx-cli's canonical key store → `api_key` + `region`
```

Exit codes: `2` = caller-side config error (missing key, missing `--out`,
empty text). `3` = API/parse/response error. `4` = write to `--out` failed.

## OpenAI-compatible: inline cURL

OpenAI's `/v1/audio/speech` returns binary audio directly. No JSON parsing
needed. The `telegram.json#outboundHandlers` template can be a one-line cURL
+ ffmpeg pair, no script file required. The example above shows the full
pipeline; the only knob worth parameterising per-call is the `{text}`
placeholder, which the bridge substitutes from the agent's reply.

For Cantonese specifically: use `gpt-4o-mini-tts` (not `tts-1` /
`tts-1-hd`) and pass `instructions` to bias the language. See
`docs/OPENAI-TTS-FINDINGS.md` §1 for the verified whisper round-trip.

## Switching providers

To switch from MiniMax to OpenAI (or vice versa), edit `telegram.json#outboundHandlers`.
No `pi install`, no `pi remove`, no version bump. The provider decision is
made at edit time, not at agent run time.

This is the "decided at install time, not at runtime" property the user
asked for — except here the "install" is just a `telegram.json` edit. The
operator can keep multiple `outboundHandlers` entries in `telegram.json` and
toggle them by commenting/uncommenting.

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
