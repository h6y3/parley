# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-10-01

A call can now choose its own realtime settings, the callable-numbers allowlist can change without a
restart, and a new package tests Parley over the real phone network against a simulated callee.

### Added

- **Per-call realtime settings in `execution.realtime`.** Besides `provider`, an envelope may now
  set `think` (the Deepgram agent's language model), `voice`, `speed` (0.7–1.5, Deepgram) and
  `expressivity` (an integer from -2 to 2, Deepgram's Beta `agent.speak.provider.expressivity`),
  each overriding the daemon's default for that call only. The envelope schema checks shape; the
  daemon checks each name against lists the provider packages now export (`DEEPGRAM_THINK_MODELS`,
  `DEEPGRAM_VOICES`, `GEMINI_VOICES`) and refuses an unknown value, or a setting the chosen
  provider does not take (`think`, `speed` or `expressivity` on Gemini), with `400` before
  dialling. `RealtimeConnectParams` gains `settings: { think?, speed?, expressivity? }`, which the
  Deepgram provider applies to that session without changing its configured defaults. The call
  record's `realtime` becomes `{ provider, model, voice?, speed?, expressivity? }`: `model` is the
  effective model and the other three appear only when chosen (`schema/meeting-record.schema.json`
  gains them as optional). An envelope naming only `provider` connects and records exactly as
  before. See `docs/configuration.md`, "Per-call realtime settings".
- **Callable-numbers file re-read per call.** `PARLEY_CALLABLE_NUMBERS_FILE` names a file of extra
  callable numbers (one E.164 per line, `#` comments), read on every call so numbers can be added
  or removed without restarting the daemon. A missing or unreadable file adds no numbers and warns
  once per distinct error. `PARLEY_CALLABLE_NUMBERS` still applies; the allowlist remains a typo
  guard, not access control (`PARLEY_CALL_TOKEN` is).
- **`@parley/phone-test`: phone test campaigns.** A new package that places real calls from a
  running daemon to a simulated callee on a temporary Twilio number and scores them, with no
  person on the line. Phone scenarios (`packages/phone-test/scenarios/`) hold a Parley job, the
  callee personas and the expected outcome; configuration files (`packages/phone-test/configs/`)
  name the per-call realtime settings to compare. Each call is scored on its outcome (typed codes
  read from the call record), its timing (a per-channel energy VAD over the stereo capture:
  `slow-response`, `spoke-before-callee`, `talk-over`, `slow-barge-in`, `talked-after-goodbye`,
  `dead-air`, thresholds in `configs/thresholds.json`) and, optionally, a pairwise Gemini audio
  judge run in both orders. The report gives failure rates per code, response-gap percentiles,
  judge win rates and cost, picks finalists against the Gemini reference by a fixed rule, copies
  the best recordings and writes a blind listening pack for checking the judge. See
  `docs/phone-testing.md`.
- **`parley sim serve`.** The simulated callee: answers the test number's Twilio webhook on
  `127.0.0.1:3340` under `/sim/`, verifies Twilio signatures against `PARLEY_PUBLIC_HOST`, rejects
  every caller but the daemon's number (`--caller`, else `TWILIO_FROM_NUMBER`), plays
  the registered persona through the realtime provider not under test, and records a stereo WAV
  (agent as heard, callee) with a timeline. Its control API (`/control/*`) is loopback-only.
- **`parley campaign start|run|stop|status`.** `start` refuses on an existing campaign, a spent
  monthly budget or a Twilio trial account, then buys one US local number, adds it to
  `PARLEY_CALLABLE_NUMBERS_FILE` and starts the sim; `run` places calls serially, refusing any
  number but the campaign's and any call whose worst case would exceed the budget (`--budget`,
  default $50 a month), and books each call's estimated cost; `stop` is idempotent and safe after
  a crash — it releases the number, removes it from the file, stops the sim and clears the state;
  `status` shows the campaign, its age and the month's spend. State and spend live in
  `~/.config/parley/` (`test-campaign.json`, `test-spend.jsonl`, mode 600). Secrets come from the
  environment only.

### Fixed

- **A missed greeting no longer leaves a two-party call silent.** If the far end has spoken, in
  speech that began within the first 10 s of the call (`NUDGE_OPENING_WINDOW_MS`), and the model
  has produced no audio, text or tool call within 2.5 s of the end of that speech
  (`MISSED_GREETING_NUDGE_MS`; far-end speech starting again holds the window until its
  transcript), `CallSession` now sends the short `CALL_ANSWERED_CUE` once through
  `sendOpeningTrigger` (planned as `OpeningPlan.answeredCue` for a two-party `"prompt"` opening
  only, never a meeting, a call that declares `execution.ivr` (a menu can pause longer than the
  window) or one the carrier says a machine answered; logged as `missed greeting: opening re-sent at +Nms`), because on live
  calls since 0.4.1 put the opening in the prompt, a greeting the model missed — one transcript
  held only "de Sesame" — left the agent with no turn at all until the callee said hello again or
  the silence cap ended the call.

### Known issues

- **Deepgram Voice Agent can stay silent for a whole call.** In a 32-call phone-test campaign, the
  Deepgram agent produced no speech in roughly one call in four with a realistic callee, across the
  `gpt-4o-mini`, `claude-haiku-4-5` and `claude-sonnet-4-6` think models: the think stage reports
  output, but no audio follows, even after the missed-greeting cue. Gemini is the default provider;
  use Deepgram per call only for comparison until this is understood.
- **A greeting that arrives before the realtime session is ready may not be transcribed**, and the
  missed-greeting cue only arms on a far-end transcript, so such a call still waits for the callee
  to speak again.
- **The phone-test harness cannot yet verify phone-menu navigation:** the carrier does not report
  the agent's in-band keypad tones to the simulated callee, so a menu persona never advances.

### Upgrading

No action is required for a client that sends `execution.realtime` with `provider` alone and
reads call records leniently. Otherwise:

- **Envelopes may now carry realtime settings.** `execution.realtime` accepts `think`, `voice`,
  `speed` and `expressivity` besides `provider`. A client that validates envelopes against its own
  copy of the schema must accept the new optional fields; a value outside the provider's lists, or
  a setting the chosen provider does not take, is refused with `400` before dialling.
- **The record's `realtime` carries the effective settings.** It is now
  `{ provider, model, voice?, speed?, expressivity? }`, with `model` the effective model (a
  per-call `think` when chosen). A strict consumer that rejects unknown record fields must accept
  the three optional ones (`schema/meeting-record.schema.json` declares them).
- **New optional environment variable `PARLEY_CALLABLE_NUMBERS_FILE`** on the daemon: a file of
  extra callable numbers, re-read on every call. Unset keeps today's behaviour. The variable itself
  is read at startup: **set it, then restart the daemon once**; after that, edits to the file need
  no restart. Phone campaigns
  also read `PARLEY_DAEMON_URL` (required by `campaign run`, no default there) and
  `PARLEY_CALL_RECORDS` (defaults to `PARLEY_CALL_RECORDS_PATH`), and optionally
  `PARLEY_TEST_OUT_DIR` (where reports go; default `./parley-tests/<campaign>/`).
- **New package and commands.** `@parley/phone-test` and the `parley sim` / `parley campaign`
  commands are additive; nothing runs unless invoked. A campaign needs a non-trial Twilio account,
  `TWILIO_FROM_NUMBER` in the campaign's environment (the daemon's own caller number),
  `PARLEY_CALLABLE_NUMBERS_FILE` set on the daemon, and a public route from
  `https://<public host>/sim/*` to `127.0.0.1:3340` (`docs/phone-testing.md`).
- **Every package is now 0.5.0**, in lockstep.

## [0.4.1] — 2026-10-01

A call whose outcome asks who confirmed the arrangement now asks the person's name once, and a
role is no longer accepted in its place.

### Added

