import type { SpeakerRole } from "./types.js";

/** The transports a meeting can be conducted over.
 *
 * This is a FACT a record states about itself, not something a reader infers.
 * The consent invariant on `MeetingRecord` used to key on the presence of
 * `joinOutcome` as a proxy for "consent is not spoken on this transport", and
 * nothing anywhere enforced that proxy: a telephony record that happened to
 * carry a `joinOutcome` escaped the requirement to carry the consent receipt
 * that authorized it, silently, which is the one requirement on that record
 * that exists for a legal reason. */
export const MEETING_TRANSPORTS = ["telephony", "browser"] as const;

export type MeetingTransport = (typeof MEETING_TRANSPORTS)[number];

/** The transport a record that names none was conducted over.
 *
 * `transport` is additive: telephony was the ONLY transport that existed when
 * every record lacking the field was written, so absence is not "unknown", it
 * is "telephony". Reading it that way is what keeps every prior record and
 * fixture valid, and correctly classified, without being rewritten. */
export const DEFAULT_MEETING_TRANSPORT = "telephony" satisfies MeetingTransport;

/** The transports on which consent is obtained by SPEAKING — the agent asks
 * the room aloud and waits for a go-ahead, producing a `ConsentReceipt`.
 *
 * A browser transport is not one: it is admitted to the meeting under a
 * caller-supplied display name, and that name IS the disclosure to the room
 * (see `BrowserMeetingConfig.displayName` in `@parley/meeting-browser`). It
 * has no spoken exchange to receipt, so requiring a receipt of it would
 * demand a document that cannot exist. */
export const SPOKEN_CONSENT_TRANSPORTS = [
  "telephony"
] as const satisfies readonly MeetingTransport[];

/** Whether consent on this transport is obtained by speaking, and therefore
 * whether a completed meeting on it owes a `ConsentReceipt`.
 *
 * Takes `undefined` and resolves it through `DEFAULT_MEETING_TRANSPORT`
 * rather than making every caller remember the absence rule — a caller that
 * forgets it reads an old telephony record as if it were on some transport
 * with no obligations at all. */
export function consentIsSpoken(transport: MeetingTransport | undefined): boolean {
  const resolved: MeetingTransport = transport ?? DEFAULT_MEETING_TRANSPORT;
  return (SPOKEN_CONSENT_TRANSPORTS as readonly MeetingTransport[]).includes(resolved);
}

/** Every way an attempt to JOIN a meeting can end. Enumerated, never inferred.
 *
 * There is deliberately no catch-all member. On the telephony transport,
 * `begin_notetaking` returned one identical message for two different causes,
 * and a real live failure could not be diagnosed from the log because of it.
 * A caller that cannot say WHICH of these happened has not handled the case.
 *
 * Declared HERE, in the transport-agnostic core, rather than in the browser
 * transport that produces the values or in the record schema that validates
 * them. It was declared in both of those at once — a `readonly` tuple in
 * `@parley/meeting-browser`'s `types.ts` and the same strings retyped
 * into a `z.enum(...)` in `@parley/cli` — because the transport depends on the
 * CLI and so cannot be imported by it. Two lists that must agree and cannot
 * see each other is the same defect as a hand-mirrored JSON Schema clause:
 * both halves compile, one is wrong, and nothing says so until a record is
 * rejected downstream. Core is the one package both of them already depend on,
 * so it is the only place the list can exist once.
 *
 * The members, and what each one is a statement about:
 *
 * - `admitted` — the transport is in the meeting.
 * - `waiting_room_timeout` — admission could not be CONFIRMED before the
 *   deadline. On the browser transport this can also mean a successful join
 *   whose in-call anchors were not recognised (a non-English Meet UI does
 *   exactly that), so it is a statement about our own evidence, not about the
 *   room's decision. See the return site in `@parley/meeting-browser`'s
 *   `join-driver.ts`.
 * - `denied` / `not_started` / `auth_required` — a terminal pre-join screen
 *   was recognised and read. Each IS a statement about the room or the
 *   account.
 * - `join_error` — the join threw. No verdict was ever reached, because the
 *   attempt did not run to completion: a page that would not open, a locator
 *   that timed out, a device whose state could not be established
 *   (`DeviceStateUnknownError`). The exception itself is in the transport's
 *   own `captureFault`; this field says the meeting has no join verdict to
 *   report at all.
 *
 * `join_error` is NOT the catch-all this list refuses to have. A catch-all
 * would stand in for the four above and let a caller stop distinguishing
 * them; this one names a case none of the four covers — the difference
 * between "we asked and got an answer we did not like" and "we never got as
 * far as an answer". It exists because that case was previously written down
 * as `waiting_room_timeout`, which made one value mean three things at once:
 * a real lobby timeout, an unrecognised-locale join that in fact succeeded,
 * and a crash. A live failure in any of the three could not be told from the
 * other two, which is precisely the defect on the telephony transport that
 * made this list an enum in the first place.
 *
 * ADDITIVE. It lands on `MeetingRecord.joinOutcome`, which is optional, so no
 * record written before it existed changes meaning; `schema/`'s committed
 * projection is regenerated in the same motion, and the downstream consumer
 * resolves its schema directory to that folder and reads those files
 * directly. */
