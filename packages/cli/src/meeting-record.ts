import {
  consentIsSpoken,
  JOIN_OUTCOMES,
  MEETING_TRANSPORTS,
  SPOKEN_CONSENT_TRANSPORTS
} from "@parley/core";
import { z } from "zod";

export const MEETING_RECORD_VERSION = 1;

/** Every consent outcome a meeting record can be classified as.
 *
 * A named constant rather than five literals inline in the `z.enum(...)`
 * because the cross-language agreement matrix (`test/schema-agreement.test.ts`)
 * has to assert that it varies EVERY member of it. Against a literal list the
 * matrix could only be compared to a second copy of the same literals, which
 * is a copy that can drift; against this it cannot. `transport` and
 * `joinOutcome` already had such a constant, in `@parley/core`; `status` is
 * declared here because it is a property of this record and of nothing else. */
export const MEETING_STATUSES = [
  "completed",
  "consent_refused",
  "consent_timeout",
  "failed",
  "never_joined"
] as const;

const consentReceiptSchema = z.object({
  requestedAt: z.string().describe("ISO-8601 UTC instant the agent asked for consent."),
  grantedAt: z
    .string()
    .describe("ISO-8601 UTC instant consent was matched — at or after requestedAt."),
  phrase: z
    .string()
    .describe(
      "The consent phrase this call's execution configured as canonical — not necessarily the " +
        "exact words the room said; see matchedPhrase for what was actually spoken."
    ),
  /** Which declared phrase actually granted consent — `phrase` itself, or
   * one of `execution.meeting.consent.additionalPhrases`. Optional (additive,
   * v1.x): a record written before multi-phrase support has no such field to
   * report, and this schema is NOT `.strict()` for exactly that reason. See
   * `ConsentReceipt.matchedPhrase` (`@parley/core`'s `meeting.ts`) — every
   * record built after this change carries it; "one of these five phrases
   * was said" is not a record of what happened. */
  matchedPhrase: z
    .string()
    .optional()
    .describe(
      "Which declared phrase the room actually said, when it differs from phrase — the room may " +
        "have used one of the meeting's configured additionalPhrases instead of the canonical one. " +
        "Absent on a record written before multi-phrase support existed, even though consent was " +
        "granted."
    ),
  utterances: z
    .array(
      z.object({
        speaker: z
          .string()
          .describe(
            'Who said this utterance: "model" for the agent, or the far end\'s speaker tag ' +
              '("participant" on a meeting).'
          ),
        text: z.string().describe("The utterance's text, as transcribed.")
      })
    )
    .describe(
      "The pre-consent exchange only, in time order — what was said before consent was matched. " +
        "This is NOT the meeting itself: the meeting's own contents live in the file transcriptPath " +
        "names, not here."
    )
});

/** The record's SHAPE, with no cross-cutting invariant applied yet.
 *
 * Deliberately not exported and deliberately not the thing anyone validates
 * against: `meetingRecordSchema` (below) is the schema, and it is this object
 * plus `MEETING_RECORD_INVARIANTS`. The split exists for one reason — an
 * invariant's runtime predicate has to be typed against the record, and the
 * record's type is inferred from the schema the invariants are attached to.
 * Declared as one expression that would be a circle TypeScript refuses to
 * infer; declared in two steps it is not, and every predicate below gets the
 * real field types, so `record.status === "complete"` is a compile error
 * rather than a check that silently never fires.
 *
 * NOT `.strict()`. The compatibility rule is additive-within-a-major with
 * unknown fields ignored, so a reader on version 1 must tolerate a field a
 * later 1.x writer added. Strictness here would make every additive change a
 * breaking one across the repo boundary. */