- **`realtimeClose: { code, reason }` on the call record, when the realtime session closes
  unasked.** Live, Gemini 3.8: prepaid credits ran out and the session closed with code 1011 ("Your
  prepayment credits are depleted…") one to two seconds after pickup. The daemon log had it; the
  call record showed only a two-second call, so the client could not tell the user why.
  `RealtimeProviderCallbacks.onClose` gains an optional second argument `{ code?, reason? }`, which
  both shipped providers fill. Gemini reports every unasked close, including one during connect;
  Deepgram reports one only once the session is up — a close before `SettingsApplied` (a key or
  credit refusal at setup) still rejects `connect` instead, and leaves no `realtimeClose`.
  `CallSession` records it only when the close is not the consent handoff and not Parley's own end
  (`endCall` has already settled), redacts the reason (`+` numbers and any bare run of ten or more
  digits; `key=`/`token=`/`Bearer` text; bare Google `AIza…` keys, `sk-…` keys, GitHub `gh[pousr]_…`
  tokens and long mixed letter-and-digit runs) and caps it at 300 characters. The call ends
  `endedBy: "error"` alongside, as before. The field is absent on every other call, ordinary and
  meeting records alike (`schema/meeting-record.schema.json` gains it as optional).

### Changed

- **`record_outcome`'s description asks for a name when an outcome field needs one.** When a
  declared field asks who confirmed the arrangement (`@parley/core` `isWhoConfirmedField`), the
  description tells the model to ask once, before it records, who it is speaking with ("And who am I
  speaking with?"), and to leave the field empty if they will not say. Calls without such a field
  read exactly what they read before. No recap is asked for. The field is recognised by its NAME:
  `confirmedBy` / `confirmed_by`, `contactName`, `contactPerson`, `spokeWith`, `spokeTo`,
  `speakingWith`, `personName`, `staffName`, `agentName`, `representativeName`, `nameOfPerson`; a
  name that only might be a person (`contact`, `rep`, `agreedWith`) also needs its description to
  say "confirmed by", "who … confirmed", "speaking with" / "spoke to" or "name of the person". A
  description never decides alone, and a name containing date, time, day, amount, price, cost, fee,
  number, id, notes, comment, summary or details never matches — so "Delivery date as confirmed by
  the store" (`deliveryDate`) and "Anything the person you spoke with mentioned" (`notes`) are left
  alone.
- **Gemini two-party calls take the opening in the prompt, as Deepgram does.** The opening
  instruction is appended to the one-time system instruction and nothing is sent at connect, so
  the far end's own voice — a person, a voicemail greeting, an IVR menu — is the model's first
  input. Sent as its own turn at connect, it was a turn the model answered: offline (Gemini 3.8),
  with 3 s of line hiss before the callee's "hello", the model spoke before the callee in 9 of 18
  runs, against 0 of 72 with the opening in the prompt; end-of-hello to first audio also fell
  (median 1566 → 1316 ms, p90 1871 → 1399). Gemini meetings are unchanged, byte for byte:
  `MEETING_OPENING_TRIGGER` still goes as its own turn. `RealtimeProvider.openingDelivery` (and
  `ScenarioTransport.openingDelivery`) may now be declared per call shape,
  `{ twoParty, meeting }` (`OpeningDeliveryByShape`, exported from `@parley/core`), and
  `planOpening` accepts either form; Gemini declares `{ twoParty: "prompt", meeting: "turn" }`.
- **The date list names the year on days in a later year.** Across a year boundary the 14-day list
  reads "Thu Dec 31, Fri Jan 1 2027, Sat Jan 2 2027, ..." (today's own `YYYY-MM-DD` already carries
  the year); a list within one year is unchanged.
- **The harness `preview` command shows where the opening really goes.** On a two-party call
  (both shipped providers) the opening is part of the system instruction and nothing is sent at
  connect, so the preview prints `openingTrigger: (none ...)` instead of a separate opening turn;
  a meeting envelope still shows its trigger as its own turn.
- **The confirmation refusal ends "— without mentioning this".** Scenario matrix, Gemini 3.8:
  after `record_outcome` was refused for want of the callee's yes, the model said aloud "I'm
  sorry, I understand I need to wait for you to confirm the arrangement before proceeding." The
  literal is now "refused: they have not confirmed what you just said — read the arrangement back
  exactly as they said it, wait for their yes, then record; do not end the call — without
  mentioning this", matching the end_call refusal's "without mentioning it". The role refusal
  above carries the same ending.

- **The deferral rule's go-ahead never covers money or authority.** Scenario matrix, Gemini 3.8:
  quoted $430 against an authorised ceiling of $250, the model said "I do not have that
  information… Can we still proceed with booking the visit?" — the deferral rule's own "ask whether
  they can still go ahead without it" — and booked, recording `completed` with the amount empty.
  `deferralRule` now continues, after "not a reason to stop.": "This never covers a price, fee or
  commitment beyond what you are authorised to agree to — for those, do not go ahead; say you will
  confirm with ${principalName} and call back." This is a prompt rule only, and a model may still
  slip: nothing in code refuses a `completed` record with the amount left empty. The record's
  amount check applies only when the call sets a `spendCeiling`, and only to an amount written in
  that field.

- **The committed harness scenarios model the 0.4.1 call.** Lines that are not replies (a hold
  ending, a transfer picking up, a menu after its greeting, a queue message) carry
  `unpromptedAfterMs`. Every press gate names the key a correct model presses, `0` on the
  no-matching-option cells. Offers are dated for `--today 2026-10-01`. Every cell that settles an
  arrangement declares `params.agreement` and has a callee line that agrees in plain words. The
  reference also scores a `confirmedBy` name. The over-ceiling cells expect `partial` and book
  nothing. A matrix from before this change is not comparable with one after it. See
  `docs/scenario-authoring.md`, "It happened: the 0.4.1 refit".

### Fixed

- **A completed record made straight after the callee's offer is refused.** Scenario matrix,
  Gemini 3.8, 4–6 of 43 model-ended runs: the callee offered "We have an opening this Thursday
  between 1:00 PM and 4:00 PM that I can reserve for you.", the model recorded `completed` before
  saying a word, ended the call, and only then said "Thank you, that works perfectly. Goodbye."
  The existing rule (refuse when the model has spoken since the far end last did) cannot see a
  record made before the model speaks. `ToolGate` now also refuses a `completed` record on a
  two-party call, once per call, when the far end's words since the model last spoke carry no
  agreement signal — a case-insensitive whole-word match against `AGREEMENT_SIGNALS` ("yes",
  "okay", "that works", "sounds good", "you're all set", "booked", "reserved", …; "I can
  reserve" does not match, and "not sure" or "fully booked" are struck out first). The refusal is
  the existing confirmation literal, and the refused record is stored as `partial` first (fields
  kept), so a call that ends there keeps an honest outcome; a later accepted record replaces it.
  "Mm-hmm", "uh-huh", "that's fine", "that'll work" and "rescheduled" count as agreement; "we're
  booked", "can't say yes" and a yes inside a question do not. It is one-shot, so a yes the list misses costs one extra
  read-back and never traps the model; it is also spent once it has passed, so a record refused
  later for a role or an amount is not asked for a second yes. When the far end's latest words are
  the answer to "who am I speaking with?" — they hold the record's who-confirmed name ("Sam.") —
  the agreement is read from the words just before them as well, so "Yes, Monday at 9:26 works." —
  "Sam." is accepted while "We have Thursday 1 to 4." — "Sam here." is still refused. `partial`, `failed` and meetings
  are not gated. `ToolGate.noteCallerSpeech` now takes the far end's text and whether it is final:
  Gemini's non-final fragments are joined as they came, Deepgram's (and the harness's scripted
  lines') whole utterances with a space between.
- **A role is never recorded where a person's name belongs.** Live, Gemini 3.8: on several calls
  whose job declared `confirmedBy` ("Who at the office confirmed it"), the model never asked and
  recorded "receptionist" or "Receptionist". `ToolGate.recordOutcome` now stores a who-confirmed
  value made only of role or placeholder words ("the receptionist", "front desk staff", "N/A", "the
  person I'm speaking with") as an
  empty field. On a `completed` record it also answers, once, with a new `ToolResult`, "refused:
  that is a role, not a name — ask who you are speaking with, or leave it empty if they will not say
  — without mentioning this". The record is written before that refusal (every other field as given,
  the name empty), so it satisfies `end_call`'s record-first rule, and a call that ends before the
  model records again keeps the booking; a later record replaces it. A `partial` or `failed` record
  (a voicemail, say) is blanked and accepted with no refusal, so the model is never told to ask "who
  am I speaking with?" into a recording. An empty value and any value carrying a name ("Sam", "Dr.
  Patel", "Sam at the front desk") are accepted; no other field is affected. The refusal is
  one-shot, so it cannot loop.
- **The harness tells the model today in `PARLEY_TIMEZONE`.** The payload preview, scenario runs
  and the `--today` pin used the host zone whatever the daemon was configured with; they now use
  `PARLEY_TIMEZONE` when set (an invalid name fails as it does at daemon boot), else the host
  zone. `resolveTimeZone` moved to `@parley/core`; `@parley/cli` still exports it.
- **The date in the date sentence no longer depends on ICU's `en-CA` locale.** It is read by part
  (`formatToParts`) in the call's zone; `@parley/core` exports `isoDate(now, timeZone)`.

### Upgrading

No action required beyond this: a consumer that switches on `ToolResult` gains one literal (the
role refusal — which, unlike the other refusals, follows a record that WAS written, name empty), and must match the confirmation refusal by its new text — it now ends "— without
mentioning this". Code that drives `ToolGate` directly must pass the far end's words to
`noteCallerSpeech(text, isFinal)`; with no words the agreement check sees no yes. Scenario scripts
whose confirming line agrees without an agreement word will show one extra confirmation turn.

A `completed` record refused for want of the callee's confirmation is now stored as `partial`
(fields as given, a who-confirmed role blanked) before the refusal is returned, so a call that ends
during the read-back reports `partial` rather than no outcome, and `end_call` accepts it as the
record. Treat that `partial` as "arranged, not confirmed". A spend-ceiling amount written as a
range (`$150-$200`, `150 to 200`) is now held to its high end, and `$1,250` reads as 1250.

The composed prompt changes wherever the deferral rule is on: a client that keeps a snapshot of
the composed rails, or pins the prompt byte for byte, must regenerate it.

A custom `RealtimeProvider` may pass `{ code, reason }` as `onClose`'s second argument; without it, the
record carries code `0` and the prose reason.

Code that reads `RealtimeProvider.openingDelivery` or `ScenarioTransport.openingDelivery` as a
string must accept the `{ twoParty, meeting }` form too; pass it to `planOpening` rather than
resolving it by hand. A Gemini scenario matrix from before this release ran two-party scenarios
with the trigger as a turn, so expect its ring-time codes (`spoke-before-callee`) to move when
compared against one after.

## [0.4.0] — 2026-10-01

Realtime provider parity: Deepgram Voice Agent is now a supported, selectable speaking-plane
provider alongside Gemini Live, a call can choose between them, and the audio contract that made
that impossible is replaced. Breaking for anyone who implements a provider or embeds
`CallSession` / `createParleyServer` directly. A daemon run through `parley serve` with an
unchanged environment keeps its configuration, but its calls are not identical to before. The
default Gemini model changed. Every call's system instruction now ends with a date sentence. The
`end_call` description every model reads is longer. A hangup or consent handoff now waits for the
words the model speaks after a tool answer. See **Upgrading**.

### Added

- **`--realtime-provider deepgram` is supported.** It was refused (the flag threw) because
  `CallSession` hard-coded Gemini's audio formats. `parley serve` now builds every realtime
  provider whose key is set, so a deployment keyed for both offers both; the flag only picks the
  daemon's default (still `gemini`).
- **`execution.realtime.provider`** (`"gemini" | "deepgram"`, requires envelope `version: 2`)
  chooses the provider for one call. It names a provider, never a model. A daemon that has not
  built the named provider answers `503` rather than falling back; a call whose maximum speaking-plane
  lifetime exceeds the chosen provider's declared `maxSessionSeconds` answers `422` (a guard: no
  valid envelope trips it with today's providers). Both happen before
  dialling and before a retry attempt is consumed.
- **Deepgram speak speed**, default `1.25`: `speed` on `createDeepgramRealtimeProvider`
  (`DEFAULT_DEEPGRAM_SPEED`, range 0.7 to 1.5, rejected at construction outside it) and
  `PARLEY_DEEPGRAM_SPEED` for the daemon. Deepgram's default pace was too slow on live calls
  (about 119 words a minute; a 29-word reply took 14.6 s), and 1.25 was chosen by ear on live
  calls (1.4 and 1.45 sounded too fast over a whole conversation).
- **`brief.keyterms`**: up to 20 recognition hints (a name the listener would mishear), passed to
  the provider and never rendered into the system instruction.
- **Call record `realtime { provider, model }` and `firstModelAudioMs`**, also on the meeting
  record and `schema/meeting-record.schema.json` (additive, optional).
- **Environment variables** `PARLEY_GEMINI_MODEL`, `PARLEY_DEEPGRAM_THINK_PROVIDER`,
  `PARLEY_DEEPGRAM_THINK_MODEL`, `PARLEY_DEEPGRAM_LISTEN_MODEL`, `PARLEY_DEEPGRAM_VOICE`.
- **Harness** `--realtime-provider gemini|deepgram` on `reliability`, `scenario` and
  `metamorphic`; `--think-model` for Deepgram; `--first-line-delay-ms` on `scenario` and
  `metamorphic` (a ring before pickup); `--today <YYYY-MM-DD>` on `reliability`, `scenario` and
  `metamorphic`, pinning the date the model is told so a script naming a weekday scores the same
  on any day (default: the wall clock, as before); failure codes `spoke-before-callee` and
  `transport-closed`. One conformance suite and a `CallSession` invariant suite now run against
  every provider.
- **`RealtimeSessionCallbacks.onDiagnostic`** (optional): transport facts for the operator's log,
  never call content.
- **A call's timeline in the log.** `CallSession` writes one content-free diagnostic per routed
  tool call (`tool record_outcome → recorded at +1200ms`: the tool, the kind of answer up to its
  first " —", and ms since the session started), plus `model turn complete at +…ms` and
  `caller final at +…ms`. Never arguments, never what anyone said.
- `@parley/core` exports `OpeningDelivery`, `planOpening` and `MEETING_CONNECTED_CUE` — the one
  place a call's opening is decided, for `CallSession` and the harness alike — and `withOpening`,
  the one place the rendered brief and a prompt-delivered opening are joined into the prompt a
  connect sends.
- **`RealtimeProvider.continuesAfterToolResponse`** (required): whether the model goes on speaking
  after a tool answer. Both shipped providers declare `true`.
- `@parley/audio` exports `canConvert`, sharing `convert`'s path table; `@parley/realtime-gemini`
  exports `geminiFunctionDeclarations`.
- The model is told today's date. `renderSystemInstruction` takes an optional `today` and appends
  one Parley-authored sentence ("Today is Wednesday, 2026-09-30 (America/Los_Angeles). When the
  other person gives a relative date such as ...") so it can turn "next Tuesday" into the ISO date
  the outcome schema requires. `CallSession` computes it once at connect from its clock and the new
  optional `CallSessionParams.timeZone`; the daemon reads it from `PARLEY_TIMEZONE` (optional IANA
  name, defaulting to the host's zone; an invalid name fails boot), via `ServerDeps.timeZone`. The
  harness scenario runner and payload preview send the same sentence. Without `today` the rendered
  output is byte-identical to before.

### Changed

- **A gap in the brief no longer ends the task by itself.** When asked something the brief does not
  cover, the model says it will follow up, then asks whether they can still go ahead without it; if
  they can, it gets as much done as it can and the gap becomes a follow-up item. Only a gap that
  actually stops them acting makes the arrangement unfinished (the deferral and wrap-up rails).
- **Default Gemini model is `gemini-3.8-live`** (was `gemini-3.1-flash-live-preview`). Every tool
  is declared `BLOCKING`, which 3.8 needs to keep request/response tool semantics (its default is
  non-blocking). `GoAway` and `interaction_status` are logged as diagnostics.
- **Deepgram provider** is production-grade: Flux listening (`flux-general-en`), speak voice
  `flux-kelsey-en` (Flux voices declare speak `version: "v2"`, Aura voices `"v1"`, any other voice
  none; Kit was tried and was harder to understand at speed), `mulaw@8000` both ways with no
  conversion, `mip_opt_out: true`, a two-hour `maxSessionSeconds`, and a default think model of
  `gpt-4o-mini` on Deepgram's managed `open_ai` provider: the model Deepgram's own telephony
  reference agents use, in the Standard pricing tier ($0.075 a minute against $0.163 for the
  Advanced tier), measured at about 0.5 to 0.96 s from callee text to first audio against about
  1.15 to 1.77 s for `claude-sonnet-4-6`.
- The Deepgram provider takes `think: { provider, model }` (was `llmModel`), plus `listenModel`,
  `voice` and `settingsTimeoutMs`.
- The public docs, decision record (`docs/decisions/2026-08-19-voice-agent-spike.md`) and README
  describe Deepgram as supported. Making it the default is still open: it needs the live A/B the
  decision record names.
- Reframed the public documentation around Parley's actual product boundary: a one-shot
  voice-agent harness for bounded calls, rather than a voice connection or generic bot. The README
  now leads with the call contract, capability gate, structured evidence, retry lineage, and
  offline-to-live validation loop; the getting-started, architecture, agent-setup, security, and
  package metadata use the same nomenclature.
- Added `@parley/meeting-browser` to the README package inventory, which had fallen behind the
  workspace after the package was introduced.
- **`end_call` now says when not to end.** Its description gains: never call this while waiting
  for the other side (after a keypress, on hold or being transferred, before anyone has
  answered); having recorded an outcome is not a reason to end; once they have said goodbye, ask
  nothing further, record, and end. In billed runs one model called `end_call` about 2 s after
  pressing a key, and another kept asking questions after the callee said goodbye. Every provider
  receives the same declarations, so Gemini's behaviour may move too; re-measure it.
- **The closing rail closes once.** It asked the model to "confirm the single key outcome in one
  short sentence, thank them and say goodbye"; on live calls that produced re-confirmations of
  details the callee had already agreed and a scripted recap. It now reads: when the purpose is
  settled, check once whether they need anything else from you to act on it, then record the
  outcome, say one short goodbye, and end the call; do not ask them to re-confirm details they
  have already confirmed, and do not recap settled details back to them. The follow-up sentences
  for what the brief does not cover are unchanged. The rail opens with "Nothing is settled until
  they have agreed to a specific arrangement in their own words; their offer or your proposal is
  not agreement — accept it, let them confirm, then close", because on a live call the model
  recorded the outcome and hung up in the turn the callee only offered a time.
- **`record_outcome` and `end_call` answers say what happens next.** Every tool answer starts a
  spoken turn, and a bare `"recorded"` or `"ok"` gave the model nothing to do with it, so live
  calls spent each one on another thank-you or a second goodbye. On a call that declares
  `end_call`, `record_outcome` answers `"recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call"` (without `end_call` it
  answers `"recorded"`). An accepted `end_call` answers `"ok — say nothing more"`. A refused first `end_call` (no outcome yet) answers `"refused: record the outcome first
— call record_outcome now without mentioning it"`, so the model does not narrate the refusal
  aloud. These are new members of the closed `ToolResult` union; every other tool's `"ok"` is
  unchanged.
- **A `completed` record needs the other side to have spoken since the model did.** On a
  two-party call `record_outcome` with status `completed` is refused when the model has produced
  audio since the far end last spoke (or before the far end has said anything), with
  `"refused: they have not confirmed what you just said — read the arrangement back exactly as they said it, wait for their yes, then record; do not end the call"`.
  `partial` and `failed` are never held to it, meetings are not gated, and a refusal records
  nothing. On a live Gemini 3.8 call the callee offered "Monday at 9:26 a.m." and the model, in
  one turn, accepted, restated it as 9:30, said goodbye, recorded `completed` at 9:30 and hung
  up; three prompt-level fixes had not stopped that shape, so it is enforced in `ToolGate`.
  `CallSession` feeds it model audio frames and every non-empty far-end transcript (Gemini never
  marks its input transcription final), and `end_call`'s refusal is still one-shot, so a model
  that never gets its confirmation can still hang up. The scenario runner feeds the same gate:
  each delivered line is far-end speech, and transports raise a new optional
  `ScenarioTransport` `on.modelAudio()` (both built-in transports do).
- **The date sentence lists the next 14 days.** Told only today's weekday and date, a model on
  live calls resolved "next Tuesday" to the wrong day. The sentence now ends "The next 14 days
  are: Thu Oct 1, Fri Oct 2, …", the 14 calendar days after today in the call's zone, computed
  without depending on the host's locale. It ends "When you say a date, use the weekday and date
  together exactly as listed." (a live call said "Tuesday, October 8th" for a Thursday).
- **`CallSession.resolveSystemInstruction()` returns the full prompt the call sends**, including
  the opening on a `"prompt"`-delivery provider. It used to return the rendered brief alone.
- **`CallSession.audioBridgeStats` is `{ inbound, outbound, listening }`**, each
  `{ conversions, passThroughs }`, one per bridge. It was a single `{ conversions, passThroughs }`
  for the listening plane.
- **Waiting for a model turn to finish is bounded by idle time.** The four-second cap on a hangup's
  or consent handoff's wait now restarts on every model audio frame. A 15-second ceiling from the
  start of the wait bounds the total. `CONSENT_HANDOFF_MAX_MS` is derived from that ceiling (now
  30 s, was 19 s), so the `422` lifetime guard allows for it.
- **Harness Layer 1 (`reliability`) scores differently from 0.3.x.** A turn ends on the reliability
  runner's own turn end, with 2.5 s of trailing silence (`RELIABILITY_TRAILING_SILENCE_MS`). The
  disclosure check follows the represented-call disclosure rule. A turn with no spoken reply is
  dirty with the new `no-reply` code. Layer 1 numbers from 0.4.0 are not comparable with earlier
  versions; re-baseline before reading a trend across the upgrade.

### Fixed

- **Deepgram latency is logged.** The diagnostic keyed on `AgentStartedSpeaking`, which the current
  Voice Agent API never sends; it now logs `deepgram latency <field>=<ms>ms` for each `LatencyReport`.
- **A model turn opens on its first audio**, not only its first transcript, so `end_call` waits for
  the goodbye even when the transcript has not arrived.
- **A hangup no longer cuts off the goodbye the model speaks after `end_call`.** On both vendors
  the tool call arrives first, and the goodbye is spoken in the turn that continues after the tool
  answer. On Deepgram's wire it started about 190 ms after the answer and ran 6.7 s. With no turn
  open when the call arrived, `CallSession` drained an empty queue and hung up over the whole
  goodbye. The consent handoff retired the speaking plane over the acknowledgment the same way. An
  answered tool call on a provider declaring `continuesAfterToolResponse` now opens a model turn,
  and the hangup or handoff waits for that turn to end before draining.
- **After `end_call`, the callee no longer hears the model narrate the call.** On a live Gemini
  call the model said "Thank you very much. Goodbye." after `end_call` and then "I have
  successfully rescheduled the appointment." — a report meant for the principal. Once `end_call`
  is accepted on a provider declaring `continuesAfterToolResponse`, `CallSession` stops forwarding
  model audio once a completed sentence containing "bye" (bye, goodbye, bye-bye) has been spoken,
  and goes straight to drain and hangup without waiting for the turn to end. The transcript leads
  its audio (0.7–1.1 s measured on Gemini), so the goodbye is held for 1.5 s of audio after its
  words arrive, or 90 ms a character of its sentence if longer. With no goodbye, audio stops after
  3 s of it. Each stop logs `after end_call: stopped at goodbye|3000 ms cap at +<ms>ms`.
- **Deepgram no longer reports the meeting cue as participant speech.** Deepgram echoes every
  `InjectUserMessage` back as user `ConversationText`, so `MEETING_CONNECTED_CUE` reached the
  transcript and the pre-consent buffer as something a participant said. The provider now drops
  the first user utterance that matches each line it injected, and logs a content-free diagnostic.
- A Deepgram vendor `Error` that arrives after the handshake has already failed no longer reports
  a fatal error. `connect` has already rejected by then.
- `examples/express-minimal` answers an audio contract that cannot be bridged with `503`, as
  `@parley/server` does, instead of an unhandled rejection.
- **Deepgram takes the opening in its prompt.** It was sent as `InjectAgentMessage`, which Deepgram
  speaks verbatim: the callee would have heard the private instruction read aloud. Sent instead as
  an `InjectUserMessage`, its model heard it as the callee speaking — in billed text-mode runs one
  model hung up during the ring and another said "I'm listening and waiting for the other end to
  speak" aloud on every run. The provider now declares `openingDelivery: "prompt"`: the opening
  trigger is appended to the one-time `Settings` prompt, a two-party call injects nothing, and a
  meeting sends one short Parley-authored cue (`MEETING_CONNECTED_CUE`). Gemini's opening is
  unchanged. The harness scenario and reliability runners plan the opening through the same
  `planOpening` helper as `CallSession`, so a Deepgram matrix run measures what a Deepgram call
  sends.
- **Deepgram handshake and turns.** `connect` waits for `SettingsApplied` (bounded by
  `settingsTimeoutMs`). A turn is complete once an `AgentAudioDone` has been followed by the quiet
  window described below, so drains, consent handoff and the meeting `never_joined`
  classification see it. Vendor `Error` / `Warning` messages surface;
  server-side (`client_side: false`) function calls are not answered by the client.
- **A Deepgram turn is complete only when its audio stops, so the hang-up no longer clips a
  goodbye.** Deepgram can send an `AgentAudioDone` and then more audio of the same reply: in one
  billed session, `end_call`, an `AgentAudioDone`, about 1.3 s more speech, then a second
  `AgentAudioDone`. The farewell waited for the first turn end and then drained only the audio
  already queued, so the rest was cut off. The provider now reports the turn complete once an
  `AgentAudioDone` has been followed by `DEEPGRAM_TURN_QUIET_MS` (300 ms) with no agent audio; audio
  inside that window cancels it and the next `AgentAudioDone` re-arms it. The same turn end drives
  the consent handoff's drain and `modelTurnsCompleted`. The harness Deepgram transport uses the
  same helper (`createDeepgramTurnCompletion`, exported from `@parley/realtime-deepgram`), so a
  matrix scores the boundary a call hangs up on. Gemini is unchanged. The early
  `AgentAudioDone` was also seen right after `press_digits` (two cases at about 4.46 s), not only
  on goodbyes, so the quiet window also changes post-press timing; bear that in mind when reading
  a Deepgram matrix.
- Harness runs a session that dies mid-run as a scored `transport-closed` run, a refused Deepgram
  line ends the run, and a Gemini session refused during setup is a configuration error.
- **Harness `scenario` at the default `--first-line-delay-ms 0` no longer stalls on a silent
  model.** The first callee line waited on the model's first completed turn, and a model obeying
  the opening trigger takes none: Gemini sends no `turnComplete` for it, so 8 of 10 runs of one
  batch ended `stalled` before "Hello." went out. `0` is now a ring of zero (the first line goes out
  right after the trigger). Runs at `0` before and after this measure different openings.
- **Harness scoring could pass an invented or premature outcome.** A scenario can now declare
  `params.agreement` (`confirmTurn`, and per outcome field the forms a value may take). A
  `completed` record made before the callee's agreeing line fails `premature-record`, and a
  recorded value matching none of the forms fails `unsupported-outcome`. Tool calls carry
  `turnsDelivered`, and the trace's `tool-call` events carry the model's arguments, so a
  transcript file shows what each `record_outcome` claimed.

### Upgrading

Breaking changes, for code that implements or embeds these interfaces:

- **`RealtimeProvider.audio` is required**: `{ accepts: readonly AudioEncoding[]; emits: AudioEncoding }`.
  Add `maxSessionSeconds` if the vendor bounds a session; a provider that declares none is never
  refused on duration.
- **`RealtimeProvider.openingDelivery` is required**: `"turn"` (the opening trigger is sent after
  connect through `sendOpeningTrigger` — what every provider did before) or `"prompt"` (it is
  appended to the `systemInstruction`, and `sendOpeningTrigger` is called only on a meeting, with
  `MEETING_CONNECTED_CUE`). A provider that should behave as before declares `"turn"`; see
  `docs/provider-authoring-guide.md`. A harness `ScenarioTransport` declares the same field.
- **Harness `runAudioScript` and `runScenarioReliability` no longer take `openingTrigger`.** The
  opening is planned from the provider's declaration; `runAudioScript` takes an optional
  `meeting` flag instead.
- **`AudioCodec` is `dtmfTones` only.** `decodeInbound` and `encodeOutbound` are removed; the
  bridge between the carrier's and the provider's encodings is `convert` from `@parley/audio`.
- **`CallSession` params gain `convert` and `canConvert`** (pass `convert` and `canConvert` from
  `@parley/audio`). `ServerDeps` takes the same pair.
- **`TelephonyProvider.mediaEncoding` is required** (`mulaw@8000` for Twilio).
- **`ServerDeps.realtime` / `ParleyServerConfig.realtime` is now a `RealtimeRegistry`**:
  `{ providers: { gemini?: { provider, model }, deepgram?: { provider, model } }, default }`,
  replacing `realtime` plus `model`. `createParleyServer` throws at construction if `default` names
  a provider that is not built.
- **Deepgram provider options**: `llmModel` becomes `think: { provider, model }`; `listenModel`,
  `voice` and `settingsTimeoutMs` are new.
- **`RealtimeProvider.continuesAfterToolResponse` is required.** Declare `true` if the vendor's
  model goes on speaking after a tool answer (both shipped vendors do). Declare `false` only if it
  says nothing afterwards. See `docs/provider-authoring-guide.md`.
- **`CallSession.audioBridgeStats` is `{ inbound, outbound, listening }`**. Read
  `.listening.conversions` / `.listening.passThroughs` where you read `.conversions` /
  `.passThroughs` before.
- **`DEFAULT_DEEPGRAM_LLM_MODEL` is removed** from `@parley/realtime-deepgram`. Use
  `DEFAULT_DEEPGRAM_THINK` (`{ provider, model }`).
- **`CallSession.resolveSystemInstruction()` includes the opening** on a `"prompt"`-delivery
  provider. Code that appended `planOpening(...).promptSuffix` itself should stop doing so, or use
  `withOpening`.
- **Harness `runCallScenario` takes a `transport`** (a `ScenarioTransport`, e.g. from
  `geminiTransport` or `deepgramTransport`) in place of `apiKey`, `model` and `genAIFactory`.
- **`ScenarioTransport.completesAfterToolResponse` and `ScenarioTransport.openingDelivery` are
  required.** A custom transport declares both.
- **`CompletedCallRecord.realtime` is required on the type** (`{ provider, model }`). Code that
  builds a record must set it. It stays optional in `schema/meeting-record.schema.json`, so older
  records still validate.
- **An accepted `end_call` no longer answers `"ok"`.** Code that reads tool results (a custom
  transport, evaluator or log parser) and tests `end_call` for `"ok"` should test for
  `"ok — say nothing more"`; a successful `record_outcome` on a call with
  `end_call` is
  `"recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call"`.
- `RealtimeSessionCallbacks.onDiagnostic` is new and optional; nothing to change.

Actions for an operator:

1. **Upgrade the daemon before any client sends the new envelope fields.** The envelope schema is
   strict, so an older daemon rejects `execution.realtime` and `brief.keyterms` with `400`.
2. Send **`version: 2`** on any envelope that carries `execution.realtime` (v1 envelopes cannot
   carry `execution`).
3. **Choose your providers.** Set `GEMINI_API_KEY` and/or `DEEPGRAM_API_KEY`; `serve` builds every
   provider whose key is set. Boot fails if the default (`--realtime-provider`, default `gemini`)
   has no key. A Deepgram-only daemon: `--realtime-provider deepgram` and no Gemini key.
4. **The default Gemini model changed** to `gemini-3.8-live`. To stay on the previous model set
   `PARLEY_GEMINI_MODEL=gemini-3.1-flash-live-preview`; recorded `model` values on new call
   records change accordingly.
5. Optionally set `PARLEY_DEEPGRAM_THINK_PROVIDER`, `PARLEY_DEEPGRAM_THINK_MODEL`,
   `PARLEY_DEEPGRAM_LISTEN_MODEL`, `PARLEY_DEEPGRAM_VOICE`, `PARLEY_DEEPGRAM_SPEED`. Defaults:
   `open_ai`, `gpt-4o-mini`, `flux-general-en`, `flux-kelsey-en`, `1.25`. To run the previous
   model set `PARLEY_DEEPGRAM_THINK_PROVIDER=anthropic` and
   `PARLEY_DEEPGRAM_THINK_MODEL=claude-sonnet-4-6` (it bills at Deepgram's Advanced tier). The
   meeting-connected cue has not been checked on the default, so route meetings to Gemini
   (`execution.realtime.provider`) until it is.
6. Consumers of call records or `schema/meeting-record.schema.json` can read the new optional
   `realtime` and `firstModelAudioMs` fields; nothing existing changes meaning.
7. Making Deepgram the default is deliberately not part of this release; it waits on a live A/B
   (see the decision record).

## [0.3.1] — 2026-09-27

### Added

- **Caller-owned operation lineage for safe retries.** `brief.operation` carries a stable `id`,
  one-based `attempt`, and `maxAttempts`. The server rejects concurrent, duplicate, skipped,
  over-budget, or conflicting attempts with HTTP 409 before origination. Completed-call records
  preserve the lineage. Reservations are process-local, so callers still need a durable ledger
  across daemon restarts.
- **Outcome expectations in completed-call records.** `CompletedCallRecord.expectedOutcomeFields`
  exposes the declared field names alongside the recorded outcome, allowing downstream processors
  to distinguish “no outcome was required” from “a required result was never recorded.”

- **`MeetingRecord.status` gains `"never_joined"`** (additive, v1.x): a call classified this way
  never obtained consent AND never completed a single model turn, distinct from `"consent_refused"`
  (the room was reached and never said yes). See **Fixed** below for why this exists.
- **`JOIN_OUTCOMES` gains `"join_error"`** (additive, v1.x, on the optional `MeetingRecord.joinOutcome`
  — no record written before it existed changes meaning, and `schema/meeting-record.schema.json` is
  regenerated with it). The join THREW, so no verdict was ever reached: a page that would not open, a
  locator that timed out, a device whose state could not be established. That case was previously
  written down as `"waiting_room_timeout"`, on the reasoning that widening the enum would break a
  downstream validator — the constraint does not hold, because the consumer resolves its schema
  directory to this repository's own `schema/` folder and reads the committed files directly, so
  regenerating updates its validation in the same motion. What the old spelling cost is not
  hypothetical: it made one outcome mean three different things at once — a genuine lobby timeout, a
  successful join whose in-call markers went unrecognised, and a crash — which is exactly the defect
  this project already fixed once, when a single message covered two distinct refusals and a live
  failure could not be diagnosed from the log. `"join_error"` is not the catch-all `JOIN_OUTCOMES`
  deliberately refuses to have: it names a case none of the other five covers, the difference between
  "we asked and got an answer we did not like" and "we never got as far as an answer".
  `captureFault` still carries WHICH throw it was, unchanged.
- **Carrier-side DTMF at origination — `execution.dial.sendDigits`.** Two live calls to a real
  conference bridge failed identically: the model pressed the meeting ID in-band (`press_digits`,
  which sends tones over the media stream via `AudioCodec.dtmfTones`), the bridge re-prompted, and
  it hung up after three attempts. A third call to a human phone, same code path, produced clearly
  audible tones the human confirmed hearing — so the tone generation and outbound audio path are
  correct, and the bridge's DTMF detection (widely conference-bridge behavior, though not verified
  against this bridge directly) is the mismatch, not Parley. Twilio's `SendDigits` parameter of
  `POST /Calls` plays digits itself, out-of-band, once it answers — before the model, the media
  stream, or anything on our end of the call exists — which a scripted bridge entry can rely on
  without needing to listen for anything. `OriginateParams` gains `sendDigits?: string`;
  `TwilioTelephonyProvider.originate` sets it and validates it against Twilio's alphabet (`0-9`,
  `*`, `#`, `w`/`W` for a half-/one-second pause) and an assumed 32-character ceiling (Twilio's docs
  were not checked live while this was built; revisit if they are) **before** ever calling `fetch`,
  so one bad character fails locally rather than failing the whole origination against Twilio's
  API. The envelope gains `execution.dial.sendDigits`, validated identically by the schema
  (`@parley/policy`) so a malformed value is rejected before a call is ever originated. Unlike
  `execution.ivr`/`execution.meeting`, `execution.dial` takes **no `policy` pairing** — the carrier
  plays the tones before the model is ever connected, so there is nothing to tell the model, unlike
  the tool-declaring blocks that pairing rule exists for. `sendDigits` typically carries a bridge
  passcode: `redactSecrets`'s key-name pattern now also matches `sendDigits` (narrower than a bare
  `digits`, so it does not over-match the unrelated `allowedDigits` config or `press_digits`'s own
  `digits` argument), the provider's validation errors never echo the value, and
  `request-handler-call.test.ts`/`provider.test.ts` assert directly that a representative
  secret-shaped digit string never reaches a response body or a `console.error` call along the
  origination path. This does **not** reverse the earlier removal of `TelephonyProvider.sendDtmf`
  (see **Removed**, `[0.2.0]`): that method posted replacement TwiML to a **live** call and
  redirected it off the media stream; `sendDigits` is a parameter of the origination request, read
  before the call is even dialled, so there is no TwiML document to redirect and no media stream to
  tear down. See `docs/configuration.md#executiondial--carrier-side-dtmf-at-origination`.
- **`execution.meeting.consent.additionalPhrases`** — other utterances that grant consent
  identically to `phrase`, so a principal answering live can use whichever of several declared
  phrases comes naturally instead of needing to recall one exact wording (`packages/core/src/meeting.ts`,
  validated by `@parley/policy`'s schema with the same per-phrase floor as `phrase`). Optional; a
  single-`phrase` envelope parses and behaves exactly as before. `ConsentReceipt` gains
  `matchedPhrase` — which declared phrase (`phrase` or one of `additionalPhrases`) actually granted
  consent, distinct from `phrase`, which only ever names what was configured. "One of these five
  phrases was said" is not a record of what happened; `matchedPhrase` is. `MeetingRecord`'s
  `consentReceipt` and the committed JSON Schema carry it too (optional, additive v1.x).
- **`MeetingRecord.modelTurnsCompleted`** (optional, additive v1.x) — the same count
  `classifyMeetingOutcome` classifies `status` from, now written to the persisted record rather than
  discarded after use. A previous fix (see **Fixed** below, `[0.3.0]`) added `modelTurnsCompleted` to
  the internal `CompletedCallRecord` and threaded it into classification, but never into the record
  classification produced — so a `"never_joined"`/`"consent_refused"` split could not be checked
  against the artifact, only trusted. `commands.ts`'s `base` now carries it through both branches of
  `runCompletedCallPostCall`. Found on the same live call as the consent-ordering fix above, while
  checking whether the room's `consent_refused` classification could be independently verified.
- **Exit codes for `parley meeting join`, and a tolerance an operator can tune.** `meetingExitCode`
  gives three: `0` for a meeting that was joined and went cleanly (captions off is still `0` — an
  unattributed transcript is not a failed meeting), `2` for one that never happened, `3` for one
  that was joined and broke. `1` is left alone as the code the CLI's top-level catch already sets
  for an exception, which is a different event from a meeting that ran badly.
  `BrowserMeetingConfig.endedConfirmSeconds`, `--ended-confirm-seconds` and
  `PARLEY_MEET_ENDED_CONFIRM_SECONDS` expose how long the meeting UI must look gone before a run
  believes the meeting ended; the right value is a property of a deployment's link quality, not of
  the platform.

- **A second meeting transport: browser-driven, alongside telephony (`@parley/meeting-browser`,
  new package).** The agent can now join a video meeting as a named participant instead of dialling
  in — the join step is behind a `PlatformAdapter` interface so more platforms can follow without
  touching anything else — capture the host machine's system audio, read the platform's live
  captions, and attribute each transcript utterance to whichever caption speaker was talking closest
  to it in time. There is no phone call to speak an announcement into, so the joined display name
  IS the disclosure to the room (caller-supplied; this package ships no default). It writes the same
  two artifacts a telephony meeting does — `transcript.jsonl` and a line in the meeting-records file
  — through `@parley/cli`'s existing schema and writer, so a consumer reading meeting records does
  not need to know which transport produced any given one. `MeetingRecord` gains an optional
  **`transport`** field (`"telephony" | "browser"`) to say which. Absent means `"telephony"` — the
  only transport that existed before this field did — so every record written before this change
  remains valid without modification. It is also what the consent invariant keys on directly: a
  completed meeting on a transport whose consent is spoken (telephony) must carry the receipt that
  authorized it; a browser meeting's consent is the disclosed display name rather than a spoken
  exchange, so its `consentReceipt` is correctly `null` on a completed browser record, not missing
  data.
- **`MeetingRecord.joinOutcome`** (optional, additive; `JOIN_OUTCOMES`, `@parley/core`:
  `"admitted" | "waiting_room_timeout" | "denied" | "not_started" | "auth_required" | "join_error"`).
  How the
  attempt to JOIN a meeting ended — present only on a transport that must be admitted rather than
  answered, like a browser join; absent on a dialled call, which has no such step. A failed join
  still writes a record — `status: "never_joined"` and the outcome that explains it — so an attempt
  that never became a meeting is evidence on disk rather than silence. Every record written before
  this field existed remains valid; it carries no implication about consent (see `transport` above
  for that).
- **`transcript.jsonl` utterance rows carry their attribution's provenance: `speakerSource` and
  `speakerConfidence`.** Both are required and nullable, exactly like `speakerId`, so a reader
  parsing one line at a time meets the same shape whether or not anything was attributed, and both
  are `null` precisely when `speakerId` is. They exist because a name on its own is not the fact: a
  browser meeting attributes speech by matching the platform's own caption lines to an utterance
  within three seconds and writes `"roster"` at `0.6` confidence, and written as a bare
  `speakerId` that inference reached a consumer looking exactly like diarization-grade
  attribution. **The committed schema's own descriptions were wrong about this and are corrected**:
  it told consumers that "this format's shipped writer never attempts attribution, so every row
  carries `null` here today", and that a populated `speakerId` was reserved for a diarizing
  provider. `diarized` answers only what the TRANSCRIPTION PROVIDER did — a browser meeting writes
  `false` there and still attributes every row it can, because captions are not diarization; read
  each row's `speakerSource` for where its name came from. A telephony transcript is unchanged in
  meaning: all three fields are `null` on every row, as they always were in practice.
- **`MeetingRecord.gapMs`/`coveredMs` say which window they measure on each transport.** Their
  descriptions named "the instant consent was granted", which is meaningless on a transport with no
  spoken consent exchange. On a browser meeting the window opens when audio capture actually began,
  so the waiting room and the captions toggle are counted by neither field — the same accounting
  the telephony transport already used for its pre-consent time — and a meeting whose capture never
  started reports `coveredMs: 0` with the whole meeting as `gapMs`, never `gapMs: 0`, which a
  reader takes for "no holes".

### Fixed

- **`record_outcome` no longer accepts partial result maps.** Every declared outcome field must be
  present with a string value; otherwise ToolGate returns the constant refusal
  `"refused: incomplete outcome"` and records nothing. Empty strings remain valid when the caller
  deliberately uses them to represent an unavailable value.
- **A call that terminates before opening its media WebSocket no longer pins its operation active.**
  Signed terminal Twilio status callbacks evict unconnected sessions and release the retry
  reservation; connected calls remain owned by the media-close path so a late status callback
  cannot permit an overlapping retry.

- **`callId`'s committed description was false on every browser record.** It read "the telephony
  provider's identifier for this call (its call SID) — assigned by the provider, not Parley", which
  is true of a dialled call and wrong on a browser meeting: there is no telephony provider, and
  `@parley/meeting-browser` mints the id itself when the meeting starts. A consumer joining records
  to a carrier's call logs on that field had been told, in the contract, that it should — and on a
  browser record it would match nothing, with the contract as the reason. Both schemas now say who
  assigns it per transport and that a reader must check `transport` before joining these to
  anything external; the transcript header's own `callId` description is corrected in the same way.
  Two content tests pin the claim, because a description that merely exists passes every
  completeness check and can still say something false.
- **`removeAdditionalStrategy: "strict"` is pinned by tests.** It is a one-word option in
  `emit-schema.ts` whose entire job is keeping `additionalProperties: true` in both generated
  documents: zod-to-json-schema's default for a non-`.strict()` object is
  `additionalProperties: false`, and neither artifact is `.strict()`, because both are
  additive-within-a-major with unknown fields ignored. Nothing tested it — deleting it left every
  test in this repository green while every future additive record was rejected downstream, in
  another repository, on a record this one had happily written. Now pinned from both ends: the
  option's direct effect on both generated documents (every object definition, not only the three
  that exist today), and its consequence, where a record carrying an unknown field is validated
  against the zod schema and the committed JSON Schema at once and both must accept it.
- **The pre-join classifier's locale limit is written down, and its symptom is not the documented
  one.** Every locale note in the join driver concerned the in-call anchors. `classifyPreJoin`'s
  patterns (`PRE_JOIN_MARKERS`) are equally English-only and this was stated in neither the source
  nor the README — and the consequence differs, and is worse. An anchor failure means admission
  cannot be _confirmed_: the bot knocked and is very possibly sitting in the meeting. A classifier
  failure means the ready screen is never recognised, and since `/ask to join/i` is the only thing
  that sets `clicked`, **the join control is never pressed at all** — the transport times out having
  never knocked, so nobody in the room ever saw a notetaker and the host was never asked to admit
  anything. Both produce the same `waiting_room_timeout`, and the existing comment sent a debugger
  looking for "a meeting the host says the notetaker was visibly in", which points away from the
  cause in the second case. The timeout's comment now names both paths with the one question that
  separates them (did a participant ask to be let in?), and the behaviour is pinned by a test:
  unrecognised ready-screen copy never clicks, English copy does.
- **The selector that gates every admission is now proved against the engine that parses it.**
  `IN_CALL_ANCHOR_VISIBLE_SELECTOR` is the only query `isAdmitted` runs, and it is written in
  Playwright's own CSS dialect. Its only assertions were that it string-equals its own derivation
  and that jsdom rejects it — and no test in the package imported Playwright, so nothing anywhere
  established that Playwright accepts a comma-separated list with `:visible` on **each** member,
  which is the exact shape the constant has. If it threw or resolved to zero, `isAdmitted` would be
  permanently false and every join would time out, silently. A new `test/browser/` suite loads the
  committed captures in a real Chromium and measures it: accepted, one visible element per anchor
  on both in-call captures, zero on both pre-join captures. It also settles a cost the module could
  previously only state — `:visible` needs layout, and the `Call feature notifications and actions`
  live region has a non-zero bounding box, so that anchor does contribute rather than silently
  dropping out. Excluded from `pnpm run test` (it needs a browser binary) by a separate vitest
  config rather than a skip guard, and run with
  `pnpm --filter @parley/meeting-browser run test:browser` after
  `playwright install chromium`; see that package's README.
- **`[aria-label="Share screen"]` is no longer an admission anchor.** It was kept in
  `IN_CALL_ANCHORS` on the grounds that "the evidence for it is real; it is only the sole reliance
  on it that was wrong" — an argument for not depending on it, not for keeping it. Under any-match
  semantics those are different questions: a false negative needs every member to fail at once, so
  each addition helps a little, while a false positive needs only **one** member to fire in a state
  we are not in, so the weakest member alone sets the false-positive floor — and a false positive
  here starts an all-system-audio capture outside a meeting. Share screen was the weakest on both
  counts. It is the only member that sat **inside** `[role="region"][aria-label="Call controls"]`,
  a toolbar `prejoin-waiting.html` shows Meet already rendering **populated** in the lobby (six
  controls before admission), so its zero pre-join records which buttons Meet currently chooses to
  put there rather than a structural boundary — one more lobby button and it fires from the waiting
  room. Its marginal false-negative value was nil: it helps only where all three other anchors fail
  at once, and `Meeting details` is argued to be immune to the one host policy that removes Share
  screen. The set is now three members, all outside that toolbar, and a test asserts that as a
  membership rule so the reasoning cannot be undone by an edit that only re-checks capture counts.
- **A caption whose words move inside its own line is no longer read as silence.** `readCaptions`
  measured drift by removing every matched caption line's subtree from the region and weighing what
  was left, so text _within_ a matched line was invisible to that check by construction. The
  per-line guards catch a speaker or text element that is missing, but an element that is present
  and empty yields `""`, which is deliberately permitted. Combine the two and a Meet change that
  keeps the caption-line class while moving the words into a new child produces one matched line,
  zero residual, a real speaker and an empty text — every guard green, and the cue records that the
  speaker said nothing. That is the same "captioned meeting reported as quiet" lie the zero-line
  guard exists to prevent, one level further down. The region's visible text is now also compared
  against what the two per-line selectors actually read, under the same
  `CAPTION_RESIDUAL_TOLERANCE_CHARS` budget. The two measurements are complementary rather than
  redundant: deletion is exact but blind inside a line, arithmetic sees inside a line but cannot
  model whitespace between lines. On the one real captured region the selectors cover it
  exactly — speaker 13 plus text 351 of 364 characters — so the budget starts entirely spare.
- **`emit-schema` writes the committed form, so regenerating a schema is a semantic diff.** The
  generator wrote `JSON.stringify(document, null, 2)` while the committed files are
  prettier-formatted (`schema/` is not in `.prettierignore`, so `pnpm run format` reformats them),
  and prettier collapses any array that fits inside `printWidth` onto one line where
  `JSON.stringify` always breaks it. Regenerating without remembering a manual prettier pass
  produced a 104-line diff across two files nobody had semantically changed — a trap already paid
  for once on this branch, and payable again on every future regeneration. The renderer now runs
  prettier itself, resolving the repository's own `.prettierrc.json` from the target path so it
  declares no style of its own, and the staleness test compares raw bytes rather than parsed
  objects: the old comparison was structurally blind to exactly the drift that happened. A step an
  operator has to remember is a step that gets skipped, so the knowledge lives in the generator
  rather than in a runbook.
- **The browser notetaker leaves the meeting when it is done.** `leaveCallButton` was defined in the
  Google Meet adapter and never clicked, and the page the transport opened was never closed — only
  the CDP connection was dropped. After any ending it therefore stayed in the participant list,
  under the display name that is the room's only disclosure that a notetaker is present, no longer
  recording anything, with the owning process gone and no way to remove it but by hand. On a meeting
  that outruns the duration ceiling that was guaranteed rather than hypothetical, and the name went
  on asserting something that stopped being true at teardown. `PlatformAdapter` gains `leave()`, and
  `SessionDeps` gains `closePage()` — both run inside the single-exit teardown, so every ending goes
  through them: a denied join, a normal `far_end`, a caption fault, the ceiling, and a throw from the
  join itself. Both steps run, in that order, and neither is redundant: the click is the graceful
  exit the room sees, and closing the page is what actually guarantees departure. Failing to get out
  is recorded as a `captureFault` and never withholds the record. `closePage` closes ONLY the page
  this transport opened — not the browser (that is a disconnect, and belongs to `MeetingSession.close`)
  and not the context, which is the operator's signed-in profile and holds their other tabs.
- **A throw while joining now emits a record instead of nothing at all.** The two awaits that opened
  the page and drove the join were the only ones in `runBrowserMeeting` outside a guard, and they
  are the likeliest in the package to throw — both are chains of browser round trips against
  somebody else's single-page app, where a timeout or a rotated selector is the ordinary failure.
  Unguarded, either rejected the whole run before any record existed, so a consumer that watches
  records saw an attempt that was invisible rather than failed. Worse for the second: `joinMeeting`
  calls `hasEnded` after the click and after admission is confirmed, so a throw there left the
  transport in the room with no record and no capture. Both now route through the same teardown,
  recording `joinOutcome: "join_error"` (see **Added**) with the actual error in `captureFault` and
  `status: "never_joined"`.
- **The notetaker refuses to join when it cannot read the microphone control.** `turnOff` called the
  shared toggle driver and discarded its result. That driver has four outcomes and two of them mean
  the device was never touched: `absent` (benign — the capture host had no camera and Meet still
  rendered a control) and `unrecognised`, which means the element IS there, its label read neither
  "turn on" nor "turn off", and it was therefore deliberately not clicked. Swallowed identically,
  the device stayed as it was, the join returned `admitted`, and nothing reported it. Not
  hypothetical: in the committed `in-call-captions-off.html` capture the camera selector matches
  exactly one element, labelled `"Camera problem. Show more info"` — Meet had substituted a
  device-fault control for the toggle, and that drives the driver straight to `unrecognised`. On the
  microphone this now throws `DeviceStateUnknownError` before the knock; on the camera it is
  tolerated, because the only real markup that produces it is a fault control and a faulted camera
  is not transmitting.
- **The ended-meeting tolerance is a duration, and is thirty seconds.** The threshold was 2
  consecutive polls — a two-second page blackout at the session's own 1000ms poll, four at this
  module's 2000ms default — and the comment defending it argued that a transient reload is
  survivable because "the pre-join screen's anchors reappear well inside one interval". The set
  actually consulted is `IN_MEETING_MARKERS`, on which a fully restored pre-join screen measures 0
  of 3: `hasEnded(prejoin-ready.html)` is `true`, asserted in this package's own suite. The
  justification cited the fixture that refutes it, and a Meet reload does not repaint a
  multi-megabyte SPA in four seconds. The consequence was a stopped tap, a transcript truncated
  mid-meeting and a false `far_end`, needing no Google UI drift to fire. `HAS_ENDED_CONFIRM_MS`
  replaces `HAS_ENDED_CONFIRM_POLLS`, converted to polls at the one place the loop needs them.
- **The duration ceiling is a timer rather than a line in the caption loop.** It was a clock
  comparison at the top of that loop, so it could only fire while the loop was going round — and
  every other line of the loop is a browser round trip with no default timeout. A wedged renderer
  parked the loop and the ceiling, the thing protecting against a runaway browser on a shared host,
  was never evaluated again; nothing else would have ended such a run either, since the
  ended-meeting poll is wedged on the same call. It is now raced beside the other branches, armed
  from the session's own t0 so a waiting room still counts toward the meeting's length, and
  cancelled the moment any other branch wins. Teardown is bounded for the same reason and is the
  half that makes the first half real: every step that touches the page gives up after
  `TEARDOWN_STEP_TIMEOUT_MS` and records a fault, so a page that has stopped answering cannot
  withhold the record.
- **The post-call hook is bounded, and one that overruns is killed.** There was no timeout at all: a
  hook that hangs hung the whole run, on an unattended host, with the meeting's tab still in the
  meeting — and it is the one failure this dispatcher could not report, because everything it
  reports is reported after the wait. Two minutes by default; on expiry the child is SIGKILLed and
  the timeout thrown, matching `preflight.ts`, which already kills its own child rather than asking
  a process that has stopped answering to please stop. The timer is cleared on every settle, not
  just the happy one — left armed it would hold the event loop open for a two-minute hang after
  every successful meeting.
- **`AudioTap.stop()` waits for the capture to actually die, and escalates.** It sent SIGTERM and
  resolved in the same breath — a promise about the signal, not about the process — so the caller
  went on to write the meeting's record while `ffmpeg` was still capturing all system audio, and a
  capture wedged on a device that would not release it never received anything stronger than the
  signal it was ignoring. It now awaits the exit, escalates to SIGKILL after a grace, and throws if
  even that has not landed, bounded at four seconds total. It waits on the child's `exit` rather
  than `close`: `close` also waits for stdio to close, and a stdout whose consumer has stopped
  reading holds that pending long after the process is gone.
- **`parley meeting join` no longer exits 0 on a join that never happened.** A denied join, an
  expired session, a waiting-room timeout and a non-null capture fault all reported success. For a
  scheduled notetaker the exit code is the only signal a wrapper reads. See **Added** for the codes.
- **A transcript row's `speakerSource` and `speakerConfidence` are optional, not required.** Added
  in this same cycle, both went straight into the committed schema's `required` array — which does
  not describe the file the writer produces today, it describes every file it has ever produced. The
  downstream consumer loads that schema to re-read historical transcripts, and every transcript
  written before those fields existed omits both keys, so requiring them invalidated all of them
  retroactively. Absent now means what an older file means (this writer recorded no provenance) and
  stays distinct from an explicit `null`, which positively says the row was attributed to nobody.
  The writer still emits both on every row it writes.

- **A refused meeting now leaves instead of sitting mute on the bridge.** Told no, the agent used to
  stay on the line, silent, until the far end dropped it — it had asked a question, been answered,
  and then simply remained. When the room plainly refuses, it now says one short sentence and hangs
  up: `EndReason` gains `"consentDenied"` (`classifyMeetingOutcome` maps it to
  `status: "consent_refused"`, outranking `never_joined` as `consentTimeout` already does, since a
  refusal can only be heard inside a window the agent opened; `endedReason` stays `far_end`, so
  nothing in the committed `MeetingRecord` schema changes). The two halves live in the planes that
  own them: the goodbye is speech, so it is a composed rail (`meetingConsentDeclined`,
  `@parley/policy`, which deliberately names no tool — a meeting envelope need not declare
  `execution.closure`), and the hangup is binding, so `CallSession` does it deterministically rather
  than trusting a rail, six seconds after the refusal
  (`CONSENT_DEPARTURE_GRACE_MS = TURN_FINISH_TIMEOUT_MS + 2s`) so the sentence lands.
  **A denial is not "consent not yet given"**: waiting is the ordinary state of a pre-consent
  meeting and still belongs to `consent.timeoutSeconds`, which keeps its own `EndReason` so a record
  can tell "they said no" from "nobody replied". And leaving fails closed in the opposite direction
  to recording: `isConsentDenial` requires a negation with **no accepted phrase anywhere in the same
  utterance**, narrower than the gate's own refusal, so "oh no, sorry — go ahead" takes no notes and
  does not end the call either. The departure is re-evaluated on every later utterance rather than
  latched, so anything that would now grant consent disarms it — otherwise `findConsentMatch`'s
  documented "a room correcting itself forward is not blocked retroactively" would be unreachable
  on a live call.

- **A refused `begin_notetaking` now says WHICH refusal it is.** `ToolGate.authorizeNotetaking`
  returned the identical string — `"refused: the go-ahead phrase has not been spoken"` — for two
  unrelated facts: our own side never asked (no completed model turn, or a turn carrying no words
  and so no ordering boundary at all), and the room was asked and none of what came back was a
  go-ahead. A live refusal's one line on disk therefore could not distinguish "we never asked" from
  "they never agreed", which is part of why the boundary defect above needed a live call to find.
  `ToolResult` gains `"refused: the agent has not asked for consent yet"` (additive; the union is
  carried but never branched on outside `ToolGate`, so no exhaustive match needed widening).
  `PARLEY_DEBUG_CONSENT` additionally turns on a full dump of what the gate saw — the boundary, the
  declared phrases, and every eligible utterance with its speaker, instant and text, each annotated
  by the real matcher (`match=`, `negation=`) rather than a paraphrase of it. **Off by default and
  a debugging aid only:** it writes accepted phrases and pre-consent speech to a log, which is
  exactly what the design otherwise declines to persist on a call whose consent was refused.
  `HeardUtterance` gains an optional `speaker`, read by no decision and reported only by that dump.

- **The consent gate ruled out the go-ahead it had already matched, and the meeting took no notes.**
  Found on a live call: the room said "go ahead" — a phrase on the gate's own accepted list — the
  agent acknowledged aloud that it was going quiet to take notes, and then took none. The record
  said `status: "consent_refused"`, `coveredMs: 0`, `consentReceipt: null`; the only line on disk
  read `begin_notetaking refused: the go-ahead phrase has not been spoken — heard=2 eligible=1
requested=true`. The room was told notes were being taken and none were, which for a design whose
  premise is a promise made aloud is worse than never speaking. Nothing was wrong with the words:
  the BOUNDARY moved. `findConsentMatch` skips any utterance older than `requestedAt`, and
  `requestedAt` was `CallSession.lastModelUtteranceAt()` — the agent's **most recent** utterance,
  recomputed at tool-call time — while `meetingConsentRequest` (`@parley/policy`) requires the model
  to acknowledge the go-ahead and call `begin_notetaking` in the **same turn**. The acknowledgment
  is itself a later model utterance, so by the time the call was routed the go-ahead sat before the
  boundary and was skipped. The two turns that rail deliberately binds together are exactly what
  made the boundary outrun the answer. `CallSession` now pins the boundary at the instant a
  go-ahead is first heard (`consentAnchorAt`, set on the utterance itself in `noteTranscript`) and
  judges both the gate and the receipt against it. **What is pinned is the boundary, never the
  verdict** — the full newest-first scan still runs over the current buffer on every decision, so
  an "actually, no" spoken afterwards still withdraws consent and a later go-ahead still restores
  it; storing the match instead would have traded this defect for the withdrawal one that scan
  exists to prevent. The receipt is anchored too, and had to be: fixing only the gate would have
  answered the model `ok` and then thrown inside `buildConsentReceipt` mid-handoff, and a receipt
  dated from the model's latest utterance would carry a `requestedAt` **after** its own `grantedAt`,
  contradicting `meetingRecordSchema`'s own words for the field. `@parley/core` exports
  `anchorConsentBoundary` (and the `HeardUtterance` type its signature names); the scenario harness
  calls the same function rather than deriving the boundary a second way, so the offline matrix
  keeps measuring the code a real call runs.
- **A meeting call was sent the trigger written for a two-party call, and the agent never spoke.**
  Found on two live meeting calls, not by any of the 912 tests passing at the time. Both ended
  `consent_refused` with `coveredMs: 0` and no transcript, `begin_notetaking` was never called, and
  `modelTurnsCompleted` was 2 and 1 — the model took its turns and chose silence on both. The
  person on the far end heard the carrier's dial-in tones, then nothing, and hung up.
  `CallSession.attach` sent `OPENING_TRIGGER` unconditionally. Its opening half holds for either
  shape of call — at connect a bridge is hold music or silence, so "say NOTHING until the other end
  has spoken" is right — but its only affirmative half is transactional: greet a person and say why
  you are calling, or work through a recorded menu. Neither describes joining a meeting, so for a
  meeting the line as a whole resolves to "keep waiting", and nothing afterwards ever revisits it.
  The composed meeting rails did not contradict it: they say "wait until you hear people talking to
  one another" and "you are a notetaker, not a participant" — correct, and all of it pointing at
  silence. What was missing was never another prohibition, it was the TRANSITION — no line anywhere
  told the model that hearing the room is permission to speak rather than one more reason to wait.
  `MEETING_OPENING_TRIGGER` (`@parley/core`, exported) carries that moment and nothing else, and is
  chosen at the send site off `CallSession.isMeeting` — the same discriminator the post-call record
  reads, so the trigger and the record cannot disagree about which shape of call this was. It
  duplicates no rail content: the rails still hold WHAT to announce (`meetingAnnounce`, with the
  principal and the purpose) and WHAT to ask (`meetingConsentRequest`); this holds WHEN, borrowing
  the rails' own boundary test — "talking to one another" — verbatim, so the model is never handed
  two slightly different tests for the same moment. It asks for consent positively ("whether it is
  all right"), never as an objection, for the reason `meetingConsentRequest` already records: a
  negative-polarity ask is granted with a bare "no", the one answer the consent gate structurally
  cannot accept. `OPENING_TRIGGER` and every ordinary-call path are unchanged. `runCallScenario`
  (`@parley/harness`), which bypasses `RealtimeProvider` and so makes this choice for itself, makes
  the same one off the same signal — otherwise the only tool in the repo that puts a trigger in
  front of a real model would have run any check of this fix on the constant the fix replaces. The
  new tests assert PROPERTIES of the trigger rather than its literal sentence, so the wording can
  be tuned against the next live call without any of them being lost silently — which is how this
  survived in the first place: nothing anywhere asserted that the instruction a meeting receives
  ever tells the model to speak.

- **A short, natural reply to the consent request was refused because the declared phrase was
  four words long.** Found on a live call: the announcement and request were made, the declared
  phrase was `"go ahead and take notes"`, and the principal answered `"go ahead"` — the ordinary
  human reply — several times. `ToolGate.authorizeNotetaking`'s normalized substring match
  correctly refused every one of them: `"go ahead"` is not a substring of a four-word phrase. The
  call ended with no consent, no transcript, and a record reading `consent_refused`. The four-word
  minimum was guarding against a phrase being said BY ACCIDENT and counting as consent — a real
  risk, but length was the wrong instrument for it, turning the phrase into a password rather than
  something a person says. The actual risk has a precise shape: an utterance that arrives BEFORE
  the agent has asked anything (said to someone else, about something else, sitting in the
  pre-consent buffer until it retroactively "answers" a question nobody had posed yet). That risk
  is about ORDERING, not length. `findConsentMatch` (`packages/core/src/execution.ts`) now grants
  consent only for an utterance that arrives at or after the agent's own most recent utterance —
  the announcement or the request, whichever is later — and the schema's `.refine` floor drops from
  four words to two, low enough that `"go ahead"` works, high enough that a bare "yes" still
  cannot carry it alone. `ToolGate.authorizeNotetaking` and `CallSession.buildConsentReceipt` share
  the one ordering implementation rather than two independently maintained copies. See
  `docs/security-model.md#meeting-notetaking--consent-not-absence-of-capture` and
  `docs/configuration.md#setting-up-a-meeting`.

- **A DTMF keypress could be erased mid-press by the model's own barge-in handling.** Found on the
  first real call this branch ever placed, not by any of the 742 tests that were passing at the
  time. `onInterrupted` (fired on every barge-in) and `sendDtmf` both act on the SAME outbound audio
  queue: `onInterrupted` clears it (and tells the carrier to flush its own playout buffer) while
  `sendDtmf` queues a keypress into it as several seconds of tone audio. A live IVR talks more or
  less continuously, so the realtime model's VAD fired `onInterrupted` repeatedly while a 12-digit
  meeting ID was still mid-press, wiping the tones before they finished playing. The agent pressed
  the same ID three times and never reached the passcode prompt. Every existing DTMF test asserted
  tones were _generated_, never that they _survived to the wire_ — the two mechanisms were each
  individually correct and individually reviewed, and only interact on a live call. `CallSession`
  now tracks a burst's computed duration (`frame.data.length / 8` ms for μ-law @ 8 kHz, plus a fixed
  margin) and `onInterrupted` skips the clear while a burst is in flight; barge-in outside a burst
  is unchanged.
- **A call that never reached the room was recorded as the room refusing consent.** Any call ending
  with no consent receipt fell into `classifyMeetingOutcome`'s `"consent_refused"` catch-all,
  including a call that died inside a dial-in IVR before the agent ever spoke a word — a false
  statement about a room's wishes, in the artifact whose whole purpose is to record what a room
  agreed to. `classifyMeetingOutcome` now also takes `modelTurnsCompleted` (already tracked by
  `CallSession`, now threaded onto `CompletedCallRecord`) and classifies a no-receipt,
  zero-completed-turn ending as `"never_joined"` instead.

## [0.3.0] — 2026-08-20

A second call shape: alongside a two-party phone call, Parley can now dial into a conference
bridge, announce itself, obtain consent on the record, and hand off from a speaking plane to a
silent, transcribing one — never both live at once. The security argument for that changes with
it: it now rests on the consent gate, not on the fact that nothing is recorded, because a meeting
produces a text transcript even though Parley still records no audio anywhere. See
[`docs/security-model.md`](docs/security-model.md#meeting-notetaking--consent-not-absence-of-capture).

Pre-1.0, so the breaking changes below bump the minor version. See **Upgrading** at the end of
this entry — it is longer than the 0.2.0 one, because more of this release reaches into
interfaces a provider author implements against.

### Added

- **The listening plane** (`@parley/core`'s `transcription.ts`, `meeting.ts`): a
  `TranscriptionProvider`/`TranscriptionSession` pair, structurally incapable of sending audio or
  anything else back onto the call — there is no method on `TranscriptionSession` that could. See
  [`docs/architecture.md`](docs/architecture.md#the-listening-plane-has-no-way-to-talk-back--on-purpose-and-in-the-type)
  for why that is a property of the type, not a convention. `@parley/transcription-deepgram`
  implements it over Deepgram's Listen API — the tenth package in the workspace, and now a
  dependency of `@parley/cli`.
- **`parley serve` wires the listening plane.** `ParleyServerConfig`/`ServerDeps` gain an optional
  `transcription` field; `cli.ts`'s `buildTranscription()` reads `DEEPGRAM_API_KEY` (unconditionally,
  every `serve` run — the same variable `--realtime-provider deepgram` reads, one Deepgram account
  key serving both of that vendor's products here) and constructs the real provider when it's set.
  **`POST /call` refuses a meeting envelope with `503`, before origination, whenever no
  transcription plane is configured** —
  `"meeting calls require a transcription plane, which this daemon does not have configured"`.
  Closes a gap found and disclosed before this fix landed: before
  this, a meeting call obtained consent, told the room it would take notes, and then
  `beginNotetaking()` threw _after_ that promise was made — caught, logged, notes silently never
  taken, agent still live on the speaking plane. Refusing at intake instead costs a caller one
  rejected request, not a room its honesty about being recorded.
- **`policy.meeting.announce` and `execution.meeting` must both be present or both absent** — a new
  cross-plane pairing rule in `callEnvelopeSchema`'s `superRefine`, alongside the existing
  `policy.ivr`/`execution.ivr` one. Without it, an envelope could carry
  `policy.meeting.announce: true` with no `execution.meeting`: the model is told to announce itself
  as a notetaker and ask for the go-ahead, but `begin_notetaking` is never declared as a tool, and
  neither `CallSession.isMeeting` nor the `POST /call` transcription-plane guard above ever sees it
  — the exact defect that guard exists to prevent, reached through a door it cannot see. Keyed on
  `announce === true` specifically (not mere object presence), because `announce: false` composes no
  meeting rail at all and pairing on presence alone would reject a harmless combination.
- **`execution.meeting`**: `consent.phrase` (validated to at least four words),
  `consent.timeoutSeconds` and `consent.onTimeout` (`hangUp`). The announcement's wording lives in
  `policy.meeting.purpose` — see **Fixed**. Nothing reaches the listening plane, and
  nothing reaches disk, until the model calls `begin_notetaking` and
  `ToolGate.authorizeNotetaking` verifies the declared phrase was actually heard from a non-model
  speaker after at least one completed model turn — the same "model proposes, server disposes"
  split as every other tool in this project. Everything said before that point lives only in a
  bounded, discarded pre-consent buffer (`PRE_CONSENT_BUFFER_MAX = 500` entries).
- **Meeting ceilings, separate from call ceilings on purpose**: `execution.limits.maxDurationSeconds`
  and `execution.ivr.maxPresses` can reach `MEETING_MAX_DURATION_SECONDS` (4 hours) and
  `MEETING_MAX_PRESSES` (40) only when `execution.meeting` is declared; every other envelope is
  held to the existing `CALL_MAX_DURATION_SECONDS` (30 min) / `CALL_MAX_PRESSES` (20) by a schema
  `superRefine`, not merely by convention.
- **Coverage accounting for a hole in the record**: `TranscriptGap` (`{fromMs, toMs, reason}`),
  and `CompletedCallRecord.gaps`/`gapMs`/`coveredMs`. A frame that arrives while the transcriber
  isn't ready is dropped, not buffered, and the drop is written down — a readout built over an
  unmarked hole would read exactly like a readout of a complete meeting.
- **The two artifacts a meeting produces**: `meetings/<YYYY-MM-DD>/<callId>/transcript.jsonl` (mode `0600`,
  in a mode-`0700` directory; written only when consent was actually obtained) and a `MeetingRecord`
  (`kind: "meeting"`) appended to `PARLEY_CALL_RECORDS_PATH`. The zod schema for the latter is the
  source of truth and emits a committed [`schema/meeting-record.schema.json`](schema/meeting-record.schema.json)
  (`pnpm --filter @parley/cli run emit-schema`) — the cross-repository consumer that reads these
  files is a Python codebase and validates against that JSON Schema with `jsonschema`, not against
  the zod schema itself. See [`docs/configuration.md`](docs/configuration.md#meetings--the-listening-plane).
- **`AudioEncoding`** (`@parley/core`): `{ codec: "mulaw" | "pcm"; sampleRate: number }`, with
  frozen constants `MULAW_8K`/`PCM_16K`/`PCM_24K` and helpers `encodingEquals`/`formatEncoding`,
  replacing the old closed string-literal union — see **Changed** and **Upgrading**.
- **`AudioSource`** (`@parley/core`): which stream a frame arrived on, with `MIXED_SOURCE` for a
  carrier (like Twilio) that delivers one mixed stream. Exists now, on an already-shipped
  interface, because adding it later would have broken the one callback every audio sink hangs off.
- **`AudioBridge`** (`@parley/core`): adapts frames from whatever a source produces to whatever a
  sink accepts — a pass-through when the encoding already matches, one `convert()` call otherwise
  — and counts both, so "it worked because both sides spoke the same codec" and "it worked because
  we converted" are distinguishable from outside.
- **Wider `TranscriptEvent`, additive**: `speakerId`, `speakerConfidence`, `speakerSource`
  (`"channel" | "roster" | "diarization"`), `startMs`, `endMs`, `words`, and `segmentId`. A
  provider author implementing `TranscriptionProvider` must get `segmentId` right: two events
  sharing one are two revisions of ONE segment (the later **replaces** the earlier); its absence
  means the historic append-only delta contract `@parley/realtime-gemini` already emits. A
  streaming-ASR provider that emits growing prefixes and omits `segmentId` will have an aggregator
  concatenate them into nonsense.
- **`SpeakerRole` gains `"participant"`**, and `RealtimeConnectParams` gains `speakerRole` so a
  meeting's far end is tagged `"participant"` at the source, by the provider, rather than patched
  after the fact — nothing downstream infers meeting-vs-call from context.
- **`CallLifecycleEvent` gains `waiting`, `admitted`, `participant`, `removed`** — states a
  conference bridge can report that a two-party PSTN call cannot.
- **`EndReason` gains `consentTimeout`, `transcriptionLost`, `removed`** — a meeting that never
  got consent, one whose transcriber died mid-call, and one where the host removed the agent, are
  now each their own reason rather than folded into `error`/`remote`.
- **`@parley/realtime-deepgram`** — a second `RealtimeProvider` (the **speaking** plane), a spike
  behind `parley serve --realtime-provider deepgram` (default remains `gemini`). Verdict, in
  [`docs/decisions/2026-08-19-voice-agent-spike.md`](docs/decisions/2026-08-19-voice-agent-spike.md):
  **needs more work** — a live A/B this codebase cannot currently run is named as the open question,
  with the measurements that would settle it.
- **`DEEPGRAM_API_KEY`** — one variable, two independent gates. `requireEnv`'d, boot-time, only
  when `--realtime-provider deepgram` is passed (the speaking-plane spike). Read unconditionally
  and optionally otherwise: `parley serve` always calls `buildTranscription()`, and its absence is
  what makes `POST /call` refuse every meeting envelope with `503` — an ordinary (non-meeting) call
  is unaffected either way. `parley doctor` reports meetings as a **capability** rather than as a
  presence line — `meetings: ready`, or `meetings: not configured (needs …)` naming exactly what is
  missing — so an operator can learn "this daemon cannot take meetings" without placing a call, and
  a Gemini-only deployment that never intended to take one is not shown a `MISSING` that is not a
  fault.

### Changed

- **`AudioFrame.encoding`** is now the `AudioEncoding` object above, not the old closed string
  union (`"mulaw8k" | "pcm16k" | "pcm24k"`). See **Upgrading**.
- **`AttachMediaStreamParams.onInboundAudio`** now takes a second parameter, `source: AudioSource`.
  See **Upgrading**.
- **`onCallCompleted` may now return `Promise<void>`, and is awaited** before the media socket's
  own `stop()` runs — so a hook that writes files (as the CLI's own meeting post-call path does)
  is guaranteed to finish before the carrier hangup proceeds, rather than racing it. See
  **Upgrading**.
- **`CompletedCallRecord`** grew `isMeeting`, `startedAt`, `consentReceipt`, `gaps`, `gapMs`,
  `coveredMs` — present on every record, meeting or not, so an ordinary call's consumer can ignore
  them at no cost. See **Upgrading**.

### Known limitations

- **The consent phrase is a record that the words were spoken before note-taking began. It is not
  authentication.** Parley does not diarize in this release, so nothing distinguishes the
  principal's voice from that of anyone else who heard the phrase said aloud. Wiring the listening
  plane into `parley serve` (above) closes the _daemon-cannot-take-notes_ gap; it does not and
  cannot touch this one — no amount of plumbing between the consent gate and a real transcriber
  changes who the words are attributed to. See
  [`docs/security-model.md`](docs/security-model.md#meeting-notetaking--consent-not-absence-of-capture).
- **The listening plane does not reconnect, so `gapMs` is small on every real meeting.** There is
  no backoff and no resume: `CallSession` treats the transcriber's `onClose` as terminal and ends
  the call as `transcriptionLost`. A `transcriber_not_ready` gap is therefore effectively
  unreachable in production — the gap a real meeting records is the handoff's
  `transcriber_connecting` window and nothing else. A downstream "degrade the readout if more than
  N% is missing" rule will effectively never fire in this release; the signal that notes stopped is
  `endedReason: "transcription_lost"` on the meeting record, not `gapMs`. Stated as a divergence
  from the design's backoff/alert/hangup ladder rather than carried as documentation of behaviour
  that does not exist. See
  [`docs/architecture.md`](docs/architecture.md).
- **A host removing the agent from a bridge is indistinguishable from a hangup.** A PSTN carrier
  reports a socket close and nothing more, so `EndReason` and the meeting record's `endedReason`
  carry no `"removed"` value and a host removal reads as `far_end`. `CallLifecycleEvent` still has
  a `removed` variant for a future native meeting API that can report a host action for real.
- **`--realtime-provider deepgram` is refused.** `RealtimeProvider` has no encoding negotiation, so
  a Deepgram-backed call would be silent inbound and noise outbound while flooding the log. See
  **Fixed** below and
  [`docs/decisions/2026-08-19-voice-agent-spike.md`](docs/decisions/2026-08-19-voice-agent-spike.md).

### Fixed

- **The consent handoff ended the call.** `beginNotetaking()` closes the speaking plane, both
  shipped providers implement `close()` as a socket close, and a socket close raises
  `callbacks.onClose` — whose handler in `CallSession` hung the carrier leg up unconditionally. On
  a real meeting the line dropped at the exact instant consent was granted, and
  `classifyMeetingOutcome` then wrote `status: "completed"` over an empty transcript: a record
  asserting a meeting that never happened. An explicit `speakingPlaneRetired` flag now distinguishes
  a session we retired from one that died unasked. The test stub that hid it — a `close()` that set
  a boolean and fired nothing — now fires `onClose` like a real one.
- **A meeting-capable daemon with no records path wrote nothing, silently.** `POST /call` failed
  closed on a missing transcription plane but not on a missing artifact sink, so with
  `DEEPGRAM_API_KEY` set and `PARLEY_CALL_RECORDS_PATH` unset a meeting was accepted, the bridge
  dialled, consent obtained on the record and notes taken for hours — with no transcript, no record
  and no hook ever existing, and nothing logging it. The `503` now covers both halves
  (`ServerDeps.meetingArtifactsConfigured`).
- **The meeting artifacts were built from a session that had not been torn down.** On the normal
  meeting ending — the bridge drops the leg — `handleMediaConnection`'s `evict()` invoked
  `onCallCompleted` before `handle.stop()`, so two things `endCall` does to make the record honest
  had not run: a gap still open was never sealed (the record read `gaps: [], gapMs: 0` over a real
  hole) and the listening plane was never flushed (the meeting's last utterance was lost). The
  teardown now runs first; the hook is still awaited before eviction finishes, so nothing races the
  files it was handed. Relatedly, `@parley/transcription-deepgram`'s `flush()` now awaits the
  `Results` message `Finalize` asks for, under a bounded timeout, instead of resolving as soon as
  the marker was written to a socket.
- **Every carrier lifecycle event was discarded.** `CallSession` passed `onCallEvent: () => {}`, so
  `admitted`, `waiting`, `participant`, `removed`, `completed` and `failed` reached a function that
  dropped them. They are now routed into `noteLifecycleEvent` and reported. See **Upgrading** for
  the removal of `EndReason`'s `"removed"`.
- **Two `purpose` fields that could disagree.** `execution.meeting.announce.purpose` was required
  and validated and read by nothing; the prose the room hears comes from `policy.meeting.purpose`.
  Setting the former and leaving the latter unset made the room hear the default, with no error.
  There is now one. See **Upgrading**.
- **`--realtime-provider deepgram` could not carry a call**, and now says so instead of producing
  one. The realtime sink always sends `pcm@16000` and `DeepgramRealtimeProvider.sendAudio` accepts
  only `mulaw@8000`, so every inbound frame threw inside the sink fan-out (~50 caught diagnostics a
  second, agent hearing nothing) while its `mulaw@8000` output was encoded as `pcm@24000` (callee
  hearing noise). The flag is rejected at parse time until `RealtimeProvider` gains encoding
  negotiation.
- **The meeting test apparatus was unreachable.** `MEETING_SCENARIOS` had one consumer — its own
  test — and was absent from `harness scenarios` and from `generate-fixtures`, so it could not be
  run through `harness reliability`. `withoutConsentPhrase` / `relateConsentGate` were absent from
  `index.ts` and `runMetamorphicCommand` threw on any pair that was not the quote raise. All four
  are now reachable, with `metamorphic --relation <id>` selecting the pair; the scenario runner now
  passes `heard` and `modelTurnsCompleted` into `routeToolCall`, without which the consent gate
  refused every scripted `begin_notetaking` regardless of what the script said.
- **An untimed transcript row sorted to position 0.** `transcript.jsonl` sorted on `startMs ?? 0`,
  and production emits exactly one kind of untimed row — an utterance from the speaking plane,
  which reports no timestamps. It landed ahead of every gap row, asserting it was the first thing
  said on the call. Untimed rows are now appended after the timeline, still carrying
  `startMs: null`.
- **The committed meeting fixtures were not faithful**, and the README said they were. They were
  built by feeding a hand-assembled `CompletedCallRecord` into the post-call path, one layer below
  where `CallSession` decides which events reach a transcript — so they carried the announcement
  and the go-ahead as timed transcript rows, which production puts in the volatile pre-consent
  buffer and never in `transcriptLog`. They are now captured by driving a real meeting through the
  real path, and the capture re-runs on every test run and is compared to what is committed.

### Upgrading

1. **Custom `TelephonyProvider`/`RealtimeProvider`/`AudioCodec` implementations**: `AudioFrame.encoding`
   is now an `AudioEncoding` object (`{ codec, sampleRate }`), not a string literal. Compare it
   with the exported `encodingEquals` helper, not `===`; construct frames with the exported
   `MULAW_8K`/`PCM_16K`/`PCM_24K` constants rather than a literal.
2. **Custom `TelephonyProvider` implementations**: `AttachMediaStreamParams.onInboundAudio` now
   takes a second parameter, `source: AudioSource`. A carrier delivering one mixed stream (the
   ordinary PSTN case) should pass the exported `MIXED_SOURCE` constant, matching
   `@parley/telephony-twilio`.
3. **A programmatic `onCallCompleted` hook that returns a `Promise`** is now awaited before the
   carrier hangup proceeds. If your hook used to fire-and-forget an async operation, it will now
   hold up call teardown until that promise settles — usually the fix you want, since it is what
   makes a meeting's transcript write finish before the hook's own spawned command runs, but audit
   any hook doing slow I/O.
4. **`CompletedCallRecord` grew six fields** (`isMeeting`, `startedAt`, `consentReceipt`, `gaps`,
   `gapMs`, `coveredMs`). A hook that only reads fields it already knew about is unaffected; a test
   double or fixture that constructs one by hand needs the new required fields.
5. **A post-call `onCallCompleted` hook must now branch on `record.isMeeting` (`boolean`) — not
   on a `kind` field.** `CompletedCallRecord`, the type the hook receives, has no `kind` field.
   `kind: "meeting"` is real, but it belongs to the separate on-disk `MeetingRecord` artifact
   written to `PARLEY_CALL_RECORDS_PATH` for a meeting — the shape a _file-reading_ consumer
   (`PARLEY_POST_CALL_COMMAND`, or A2) sees, never the shape passed to the in-process hook.
6. **`SpeakerRole`, `EndReason`, and `CallLifecycleEvent` all grew new members** (`"participant"`;
   `"consentTimeout"`, `"transcriptionLost"`; and `CallLifecycleEvent`'s `waiting`, `admitted`,
   `participant`, `removed` variants). An exhaustive `switch`/`if`-chain over any of the three needs
   a new arm to stay exhaustive.
7. **`TranscriptionProvider` authors**: implement `segmentId` correctly (see **Added** above) — a
   provider that emits growing prefixes and omits it will read as garbled, not merely incomplete.
8. **Set `DEEPGRAM_API_KEY`** before taking meetings through `parley serve`. Without it, `POST /call`
   now refuses every `execution.meeting` envelope with `503`
   (`"meeting calls require a transcription plane, which this daemon does not have configured"`).
   This is a _separate_ enforcement point from `--realtime-provider deepgram`'s own, boot-time
   `requireEnv` check: the same variable gates two independent things, checked at two different
   moments (request time for meetings; process-start time for the speaking-plane spike), and an
   ordinary non-meeting deployment can leave it unset either way.
9. **`policy.meeting.announce` and `execution.meeting` must now both be present or both absent** —
   an envelope carrying one without the other is rejected by `parseCallEnvelope`/`POST /call` with a
   `400` naming `["execution", "meeting"]`. A caller building a meeting envelope by hand (rather than
   through a shared helper) needs to declare both halves together.
10. **`RealtimeProvider` authors: honour `RealtimeConnectParams.speakerRole`.** It is optional on
    the type, so a provider that ignores it compiles cleanly and then tags a meeting's far end
    `"caller"` — reproducing, in a third-party provider, exactly the defect this release fixed in
    its own. Absent or `"caller"` is the ordinary two-party call; a meeting passes `"participant"`,
    and every far-end `TranscriptEvent` must be emitted with that role. Nothing downstream infers
    meeting-vs-call from context or patches a `"caller"` event into a `"participant"` one after the
    fact, so a provider that drops the field silently mis-attributes a room's words — including in
    the consent receipt.
11. **`TranscriptionProvider` authors: `accepts: readonly AudioEncoding[]` is REQUIRED**, ordered
    most-preferred first, and must be non-empty — `AudioBridge` converts the carrier's frames to
    `accepts[0]` when the source produces none of them, and both `CallSession.beginNotetaking()` and
    `AudioBridge`'s constructor refuse a provider that accepts nothing. Declaring an encoding you
    cannot actually decode makes every frame of a meeting arrive misinterpreted, which reads as a
    transcriber that produces nonsense rather than one that is misconfigured.
12. **`EndReason` LOST `"removed"`, and so did `MeetingRecord`'s `endedReason` enum and the
    committed `schema/meeting-record.schema.json`.** Nothing could ever produce it: a PSTN carrier
    reports a socket close and cannot distinguish a host removing the dial-in from an ordinary
    hangup (`@parley/telephony-twilio` synthesises `{ type: "removed", by: "unknown" }` on _every_
    call end for that reason). A host removal reads `far_end`. A reader with a `"removed"` branch
    should delete it; a writer that produced the value could not have been Parley.
13. **`execution.meeting.announce` is GONE, and the schema is `.strict()`, so an envelope still
    sending it is rejected with a `400`.** The announcement's wording now has exactly one home:
    `policy.meeting.purpose`. Move the string across — `"execution": { "meeting": { "announce":
{ "purpose": X } } }` becomes `"policy": { "meeting": { "announce": true, "purpose": X } }`.
14. **The meeting transcript path changed to
    `<dirname of PARLEY_CALL_RECORDS_PATH>/meetings/<YYYY-MM-DD>/<callId>/transcript.jsonl`**, from
    `…/transcripts/<callId>/…`. The date is the UTC date of the meeting's `startedAt`, so a
    retention sweeper can select on the path without opening a file. A consumer that globbed the
    old layout needs the new one; existing files are not migrated.
15. **A programmatic `createParleyServer` embedder that accepts meeting envelopes must pass
    `onCallCompleted`.** `POST /call` now refuses a meeting envelope with `503` when no artifact
    sink is configured (`ServerDeps.meetingArtifactsConfigured`, derived from `onCallCompleted`'s
    presence), the same way it already refused one with no transcription plane. Anyone constructing
    `ServerDeps` directly — rather than through `createParleyServer` — must set the field.
16. **`onCallCompleted` is now invoked AFTER the session is torn down**, not before. The record it
    receives describes a finished call: a gap still open has been sealed and the listening plane has
    been flushed. Two consequences for an existing hook: it is invoked a few microtasks later than
    it used to be (teardown is asynchronous), and `record.transcript` may now contain one more
    entry — the meeting's last utterance — than it did.

## [0.2.0] — 2026-08-19

Completing the call: a model can now navigate a phone tree, agree to a charge under an enforced
ceiling, record a structured outcome, and hang up cleanly — with a server-side gate in front of
every one of those. Plus the harness that measures whether it did, and the authentication that
`POST /call` was missing.

Pre-1.0, so the breaking changes below bump the minor version. Three of them require action on
upgrade; see **Upgrading** at the end of this entry.

### Added

- **Execution plane** (`@parley/core`'s `execution.ts`, `@parley/policy`'s `callExecutionSchema`).
  An envelope's advisory `brief`/`policy` now sits beside a binding `execution` block. Capability
  is declared by **presence**, not by an `enabled` flag: an envelope with no `execution.ivr` block
  cannot press a key, because the tool is never declared to the model.
- **Tool channel**: `press_digits`, `record_outcome`, `end_call`, routed through `ToolGate`.
  `ToolResult` is a closed union of string literals (`TOOL_RESULTS`) and is never built by
  interpolation, so nothing a caller says can reach the model through a tool result.
- **Enforced spend ceiling**: `execution.spendCeiling` binds an outcome field to a hard limit.
  `ToolGate.recordOutcome` refuses an over-limit record **before writing anything** — a partial
  record with the appointment kept and the price dropped would read as free. The schema requires
  the ceiling to be declared coherently across both planes, with matching limits.
- **DTMF synthesis** (`@parley/audio`): `dtmfMuLaw`, `DTMF_FREQUENCIES`. Keypresses are audio,
  sent in-band down the media stream the call is already on.
- **Carrier-confirmed drain** (`@parley/telephony-twilio`): `MediaStreamHandle.drainOutbound`
  waits out the local queue, sends a Twilio `mark`, and resolves on the carrier's echo — so a
  hangup no longer truncates the goodbye. `CallSession` also waits for the model's turn to finish
  before draining.
- **`navigableCall` preset** and new policy rails for adjacency, IVR, preferences, spend and
  patience.
- **Call scenario harness** (`@parley/harness`): multi-turn `CallScenario` with expectations
  _derived_ from each scenario's declared parameters rather than authored beside its prose; a
  generator over a cost/complication matrix; a structural evaluator; failure **rates** with typed
  codes instead of pass counts; `--concurrency`; and a `parley-harness` bin entry that works.
- **Metamorphic pairs** (`@parley/harness`'s `metamorphic.ts`): a deterministic source transform
  raises a quoted price above the ceiling, and the relation between the two runs is checked — a
  property that needs no correct absolute answer. Unpairable scenarios and vacuous passes are
  reported as such rather than counted as holding.
- **Twilio status callbacks and answering-machine detection**; `POST /twilio/status`.
- **Structured call record** returned by the daemon, with the outcome the model recorded.
- **`PARLEY_BIND_HOST`** (default `127.0.0.1`) and **`PARLEY_AUTHOR_MIN_INTERVAL_MS`**.
- **[`docs/scenario-authoring.md`](docs/scenario-authoring.md)** — seeding, generating, running and
  reading scenarios, including what the harness structurally cannot see and why a correct product
  change can look like a regression.
- A test that walks every fenced JSON envelope in the docs and parses it, so a documented example
  cannot drift out of the schema.

### Changed

- **Wire version 2.** `version: 2` accepts the `execution` block. `version: 1` envelopes remain
  valid and are treated as carrying no execution plane; a v1 envelope that declares `execution`
  is rejected rather than silently downgraded.
- The daemon binds **loopback by default**. It previously bound every interface, and no
  configuration existed that could have stopped it — `server.listen(port, resolve)` puts the
  callback where Node's host argument goes.
- `renderSystemInstruction`'s opening trigger now tells the model the call has just connected and
  that waiting means _silence_ — not announcing that it is waiting.
- Transcript entries store one entry per model turn rather than one per streamed fragment.
- The wrap-up rail asks what the other side still needs before closing, rather than only
  summarizing what was agreed. An appointment nobody can act on is not an appointment.

### Removed

- **`TelephonyProvider.sendDtmf`** — removed from the interface and from the Twilio provider.
  It posted replacement TwiML, which _redirects_ a live call and tore down `<Connect><Stream>`;
  every keypress hung up. Keypresses are now `AudioCodec.dtmfTones`, in-band.
- `OPENING_TRIGGER` is no longer exported from `@parley/policy`. It was a second copy of the
  constant in `@parley/core` that nothing imported and that drifted the moment the real one
  changed. Import it from `@parley/core`.

### Fixed

- A model hangup no longer cuts off its own final sentence.
- The spend ceiling is a running total for the whole call, not a per-item price.
- The ceiling is private: the model no longer announces having a budget or a maximum.
- The model no longer invents specifics — an address, a name, a date, an account number — that
  the brief did not give it.
- The model no longer presses keys into silence as an opening move, and is told what to do when
  no menu option matches.
- The outcome is recorded before the goodbye rather than after it, so a callee who hangs up first
  no longer leaves the call unrecorded.

### Security

- **`POST /call` now requires authentication** — `Authorization: Bearer $PARLEY_CALL_TOKEN`,
  compared in constant time, checked _before_ the body is parsed so an anonymous caller cannot
  distinguish a malformed envelope from an unlisted number and enumerate the allowlist. It fails
  closed on an unconfigured token (`503` to everybody, never open to everybody), and `parley serve`
  refuses to start without the variable.
  This route was previously unauthenticated. The callable-number allowlist is **not** access
  control — it bounds who may be _dialled_, never who may _dial_ — and counting it as
  authentication is what left the route open.
- `POST /twilio/answer` and `/twilio/status` remain deliberately un-gated by the token: Twilio
  cannot present one. Their control is signature verification.
- `parley doctor` now reports `PARLEY_CALL_TOKEN` presence, still without printing any value.

### Upgrading

1. **Set `PARLEY_CALL_TOKEN`** (`openssl rand -hex 32`) in the daemon's environment _and_ wherever
   `parley call` or your own client runs. Without it `serve` will not start.
2. **Check your ingress still reaches the daemon.** It now binds `127.0.0.1`; set
   `PARLEY_BIND_HOST` only if you have a specific reason not to front it with a tunnel or proxy.
3. **Custom `TelephonyProvider` implementations**: delete `sendDtmf`. If you relied on it, supply
   `dtmfTones` on your `AudioCodec` instead (`@parley/audio`'s `createAudioCodec` already does).

## [0.1.0] — 2026-07-28

### Added

- Initial public release: briefed outbound phone calls with Gemini Live over Twilio.
- Packages: `@parley/core`, `@parley/policy`, `@parley/audio`,
  `@parley/telephony-twilio`, `@parley/realtime-gemini`, `@parley/server`,
  `@parley/cli`, `@parley/harness`.
- `parley` CLI: `serve`, `call`, `harness`, `doctor`.
- Offline harness: text/audio turns, multi-turn derail scripts, N-run
  reliability reporting, payload preview.
- Example library and getting-started, configuration, agent-setup, and
  deployment documentation.
