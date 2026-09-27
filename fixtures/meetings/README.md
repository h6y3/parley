# Meeting fixtures

These are contract #4 to A2 (the separate Python repository that reads Parley's
meeting artifacts): committed sample `record.json`/`transcript.jsonl` files so
A2's author can build a readout against real artifact shapes before this
repo's live-call meeting gate has ever run against a real bridge.

## Provenance — read before trusting or editing these

**They are captured from a real meeting driven through the real production
path, and `packages/cli/test/meeting-fixtures.test.ts` re-runs that capture on
every test run and compares it to what is committed.** Drift is a test failure,
not something a reader has to notice.

The capture (`packages/cli/test/helpers/capture-meeting-fixtures.ts`) runs the
whole path, not just its last step:

`handleMediaConnection` → a real `CallSession` (meeting declared) → the model
announces and asks through the real realtime callbacks → the room answers →
`begin_notetaking` through the real `ToolGate` → the real consent handoff →
carrier frames through the real audio-sink fan-out (which is what produces
`coveredMs` and the gap rows) → the socket close → the real
`runCompletedCallPostCall` → the real `writeTranscriptJsonl` and
`buildMeetingRecord`.

Only the three vendor edges are stubs — telephony, the realtime session, and
the transcription session. No network call is made and no credential is read.
The meeting-relative clock is injected and `Date` is faked, so the receipt
timestamps and the record's `startedAt`/`endedAt` are identical on every run
and on every host.

**One substitution, and only one:** `record.transcriptPath`. A capture writes
into a scratch directory and cannot know the path its own output will be
committed at, so the produced path is replaced with the fixture's committed
location. The regeneration test applies the same substitution, so the
comparison stays exact.

### What this replaced, and why it mattered

The previous fixtures were built by feeding a **hand-assembled**
`CompletedCallRecord` into `runCompletedCallPostCall`. That is one layer too
late: every decision about _which_ events reach a meeting's transcript is made
upstream, in `CallSession`. The result carried the announcement and the
go-ahead as timed transcript rows and a model row stamped `startMs: 8000` —
none of which production can emit — under a README claiming the files
"reflect exactly what production emits today".

## What a reader should notice about the shapes

- **The announcement and the go-ahead are not in the transcript.** They are in
  `record.json`'s `consentReceipt` and nowhere else. Pre-consent speech reaches
  a bounded, volatile buffer; the promise made aloud to the room is that
  nothing is written until the go-ahead, and that is where the bytes go rather
  than a rule the model is asked to follow.
- **The last row has `startMs: null` and sits AFTER the timeline.** The
  speaking plane (a realtime model) reports no timestamps at all, so the model
  turn still open when the consent handoff retires that plane is committed
  untimed. Gap rows and timed utterances are interleaved in time order; an
  untimed row has no place in that order and is appended rather than sorted to
  position 0, which would assert it was the first thing said on the call.
- **`coveredMs + gapMs` is less than the call's length, and must be.** Nothing
  is covered before consent — no transcription sink exists until the handoff —
  so the shortfall is exactly the pre-consent period. Here: a 240 s call,
  consent at ~15 s, `coveredMs` 191000, `gapMs` 34000.
- **`endedReason` is `far_end`.** There is no `"removed"` value: a PSTN carrier
  reports a socket close and cannot distinguish a host removing the dial-in
  from an ordinary hangup, so nothing downstream may claim it could.

## Regenerating them

Edit the script in `packages/cli/test/helpers/capture-meeting-fixtures.ts`, then
re-run the capture and write its output over these files. The comparison test
tells you immediately whether what you committed is what the code produces.

Everything the capture exercises is real code, so a change to any of these
modules shows up as a diff here rather than as silent drift:

- `packages/core/src/call-session.ts` (the handoff, the buffer, the gaps)
- `packages/cli/src/meeting-record.ts` (`meetingRecordSchema`, `buildMeetingRecord`)
- `packages/cli/src/transcript-writer.ts` (`writeTranscriptJsonl`)
- `packages/server/src/media-connection.ts` (record assembly and its ordering)

## `brief` — one fixture carries it, one deliberately does not