const meetingRecordFields = z.object({
  version: z
    .literal(MEETING_RECORD_VERSION)
    .describe(
      "This document's own schema version — always the literal 1. Not a value a producer " +
        "chooses; present so a future non-additive redesign of MeetingRecord can identify itself."
    ),
  /** Present because PARLEY_POST_CALL_COMMAND is ONE global env var fired
   * for every call. Without a discriminator the meeting readout runs on
   * ordinary phone calls and has to sniff the payload to find out. */
  kind: z
    .literal("meeting")
    .describe(
      'Always the literal "meeting" — the discriminator a reader needs because the same ' +
        "post-call hook also fires for ordinary, non-meeting calls."
    ),
  /** WHO assigns this depends on the transport, and the description says so.
   * It read "the telephony provider's identifier … assigned by the provider,
   * not Parley" — true of a dialled call and false of every browser meeting,
   * where there is no provider and `@parley/meeting-browser` mints the id
   * itself. A consumer joining records to a carrier's call logs on this field
   * had been told, in the contract, that it should; on a browser record it
   * would match nothing, and the contract would be why. */
  callId: z
    .string()
    .min(1)
    .describe(
      "An opaque identifier for this call or meeting, stable for its lifetime. WHO assigned it " +
        "depends on transport, and a consumer joining these to anything external must read that " +
        'field first. "telephony": the provider\'s own identifier for the call (its call SID), ' +
        "assigned by the provider and not by Parley, so it joins against that provider's call " +
        'logs. "browser": there is no telephony provider and no such log — Parley assigns the id ' +
        "itself when the meeting starts, and it will match no provider record anywhere. Treat " +
        "its format as opaque on both; it is not parseable and nothing downstream should try."
    ),
  startedAt: z
    .string()
    .describe(
      "ISO-8601 UTC instant the call began. The origin every other timestamp in this record, " +
        "including the consent receipt's own, is measured from."
    ),
  endedAt: z.string().describe("ISO-8601 UTC instant the call ended, captured at hangup teardown."),
  durationSeconds: z
    .number()
    .nonnegative()
    .describe(
      "Wall-clock length of the whole call, in seconds, start to end. Not the same span " +
        "gapMs/coveredMs account for — see those two fields for why the numbers don't sum."
    ),
  /** `"never_joined"` (additive, v1.x) is distinct from `"consent_refused"`:
   * the latter means the call reached the room and consent was never
   * granted; the former means the agent never got that far at all — no
   * consent receipt AND no completed model turn, so nothing was ever
   * asked. Conflating them makes `"consent_refused"` a false statement
   * about a room's wishes when the room was never reached — see
   * `classifyMeetingOutcome` (`packages/cli/src/commands.ts`) for the
   * exact classification. */
  status: z
    .enum(MEETING_STATUSES)
    .describe(
      "The meeting's consent outcome, classified from whether a consent receipt exists, how the " +
        "call ended, and modelTurnsCompleted (see classifyMeetingOutcome in commands.ts) — a " +
        "different axis from endedReason below, which describes how the call itself ended, not " +
        'what happened with consent. "completed": a consent receipt was obtained and notes were ' +
        'taken. "consent_refused": the room was reached and the agent completed at least one ' +
        'turn, but consent was never granted — a real no. "consent_timeout": the meeting\'s ' +
        'consent window expired with no decision either way. "failed": the call ended in an ' +
        'error unrelated to consent. "never_joined": the agent never completed a single turn on ' +
        "this call — nothing was ever asked, so this is NOT a refusal and must not be read as " +
        "one; it means the agent never got far enough to ask. That is the distinction that " +
        "matters most: consent_refused is a statement about the room's wishes, never_joined is " +
        "not a statement about the room at all."
    ),
  /** No `"removed"`. It was here, and nothing could produce it: a PSTN
   * carrier reports a socket close and cannot tell a host removal from a
   * hangup, so `EndReason` (@parley/core) carries no such member either. A
   * value a reader is told to expect and never sees is worse than one that
   * is absent. A host dropping the dial-in reads `far_end`. */
  endedReason: z
    .enum(["far_end", "duration_cap", "transcription_lost"])
    .describe(
      "How the underlying call/media connection itself ended — orthogonal to status above; do " +
        "not infer one from the other, a failed or consent_timeout record still typically reads " +
        'far_end here too. "far_end": the default/catch-all — covers the remote party ' +
        "disconnecting, the agent itself ending the call, an error, or the consent window timing " +
        'out; it is not a promise the other party hung up. "duration_cap": Parley\'s own ' +
        "meeting duration or silence cap was reached and the call was ended by Parley, not " +
        'either party. "transcription_lost": the transcriber connection dropped mid-meeting and ' +
        "could not be restored, so the call was ended deliberately rather than continue billing " +
        "a call that was no longer taking notes."
    ),
  /** The transport this meeting was conducted over, stated rather than
   * inferred. Optional and additive: absence means `"telephony"` (see
   * `DEFAULT_MEETING_TRANSPORT`, `@parley/core`), which is the only
   * transport that existed when every record without this field was
   * written, so no prior record or fixture had to change.
   *
   * It exists because the consent invariant needs to know whether consent
   * on this call was SPOKEN, and it used to answer that by asking whether
   * `joinOutcome` was present. Nothing enforced that proxy — a telephony
   * record carrying a `joinOutcome` for any reason escaped the requirement
   * to carry its consent receipt, which is the one requirement on this
   * record that exists for a legal reason rather than a technical one. */
  transport: z
    .enum(MEETING_TRANSPORTS)
    .optional()
    .describe(
      "How this meeting was conducted, and the field the consent rules below key on. " +
        '"telephony": a dialled call, answered by the far end, where consent is obtained by ' +
        "the agent asking the room aloud and hearing a go-ahead — such a record carries a " +
        'consentReceipt recording that exchange. "browser": the agent was admitted to a ' +
        "conference under a caller-supplied display name, and that name is the disclosure to " +
        "the room; there is no spoken exchange, so there is no consentReceipt to carry and " +
        "its absence on a completed browser meeting is correct rather than missing data. " +
        "ABSENT means telephony: this field is additive, and every record written before it " +
        "existed was on that transport. Do not read an absent transport as unknown."
    ),
  /** `JOIN_OUTCOMES` (`@parley/core`'s `meeting.ts`) rather than the same
   * string literals retyped here. The transport that produces these values
   * (`@parley/meeting-browser`) depends on this package, so it cannot be the
   * source; core is the package both already depend on. Retyped, the two
   * lists could disagree and neither compiler would notice. */
  joinOutcome: z
    .enum(JOIN_OUTCOMES)
    .optional()
    .describe(
      "How the attempt to JOIN ended — a third axis, orthogonal to both status " +
        "and endedReason. Present only on transports that must be admitted to a " +
        "meeting (a browser joining a conference); absent on a dialled call, which " +
        "is answered rather than admitted. Optional and additive: every record " +
        "written before this field existed remains valid. A failed join emits a " +
        'record with status "never_joined" and the outcome that explains it, so ' +
        "an attempt that never became a meeting is still evidence rather than silence. " +
        'What each value claims: "admitted", the transport was in the meeting. ' +
        '"denied", "not_started" and "auth_required" each mean a terminal pre-join ' +
        "screen was recognised and read, so each is a statement about the room or the " +
        'account. "waiting_room_timeout" means admission could not be CONFIRMED before ' +
        "the deadline — a statement about the producer's own evidence rather than about " +
        "the room, and on a browser transport it also covers a successful join whose " +
        "in-call markers went unrecognised (a non-English meeting UI does this). " +
        '"join_error" means the attempt threw and no verdict was ever reached at all: ' +
        "a page that would not open, a locator that timed out, a device whose state could " +
        "not be established. Do not read it as a refusal, and do not read a " +
        'waiting_room_timeout as one either. "join_error" is additive (v1.x) and was ' +
        "split out of waiting_room_timeout, which had come to mean three different " +
        "things at once. " +
        "This field means ONLY what its name says and carries no implication about " +
        "consent: read transport for that. It was briefly used as a stand-in for " +
        '"consent is not spoken here", which made a telephony record that carried one ' +
        "for any reason silently exempt from the consent rules below."
    ),
  consentReceipt: consentReceiptSchema
    .nullable()
    .describe(
      "Null on any record whose consent was not obtained by speaking: every record whose " +
        'status is not "completed", and every record on a transport with no spoken consent ' +
        "exchange (see transport above, and this schema's own allOf block, which is what " +
        "enforces this). A completed meeting on a spoken-consent transport must carry the " +
        "receipt that authorized it. " +
        "Records how consent was obtained, not what was said afterward: utterances is only the " +
        "pre-consent exchange, never a transcript of the meeting itself — the meeting's contents " +
        "live in the file transcriptPath names. matchedPhrase, when present, is the phrase the " +
        "room actually said and can differ from phrase, the record's own canonical phrase, when " +
        "the room used an alternate configured phrase instead."
    ),
  transcriptPath: z
    .string()
    .nullable()
    .describe(
      "Filesystem path, on the machine that produced this record, to the meeting's transcript — " +
        'a JSONL file: one header line, then "utterance" and "gap" rows interleaved in time ' +
        "order, with any untimed utterance appended last. Null whenever status is not " +
        '"completed" (this schema\'s own invariant forbids naming a transcript without consent). ' +
        "A consumer must tolerate both null and a path that does not resolve from wherever it " +
        "runs — this names where the file was written, not a live, portable reference. " +
        "That file has its own committed schema, schema/transcript.schema.json, which is " +
        "the authority on its rows; the sketch above is orientation, not a substitute."
    ),
  /** Sourced from the call's own `execution.meeting.brief`
   * (`@parley/policy`'s `callExecutionSchema`) — never derived from this
   * record's own fields or from `Brief` (`@parley/core`, which carries
   * `persona`/`objective`/`facts`, not a meeting title or role): mapping
   * one onto the other is fabrication with a plausibility varnish, worse
   * than an absent field because it stops reading as a gap. The whole
   * object is OMITTED — never emitted as an object of empty strings —
   * when the caller supplied no meeting brief at all: a meeting can
   * legitimately be dialled with nothing known about it beyond the phone
   * number, and forcing a caller to invent a title produces worse data
   * for the readout than an absent field would. Every field inside is
   * independently optional, so partial supply (a title with no track) is
   * valid and preserved exactly as given. */
  brief: z
    .object({
      title: z
        .string()
        .min(1)
        .optional()
        .describe(
          "What the meeting is called, exactly as the caller supplied it — for example a " +
            "calendar invite's own subject line. Absent when the caller supplied none; do not " +
            "invent one to fill the gap, and do not read absence as evidence the meeting itself " +
            "had no name, only that this record was never told one."
        ),
      topic: z
        .string()
        .min(1)
        .optional()
        .describe(
          "One line on what the meeting is actually about, distinct from title — a meeting " +
            'titled "Weekly Sync" still needs this to say what today\'s sync covers. Absent when ' +
            "the caller supplied none."
        ),
      role: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The principal\'s own role in this meeting — for example "interviewer" or "vendor" — ' +
            "so a readout can be written from the correct participant's point of view instead of " +
            "guessing it from the transcript. Describes the principal Parley is calling on " +
            "behalf of, never the calling agent itself, which has no role in the meeting beyond " +
            "taking notes. Absent when the caller supplied none."
        ),
      track: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
          "A LIST of directives naming how the readout should be shaped for this meeting — " +
            "for example which template or level of detail to use. A list, not one string: a " +
            "meeting can belong to several tracks at once, and the caller supplies as many as " +
            "apply, in no significant order. ADVISORY ONLY: a suggestion to the downstream " +
            "readout consumer, never an instruction Parley itself reads, enforces, or acts on " +
            "in any way. Absent when the caller supplied none; an empty list is rejected " +
            "rather than stored, so a present track is always non-empty."
        )
    })
    .optional()
    .describe(
      'Context for the meeting\'s downstream readout (a separate repository, "A2", that turns ' +
        "a finished meeting into a written summary) — sourced from the call's own " +
        "execution.meeting.brief and never read by anything inside Parley itself. Omitted " +
        "entirely, never emitted as an object of empty strings, when the caller's " +
        "execution.meeting.brief supplied nothing at all; a record written before this field " +
        "existed, or for a meeting whose caller supplied no brief, both simply omit this key."
    ),
  gapMs: z
    .number()
    .nonnegative()
    .describe(
      "Milliseconds, within the listening window only, during which no audio reached the " +
        "transcriber — a hole in the transcript, not in the call. The window's start depends on " +
        'the transport: on "telephony" it opens the instant consent was granted, and on ' +
        '"browser" (which has no spoken consent exchange) the instant audio capture actually ' +
        "began. " +
        "gapMs + coveredMs spans only that window, not the whole call: it is normally LESS than " +
        "durationSeconds*1000, because the time before the window opened (ringing, the greeting " +
        "and the consent ask on a phone call; the waiting room and switching captions on in a " +
        "browser meeting) is outside it and counted by neither field — that is not a bug to " +
        "reconcile. A gapMs that is large relative to coveredMs means a real stretch of what " +
        "the room said may be missing from the transcript, even though a transcript file " +
        "exists. One case is worth naming: a browser meeting whose capture never started at " +
        "all reports coveredMs 0 and the WHOLE meeting as gapMs, because there was no window " +
        "and nothing was recorded — never gapMs 0, which a reader would take for no holes."
    ),
  coveredMs: z
    .number()
    .nonnegative()
    .describe(
      "Milliseconds of audio actually delivered to the transcriber during the listening window " +
        "(see gapMs for when that window opens on each transport) — what the transcript can " +
        "vouch for. See gapMs for the accounting relationship too: together they cover only " +
        "that window, not durationSeconds, so their sum is normally less than " +
        "durationSeconds*1000 and that shortfall is expected, not missing data. It measures the " +
        "DELIVERY window rather than summing frame durations, so a capture device that stayed " +
        "open while producing silence is counted here as covered; what this field rules out is " +
        "audio that never reached the transcriber at all, not a room that said nothing."
    ),
  /** All three optional and all three pass through from the underlying
   * call's `CompletedCallRecord` verbatim — meetings are precisely the
   * calls that press digits to join a bridge (`MEETING_MAX_PRESSES = 40`
   * vs `CALL_MAX_PRESSES = 20`), so `dtmf` is meaningfully populated on
   * exactly the calls that would otherwise discard it. */
  answeredBy: z
    .enum(["human", "machine", "fax", "unknown"])
    .optional()
    .describe(
      "Who or what picked up, from the underlying call's own answering-machine detection — " +
        "passed through verbatim, and independent of the meeting's consent outcome above (a " +
        'machine-answered dial-in can still be a valid "completed" meeting record by this field ' +
        "alone). Absent when the underlying call never determined it."
    ),
  outcome: z
    .object({
      status: z
        .enum(["completed", "partial", "failed"])
        .describe(
          "The model's own claim about how the call went — a separate value from this record's " +
            "own top-level status; do not conflate the two."
        ),
      fields: z
        .record(z.string())
        .describe(
          "Only the field names the call's execution declared for record_outcome; any other key " +
            "is dropped before this record is built."
        ),
      recordedAt: z
        .string()
        .describe("ISO-8601 UTC instant the model recorded this outcome via record_outcome.")
    })
    .optional()
    .describe(
      "A structured result the model recorded via the call's record_outcome tool — a general " +
        "call-completion mechanism most meaningful on an ordinary (non-meeting) call, passed " +
        "through here verbatim and usually absent on a meeting record."
    ),
  dtmf: z
    .object({
      pressed: z.array(z.string()).describe("Digits pressed, in order."),
      refused: z
        .number()
        .describe(
          "How many press attempts were refused (press budget exhausted or a digit not " +
            "permitted)."
        )
    })
    .optional()
    .describe(
      "Digits pressed while dialing into the meeting's bridge, and how many were refused — " +
        "passed through verbatim from the underlying call record. Meaningfully populated on a " +
        "meeting specifically because reaching one means dialing into a bridge (a meeting's " +
        "press budget is double an ordinary call's), where an ordinary call's dtmf activity " +
        "would otherwise go unrecorded here."
    ),
  /** How many of the model's turns actually completed on this call — the
   * number `classifyMeetingOutcome` (`commands.ts`) actually classified
   * `status` from. Optional (additive, v1.x): a record written before this
   * field existed has none to report, same reasoning as `brief` above.
   *
   * This is the field a previous fix added to the internal
   * `CompletedCallRecord` (`@parley/server`) to drive classification but
   * never surfaced here — so a `"consent_refused"` record could not be
   * told apart, after the fact, from a `"consent_refused"` record backed
   * by a suspiciously low turn count, without reading server logs nobody
   * keeps. Passing `record.modelTurnsCompleted` correctly INTO
   * classification and never WRITING it to the artifact classification
   * produced are different bugs; this closes the second one — see
   * `runCompletedCallPostCall`. */
  modelTurnsCompleted: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "How many of the model's turns completed on this call, per the realtime provider's own " +
        "turn-complete signal — INCLUDING a turn whose only action was a tool call, with no " +
        "speech at all. A nonzero value proves the agent got a turn, not that the room ever " +
        "heard it speak: a real call has ended with this at 1 or more because the model called " +
        "a tool on its very first turn, before saying a word. This is the count " +
        "classifyMeetingOutcome (commands.ts) uses to tell never_joined (0 turns) apart from " +
        "consent_refused (1+ turns). Optional: a record written before this field existed has " +
        "none to report."
    ),
  /** Passed through verbatim from `CompletedCallRecord.realtime` and
   * `.firstModelAudioMs` (`@parley/server`). Optional (additive, v1.x): a
   * record written before a daemon could choose its realtime provider per call
   * has neither to report. */
  realtime: z
    .object({
      provider: z
        .string()
        .describe('The realtime provider that spoke on the call, e.g. "gemini" or "deepgram".'),
      model: z
        .string()
        .describe(
          "The model that provider ran. For Deepgram this is the think model (the language " +
            "model behind the voice agent), not a speech-to-text or voice model."
        )
    })
    .optional()
    .describe(
      "Which realtime provider and model conducted the call's speaking plane — on a meeting, " +
        "the pre-consent part only, since the speaking plane is retired at consent. Optional: " +
        "a record written before this field existed has none to report."
    ),
  firstModelAudioMs: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Milliseconds from startedAt to the first frame of audio the model produced — the " +
        "answer-to-first-word time, measured the same way for every provider. Absent when the " +
        "model never produced audio at all, which is a different fact from a slow first word; " +
        "also absent on a record written before this field existed."
    ),
  realtimeClose: z
    .object({
      code: z.number().describe("The WebSocket close code; 0 when the transport reported none."),
      reason: z
        .string()
        .describe("The vendor's close reason, redacted and capped at 300 characters.")
    })
    .optional()
    .describe(
      "Present only when the realtime session closed unasked — not at the consent handoff and " +
        "not as part of Parley's own hangup — e.g. a vendor ending it over depleted credits or " +
        "quota. endedReason/status read as an error alongside it. Absent on every call that " +
        "ended by our own hand."
    )
});

