# Provider Metadata Architecture — A Design Discussion

> **Status:** design notes from a 2026-08-24 architecture review. Not a
> plan or a commitment; the v0.3.0 deliverable ships **without** any
> upstream changes (see "Pragmatic v0.3.0 decision" §). When the
> upstream (`@earendil-works/pi-coding-agent` / `@llblab/pi-telegram`)
> ever adds a `PiMediaProvider` abstraction, this doc is the
> reference for why and how to use it. **Until then: `telegram.json#extensions["pi-telegram-tts"]`
> + `schema.json` is the operator's config UX** — same as v0.1.0's
> `telegram.json#voice.*` was for the bridge-owned policy.

## TL;DR

The upstream `@llblab/pi-telegram` synthesis-provider surface is
**intentionally minimal**: a single `(text, { lang?, rate? })` call
plus two optional `getVoicePolicy?()` / `getVoicePromptContribution?()`
hooks. **No structured provider-metadata API** (no voice list, no model
list, no current-state query). The `lang` / `rate` parameters are
"half-hearted" — they pass through the bridge but nothing on the
bridge side reads them; the provider is free to use or ignore them.

The right long-term answer is a **`PiMediaProvider` abstraction at the
`pi-coding-agent` layer** (a level below `pi-telegram`), so the same
TTS / STT / image / video providers can be queried by **any transport**
(Telegram, TTY, web, mobile). This is a non-trivial upstream design
change; the v0.3.0 work doesn't need it. **The plan is to file the
design issue with the upstream maintainer when the v0.4.0 work
needs it.**

---

## 1. The current upstream surface (evidence)

### 1.1 What the bridge exposes to a synthesis provider

From `node_modules/@llblab/pi-telegram@0.36.8/lib/voice.ts:43-65`:

```ts
export type TelegramVoiceSynthesisProviderResult =
  | string
  | { audioPath: string; transcriptText?: string }
  | undefined;

export interface TelegramVoiceSynthesisProvider {
  (
    text: string,
    options?: { lang?: string; rate?: string },
  ): Promise<TelegramVoiceSynthesisProviderResult>;
  getVoicePolicy?: () => { replyMode?: TelegramVoiceReplyMode };
  getVoicePromptContribution?: (
    view: TelegramVoiceTurnView,
  ) => string | undefined;
}
```

That's the entire provider surface. The view object is
`TelegramVoiceTurnView = { voiceReplyPreferred?, voiceReplyRequired?, hasVoiceInput?, userText? }`
— read-only context, no provider-config data.

### 1.2 How `lang` / `rate` actually flow

Traced end-to-end:

1. **Origin.** The agent emits markdown with inline markup: `<!-- telegram_voice text="..." lang="..." rate="..." -->`. These come from the **agent's prose**, not from any system config. (`docs/command-templates.md:124`)
2. **Parse.** `planTelegramVoiceReply()` (`lib/outbound-markup.ts:477-521`) extracts the markup into a `TelegramVoiceReplyItem { text, lang?, rate? }`. The bridge does **not** look up any default; if the agent didn't write them, they're `undefined`.
3. **Forward.** `createTelegramOutboundReplyArtifactSender()` (`lib/outbound.ts:857-858, 880-895`) reads `plan.lang` / `plan.rate` and passes them as options to the voice reply sender.
4. **Re-forward.** `createTelegramVoiceReplySender()` (`lib/outbound-voice.ts:189-190, 212-213, 247-248`) passes them as the 2nd-arg options to the provider's `(text, opts)` call — **3 places**: programmatic handlers, voice handlers, synthesis providers.
5. **Receive.** The provider gets them as **hints** it can use or ignore. The operator-facing doc is explicit: *"The provider receives the raw agent text plus optional `{ lang?, rate? }`."*
6. **Who else reads them?** Nobody. A grep across `@llblab/pi-telegram` shows `lang` / `rate` only appear in the type definition, the 3 caller sites, and the `command-templates.md` docs (as a separate `telegram.json#outboundHandlers[0].template` placeholder feature, **not** the synthesis-provider path).

**Conclusion:** `lang` / `rate` are vestigial. The bridge passes them through because it would be more work to NOT pass them; nothing on the bridge side reads them. They are **hint plumbing**, not a contract.

