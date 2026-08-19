# Security model

Parley is secure by default — none of the following require a hardening pass after adoption;
they are the out-of-the-box behavior of `@parley/telephony-twilio` and `@parley/server` as built.

## `POST /call` authentication — the primary control

`POST /call` is the only route that can spend money and dial a human being. It requires a shared
secret presented as `Authorization: Bearer <token>`, compared in constant time against
`PARLEY_CALL_TOKEN` (`authorizeCall`, `packages/server/src/request-handler.ts`).

Three properties matter more than the mechanism:

- **It fails closed on an unconfigured token.** An operator who never sets `PARLEY_CALL_TOKEN`
  gets a daemon that returns `503 { error: "call authentication is not configured" }` to
  everybody — never one that dials for everybody. "The secret is missing, so skip the check" is
  the shape of most auth bypasses, so the empty case is handled explicitly rather than falling
  through. `parley serve` goes further and refuses to start at all without the variable, so the
  misconfiguration surfaces at boot rather than as an outage hours later.
- **It runs before the body is parsed.** Authorizing after parsing would let an anonymous caller
  distinguish a malformed envelope (`400`) from an unlisted number (`403`) and so enumerate the
  callable-number allowlist without ever holding the token.
- **It is not defence in depth — it is the control.** The daemon binds loopback by default
  (`PARLEY_BIND_HOST`, default `127.0.0.1`), but Twilio must reach `/twilio/answer` from the
  public internet, so any real deployment puts a tunnel or reverse proxy in front that maps a
  whole hostname to the daemon. That path reaches `/call` too. **The callable-number allowlist is
  not access control** — it bounds who may be _dialled_, never who may _dial_. Counting it as
  authentication is exactly the mistake that leaves this route open.

`POST /twilio/answer` and `POST /twilio/status` are deliberately **not** token-gated: Twilio
cannot present a bearer token. Their control is signature verification, below. `GET /healthz` is
unauthenticated and side-effect-free by design.

## Twilio signature verification — on, and fails closed

`POST /twilio/answer` verifies every inbound webhook against Twilio's signature scheme
(`verifyTwilioSignature`, `packages/telephony-twilio/src/signature.ts`) before doing anything
else with the request:

- A missing `X-Twilio-Signature` header, an empty auth token, or a signature that doesn't match
  the HMAC-SHA1 computed from the reconstructed URL + sorted form params all return `false`.
- The comparison uses `crypto.timingSafeEqual`, not `===`, to avoid a timing side-channel on the
  signature check.
- **There is no "log a warning and continue" path.** A failed check returns HTTP `403` and the
  request is not processed further — the server never proceeds on a webhook it can't verify.

## SSRF-safe URL reconstruction