/** The record's own field types, as inferred from the shape above — what an
 * invariant's runtime predicate reads. Exported because
 * `MeetingRecordInvariant` names it in a public signature. */
export type MeetingRecordFields = z.infer<typeof meetingRecordFields>;

/** The JSON Schema half of one invariant: a draft-07 conditional, exactly as
 * it will appear inside `MeetingRecord.allOf` in the emitted document.
 *
 * Draft-07 `properties` constrains a key ONLY when that key is present, which
 * is load-bearing in several clauses below — an `if` that names an optional
 * field under `properties` (and does not `require` it) matches a record that
 * omits the field. Read every clause with that rule in hand. */
export interface JsonSchemaConditional {
  readonly if: Record<string, unknown>;
  readonly then: Record<string, unknown>;
}

/** ONE cross-cutting invariant of a meeting record, declared once and carrying
 * BOTH of the forms it has to exist in.
 *
 * This type exists because the two forms used to be two declarations. The zod
 * `.superRefine` was the runtime check; a hand-written `allOf` block in
 * `emit-schema.ts` was its cross-language projection, with a comment saying it
 * mirrored the refinement and nothing whatsoever making that true. It drifted
 * within a single branch: the refinement gained a carve-out, the `allOf` block
 * did not, and every browser meeting would have been rejected by the Python
 * consumer that validates against the committed file — which is to say the
 * failure lands in another repository, on live data, and not here.
 *
 * A test can only catch that drift for invariants someone remembered to write
 * a row for. So the fix is not a better test: it is that `violatedBy` and
 * `jsonSchema` are both REQUIRED members of one entry. Adding an invariant
 * with only its runtime half does not fail a test — it fails to compile, and
 * `test/schema-agreement.test.ts` proves the two derivations still agree.
 *
 * `message` is the zod issue message AND the lead of the emitted description,
 * so the sentence a developer reads in a stack trace and the sentence an A2
 * author reads in the schema cannot say different things either. */