`roadmap-sync/record.json` now carries a `brief` block (`title`, `topic`,
`role`, `track`), sourced from the `execution.meeting.brief` the capture
configures in `capture-meeting-fixtures.ts`'s `ROADMAP_SYNC_BRIEF` — real code
producing it, same as every other field here, not hand-added to the committed
JSON. `consent-refused/record.json` still carries none, and that absence is
just as deliberate: its capture passes no `meetingBrief` at all, so A2's
author can see both committed shapes side by side — `brief` present when the
caller supplied one, `brief` omitted (never an object of empty strings) when
the caller supplied nothing. See `brief`'s own `.describe()` in
`meeting-record.ts` for the full reasoning, including why these fields are
never derived from `Brief.objective`/`persona` instead of being left absent.

## `truncated-standup` — the branch the other two fixtures cannot show

`roadmap-sync` and `consent-refused` both end `endedReason: "far_end"`: the
room, not Parley, ends the call. `truncated-standup` covers the other case —
`status: "completed"` (consent was granted and notes were taken) but
`endedReason: "duration_cap"` (Parley's own ceiling ended it, not the room).
That branch fires only on the longest meetings, which is exactly the kind a
committed fixture is smallest and fastest at showing without actually running
one that long — without it, a downstream reader has no committed sample of
the one ending that isn't the room hanging up.

Its transcript also has **no gap row**, unlike `roadmap-sync`'s — the
transcriber never drops out here — so a reader can tell this fixture's
truncation banner apart from `roadmap-sync`'s gap banner rather than
conflating the two from `roadmap-sync` alone. It carries two timed
`participant` utterances (plus one untimed `model` row, same handoff artifact
as `roadmap-sync`'s), so the no-gap claim is exercised against real content
rather than an empty transcript that could not contain a gap either way.

## `meet-attributed-standup` — the first ATTRIBUTED transcript, and the browser transport's shape

The other three fixtures all come from the telephony path, where every
`speakerId` is `null` because that path cannot know who spoke. A2 was written
against exactly those three, and it concluded — reasonably, from the only
evidence it had — that `speakerId` is _always_ null and that a readout may
never name anyone. This fixture is the counterexample, and it is committed so
that conclusion can be tested rather than inherited.

Captured by `packages/meeting-browser/test/helpers/capture-browser-fixture.ts`
through the real `emitMeetingArtifacts`, so `attributeEvents` performs the real
caption-to-utterance alignment and `writeTranscriptJsonl` decides every row's
shape. `packages/meeting-browser/test/meet-fixture.test.ts` regenerates it on
every test run and compares byte for byte, the same contract the three
telephony fixtures are under.

### What a reader should notice

- **`speakerId` carries a display name, not an opaque id.** Google Meet's
  caption region reports the name the participant is signed in as, and that
  string is what gets written. `speakerSource: "roster"` and
  `speakerConfidence: 0.6` travel with it and say what it is worth: the meeting
  UI showed this name speaking within three seconds of this utterance. That is
  an inference, not diarization, and a consumer putting the name in front of a
  human must say so.
- **Attribution is PARTIAL, deliberately.** The third utterance has no caption
  cue within `ALIGN_WINDOW_MS`, so production left it unattributed. Captions
  drop lines routinely; a fixture where every row is attributed would let a
  consumer skip the unattributed branch entirely and then meet it in
  production.
- **`diarized` is `false` in the header while rows carry names.** These are not
  in tension: `diarized` means diarization was _attempted_, and it was not
  (Decision 11). **A consumer must branch on the rows, never on this header
  field**, to decide whether it may name anyone. Branching on the header reads
  this transcript as unattributed and throws away every name in it.
- **`coveredMs + gapMs` accounts for the WHOLE meeting here**, unlike the
  telephony fixtures where the pre-consent period is uncovered by construction.
  There is no consent handoff on a browser meeting — capture starts at
  admission. A consumer that learned "the sum is always short of the call
  length" from `roadmap-sync` alone learned a telephony fact as a universal one.
- **`consentReceipt` is `null` and `transport` is `"browser"`.** The disclosure
  on this path is the notetaker's own display name in the participant list, not
  a spoken exchange, so all five receipt fields are inapplicable. `status`, not
  this field, is what separates a completed meeting from a refused one.

### Regenerating

Same as the others: edit the capture helper, run
`pnpm --filter @parley/meeting-browser exec vitest run meet-fixture`, and write
what it produces over these files. The comparison test tells you immediately
whether what you committed is what the code produces — the first run of this
capture omitted `isFinal` on its events and produced a transcript of nothing
but a header, because `writeTranscriptJsonl` drops non-final events. A
hand-authored fixture would have carried four rows production discards.