Twilio's signature is computed over the full webhook URL, which means whatever string is used as
that URL is trust-bearing. `@parley/server`'s answer-webhook handler
(`packages/server/src/request-handler.ts`) reconstructs that URL from a **configured host
allowlist** (`HostAllowlist`, populated from `PARLEY_PUBLIC_HOST` in the CLI's `serve` command) —
**never** from the request's `Host` header or `X-Forwarded-Host` alone. The allowlist check runs
_before_ signature verification: an unrecognized host is rejected with `403` immediately, and the
signature is never computed against an attacker-controlled URL. This closes the SSRF-adjacent
class of bug where a forwarded header is trusted as if it had been independently verified.

## The media WebSocket — an honesty note

**The media WebSocket is not per-message signed by Twilio.** Twilio Media Streams has no
message-level authentication scheme comparable to the answer webhook's HMAC signature — this is
a real gap in the underlying protocol, not a Parley oversight, and this document says so
explicitly rather than leaving a reader to assume the WS carries the same guarantee as the
webhook.

What actually protects `wss://HOST/media/{CallSid}` is the combination of three checks, all
enforced at HTTP-upgrade time, before any audio frame is accepted:

1. **An unguessable per-call path.** The URL segment is the Twilio `CallSid` for a call this
   server itself originated and is still tracking — not a static, discoverable endpoint.
2. **A `callId` that must match a pending session.** `packages/server/src/server.ts`'s `upgrade`
   handler and `packages/server/src/media-connection.ts`'s `handleMediaConnection` both require
   `pendingSessions.get(callId)` to return an entry; if the `CallSid` in the path doesn't match a
   call this server originated (and hasn't yet completed or been evicted), the socket is
   destroyed/closed and nothing attaches.
3. **The host-allowlist check on upgrade.** The same `HostAllowlist` used for the answer webhook
   also gates the WebSocket upgrade — the incoming `Host` header must be on the configured
   allowlist, or the raw socket is destroyed before the WebSocket handshake completes.

Together these mean an attacker would have to both know a live `CallSid` (a value never returned
to any caller other than the `/call` response itself) and reach the server on an allowlisted host,
within the narrow window before the call completes and the entry is evicted. A `CallSid` is not a
secret and is not redacted — `redactSecrets` (`packages/core/src/redaction.ts`) only matches key
names like `api_key`/`token`/`secret`/`password`/`authorization`, and `callId`/`CallSid` matches
none of those, so it would pass through unredacted if ever logged. Its protection here comes
entirely from the two checks above (the unguessable per-call path plus the required pending-session
match), not from log redaction. That is a materially weaker guarantee than cryptographic
per-message signing, and this document deliberately does not imply otherwise.

## The tool channel — bounded capability, constant-only results

Parley V1 had **two channels into the model and none out**: a `systemInstruction` sent once at
connect and immutable thereafter, plus one short opening trigger. That is still true of a call
that declares no `execution` block, and it is why `RealtimeSession` has never exposed a
general-purpose "send a turn" method.

A call that declares an `execution` block gets up to three tools — `press_digits`, `end_call`,
`record_outcome` — and it is worth being precise about what that does and does not change.

**What is unchanged.** `systemInstruction` is still sent exactly once and is still immutable for
the session's lifetime. There is still no code path that pushes a second privileged turn. A tool
call is the model _acting_, not the model being _instructed_.

**What is new, stated as a threat rather than as a feature.** Two things did not exist before.
First, an outbound capability: the model can now cause a real side effect on a live phone call.
Second, an inbound text channel: a tool _result_ is text the model reads, which is exactly the
shape a prompt injection wants. And with them comes a threat Parley did not previously have — **a
callee talking the model into pressing keys, or into hanging up before the task is done.** No
amount of prompt wording closes that, because the persuasion happens in the conversation the
prompt cannot see.

**The answer: the model proposes, the server disposes.** Every tool call is a _request_.
`ToolGate` (`packages/core/src/execution.ts`) decides it against the envelope's execution plane
before anything happens:

- a tool is declared **only** if its execution block is present, so an undeclared capability is
  not merely refused — it is invisible;
- `press_digits` is checked against `allowedDigits` and a whole-call `maxPresses` budget counted
  in individual keys;
- budget is charged **after** the carrier accepts, so a failed REST call cannot consume the
  model's ability to navigate;
- `end_call` can be gated behind `record_outcome`, and that refusal is **one-shot** — a model
  that cannot produce an outcome is never trapped on a live, billing call;
- `record_outcome` keeps only fields the envelope declared and silently drops the rest.

None of these limits is reachable by anything said on the call. A callee who succeeds completely
in persuading the model gets the declared budget and then refusals.

**Tool results are a fixed literal union.** Every value the server can return is a member of
`ToolResult` — `"ok"`, `"recorded"`, `"refused: press budget exhausted"`, and so on. No result is
ever built from a tool argument, a callee utterance, or an error message, so the new inbound
channel carries no attacker-influenced bytes. This is enforced twice: `sendToolResponse` takes
`ToolResult` as its parameter type, so the compiler rejects an interpolated string at every call
site, and `tool-gate.test.ts` asserts membership mechanically for every value the gate can
produce.

**The spend ceiling, said plainly: half of it is enforced and half of it cannot be.**

Agreeing to a price is speech. No server code makes a sentence unspoken, so the part of the
ceiling that governs what the model _says_ is a prose rail — `authority.spend` — and it is
advisory like every other sentence in the prompt. A live scenario matrix measured what that is
worth on its own: on three of four cells quoted 430 against a 250 ceiling, the model agreed and
recorded a **completed** call at 430.

The part that _can_ be enforced is what gets written down, and it now is.
`execution.spendCeiling` binds an outcome field to a hard limit, and `ToolGate.recordOutcome`
refuses — `"refused: that amount is above the limit for this call"` — rather than writing a record
that claims an unauthorised commitment. Nothing downstream acts on the conversation; it acts on
`record_outcome`. The refusal also reaches the model mid-call, which is the point at which it can
still defer and call back.

The two halves are required together. An envelope carrying `policy.authority.spend` and an
`execution.outcome` block is **rejected** without a matching `execution.spendCeiling`, and the two
limits must be equal — a ceiling the model is told is 250 while the server enforces 500 reads as
protection and is not.

Two limits stated rather than papered over. The gate reads **digits**: an amount written out in
words passes it, and the prose rail is the only thing covering that case. And a refused record is
still a call on which a price was verbally agreed — this bounds the record, not the conversation.

## Callable-number allowlist — fails closed

Every `POST /call` checks `brief.to` against a configured `NumberAllowlist`
(`createNumberAllowlist`, `packages/server/src/allowlist.ts`) before origination. The allowlist is
built from the `PARLEY_CALLABLE_NUMBERS` environment variable (comma-separated E.164 numbers); an
unset or empty value produces an **empty allowlist, which denies every number** — there is no
default-allow fallback. An unlisted `to` number gets a `403 { error: "number not permitted" }`
response and `CallSession.originate()` is never invoked. Numbers are normalized (`normalizeE164`)
before comparison so formatting differences (`(415) 555-0002` vs. `+14155550002`) don't cause a
false negative.

## Webhook host allowlist — fails closed, SSRF-safe

Described above under "SSRF-safe URL reconstruction" and reused verbatim for the media-stream
upgrade check. Like the number allowlist, it is an **injectable policy object**
(`createHostAllowlist`) populated from configuration (`PARLEY_PUBLIC_HOST`) rather than a
hardcoded default — the security decision stays explicit in the consumer's hands.

## Request-body size cap

`@parley/server`'s HTTP handler caps buffered request bodies at 64 KiB
(`MAX_BODY_BYTES`, `packages/server/src/server.ts`) before any authentication has happened —
Twilio's form-encoded webhook bodies are tiny, and call audio never rides the HTTP path (it's
carried entirely over the media WebSocket), so there is no legitimate reason for a `POST /call`
or `POST /twilio/answer` body to be large. A request that exceeds the cap gets `413` and the
connection is torn down without ever reaching the number/host/signature checks — an
unauthenticated caller can't use an oversized body to exhaust server memory.

## Secrets — environment-only, never logged, never in a CLI arg

`GEMINI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` are read
exclusively from `process.env` (see `packages/cli/src/cli.ts`'s `serve()`) — never accepted as a
CLI flag, never written into parsed-args, and never appear as a positional argument that could
show up in `ps` output or shell history. The repo ships only `.env.example` with placeholder
values; `.env` and `.env.*` are gitignored (with `.env.example` explicitly un-ignored so the
template itself stays tracked). `parley doctor` reports presence/absence of each required secret
(`"present"` / `"MISSING"`) and never prints an actual value.

`@parley/core` exports a redaction utility, `redactSecrets` (`packages/core/src/redaction.ts`),
that deep-walks an arbitrary value and replaces any object value whose key looks
secret-shaped (`apiKey`, `token`, `secret`, `password`, `authorization`, etc.) with `[redacted]`,
plus a companion `redactPhoneNumber` that masks all but the last four digits of an E.164 number.
Both are unit-tested and exported for any consumer that logs briefs, transcripts, or errors to
apply before writing. **As built in this milestone, `@parley/server` itself does not emit any
application log lines containing brief/transcript/secret content** — it has no logging
statements beyond the CLI's own status/usage output (`parley daemon listening on :PORT`, the
`doctor` presence report), neither of which touches a secret value. There is therefore nothing in
the shipped daemon today that redaction would need to intercept; the redaction utilities exist
and are ready for any logging a consumer adds (or a future milestone wires into the daemon
itself), and the guarantee to rely on for now is the narrower one: **the daemon logs nothing
containing a secret, because the daemon logs almost nothing at all.**

## No call-audio recording by default

Parley has no recording code path anywhere in `@parley/telephony-twilio` or `@parley/server` —
there is no Twilio `<Record>` verb generated, no recording REST call, and no audio persisted to
disk. `TranscriptEvent`s (text, from Gemini's `outputAudioTranscription`) are the only
call-content artifact `CallSession` produces; raw audio is bridged in memory frame-by-frame and
never written anywhere. Recording would be a deliberate, explicit addition a consumer would have
to build, not a default this library ships with or a flag that flips it on.

## No global mutable state

`pendingSessions` is an ordinary `Map` held as an instance field on the object `createParleyServer`
returns (`packages/server/src/pending-sessions.ts`), not a module-level singleton. The two
allowlists and the `TelephonyProvider`/`RealtimeProvider` instances are likewise ordinary objects
passed into `createParleyServer`'s config, not globals. Even though V1 supports only one
concurrent call, this discipline is what makes adding concurrency later additive engineering
rather than a rearchitecture, and it rules out cross-call state bleed from day one.

## Jurisdiction posture

Parley assembles a call's opening and self-identification from one of three `CallPolicy.identity`
styles (see `docs/prompt-guide.md`, `packages/policy/src/presets.ts`, and
`packages/policy/src/constants.ts`), each with a deliberately different amount of
self-identification, plus one guardrail that applies to all three:

- **`self`** (the `principalCall` preset — calling the principal themself) — no disclosure. The
  assistant presents as itself, first person, to the person it was configured by.
- **`onBehalf`** (the `representedCall` preset — the principal's professional network) — opens as
  _"Hi, this is [assistant], [principal]'s personal assistant, calling on their behalf about
  [purpose]."_ This discloses that the caller is a personal assistant; it does **not** volunteer
  that it is AI unless `disclosure.volunteer` is also set.
- **`silent`** (the `transactionalCall` preset — businesses, restaurants, customer support) — no
  self-identification and no introduction at all; goes straight to the task on the principal's
  behalf.

**Universal floor: honest if directly asked.** When `disclosure.honestIfAsked` is set (the default
for `representedCall`/`transactionalCall`), if the person on the call directly and unambiguously
asks whether they're talking to an AI, a bot, or a real person, the assistant answers honestly
(e.g. "I'm Alex's assistant — an AI assistant, actually") and continues the call. It never leads
with this disclosure and never denies it if asked. This is enforced as a composed guardrail
sentence (`honestIfAsked()`, `packages/policy/src/constants.ts`), not left to model discretion.

**Legal reasoning (documented, deliberate).** An earlier revision of this design made AI
disclosure mandatory for every third-party call, citing California's bot-disclosure statute (the
B.O.T. Act) and the state's all-party-consent recording law. This was deliberately narrowed to the
honest-if-asked floor above, on the following reasoning — the operator's call to make for his own
assistant:

- The B.O.T. Act narrowly targets bots used to _incentivize a commercial transaction with, or
  influence the vote of,_ the person being called. A scheduling, reservation, or logistics call
  placed on the operator's behalf is generally not that use case.
- California's all-party-consent law governs **recording** a call, not merely disclosing that a
  participant is an AI. Parley records no audio anywhere in `@parley/telephony-twilio` or
  `@parley/server` (see "No call-audio recording by default" above) — the recording-consent
  concern this posture would otherwise need to address is moot for Parley as built.

A deployer in a different jurisdiction, or with a different risk tolerance, can still tighten this
(e.g. force a disclosure line into any mode's guardrail set) — the mode/floor split above is
explicit enough that doing so is a conscious policy choice, not something silently assumed by the
library.