export interface MeetingRecordInvariant {
  /** Stable identifier, for naming this invariant in a test failure. Never
   * emitted into the JSON Schema and never parsed by anything. */
  readonly id: string;
  /** What the rule requires, as one sentence in the imperative. */
  readonly message: string;
  /** WHY it holds and what a reader with no access to this repository needs
   * in order to act on it. Appended to `message` in the emitted description:
   * A2 sees no TypeScript comment, so anything omitted here does not reach
   * the only audience the JSON Schema has. Written as complete sentences,
   * punctuation included — it is appended verbatim. */
  readonly rationale: string;
  /** Where zod attaches the issue — the field a violating record is wrong
   * ABOUT, which is not always the field the predicate branches on. */
  readonly path: readonly string[];
  /** TRUE when this record BREAKS the rule. Stated as the violation rather
   * than as the rule so it reads the same way round as the `if`/`then` clause
   * beside it, where `then` is likewise what a matching record must satisfy. */
  readonly violatedBy: (record: MeetingRecordFields) => boolean;
  /** The same rule as a draft-07 conditional. Required, not optional: an
   * invariant with no cross-language form is one the consumer cannot enforce,
   * which is the exact defect this type was introduced to make impossible. */
  readonly jsonSchema: JsonSchemaConditional;
  /** Every field `violatedBy` actually reads — declared, not inferred from the
   * function body, and typed against `MeetingRecordFields`'s own keys so a
   * typo or a rename is a compile error rather than a check that silently
   * stops applying. `test/schema-agreement.test.ts` asserts this is a subset
   * of the fields its input matrix actually VARIES (more than one value in
   * `axes`), not merely a field the matrix's fixture happens to contain: a
   * field held constant across every record proves the JSON Schema clause
   * agrees with zod at that one value and says nothing about any other. Two
   * failure modes this closes: an invariant added with `axes` left untouched
   * (coverage green, the clause's behaviour at every other value unchecked),
   * and an `axes` key renamed or typo'd out from under a `reads` entry that
   * still names the old field (the field silently stops being varied, the
   * invariant that reads it silently stops being tested by anything). */
  readonly reads: readonly (keyof MeetingRecordFields)[];
}

