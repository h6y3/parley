# Prompt guide — writing and auditing a `Brief`

This document is for anyone writing a `Brief` (persona, objective, facts) or extending
`@parley/core`'s prompt rendering or `@parley/policy`'s guardrail composition. It exists to make
the failure modes Parley was built to avoid —
echo hallucination, buried directives, voiced structural markers, false-green single-turn
testing — structurally impossible for a `Brief` author to reintroduce by accident.

## The two-and-only-two channels

A Parley call's spoken behavior is fully determined by exactly two pieces of text, and nothing
else ever reaches the model as instruction-bearing content:

1. **`systemInstruction`** — a single string, built fresh for the call, sent exactly once, at the
   moment the realtime session is opened (`RealtimeProvider.connect()`). Gemini Live's API
   documents this field as immutable for the life of the session — it cannot be changed once the
   connection is open. Parley treats that immutability as a feature: the brief is fixed at call
   start by design, and `RealtimeProvider` (`packages/core/src/types.ts`) exposes no method to
   update it later.
2. **The opening trigger** — a single short, plain-language, generic sentence, sent exactly once
   via `RealtimeSession.sendOpeningTrigger()` immediately after connect. Parley's built-in trigger
   is `"Begin the call naturally now."` (`OPENING_TRIGGER`, `packages/core/src/render.ts`)
   — it never restates the persona, never restates the brief, never carries a structural marker,
   and is never longer than one sentence.

Nothing else — no fabricated conversational turn, no mid-call system-style message, no tool-call
payload — is a valid place for privileged, authoritative content in Parley. There is no third
channel to reach for, by construction: `RealtimeSession` exposes only `sendOpeningTrigger`,
`sendAudio`, `notifyActivityEnd`, and `close`. The brief lives in `systemInstruction` and nowhere
else, for the entire duration of the call.

## Why this matters

The failure mode this rule exists to prevent shares one root cause: delivering a per-call brief
by concatenating it — after a standing persona, after policy guidance, as a quoted tail — into a
single fabricated conversational turn, then replaying that whole blob back to the model as if a
caller had said it. That one design choice produces several symptoms independently:

- A large, structurally-marked instructional payload riding inside conversation history is
  exactly the shape correlated with a model reciting or paraphrasing its instructions rather than
  following them (echo hallucination), rather than treating it as scaffolding outside the
  conversation.
- Burying the actual per-call assignment at the tail of an enormous first turn gives the model no
  strong signal that this is the operative instruction rather than ambiguous input to weigh
  against everything else in the turn.
- Any marker used to set a brief apart from the rest of a fabricated turn is still tokens inside
  conversation history, with no output-side suppression on native-audio models — it can end up
  voiced, especially once a call has started to drift.
- A single-turn bench of that first fabricated turn can look completely clean, because the
  failure is a multi-turn drift, not a first-response defect — a false-green result.

Gemini Live's API already draws the line Parley needs: `systemInstruction` is the documented place
for persona, conversational rules, and guardrails, and is explicitly a one-time setup field, not
part of the conversation. Parley's design decision is to never violate that line: the brief goes
where the API says fixed instructions go, and the trigger goes where the API says a kickoff nudge
goes, full stop — enforced by the shape of `RealtimeProvider`/`RealtimeSession`, not by a
convention an author has to remember to follow correctly every time.

## Assembly order

`CallSession.resolveSystemInstruction()` calls `renderSystemInstruction()`
(`packages/core/src/render.ts`), which builds `systemInstruction` fresh per call from a `Brief`'s
pure caller content plus an already-composed `guardrails` array, in a fixed order that a `Brief`
author cannot reorder:

1. **Persona** (`brief.persona`, trimmed) — who is calling, in first person, one persona only. No
   standing "agent" identity is layered underneath a call-specific persona; a call has exactly one
   voice, top to bottom.
2. **Conversational rules and objective** (`brief.objective` followed by `brief.facts` joined as
   flat prose) — the single objective for this call, stated as declarative facts and
   instructions, never as JSON, bullet points, or headings. Facts the call needs (names, dates,
   numbers, prior context) are baked in here as flat statements, not a separate reference block.
