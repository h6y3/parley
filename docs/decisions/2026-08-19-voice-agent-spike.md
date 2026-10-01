# Voice Agent spike — Deepgram Voice Agent as a second `RealtimeProvider`

**Status:** resolved 2026-09-29 for support, still open for the default. Deepgram is a supported,
selectable realtime provider; encoding negotiation is built; the flag is no longer refused. Whether
Deepgram should become the daemon's _default_ is still undecided, and the live A/B below is still
the evidence that decides it. See "Resolution — 2026-09-29".

## Resolution — 2026-09-29

The two blockers this record ended on are both closed, and the third outcome its
recommendation listed ("keep both behind `--realtime-provider`") is now the shipped state.
The sections below are kept as written, as the historical record of what the spike found; where
they say the flag is refused, that was true on 2026-08-19 and is not true now.

**What is supported.** Both `gemini` and `deepgram` are supported realtime providers.
`parley serve` builds every provider whose key is set; `--realtime-provider` chooses which one a
call gets when its envelope does not say (still `gemini`, and that default does not change
silently). A call can choose per envelope with `execution.realtime.provider`. The Deepgram
provider is `@parley/realtime-deepgram`; release 0.4.0 is the first to ship it as supported.

**Encoding negotiation is resolved.** A `RealtimeProvider` now declares
`audio: { accepts, emits }` and `CallSession` bridges each direction between the carrier's
encoding (`TelephonyProvider.mediaEncoding`) and the provider's, with no conversion at all when
they already match (Deepgram and Twilio both speak `mulaw@8000`). An unbridgeable pairing is
refused before a phone rings. The codec's hard-wired assumption of Gemini's
formats that made every inbound frame throw and every outbound frame noise is gone from the
codec.

**Defects found in the provider itself, and fixed.** The offline invariant suite exercised the
provider directly, so it could not see these. The opening trigger was sent as
`InjectAgentMessage`, which Deepgram speaks verbatim, so the callee would have heard the private
instruction read aloud; it is now a user turn the model answers. The trigger guard capped the line
at 120 characters, well under the production trigger, so every call would have thrown at the
opening. Turn completion (`AgentAudioDone`) was unhandled, so farewell drains fell back to caps
and meetings misclassified. `connect` resolved on socket open rather than `SettingsApplied`, and
vendor `Error` / `Warning` messages were silent. The provider now handles all of these and never
sends `InjectAgentMessage`, `UpdatePrompt`, `UpdateThink`, `UpdateSpeak` or `UpdateListen`.

**Offline latency evidence (a throwaway probe, 2026-09-29).** The production system instruction
and opening trigger, the same recorded caller turns streamed in real time, measured from the end
of the caller's speech to the first agent audio byte (carrier latency, equal for all
configurations, excluded):

| Configuration                | Runs | Median  | Notes                                                             |
| ---------------------------- | ---- | ------- | ----------------------------------------------------------------- |
| Deepgram + a smaller Claude  | 6    | ~0.96 s | Ignored a one-sentence-purpose instruction; barge-in cut it early |
| Deepgram + a small GPT model | 8    | 1.13 s  | Concise, on-brief, silent during the opening trigger              |
| Gemini 3.8 Live              | 12   | 1.39 s  | Spoke during the trigger silence in 1 of 3 sessions               |

The shipped Deepgram default is `gpt-4o-mini` (provider `open_ai`, Deepgram-managed) at speed
1.25: the model Deepgram's own telephony reference agents use, in the Standard pricing tier
($0.075 a minute against $0.163 for Advanced), and measured at about 0.5 to 0.96 s from callee
text to first audio with the production prompt against about 1.15 to 1.77 s for
`claude-sonnet-4-6`. The speech after the meeting-connected cue was measured on a smaller Claude
model and has not been checked on the default, so meetings stay on the Gemini provider with
`execution.realtime.provider` until it is.
Speech recognition
misheard a proper name, which is what `brief.keyterms` is for. Small samples: these are leads, not
a verdict, and they measure everything except what a person hears.