/** Every cross-cutting invariant of a meeting record, in one table.
 *
 * `meetingRecordSchema`'s `.superRefine` iterates this; `emit-schema.ts`'s
 * `buildMeetingRecordJsonSchema` iterates the same table to build
 * `MeetingRecord.allOf`. Neither restates a rule the other declares.
 *
 * Field-level rules (a type, a `min(1)`, an enum's members) are NOT here —
 * `zodToJsonSchema` already projects those faithfully from the shape above.
 * This table is only for the checks that read more than one field, which is
 * precisely the set `zodToJsonSchema` cannot see. */
export const MEETING_RECORD_INVARIANTS: readonly MeetingRecordInvariant[] = [
  {
    id: "no-transcript-without-consent",
    message: "a call that did not obtain consent must not name a transcript",
    rationale:
      'status is the consent outcome, so any value other than "completed" means notes were ' +
      "never authorized and there is therefore no transcript to name. A record that names one " +
      "anyway is either mis-classified or points at a file it had no right to write, and a " +
      "consumer must not follow the path either way.",
    path: ["transcriptPath"],
    violatedBy: (record) => record.status !== "completed" && record.transcriptPath !== null,
    reads: ["status", "transcriptPath"],
    jsonSchema: {
      if: {
        not: {
          properties: { status: { const: "completed" } },
          required: ["status"]
        }
      },
      then: {
        properties: { transcriptPath: { type: "null" } }
      }
    }
  },
  {
    id: "completed-meeting-carries-its-receipt",
    message:
      "a completed meeting on a transport whose consent is spoken must carry the receipt that " +
      "authorized it",
    rationale:
      "a transport whose consent is spoken (currently telephony, and any record with no " +
      "transport field, which was written before any other transport existed) obtains consent " +
      "by asking the room aloud, so a completed meeting on one owes the receipt of that " +
      "exchange. A browser meeting is admitted under a caller-supplied display name, which is " +
      "the disclosure itself, and has no spoken exchange to receipt — so it is exempt because " +
      "of what its transport IS, not because of which other fields it happens to carry.",
    path: ["consentReceipt"],
    violatedBy: (record) =>
      record.status === "completed" &&
      record.consentReceipt === null &&
      consentIsSpoken(record.transport),
    reads: ["status", "consentReceipt", "transport"],
    jsonSchema: {
      if: {
        properties: {
          status: { const: "completed" },
          // Draft-07 `properties` does not constrain an absent key, so naming
          // `transport` here already matches a record that omits it — which
          // is the correct reading exactly while the DEFAULT transport is one
          // whose consent is spoken. `required` below is derived from that
          // same fact rather than written down, because it is the one place
          // these two halves could disagree about the absent case.
          transport: { enum: [...SPOKEN_CONSENT_TRANSPORTS] }
        },
        required: consentIsSpoken(undefined) ? ["status"] : ["status", "transport"]
      },
      then: {
        properties: { consentReceipt: { not: { type: "null" } } }
      }
    }
  }
];