### 1.3 Why the upstream is "minimal" by design

`docs/voice.md` says it explicitly:

> *"pi-telegram does not catalog speech providers."*
> *"The bridge only provides the registration seam and the actual
> delivery to Telegram. The provider is fully responsible for [...]"*
> *"The reply policy itself remains a built-in pi-telegram setting
> (`voice.replyMode`) rather than a provider-owned menu."*

The upstream's design philosophy is **"provider is opaque"**:
- The bridge owns the transport (poll, queue, sendVoice, captions, reply-mode policy, settings UI).
- The provider owns the STT/TTS calls, the speech rewriting, the OGG/Opus conversion, the provider-specific menus.
- The two are decoupled by a minimal interface.

This is a sound design — the bridge doesn't need to know which MiniMax voices exist or which OpenAI models are available. The provider is opaque.

---

## 2. The case for "first-class provider metadata" (the user's design intuition)

**Use cases a metadata API would unlock:**

| Use case | What it unlocks today | What changes with metadata |
|---|---|---|
| **Settings UI** | The section's voice/model picker is hardcoded in the form schema (`ui-schema.ts` planned for v0.4.0) | Section can render a dynamic dropdown from `metadata.voices` / `metadata.models` |
| **Agent prompt awareness** | The agent doesn't know what TTS voice/model is active. The README has to tell it. | The provider can include *"you have access to voices X, Y, Z via MiniMax; current voice is Cantonese_PlayfulMan"* in `getVoicePromptContribution(view)` |
| **Cross-extension reactions** | *"when voice.lang=x, do y in another extension"* — needs the other extension to query the synthesis provider's state | The other extension can read `metadata.current` and react |
| **Validation** | Bad voice IDs fall through to the script's `validateBody` exit-2 path | Section UI rejects bad voice IDs at form time, before the user hits Send |

The user's specific example: *"when lang=x, do y on other extensions"* — this is the cross-extension reactivity use case. It requires:
1. The synthesis provider exposes its current state
2. Some peer-query API so other extensions can reach it

Neither exists today.

### 2.1 The current "two provider concepts" in the stack

| Layer | Concept | What it's for | What it can do |
|---|---|---|---|
| `pi-coding-agent` | `pi.registerProvider(name, config)` | **LLM model runtime** (Anthropic, OpenAI, custom proxies) | Register a model, override `baseUrl`, OAuth |
| `pi-telegram` | `registerTelegramVoiceSynthesisProvider()` / `registerTelegramVoiceTranscriptionProvider()` | **TTS / STT specifically** for Telegram | Provide audio file + optional transcript caption |
| `pi-coding-agent` | `FooterDataProvider` | Git branch + extension statuses for the UI footer | Read-only data provider |

**Notice:** there is **no generic "generation provider" concept anywhere.**
Voice is Telegram-specific. **Image, video, and music have no provider
interface at all** in either pi-coding-agent or pi-telegram. This is
a real gap.

### 2.2 If we add `getProviderMetadata` to the Telegram voice layer (option A)

```ts
// In pi-telegram:
interface TelegramVoiceSynthesisProvider {
  (text: string, options?: { lang?: string; rate?: string }): Promise<...>;
  getProviderMetadata?(): { ... };  // <-- new
  setProviderMetadata?(): { ... };   // <-- new
  // ...
}
```

**Problem:** any non-Telegram consumer (TTY, web UI, future chat
client) that wants to render the same TTS settings would have to
either:
- Duplicate the query logic (call our provider directly through some
  other seam)
- Wait for pi-telegram to expose a generic "get provider metadata"
  route through the bridge
- Implement the same surface for their own UI

**The TTS provider's metadata would be locked behind the Telegram
bridge.** A Telegram-shaped API for a non-Telegram consumer is a
re-implementation hazard.

### 2.3 If we add it at the pi-coding-agent layer (option B)

