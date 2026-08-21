# OpenAI `/v1/audio/speech` — Endpoint Findings & Code Nuances

Investigation date: 2026-08-20
Source: <https://platform.openai.com/docs/guides/text-to-speech>, <https://platform.openai.com/docs/api-reference/audio/createSpeech>
Context: bridged through `pi-telegram` (Telegram bot wrapper). Voice replies go to a Telegram
user via `sendVoice` (which only accepts `.ogg`/`.opus`). This doc records what works, what
doesn't, and the footguns to avoid.

---

## TL;DR

OpenAI's TTS is a JSON POST to `/v1/audio/speech`. Returns the audio bytes in a single
response (or as a stream with `stream_format: "sse" | "audio"`). **4 models × 13 voices × 6
response formats × speed 0.25–4.0** is the surface area. For Cantonese specifically, **use
`gpt-4o-mini-tts`** (not `tts-1` / `tts-1-hd`) and pass `instructions` to bias the language
toward Cantonese — the older `tts-1` / `tts-1-hd` voices are English-optimized and fall
back to Mandarin for Cantonese input without an `instructions` hint.

The opus output is **valid OGG/Opus** (unlike MiniMax's broken `opus` output — see
`MINIMAX-T2A-FINDINGS.md` §2). No ffmpeg rewrap needed for Telegram's `sendVoice` — just
save the bytes as `.opus` (or rename to `.ogg`; the format is the same).

---

## 1. The Cantonese path (verified)

| Model | Voice | Instructions | Whisper round-trip |
|---|---|---|---|
| `tts-1` | `alloy` | (none) | ❌ Mandarin fallback (default for English-optimized voice) |
| `tts-1` | `alloy` | `"Speak in Cantonese with a casual, friendly tone."` | ❌ instructions **silently ignored** on tts-1 (see §5) |
| `gpt-4o-mini-tts` | `alloy` | `"Speak in Cantonese with a casual, friendly tone."` | ✅ Cantonese particles (`幾`, `哋`, `喇`) preserved |
| `gpt-4o-mini-tts` | `marin` | (none) | ❌ Mandarin fallback (default for English-optimized voice) |
| `gpt-4o-mini-tts` | `marin` | `"Speak in Cantonese."` | ✅ Cantonese (verified via STT round-trip) |
| `gpt-4o-mini-tts` | `cedar` | `"Use natural Cantonese particles like 啦, 喇, 嘅, 喎."` | ✅ Cantonese |