/** The one sentence an invariant emits into the JSON Schema, built from the
 * same `message` zod raises at runtime. A function rather than a field so the
 * two can never be given different text. */
export function invariantDescription(invariant: MeetingRecordInvariant): string {
  return `${invariant.message} — ${invariant.rationale}`;
}

/** The shape above plus every invariant in the table. THIS is the schema:
 * `meetingRecordFields` alone would accept a completed meeting with no
 * receipt. */
export const meetingRecordSchema = meetingRecordFields.superRefine((record, ctx) => {
  for (const invariant of MEETING_RECORD_INVARIANTS) {
    if (!invariant.violatedBy(record)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...invariant.path],
      message: invariant.message
    });
  }
});

export type MeetingRecord = z.infer<typeof meetingRecordSchema>;

export function buildMeetingRecord(
  input: Omit<MeetingRecord, "version" | "kind"> & {
    consentReceipt?: MeetingRecord["consentReceipt"];
    transcriptPath?: MeetingRecord["transcriptPath"];
  }
): MeetingRecord {
  return meetingRecordSchema.parse({
    version: MEETING_RECORD_VERSION,
    kind: "meeting" as const,
    ...input,
    consentReceipt: input.consentReceipt ?? null,
    transcriptPath: input.transcriptPath ?? null
  });
}