export const JOIN_OUTCOMES = [
  "admitted",
  "waiting_room_timeout",
  "denied",
  "not_started",
  "auth_required",
  "join_error"
] as const;

export type JoinOutcome = (typeof JOIN_OUTCOMES)[number];

export const CALL_MAX_DURATION_SECONDS = 1800;
export const MEETING_MAX_DURATION_SECONDS = 14400;
export const CALL_MAX_PRESSES = 20;
export const MEETING_MAX_PRESSES = 40;

export interface MeetingExecution {
  /** Declares `begin_notetaking`.
   *
   * `phrase` is what the gate looks for in the pre-consent buffer. It is
   * AUDITABLE, not authentication: without diarization nothing distinguishes
   * the principal's voice from a stranger's who heard the phrase said aloud in
   * the room. It records that the words were spoken before notetaking began.
   *
   * What actually guards against an accidental match is ORDERING, not
   * length: an utterance only counts if it arrived after the agent's own
   * request (see `findConsentMatch` in `./execution.js`). A live call found
   * this the hard way — the declared phrase was "go ahead and take notes",
   * the principal said "go ahead" several times, and a length-only gate
   * refused every one of them because a natural short reply is not a
   * substring of a four-word password. `additionalPhrases` exists for the
   * same reason: forcing a principal to recall one exact wording live is its
   * own failure mode, so any one of `phrase` or `additionalPhrases` heard
   * after the request grants consent. */
  consent: {
    phrase: string;
    /** Other utterances that also grant consent, each subject to the same
     * word-count floor and the same after-the-request ordering rule as
     * `phrase`. Optional so every existing single-phrase envelope keeps
     * working unchanged — `phrase` alone is still the common case. */
    additionalPhrases?: readonly string[];
    timeoutSeconds: number;
    onTimeout: "hangUp";
  };

  /** Context for the meeting's downstream readout — a separate repository
   * ("A2") that turns a finished meeting into a written summary. Read by
   * nothing inside Parley itself: the agent's own instructions come from
   * `policy.meeting.purpose` via `@parley/policy`'s `composePolicy`, never
   * from this block, so populating it cannot change what the model is told
   * or does on the call.
   *
   * The whole block, and every field inside it, is OPTIONAL. A meeting can
   * legitimately be dialled with nothing known about it beyond the phone
   * number — a call placed on short notice, or into a recurring bridge
   * nobody bothered to title — and forcing a caller to invent a title in
   * that case would hand A2 a fabricated one indistinguishable from a real
   * one, which is worse than a field A2 can see is simply absent. Do not
   * derive these from `Brief.objective`/`persona`: that mapping is a guess
   * dressed up as data, and it is worse than an empty field because it stops
   * reading as a gap (see `meetingRecordSchema`'s `brief` field,
   * `@parley/cli`, for the record-side half of this same rule). */
  brief?: {
    title?: string;
    topic?: string;
    role?: string;
    track?: string[];
  };
}

/* NOTE: no `announce`. The announcement is SPEECH, so the prose the room
   actually hears is composed by @parley/policy from `policy.meeting.purpose`
   (see `meetingAnnounce` in its constants.ts). This interface carried an
   `announce.purpose` that was required, validated, and read by nothing: set it,
   leave `policy.meeting.purpose` unset, and the room heard the default "take
   notes" with no error anywhere. Two fields that can disagree about the same
   fact is precisely the shape the cross-plane pairing rule exists to prevent,
   so there is now one. Execution is the BINDING plane — tools and caps — and
   what the agent says is not a binding. */

/** Bound on the pre-consent buffer. A bridge waiting room can run for many
 * minutes and everything said in it is discarded, so this exists to bound
 * memory, not to bound evidence. The NEWEST entries are kept: the go-ahead is
 * the most recent thing said, never the oldest. */
export const PRE_CONSENT_BUFFER_MAX = 500;

/** What is kept when consent is granted: the announcement, the request, and
 * the go-ahead. Everything else heard before the gate is dropped.
 *
 * A point-in-time record. It is written at minute two and relied on at minute
 * forty, for people who joined at minute twenty. Slice A accepts that; it is a
 * known limit, not an oversight. */
export interface ConsentReceipt {
  requestedAt: string;
  grantedAt: string;
  /** The PRIMARY declared phrase (`MeetingExecution.consent.phrase`) — kept
   * for compatibility with every existing reader of this field, whether or
   * not it is the one actually spoken. */
  phrase: string;
  /** Which declared phrase — `phrase` itself, or one of `additionalPhrases`
   * — was the one actually heard and matched. `phrase` alone answers "what
   * was configured"; this answers "what happened", and "one of these five
   * phrases was said" is not a record of what happened. Always one of
   * `phrase`/`additionalPhrases` verbatim, never a substring of it. */
  matchedPhrase: string;
  utterances: readonly { speaker: SpeakerRole; text: string }[];
}

/** A stretch of the meeting the transcriber did not cover.
 *
 * Frames are DROPPED while the transcriber is not ready rather than buffered,
 * so a gap is a real hole in the record and is written as one. A readout built
 * over an unmarked hole reads exactly like a readout of a complete meeting,
 * which is the failure this type exists to prevent. */
export interface TranscriptGap {
  fromMs: number;
  toMs: number;
  reason: string;
}
