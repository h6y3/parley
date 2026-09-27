# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