**What is still open: making Deepgram the default.** Latency parity on a probe is not the live
A/B this record names. Before the default changes, place the same brief through both providers on
a number under the operator's control and compare the four points listed under "Live A/B" below.
Until then the default stays `gemini`, and choosing Deepgram is an explicit, per-daemon or
per-call decision. Design and evidence: `docs/superpowers/specs/2026-09-29-realtime-provider-parity-design.md`.

**Question this spike exists to answer:** does an ASR→LLM→TTS pipeline sound acceptable on a phone
line where Gemini Live is native speech-to-speech?

## What was verified from documentation, and what could not be

Fetched from `developers.deepgram.com` on 2026-08-19 (Step 1 of the task brief). Two facts were
required before writing any code; both were checked rather than assumed.

### 1. The WebSocket endpoint and settings-message shape

**Verified.** `DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"`
(`packages/realtime-deepgram/src/deepgram-realtime-provider.ts`), confirmed from
`developers.deepgram.com/docs/build-a-voice-agent` and cross-checked against
`developers.deepgram.com/reference/voice-agent/voice-agent`'s AsyncAPI schema. Regional variants
(`api.eu.deepgram.com`, `api.au.deepgram.com`) exist and are out of scope for this spike.

The literal `Settings` example fetched from `developers.deepgram.com/docs/voice-agent-settings`:

```json
{
  "type": "Settings",
  "audio": {
    "input": { "encoding": "linear16", "sample_rate": 24000 },
    "output": { "encoding": "linear16", "sample_rate": 24000, "container": "none" }
  },
  "agent": {
    "language": "en",
    "listen": { "provider": { "type": "deepgram", "model": "nova-3" } },
    "think": { "provider": { "type": "open_ai", "model": "gpt-4o-mini" } },
    "speak": { "provider": { "type": "deepgram", "model": "flux-kit-en" } }
  }
}
```

That example uses `linear16`/24000 — `mulaw`/8000 is separately confirmed as a valid
`SettingsAudioInput`/`SettingsAudioOutput` value via the AsyncAPI schema, and is what
`packages/realtime-deepgram` actually sends, matching the brief's mu-law-8k-both-directions
requirement and `@parley/core`'s `MULAW_8K` constant — no resampling on the call path, unlike
Gemini's pcm@16000-in/pcm@24000-out.