3. **Guardrails**, placed last as a final override layer. `renderSystemInstruction` itself treats
   this whole section as an opaque, pre-composed string — the guardrail selection and ordering is
   `@parley/policy`'s job (`composePolicy()`, `packages/policy/src/compose.ts`), driven by a
   `CallPolicy`, in this fixed order: a single, forceful scope statement (`SCOPE_STATEMENT` —
   "this call has exactly one purpose ... do not improvise a different reason",
   `identity.style: "self"` only relaxes this — see below); explicit redirect language
   (`REDIRECT_LANGUAGE` — if the person changes the subject, acknowledge and return to the
   objective, never invent a different purpose); the identity-style-appropriate framing line, as
   an instruction to say it verbatim — never left to inference; the honest-if-asked guardrail
   (when `disclosure.honestIfAsked` is set); and the deferral rule (when `deferral.enabled` is
   set — if asked something the brief doesn't cover, say so and defer to the principal rather than
   guessing). These guardrail sentences are defined in `packages/policy/src/constants.ts`.

   `CallPolicy.identity.style` is one of three values — set via a preset
   (`principalCall`/`representedCall`/`transactionalCall`, `packages/policy/src/presets.ts`) or
   composed directly — each with a different amount of self-identification:

   - **`self`** — calling the principal themself directly. No scope-lock (topic-switching is
     allowed), no introduction, no disclosure — the assistant just speaks as itself, first person.
   - **`onBehalf`** — the principal's professional network. Opens with a personal-assistant
     introduction ("Hi, this is Ada, Alex Rivera's personal assistant, calling on their behalf
     about…"). Discloses the assistant role; does **not** volunteer that it's AI unless
     `disclosure.volunteer` is also set.
   - **`silent`** — businesses, restaurants, customer support. No self-identification and no
     introduction at all — goes straight to the task.

   Independent of identity style, the **honest-if-asked floor** (`disclosure.honestIfAsked`, on by
   default for `representedCall`/`transactionalCall`) applies universally when set: if the person
   directly and unambiguously asks whether they're talking to an AI, a bot, or a real person, the
   assistant answers honestly and continues the call — it never leads with this and never denies
   it. See `docs/security-model.md`'s "Jurisdiction posture" section for the legal reasoning
   behind this floor.

## The plain-prose rule

The whole assembled string is plain prose. **No brackets, no markdown, no JSON, no section
markers of any kind.** `renderSystemInstruction` joins its three sections with blank lines and
nothing else — no headings, no bullet characters, no bracketed tags. This is deliberate: once
markup is present, the model has no reliable way to distinguish "structural scaffolding never
meant to be spoken" from "content that's fine to voice." Native-audio output has no built-in
suppression of structural markup — if a marker is tokens the model attends to, it can end up
voiced, especially once a call has drifted. Parley's answer is to never introduce any marker in
the first place, in its own contributed scaffolding (the guardrail constants and framing text).

A `Brief` author should hold the same standard for `persona`, `objective`, and `facts`: write them
as plain declarative sentences a person could say aloud, not as a structured template with labels,
brackets, or headers. `Brief` fields (`packages/core/src/brief.ts`) are trusted input assembled by
a prep step before the call — Parley does not sanitize or escape them, so keeping them marker-free
is the author's responsibility, not something the library enforces on caller-supplied content.

## Auditing the exact payload before a call

Never guess what a `Brief` will produce. `@parley/harness` ships two commands specifically so a
reviewer can read the literal payload before anything goes near a real call:

```bash
parley harness preview --brief <path-to-a-Brief-JSON-file>
```

prints the exact `systemInstruction` string and the exact opening-trigger text that brief would
produce — no live API call, pure local assembly (`buildPayloadPreview`,
`packages/harness/src/payload-preview.ts`). The harness always previews against one fixed
represented-mode policy (`representedCall`, `packages/harness/src/cli.ts`) — it exercises call
*behavior*, not the policy envelope itself; that is `@parley/policy`'s and `@parley/server`'s own
concern. `--brief` here takes a plain `{ to, persona, objective, facts }` Brief file, not a full
`{ version, brief, policy }` call envelope — see `examples/briefs/represented.json`'s nested
`.brief` object for the shape. (`parley call --brief <path>`, by contrast, takes a full envelope
file — see the top-level `README.md`'s quickstart.)

```bash
GEMINI_API_KEY=... parley harness run-text-preview --brief <path-to-a-Brief-JSON-file>
```

makes a live (text-only) Gemini call using that same assembled `systemInstruction` and opening
trigger, then walks it through the harness's scripted derail turns as text, printing each
response. This is useful for a fast read on prompt wording, but it is explicitly **not** the
reliability gate — §10.1 of the design spec's false-green finding is exactly why: a text-only,
single-turn-style check validates only the easy part of the problem. The actual gate is
`parley harness reliability`, which drives the real `RealtimeProvider` against synthesized audio
turns, repeated ~20 consecutive runs per critical scenario, before any brief goes near a live
phone call.