```ts
// Hypothetical — new at pi-coding-agent:
interface PiMediaProvider {
  readonly id: string;
  readonly type: "tts" | "stt" | "image" | "video" | "music";
  // Provider-class-agnostic:
  getMetadata?(): PiMediaProviderMetadata;
  getCurrentPayload?(): Record<string, unknown>;
  setPayload?(payload: Record<string, unknown>): void;
  // Provider-class-specific call methods:
  // TTS: synthesize(text, opts)
  // STT: transcribe(file, opts)
  // Image: generate(prompt, opts)
  // ...
}

interface PiMediaProviderMetadata {
  type: "tts" | "stt" | "image" | "video" | "music";
  id: string;
  name: string;
  schema?: JSONSchema;  // the per-provider schema (varies by type)
  // Provider-class-specific fields, each filled if the provider has them:
  voices?: Array<{ id: string; name: string; langs?: string[] }>;
  models?: Array<{ id: string; name: string }>;
  defaultVoice?: string;
  defaultModel?: string;
  capabilities?: {
    supportsInstructions?: boolean;
    supportsPronunciationDict?: boolean;
    supportsStream?: boolean;
    // etc — each provider class picks what makes sense
  };
}
```

**Now pi-coding-agent has a generic "media provider" registry** that
any consumer (Telegram bridge, TTY, web, future) can query. The
metadata schema varies by `type` (TTS metadata is different from image
metadata) but the registry is uniform.

`pi-telegram` becomes a **consumer** of this registry — it queries
for voice providers and adapts the result to its
`registerTelegramVoiceSynthesisProvider()` shape. **No duplicate type
definitions.** The TTY, web, and future UIs are also consumers — same
registry, same shape.

### 2.4 The metadata is the schema

The `schema.json` we just shipped (Draft 2020-12) **is** the
per-provider metadata shape. `PiMediaProviderMetadata.schema` returns
our `schema.json` content for the TTS type. The agent or section UI
reads it to know what fields the provider supports and how to
validate them. **The provider's own JSON Schema IS the metadata
contract.**

This is a key insight: we don't need to invent a new metadata
shape. **The schema is the metadata.**

---

## 3. The pragmatic v0.3.0 decision

**We ship the v0.3.0 deliverable at the pi-telegram layer.** This means:

1. **The sub-block in `telegram.json#extensions["pi-telegram-tts"]` is the operator's config layer.** The bridge already reads `telegram.json` for `voice.*`, so colocation is natural.
2. **`schema.json` is the canonical reference for the surface.** The section UI reads it; the agent can be told about it via README; editors (VS Code / IntelliJ) use it for inline validation.
3. **The v0.3.0 hotfixes to `tts-*.mjs`** (path-mapping for `--config`, TDZ fix for `CLI_TO_PATH`, boolean path-mapping for `POSITIVE_FLAGS` / `NEGATIVE_FLAGS`) ensure every field in the schema actually reaches the API. The 3 in-session hotfixes were the cost of discovering that the upstream's "raw body deep-merge" `--config` is not a CLI-flag path remap.
4. **No upstream changes are required for v0.3.0.** The upstream's minimal surface is enough — the provider carries the real surface via the scripts + sub-block + schema.

### 3.1 What to NOT do for v0.3.0

- **Don't file the upstream issue yet.** The user is still forming the design, and the v0.4.0 form-driven UI work will provide a concrete use case ("the section needs to render a voice dropdown from `getProviderMetadata()`"). File the issue at that point.
- **Don't add `getProviderMetadata?()` to our provider speculatively.** pi-telegram ignores unknown methods, so it's a zero-risk addition — but it's also zero-value until the consumer exists. Wait until the section UI work needs it.
- **Don't add image / video / music provider interfaces speculatively.** They don't exist in either pi-coding-agent or pi-telegram. Wait for the upstream to define a `PiMediaProvider` abstraction (if it ever does).

### 3.2 What to do in v0.4.0+