The example also omits `agent.think.prompt` and `agent.think.functions` (systemInstruction and
tool declarations respectively). A second, schema-focused fetch of the same reference page
confirmed both are direct properties of `agent.think` (siblings of `provider`, not nested inside
it): `ThinkSettingsV1 = { provider, endpoint?, functions?, prompt?, context_length? }`, and each
`functions[]` entry is `{ name, description, parameters, endpoint? }` — Deepgram's field is
`parameters`, not `parametersJsonSchema` (that name is `@parley/core`'s own `ToolDeclaration`
field; the provider maps one onto the other, same as Gemini's adapter does).

Message-type field names, also confirmed via the AsyncAPI schema fetch:

| Message                | Direction     | Fields confirmed                                                                       |
| ---------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `FunctionCallRequest`  | server→client | `functions: [{ id, name, arguments (JSON string), client_side?, thought_signature? }]` |
| `FunctionCallResponse` | client→server | `{ type, id, name, content }`                                                          |
| `InjectAgentMessage`   | client→server | `{ type, message, behavior? }`                                                         |
| `UserStartedSpeaking`  | server→client | `{ type }` — no other fields                                                           |
| `ConversationText`     | server→client | `{ type, role: "user"\|"assistant", content, languages_hinted?, languages? }`          |

**Authentication — partially verified.** The AsyncAPI schema confirms the header _name_ is
`Authorization` (`"Authorization": { "type": "string" }`). The exact _value_ format
(`Token <key>` vs `Bearer <key>`) was not found stated for this specific endpoint in what was
fetched. The implementation uses `Token <key>`, matching the convention already established
in-repo by `@parley/transcription-deepgram` for Deepgram's Listen API — the same vendor's other
WebSocket API — but this is inferred by cross-API consistency, not independently confirmed for
Voice Agent specifically. **Marked unverified in the code comment; flagging here rather than
asserting it as read from documentation.**

**Also unverified:** no documented client-initiated close-handshake message (the Listen API has
`CloseStream`; nothing equivalent was found for Voice Agent in what was fetched). The
implementation closes the socket directly rather than inventing one.

**Managed `think` providers — verified.** A supplementary search-based check (not a page fetch)
found that `open_ai`, `anthropic`, `google`, and `nvidia` are Deepgram-_managed_ `think` providers
— no `endpoint` and no separate vendor API key required, only the Deepgram key already on the
connection. This is why `DEFAULT_DEEPGRAM_LLM_MODEL = "gpt-4o-mini"` (superseded — see
Resolution) (matching the doc's literal example) is safe to ship as a default: a caller supplying only `DEEPGRAM_API_KEY` gets a working
`think` leg, not a second credential requirement discovered at runtime. This fact came from search
result summaries rather than a direct page fetch and is accordingly weighted lower than the
schema-derived facts above, though it is corroborated by the example's own `open_ai` usage with no
`endpoint` field present.

### 2. Does a voice named "Meghan" exist in Deepgram's Aura catalogue?

**Verified absent.** Two independent fetches of `developers.deepgram.com/docs/tts-models` — one
summarized, one requesting the full alphabetical listing verbatim — agree: **no voice named
"Meghan" (or any case variant) exists**, in either the Aura or Aura-2 generation. The full Aura-2
English-female-voice set was enumerated; none is a phonetic near-miss either (no "Megan",
"Meaghan", etc.).

Nearest alternatives by Deepgram's own one-line character description:

| Identifier           | Character                                  | Why it's listed                                                   |
| -------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `aura-2-cordelia-en` | Approachable, Warm, Polite                 | shipped as `DEFAULT_DEEPGRAM_VOICE` (superseded — see Resolution) |
| `aura-2-helena-en`   | Caring, Natural, Positive, Friendly, Raspy | next-nearest                                                      |
| `aura-2-juno-en`     | Natural, Engaging, Melodic, Breathy        | next-nearest                                                      |

`aura-2-cordelia-en` is a **provisional default for this spike, not a decision made on the
project owner's behalf** — the preference named a voice that does not exist, and this is exactly
the situation the brief asked to surface rather than silently substitute for. Overridable via
`createDeepgramRealtimeProvider({ voice })` or per-connect via `RealtimeConnectParams.voice`.

## What the offline evidence shows

`packages/realtime-deepgram` implements `createDeepgramRealtimeProvider(opts): RealtimeProvider`
(a factory function, matching `@parley/transcription-deepgram`'s shape rather than
`@parley/realtime-gemini`'s class), scaffolded from `packages/realtime-gemini/` per the brief.

**Verified state:**

| Gate                                                                                | Result                                                                                                                                       |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run typecheck` (all 10 packages)                                              | clean                                                                                                                                        |
| `pnpm run test` (whole workspace)                                                   | **677/677 passed** (667 baseline + 10 new: 7 in `@parley/realtime-deepgram`, 3 added `--realtime-provider` CLI tests) — **zero regressions** |
| `pnpm run lint`                                                                     | exits 0                                                                                                                                      |
| `pnpm run format`                                                                   | no changes needed                                                                                                                            |
| `@parley/realtime-deepgram` invariant suite (Step 2 of the brief, run in isolation) | 6/6 passed                                                                                                                                   |

The six invariant tests (not "does it talk" — the three guarantees `@parley/core` makes that a
function-calling vendor could quietly break) all pass:

1. `systemInstruction` is sent exactly once, inside the one `Settings` message.
2. The returned session exposes exactly five methods — `close`, `notifyActivityEnd`, `sendAudio`,
   `sendOpeningTrigger`, `sendToolResponse` — and nothing else. No re-instruction path exists.
3. `systemInstruction` never reappears in any later outbound message, including after
   `sendOpeningTrigger` and `sendAudio`.
4. `sendToolResponse` maps onto `FunctionCallResponse` with the closed `ToolResult` union
   stringified into `content`, and nothing about a callee's own utterance can reach it.
5. Deepgram's `UserStartedSpeaking` (barge-in) maps onto `onInterrupted`.
6. Outbound audio frames are `mulaw@8000` (`MULAW_8K`), confirming no resampling sits on the call
   path — unlike Gemini's `pcm@16000`/`pcm@24000`.

A seventh guard, not enumerated by the brief's six tests but implemented per resolved-ambiguity
item 3 (and exercised indirectly by test 3 above, which calls it with a short, valid string):
`sendOpeningTrigger` throws a fixed message on any input over 120 characters or containing a
newline. `InjectAgentMessage` is a general free-text injection primitive with no Gemini
counterpart — without this bound it would be exactly the mid-session re-instruction escape hatch
`packages/core/src/types.ts` says a `RealtimeSession` must never expose.

**The reliability-matrix comparison (brief Step 6, second half) was not obtained — reported as
such rather than fabricated.** The brief's literal commands:

```bash
pnpm --filter @parley/harness exec parley harness reliability --provider gemini
pnpm --filter @parley/harness exec parley harness reliability --provider deepgram
```

do not run against the current codebase, for three independent reasons, each checked directly
rather than assumed:

1. There is no `parley` bin inside `@parley/harness` — its own bin is `parley-harness`
   (`packages/harness/package.json`). Running the literal command produces
   `Command "parley" not found`.
2. Even the corrected bin name has no `--provider` flag: `packages/harness/src/cli.ts`'s
   `reliability` parser recognizes only `--brief`, `--scenario`, and `--runs`. Run directly
   (`node dist/bin.js reliability --provider gemini`), it fails immediately with
   `Error: reliability requires --brief <path> and --scenario <id>` — Deepgram-vs-Gemini selection
   has no CLI surface at all today; `runReliabilityCommand`'s `makeProvider` override exists only
   as a test-injection seam, unwired to any flag.
3. Even with `--brief`/`--scenario` supplied and a `--provider` flag added, the command makes a
   **live, billed** call to the selected vendor's real API — for Deepgram, a real call this task
   is explicitly forbidden from making, and for either vendor, a credential this environment does
   not hold: `GEMINI_API_KEY` and `DEEPGRAM_API_KEY` are both absent from this environment,
   confirmed by direct check.

Adding a `--provider` flag to `packages/harness/src/cli.ts` is not in the brief's declared Files
list for this task, and doing so would not change point 3. This half of Step 6 is not an offline
gate — it is a live reliability harness, and running it (for either provider) is out of this
spike's authorized scope. Reporting a result here would mean fabricating one; instead this is
recorded as unobtained, matching the task's explicit instruction not to write a confident sentence
that cannot be supported.

## The flag was refused on 2026-08-19 — an encoding contract the interface did not have

_Resolved on 2026-09-29; kept as the record of the finding. See "Resolution" above._

**`parley serve --realtime-provider deepgram` throws rather than serving**
(`packages/cli/src/args.ts`), and this is the finding the offline invariant
suite could not reach, because it exercises the provider directly rather than
through a `CallSession`.

`RealtimeProvider` has no encoding negotiation. `CallSession`'s realtime sink
sent the codec's inbound decode unconditionally, and `AudioCodec` was
documented as "carrier inbound → model input: 8kHz μ-law → 16kHz PCM" — so
what reaches the provider is always `pcm@16000`, the rate Gemini Live wants.
`DeepgramRealtimeProvider.sendAudio` throws on anything that is not
`mulaw@8000` (invariant test 6 above pins that deliberately). So on a real
call:

- **inbound:** every frame throws inside the sink fan-out, is caught and
  reported as a diagnostic — roughly fifty a second, for the whole call — and
  the agent hears nothing at all;
- **outbound:** the provider emits `mulaw@8000`, and the codec's outbound encode was
  documented as "model output → carrier outbound: 24kHz PCM → 8kHz μ-law", so
  it treats mu-law bytes as PCM samples and the callee hears noise.

Neither is a Deepgram defect and neither is a bug in the provider package: the
mismatch is that a `RealtimeProvider` cannot state what it accepts.
`TranscriptionProvider` already can — it carries `accepts: readonly
AudioEncoding[]`, and `AudioBridge` converts to `accepts[0]` — which is why the
LISTENING plane works with the same vendor and the same mu-law leg. Giving
`RealtimeProvider` the same field (and running the sink through `AudioBridge`)
is the work that unblocks the flag; it is not in this spike's scope.

Until then the flag is refused with that reason, rather than accepted into a
call that fails silently while flooding the log. A spike that cannot be run is
an honest state; a spike that runs and produces a dead call is not. The
provider package, its seven invariant tests, and `buildRealtimeProvider`'s
branch all stay exactly as they are — one guard is what stands between here and
a live A/B, once the encoding contract exists.

## Live A/B — the open question this spike did not answer

**Not performed, on explicit instruction.** The brief's Step 7 calls for two real outbound phone
calls (Gemini and Deepgram, same brief, back to back) measuring: time from answer to first word,
whether barge-in cut the model off cleanly, whether the announcement sounded like a person, and
whether `begin_notetaking` fired at the right moment. Placing a call is an outward-facing action
that was not authorized in this turn, so it was not attempted — no call was placed, on either
provider.

**This is the single unanswered question the spike's own question depends on.** Every offline
check above establishes that the Deepgram provider is _correct_ — it honors the same invariants
Gemini's does, sends the right messages in the right shape, and does not leak resampling or a
re-instruction path onto the call path. None of it establishes whether the pipeline _sounds_
acceptable, which is a live-audio, human-judgment question no offline test can answer, and which is
exactly why the brief scoped a live A/B as its own step rather than folding it into the invariant
suite.

**The exact comparison that would settle it:** place the same brief through both providers,
back-to-back, on one bridge, and record for each:

1. **Time from answer to first word** — Deepgram's three-stage pipeline (STT→LLM→TTS) has a
   structurally different latency profile than Gemini's native speech-to-speech; whether the
   difference is perceptible on a phone line, not just measurable, is the live-call question.
2. **Barge-in cleanliness** — whether `UserStartedSpeaking` cuts the agent off as cleanly as
   Gemini's `serverContent.interrupted` does, given the extra pipeline stage between "caller
   started talking" and "TTS actually stops".
3. **Whether the announcement sounds like a person** — the one criterion no typed test can check;
   the entire reason this task is a spike with a written verdict rather than a provider shipped on
   the strength of passing tests.
4. **Whether `begin_notetaking` fires at the right moment** — a function-calling correctness check
   that depends on real conversational timing, not the synthetic tool-call payloads the invariant
   suite exercises.

## Recommendation

**As of 2026-08-19: needs more work — and there were then TWO named items, not one. The first is closed (see "Resolution — 2026-09-29"); the second is not.** The live A/B
below is still the question the spike exists to answer; ahead of it sits
encoding negotiation on `RealtimeProvider`, without which the flag cannot carry
a call at all and the A/B has nothing to measure. The offline
half is complete and clean (677/677 tests, zero regressions, both documentation facts the brief
required either verified or plainly marked unverified). What remains is entirely the live-audio
comparison in the section above; there is no other open item blocking a decision.

Once that comparison exists, the decision resolves to one of three concrete outcomes, in order of
what the evidence would have to show:

- **Keep Gemini only** (remove or leave dormant the Deepgram provider) — if the live A/B shows the
  pipeline sounds noticeably worse, or barge-in is not clean, on a real phone line.
- **Switch the default to Deepgram** — if the live A/B shows parity or better, on all four measured
  points above, at whatever cost/latency trade Deepgram's architecture implies.
- **Keep both behind `--realtime-provider`** — if the live A/B shows a genuine trade-off (e.g.
  acceptable quality but a use case where Deepgram's function-calling model or cost profile wins),
  making the flag a real per-deployment choice rather than a spike relic.

This spike does not recommend among those three — that would mean guessing at the one thing it was
built to measure and did not.