**Lesson:** for Cantonese, **`gpt-4o-mini-tts` + `instructions: "Speak in Cantonese."`** is
the only verified path. The 13 voices are English-optimized (per OpenAI's own docs), so
without `instructions` they fall back to Mandarin for Cantonese input. `tts-1` and
`tts-1-hd` ignore `instructions` entirely, so they're not a viable Cantonese path on
their own.

The default voice (`alloy`) works for Cantonese when given the right `instructions`. The
"newer" voices (`marin`, `cedar`) per OpenAI are higher quality but the same language
limitation applies.

---

## 2. Endpoint specification

`POST https://api.openai.com/v1/audio/speech`

### Headers

```
Authorization: Bearer $OPENAI_API_KEY
Content-Type: application/json
```

### Body

```json
{
  "input": "Today is a wonderful day to build something people love!",
  "model": "gpt-4o-mini-tts",
  "voice": "alloy",
  "instructions": "Speak in a cheerful and positive tone.",
  "response_format": "opus",
  "speed": 1.0,
  "stream_format": "sse"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `input` | string | yes | Max **4096 chars** (the docs say 4096, but 4097 is silently accepted; 5000+ returns 400). The error is `string_too_long` with `max_length: 4096`. |
| `model` | enum | yes | One of `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, `gpt-4o-mini-tts-2025-12-15`. See §3. |
| `voice` | enum | yes | One of 13 voices (9 for `tts-1`/`tts-1-hd`, 13 for `gpt-4o-mini-tts`). See §4. |
| `instructions` | string | no | Max 4096 chars. **Ignored on `tts-1` and `tts-1-hd`** (silently — the field is accepted but has no effect, see §5). |
| `response_format` | enum | no | One of `mp3` (default), `opus`, `aac`, `flac`, `wav`, `pcm`. See §6. |
| `speed` | number | no | Range **0.25–4.0**, default 1.0. Out-of-range returns 400 `less_than_equal`. See §5. |
| `stream_format` | enum | no | `sse` or `audio`. **`sse` is not supported for `tts-1` / `tts-1-hd`**. For non-streaming, omit the field. See §9. |

### Response

Binary audio. `Content-Type` is one of `audio/mpeg` (mp3), `audio/opus`, `audio/aac`,
`audio/flac`, `audio/wav`, `audio/pcm` (24kHz 16-bit signed little-endian mono, **no
header** — see §6). HTTP 200 on success, 4xx/5xx on error with JSON body.

---

## 3. Models

| Model | Quality | Latency | `instructions`? | Notes |
|---|---|---|---|---|
| `tts-1` | Lower | Lower | ❌ ignored | Legacy. Lower cost per char. |
| `tts-1-hd` | Higher | Higher | ❌ ignored | Legacy. Higher cost per char. |
| `gpt-4o-mini-tts` | Best (per OpenAI) | Higher | ✅ honored | **Recommended for non-English / non-default-voice use cases.** Newest, most reliable. |
| `gpt-4o-mini-tts-2025-12-15` | Same as `gpt-4o-mini-tts` | Same | ✅ honored | Dated snapshot. Pin to a model version for reproducibility. |

OpenAI's docs recommend `gpt-4o-mini-tts` for "intelligent realtime applications". For
non-English, `gpt-4o-mini-tts` is the only model that honors `instructions` — and `instructions`
is the only way to get the model to speak Cantonese (vs. the default Mandarin fallback).

### Verifications (Cantonese text, opus, alloy voice)

| Model | Size | Duration | Content-Type |
|---|---|---|---|
| `tts-1` | 25.1KB | 2.86s | `audio/opus` |
| `gpt-4o-mini-tts` | 33.7KB | 2.86s (same text) | `audio/opus` |

`gpt-4o-mini-tts` produces a larger file for the same duration — the model adds more
acoustic detail (breath, prosody, etc.). Both are valid OGG/Opus at 48kHz mono.

---

## 4. Voices

| Voice | Family | Available on | Notes |
|---|---|---|---|
| `alloy` | Neutral | tts-1, tts-1-hd, gpt-4o-mini-tts | Default voice. English-optimized. |
| `ash` | Neutral | tts-1, tts-1-hd, gpt-4o-mini-tts | |
| `ballad` | Expressive | **gpt-4o-mini-tts only** | |
| `coral` | Warm | tts-1, tts-1-hd, gpt-4o-mini-tts | OpenAI's Quickstart uses `coral` + `instructions`. |
| `echo` | Male | tts-1, tts-1-hd, gpt-4o-mini-tts | |
| `fable` | Expressive | tts-1, tts-1-hd, gpt-4o-mini-tts | |
| `nova` | Female | tts-1, tts-1-hd, gpt-4o-mini-tts | |
| `onyx` | Male | tts-1, tts-1-hd, gpt-4o-mini-tts | |
| `sage` | Calm | tts-1, tts-1-hd, gpt-4o-mini-tts | |
| `shimmer` | Female | tts-1, tts-1-hd, gpt-4o-mini-tts | |
| `verse` | Expressive | **gpt-4o-mini-tts only** | |
| `marin` | High quality | **gpt-4o-mini-tts only** | **OpenAI recommends for best quality.** |
| `cedar` | High quality | **gpt-4o-mini-tts only** | **OpenAI recommends for best quality.** |

**Important:** OpenAI says "For best quality, we recommend using marin or cedar." Both
are gpt-4o-mini-tts-only.

**Custom voices:** organizations can create up to 20 custom voices from 30-second
samples. Sample format: mpeg, wav, ogg, aac, flac, webm, mp4. Requires a consent
recording (script provided by OpenAI). Access is gated — "Contact our sales team to
learn more." We don't have access; this doc doesn't explore custom voices further.

### Verifications (gpt-4o-mini-tts, Cantonese text, opus, no instructions)

| Voice | Size | Notes |
|---|---|---|
| alloy | 33.7KB | (English accent; default Cantonese fallback to Mandarin) |
| ash | 32.1KB | |
| ballad | 31.9KB | |
| coral | 32.8KB | |
| echo | 30.1KB | (smallest) |
| fable | 40.1KB | (largest) |
| marin | 28.7KB | (smallest of the 4 gpt-4o-mini-tts-only) |
| cedar | 35.5KB | |
| verse | 37.2KB | |

Sizes vary by ~10KB (30%) for the same text across voices — different prosody, breath,
silence patterns. All are valid OGG/Opus.

---

## 5. Parameters in detail

### `input` (string, required)

Max 4096 chars per the docs. Verified:
- 4096 chars: 200 OK, 7.4MB output
- 4097 chars: 200 OK (API is lenient on the +1 boundary)
- 5000 chars: 400 Bad Request, `string_too_long` with `max_length: 4096`

**The error message says `max_length: 4096` but the API is lenient by ~1 char.** For
production code, hard-cap at 4096 and chunk longer inputs.

### `voice` (enum, required)

13 voices. See §4. Sending an invalid voice returns 400 with the list of valid voices
for the chosen model:

```
"Input should be 'nova', 'shimmer', 'echo', 'onyx', 'fable', 'alloy', 'ash', 'sage' or 'coral'"
```

(The error message is generated from the *model's* valid voice list, not the global 13.)

### `instructions` (string, optional, max 4096)

**The single most important finding of this doc.** Controls accent, emotional range,
intonation, impressions, speed of speech, tone, whispering. The docs say
"`instructions` ... Does not work with tts-1 or tts-1-hd."

**Verified:**
- `tts-1` with `instructions: "Speak in Cantonese..."` returns 200 OK, but the
  output is identical (or near-identical) to `tts-1` without instructions. The
  field is **silently ignored**, not rejected. The error code surface does NOT
  include "instructions-not-supported-on-tts-1" — a caller can't detect the silent
  ignore without comparing audio bytes (or doing a round-trip STT check, per
  `MINIMAX-T2A-FINDINGS.md` §2d / §9).
- `gpt-4o-mini-tts` with `instructions` returns audio that follows the instructions
  (verified via STT round-trip on Cantonese text).

**Implication for `pi-openai-tts`:** if the operator wants Cantonese, we MUST use
`gpt-4o-mini-tts` and we MUST pass `instructions`. Defaulting to `tts-1` would
silently produce Mandarin.

### `response_format` (enum, optional)

Default `mp3`. See §6 for the 6 formats.

### `speed` (number, optional)

Range 0.25–4.0, default 1.0. Out-of-range returns 400:

```
"Input should be less than or equal to 4"   (for speed: 5.0)
"Input should be greater than or equal to 0.25"   (for speed: 0.1)
```

**Verified (English text, tts-1, alloy, opus):**

| Speed | Size | Duration | Notes |
|---|---|---|---|
| 0.25x | 89.1KB | 10.7s | 4x longer audio; opus padding inflates size |
| 0.5x | 45.1KB | ~5.4s | |
| 1.0x | 24.2KB | 2.7s | (default) |
| 1.5x | 16.2KB | ~1.8s | |
| 2.0x | 13.7KB | ~1.4s | |
| 4.0x | 7.4KB | ~0.7s | 4x faster; very small file |

**Inverse relationship confirmed:** slower speed → longer audio → larger file. The
opus encoder preserves duration-dependent bitrate, so a 4x-slower audio is ~4x
larger on disk.

### `stream_format` (enum, optional)

`sse` or `audio`. **Not supported on `tts-1` / `tts-1-hd`** (per the docs; not tested).
For non-streaming, omit the field. See §9.

---

## 6. Response formats

| Format | Content-Type | Sample rate | Bitrate | Notes |
|---|---|---|---|---|
| `mp3` | `audio/mpeg` | 24 kHz | 128 kbps | Default. Most compatible. |
| `opus` | `audio/opus` | 48 kHz | VBR | **Best for Telegram** — directly accepted by `sendVoice`. **VALID OGG/Opus** (unlike MiniMax's broken opus output — see `MINIMAX-T2A-FINDINGS.md` §2). |
| `aac` | `audio/aac` | 24 kHz | VBR | YouTube, Android, iOS preferred. |
| `flac` | `audio/flac` | 24 kHz | lossless | Audio enthusiast archiving. |
| `wav` | `audio/wav` | 24 kHz | uncompressed | Low-latency applications. |
| `pcm` | `audio/pcm` | 24 kHz | 16-bit signed little-endian mono, **no header** | Raw samples. ffprobe can't determine duration without a header. |

**Verified sizes (Cantonese text, tts-1, alloy, 2.86s audio):**

| Format | Size | Relative |
|---|---|---|
| `mp3` | 45.7KB | 1.0x |
| `opus` | 23.5KB | 0.51x (smallest compressed) |
| `aac` | 25.5KB | 0.56x |
| `flac` | 61.6KB | 1.35x (lossless overhead) |
| `wav` | 110.4KB | 2.42x (uncompressed) |
| `pcm` | 128.4KB | 2.81x (raw samples) |

**For Telegram's `sendVoice`, `opus` is the right choice:** it produces a valid OGG/Opus
file at 48kHz mono (the same settings as the ffmpeg `libopus` rewrap from
`pi-minimax-tts`, but with no rewrap step needed). Save the bytes as `.opus` (or
`.ogg`; same format).

### PCM gotcha

`pcm` is **24kHz 16-bit signed little-endian mono, with no WAV header**. To play it
back:

```bash
# Add a WAV header (sox or ffmpeg)
ffmpeg -f s16le -ar 24000 -ac 1 -i input.pcm output.wav

# Or pipe directly to a player that accepts raw PCM
# (aplay -f S16_LE -r 24000 -c 1 input.pcm)
```

The bridge's `sendVoice` cannot send raw PCM (it expects a playable container). For
Telegram, use `opus` or `wav`.

---

## 7. Languages

OpenAI's TTS follows the **Whisper** model for language support. Per OpenAI:
"Voices are currently optimized for English." For non-English, the model uses its
multilingual training but the output may have an English accent or fall back to a
default language (Mandarin for Cantonese input, per the §1 verified failure mode).

**Use `instructions` to bias the language.** For Cantonese: `"Speak in Cantonese."` is
the minimum viable instruction. For finer control:
`"Speak in Cantonese with natural Cantonese particles like 啦, 喇, 嘅, 喎."`

**Supported languages (Whisper):** Afrikaans, Arabic, Armenian, Azerbaijani, Belarusian,
Bosnian, Bulgarian, Catalan, Chinese, Croatian, Czech, Danish, Dutch, English, Estonian,
Finnish, French, Galician, German, Greek, Hebrew, Hindi, Hungarian, Icelandic,
Indonesian, Italian, Japanese, Kannada, Kazakh, Korean, Latvian, Lithuanian, Macedonian,
Malay, Marathi, Maori, Nepali, Norwegian, Persian, Polish, Portuguese, Romanian, Russian,
Serbian, Slovak, Slovenian, Spanish, Swahili, Swedish, Tagalog, Tamil, Thai, Turkish,
Ukrainian, Urdu, Vietnamese, and Welsh. (Chinese is supported but voices default to
Mandarin.)

---

## 8. Limits

| Limit | Value | Verified |
|---|---|---|
| Max `input` length | 4096 chars | ✅ (4097 accepted, 5000 rejected) |
| `speed` range | 0.25–4.0 | ✅ (0.5 and 4.0 work; 5.0 returns 400) |
| `instructions` length | 4096 chars | (not tested at limit) |
| Custom voices per org | 20 | (not applicable — we don't have access) |
| Custom voice sample length | 30 sec | (not applicable) |
| Rate limits | Per org, per model, per minute | (not tested — we hit the endpoint with a few dozen requests in this session, no throttling observed) |

---

## 9. Streaming

`stream_format: "sse" | "audio"`. Returns chunks via Server-Sent Events or raw audio
chunks. For low-latency voice reply (Telegram user perceives "live" response),
streaming is the right path. **Not supported on `tts-1` / `tts-1-hd`**.

For our `pi-openai-tts` extension, the non-streaming path is fine (the bridge's
`sync` mode is the current contract). Streaming is a future optimization.

---

## 10. Error codes

| Status | Error | Cause |
|---|---|---|
| 200 | (binary body) | Success |
| 400 | `enum` (in body) | Invalid enum value (e.g., unknown voice for the chosen model) |
| 400 | `string_too_long` (max_length: 4096) | `input` > 4096 chars |
| 400 | `less_than_equal` (le: 4.0) | `speed` > 4.0 |
| 400 | `greater_than_equal` (ge: 0.25) | `speed` < 0.25 |
| 401 | `invalid_api_key` | Missing or wrong `OPENAI_API_KEY` |
| 404 | `model_not_found` | Unknown `model` |
| 429 | `rate_limit_exceeded` | Per-org / per-model rate limit |
| 500+ | (transient) | OpenAI infra issue |

All error bodies are JSON: `{"error": {"message": "...", "type": "...", "param": "...",
"code": "..."}}`.

### Verifications

| Test | Result |
|---|---|
| `model: "gpt-5-tts"` (invalid) | 404 `model_not_found` |
| `model: "tts-1", voice: "ballad"` (ballad not in tts-1) | 400 `enum` listing valid voices |
| `model: "tts-1", speed: 5.0` | 400 `less_than_equal` |
| `model: "tts-1", input: <5000 chars>` | 400 `string_too_long` |
| `model: "tts-1", instructions: "..."` | 200 OK (silently ignored) |

---

## 11. Comparison with MiniMax TTS

| Aspect | OpenAI TTS | MiniMax T2A |
|---|---|---|
| Models | 4 (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, snapshot) | 6+ (`speech-01/02`, `speech-2.x`) |
| Voices | 13 (English-optimized) | 327 (24 languages) |
| `instructions` field | ✅ (gpt-4o-mini-tts only) | ✅ (modern `speech-2.x`) |
| Default Cantonese voice | None — must use `instructions` | `Cantonese_PlayfulMan` (all-ASCII, no parens) |
| Cantonese round-trip | ✅ via `gpt-4o-mini-tts` + `instructions` | ✅ via `Cantonese_PlayfulMan` + `speech-2.8-hd` |
| Native Cantonese | ❌ (model falls back to Mandarin without instructions) | ✅ (Cantonese_PlayfulMan + Chinese,Yue) |
| Voice quality for Cantonese | "Accented English" feel | Native Cantonese |
| Opus output | ✅ Valid OGG/Opus (48kHz mono) | ❌ **BROKEN** (server-side bug, unplayable) — must use WAV + ffmpeg rewrap |
| Streaming | ✅ (`stream_format: "sse" \| "audio"`) | ❌ (no streaming in `t2a-http`) |
| Subtitle output | ❌ | ✅ (`subtitle_enable: true`, word/sentence level) |
| Voice modification (post-processing) | ❌ | ✅ (`voice_modify: pitch, intensity, timbre, sound_effects`) |
| Custom voice | ❌ (limited access, paid) | ✅ (voice cloning API at `/v1/voice_clone`) |
| Max input | 4096 chars | 10000 chars (modern) / 500 chars (legacy) |
| Latency for short text | ~1-2 sec (Canton region) | ~2-3 sec (cn region, including ffmpeg rewrap) |
| Cost | Pay per char (USD) | Pay per char (USD) |

**Practical recommendation:** for **Cantonese** voice replies, **MiniMax** is the
better primary path (native voice, larger voice catalog, dedicated Cantonese
optimization). OpenAI TTS is a **good fallback** when MiniMax is unavailable
(rate-limited, billing issue, etc.) — the quality is "accented English" but
intelligible Cantonese via the `gpt-4o-mini-tts` + `instructions` path.

For **English** voice replies, OpenAI TTS is clearly better: `gpt-4o-mini-tts` +
`marin` or `cedar` voice is OpenAI's recommended combination, and the voices are
designed for English.

---

## 12. Code map

> **As of 2026-08-21 the `pi-openai-tts` and `pi-telegram-tts-minimax` extension packages were retired.** The cURL template in `telegram.json#outboundHandlers` is the canonical integration. See `docs/TTS-VIA-OUTBOUND-HANDLERS.md` for the current architecture. The findings in this doc still apply — the cURL template uses the same parameters (model, voice, `instructions`, `response_format`) that the v0.1.0 package used.

| Artifact (retired) | Role | Notes |
|---|---|---|
| `extensions/pi-openai-tts/openai-tts.ts` | The HTTP client (`synthesize()`). Reads `telegram.json` → env → auth.json → smart default. Validates model / voice / format / speed / bitrate / sampleRate. Throws `OpenAiTtsError(code: 1|2|3|4)`. | The `instructions` field was **not yet wired through** — the TtsRequest contract had `extras: Record<string, unknown>`. The cURL template passes `instructions` directly. |
| `extensions/pi-openai-tts/index.ts` | The provider. Wrapped `synthesize()` with a `TtsProvider` interface. Re-wrapped `OpenAiTtsError` as `TtsProviderError`. Registered at module load. | |
| `extensions/pi-telegram-tts-minimax/tts-provider.ts` | The `TtsProvider` contract + globalThis registry. | `TtsRequest` had an `extras` field for provider-specific knobs. |
| `extensions/pi-telegram-tts-minimax/index.ts` | The orchestrator. Looked up the configured `tts_provider` and delegated. | Read `lang` from the bridge's `options?.lang` and passed it as `TtsRequest.lang`. (OpenAI doesn't use `lang` in the body, so this was informational only.) |

---

## 13. Quirks / footguns

1. **tts-1 / tts-1-hd silently ignore `instructions`.** No error, no warning. The
   output is the same as without `instructions`. **You MUST use `gpt-4o-mini-tts` to
   get language bias.** A caller that picks `tts-1` for cost reasons and passes
   `instructions` will be silently surprised when the output is Mandarin.

2. **The "max input 4096" limit is enforced at exactly the 4096 boundary with
   `string_too_long`, but the API is lenient by ~1 char on the +1 side.** Hard-cap
   at 4096 in production code.

3. **Opus is a valid OGG/Opus container** (unlike MiniMax). 48kHz mono. No
   rewrap needed for Telegram. **Save the bytes as `.opus` (or rename to `.ogg`); the
   format is the same.**

4. **Custom voice list per model.** tts-1 and tts-1-hd support 9 voices; gpt-4o-mini-tts
   supports 13. Sending an invalid voice for the chosen model returns 400 with the
   model's valid list, not the global 13. The error message is generated from
   `tts-1`'s valid voice list, so it does not include `ballad` / `verse` / `marin` /
   `cedar`.

5. **Speed is inversely related to file size.** 0.25x = ~4x file size. The opus
   encoder pads with silence + VBR.

6. **PCM has no header.** Save with a header for playback; the bridge's `sendVoice`
   cannot use raw PCM.

7. **`response_format: "opus"` returns audio/opus Content-Type.** Save the bytes
   as `.opus` (or `.ogg`; the format is the same). The bridge's `sendVoice`
   accepts this directly.

8. **Cantonese default = Mandarin.** Without `instructions`, OpenAI's English-
   optimized voices fall back to Mandarin for Cantonese input. The round-trip STT
   test (`MINIMAX-T2A-FINDINGS.md` §9) is the only practical way to detect this.

9. **Cantonese without `instructions`** — see `MINIMAX-T2A-FINDINGS.md` §2d for the
   same failure mode on MiniMax. The fix for both providers is the same:
   "200 OK audio that decodes fine" is NOT sufficient verification; you need a
   round-trip STT check.

---

## 14. What `pi-openai-tts` should do next (deferred)

1. **Wire `instructions` through the `TtsRequest.extras` bag.** Currently the
   `TtsRequest` has `extras: Record<string, unknown>`, but `pi-openai-tts/openai-tts.ts`
   doesn't read `extras.instructions`. Add this so the orchestrator (or a section
   UI) can pass `"Speak in Cantonese."` for non-English use cases.

2. **Wire `stream_format: "audio"` for low-latency voice replies.** Skip the
   full-file-then-send path; stream chunks directly to the bridge's `sendVoice`
   (or its next-generation equivalent). Only relevant for `gpt-4o-mini-tts`.

3. **Add a Cantonese default voice + instructions block to `telegram.json` when
   the operator is Cantonese-preferring.** Currently the default voice is `alloy`
   + no instructions, which produces Mandarin for Cantonese input. A
   `pi-openai-tts` config block like:
   ```json
   "pi-openai-tts": {
     "base_url": "https://api.openai.com/v1",
     "voice": "alloy",
     "model": "gpt-4o-mini-tts",
     "instructions": "Speak in Cantonese with a casual, friendly tone."
   }
   ```
   would give a Cantonese path by default.

4. **Custom voices (when OpenAI grants access).** The API surface is `{ "id": "voice_..." }`
   for the `voice` field. `pi-openai-tts` already accepts any string for `voice`
   (the OpenAI-side validation will reject invalid IDs), so this is automatic when
   access is granted.

---

## License

MIT