1. **Build the section UI's form generator.** It reads `schema.json` directly. No upstream change needed. The form is per-provider because each provider has its own schema.
2. **If pi-coding-agent ever adds `PiMediaProvider`:** the section UI's form generator could optionally call `getProviderMetadata()` instead of reading `schema.json` from disk. The result is the same; the API just moves the schema from "file on disk" to "live query". Both are valid.
3. **File the upstream issue** with a concrete use case: *"When the section UI for the TTS provider is rendered, it needs to know which voices and models the provider supports. Today, the answer comes from a per-package `schema.json` file. A `getProviderMetadata?()` method on the provider (or a more general `PiMediaProvider` interface) would let any consumer query the metadata at runtime, and would let TTS, STT, image, and video providers share a uniform metadata shape."*
4. **Cross-extension reactivity** (the user's `when lang=x, do y` example) would need a peer-query API. The upstream could add `getRegisteredProvidersByType(type): PiMediaProvider[]` to make this discoverable. Not on the critical path for v0.4.0.

---

## 4. Open questions for the upstream issue

When the issue is filed, these are the design questions to include:

1. **Should the metadata API be per-provider (each provider has its own shape) or per-provider-class (TTS providers share a shape, image providers share a different shape)?** Recommendation: per-provider-class, with `PiMediaProviderMetadata.type` as the discriminator. Each provider-class has its own metadata schema; cross-class queries use the discriminator.

2. **Should the metadata be queryable (live `getProviderMetadata()`) or just bundled in the package (the `schema.json` approach)?** Recommendation: both. The bundled schema is the source of truth; the live query is a convenience. The bundled approach is what the v0.3.0 schema uses.

3. **Should `setPayload?()` exist, or should config changes go through the operator's config file?** Recommendation: config changes go through the operator's config file. `setPayload?()` is a footgun (the operator's source of truth gets out of sync with the runtime state). The provider reads the file on every call; the file is the canonical state.

4. **Where does the provider registry live — pi-coding-agent or a new package?** Recommendation: pi-coding-agent. It's already where the LLM model providers live (`pi.registerProvider()`); adding a sibling "media providers" registry is the natural extension.

5. **What about the existing `telegram.json#voice.*` fields (`replyMode`, `sendTranscript`)?** Recommendation: keep them. They're bridge-owned policy, not provider-owned config. The `PiMediaProvider` registry is for provider config; the bridge policy is for the bridge. Two different concepts, two different layers.

---

## 5. Summary table — what goes where

| Concern | Where it lives today (v0.3.0) | Where it should live long-term |
|---|---|---|
| Bridge transport (poll, queue, sendVoice) | `@llblab/pi-telegram` | (no change) |
| Reply mode policy (`hidden` / `mirror` / `always`) | `@llblab/pi-telegram` reads `telegram.json#voice.replyMode` | (no change) |
| Transcript preference (`voice.sendTranscript`) | `@llblab/pi-telegram` reads `telegram.json#voice.sendTranscript` | (no change) |
| Provider registry | `@llblab/pi-telegram` (`registerTelegramVoiceSynthesisProvider`) | `@earendil-works/pi-coding-agent` (`PiMediaProvider`) — pi-telegram becomes a consumer |
| Provider config (voice IDs, models, etc.) | `telegram.json#extensions["pi-telegram-tts"]` (and `schema.json` as the contract) | `PiMediaProvider.setPayload?()` or a config-file convention; `schema.json` is the per-provider metadata shape |
| Provider state (current voice, model, lang) | Not queryable; operator reads `telegram.json` | `PiMediaProvider.getCurrentPayload?()` |
| LLM model runtime | `pi-coding-agent` (`pi.registerProvider()`) | (no change) |
| Image / video / music providers | **Don't exist** in either layer | `PiMediaProvider` (hypothetical) |

---

## 6. Related docs

- `docs/PI-TELEGRAM-TTS-PLAN.md` — the v0.3.0 deliverable plan; this doc is a
  design rationale for the "Future expansion" section
- `extensions/pi-telegram-tts/schema.json` — the v0.3.0 per-provider schema
  (Draft 2020-12)
- `docs/voice.md` (in `node_modules/@llblab/pi-telegram/docs/`) — the
  upstream's operator-facing voice contract; quote: *"pi-telegram does
  not catalog speech providers."*
- `lib/voice.ts` and `lib/outbound-voice.ts` (in `node_modules/@llblab/pi-telegram/`)
  — the upstream source for the synthesis-provider surface and the
  synthesis caller
- `core/extensions/types.d.ts` (in `node_modules/@earendil-works/pi-coding-agent/dist/`)
  — the `ExtensionAPI` type; includes `registerProvider()` for LLM
  model runtime
