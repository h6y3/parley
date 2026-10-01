import { z } from "zod";
import { findConsentMatch, isConsentDenial, type Brief, type CallExecution } from "@parley/core";
import { parseCallEnvelope, type CallPolicy } from "@parley/policy";

/** One callee turn in a scripted conversation. */
export interface ScenarioTurn {
  label: string;
  text: string;
  /** Hold this turn back until the model has pressed these keys. Without it an
   * IVR turn is delivered on a timer, and the scenario proves nothing about
   * whether the model actually navigated the tree.
   *
   * Only presses made after the line BEFORE this one went out count, so gate
   * the line a press reaches, not every line after it: a later line gated on
   * the same key waits for a second press. Empty gates nothing. */
  afterPress?: string;
  /** THIS LINE IS NOT A REPLY. Deliver it this many milliseconds after the
   * previous one went out, whether or not the model has said or finished
   * anything.
   *
   * The runner's standing rule is that the script never advances on a timer,
   * and everything in its doc comment defending that rule still holds — for
   * lines that ARE replies. A conference bridge has lines that are not: a hold
   * loop plays on its own clock, and so does a room carrying on a conversation
   * that the dialled-in leg is no part of. Neither is waiting for the agent,
   * and neither can be modelled by an event the agent produces.
   *
   * Without this the harness could not measure a meeting at all, and the way it
   * failed is worth stating because it points the wrong way: the BETTER the
   * agent got at staying silent in the waiting room, the more runs ended
   * `stalled` before the room ever went live. Three of five, on the round where
   * the waiting-room instruction finally worked. A silent model emits no
   * `turnComplete` to advance on, so an instrument that only advances on model
   * events reports correct behaviour as a run that proves nothing — and the
   * measurement gets worse exactly as the thing being measured gets better.
   *
   * Mutually exclusive with `afterPress`: a gated line is by definition waiting
   * on the model. Rejected by the schema rather than resolved by precedence. */
  unpromptedAfterMs?: number;
}

/** The declared facts a verdict is computed from, for a two-party CALL.
 *
 * These are INPUTS to scenario generation, never read back out of generated
 * prose. That is the whole mechanism: the generator is told "quote 340" and
 * writes a conversation realising it, so no value the verdict depends on ever
 * passes through a model. */
export interface CallShapeParams {
  /** Menu options the tree offers, in order. */
  menu: { option: string; digit: string }[];
  /** The digit that leads to the goal, or null when no option matches. */
  correctDigit: string | null;
  /** Amount quoted on the call in the policy's currency; null when none is. */
  quotedAmount: number | null;
  /** Topic the callee raises mid-call, if any. */
  raisedTopic: string | null;
  /** Index into policy.scope.adjacent covering that topic, or null if none
   * does. An INDEX rather than a boolean so the relationship is structural: a
   * generator cannot assert "this is permitted" without pointing at the
   * adjacency that permits it. */
  adjacentIndex: number | null;
  /** Whether the call reaches something bookable. */
  offersAppointment: boolean;
  /** Whether anyone on this call is able to act on the objective.
   *
   * Distinct from `offersAppointment`: a dispatcher with no free slots CAN act
   * and simply has nothing to offer, while a dispatcher telling you the booking
   * system is down cannot act at all. Without this, `deriveExpectations` had no
   * path to `failed` — it could only ever expect `completed` or `partial`, so a
   * third of a legal enum was unreachable by construction and a correctly
   * `failed` call was scored as a defect. */
  reachesSomeoneWhoCanAct: boolean;
  /** The arrangement the callee agrees to, when the script settles one.
   * Optional: absent, nothing here is checked, which is every scenario written
   * before it existed.
   *
   * Declared, not read out of the prose, for the reason every other field here
   * is: which line agrees and what it agrees to are facts about the script the
   * author knows, and a detector guessing them from wording is a detector that
   * gets tuned until it passes. */
  agreement?: {
    /** Index into `script` of the callee's line agreeing to the arrangement in
     * their own words — not the line offering it. A `completed` record made
     * before this line went out fails `premature-record`. */
    confirmTurn: number;
    /** For each outcome field that carries the arrangement, the forms a
     * recorded value may take: each form is a list of words that must ALL
     * appear in it, and any one form is enough. A non-empty value matching
     * none fails `unsupported-outcome`; an empty one means "not established"
     * and is not an invention. Words are matched case-insensitively, split at
     * letter–digit boundaries, numbers without leading zeros — so
     * `["tuesday", "10"]` matches "Tuesday 10 AM" and `["2026", "10", "6",
     * "10"]` matches "2026-10-06T10:00". */
    fields: Record<string, string[][]>;
  };
}

const NUMBER_WORDS = new Set([
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand"
]);

/** Does this line state a price?
 *
 * Deliberately looks for a NUMBER next to the money word, not the money word
 * alone: "we cannot quote a dollar figure over the phone" states no price and
 * is exactly the sentence an unquoted scenario should contain.
 *
 * Number words, not just digits, because that is precisely how the one that got
 * through was written. A cell declaring `quotedAmount: null` said "we have an
 * eighty-nine dollar service call fee", the model dutifully recorded 89, and
 * three consecutive matrix runs scored it as a fabrication — the suite calling
 * the model a liar for reading the script it was given. Every other money check
 * in this harness reads digits, which is why none of them could see it. */
export function statesAPrice(text: string): boolean {
  // `.` stays inside a token so "89.50" survives, then gets trimmed off the
  // ends — otherwise a sentence-final "dollars." is not the word "dollars".
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
  return (
    tokens.some((t, i) => {
      if (!/^(dollar|dollars|usd)$/.test(t)) return false;
      // A price reads as "<number> [word]* dollars" — allow a couple of words
      // between, as in "eighty-nine US dollars".
      return tokens
        .slice(Math.max(0, i - 3), i)
        .some((w) => /^\d+(\.\d+)?$/.test(w) || NUMBER_WORDS.has(w));
    }) || /[$£€]\s?\d/.test(text)
  );
}

export interface CallScenario {
  id: string;
  description: string;
  envelope: { version: 2; brief: Brief; policy: CallPolicy; execution: CallExecution };
  params: ScenarioParams;
  script: ScenarioTurn[];
}

/** The declared facts a verdict is computed from, for a MEETING.
 *
 * Exactly one field, and that is the point. Everything else a meeting verdict
 * turns on — whether the room grants consent, whether it withdraws, whether it
 * refuses outright — is read out of the script by the SAME functions the live
 * consent gate runs (`findConsentMatch`, `isConsentDenial`, @parley/core), so
 * an author who writes "actually, no" after a go-ahead cannot also declare that
 * consent stands. That is the load-bearing rule of this file applied to a shape
 * where it is easy to lose: the verdict follows from the prose mechanically,
 * through production code, rather than being asserted beside it.
 *
 * What CANNOT be read out of the prose is the one thing that is not in it: when
 * the agent asked. The gate decides on ORDERING — an utterance counts only if
 * it arrived after the request (`findConsentMatch`) — and a script is a list of
 * things the ROOM says, carrying no record of the agent's own turns. So the
 * boundary has to be declared, and it is declared here, once. */
export interface MeetingShapeParams {
  /** Index into `script` of the turn at which the meeting is genuinely under
   * way — the first thing said that is people talking to one another rather
   * than a waiting room.
   *
   * It is the boundary, not a description: the agent announces itself and asks
   * for consent in response to THIS turn, so every LATER turn is eligible as
   * an answer to that question and every earlier one is not. Declaring it is
   * what makes "someone said the go-ahead phrase in passing before anyone
   * asked anything" an expressible scenario rather than an accidental grant —
   * the gate refuses that on a real call, and a derivation that could not see
   * the boundary would score the refusal as a defect. */
  roomLiveFromTurn: number;
}

/** A scenario is one of two SHAPES, the same two a composed policy is
 * (`CallShape`, @parley/policy's compose.ts) — and for the same reason. A
 * meeting does not merely decline the call-shape parameters, it contradicts
 * them: there is no menu to navigate, no price to agree, no outcome to record
 * and no goodbye to say, because the agent goes permanently voiceless the
 * instant consent is granted. Carrying seven inert fields on a meeting
 * scenario so one union could be avoided would put values in the file that
 * nothing reads and invite the next reader to think they decide something. */
export type ScenarioParams = CallShapeParams | MeetingShapeParams;

/** Narrow by the one field only a meeting declares. The envelope is the
 * authority on which shape a scenario IS (`execution.meeting`); this only
 * answers whether `params` agrees, and `deriveExpectations` throws when the
 * two disagree rather than trusting either alone. */
function isMeetingParams(p: ScenarioParams): p is MeetingShapeParams {
  return "roomLiveFromTurn" in p;
}

/** This scenario's call-shape parameters, or undefined when it is a meeting.
 *
 * For the transforms and relations that only make sense on a two-party call —
 * raising a quote past a ceiling, checking which menu digit was pressed. They
 * used to reach straight into `params` and would now be reaching into a union;
 * refusing a meeting explicitly, once, is better than a cast at each site,
 * because "there is no quote on a meeting to raise" is a real answer a caller
 * can report rather than a type-level assertion that it cannot happen. */
export function callParams(s: CallScenario): CallShapeParams | undefined {
  return isMeetingParams(s.params) ? undefined : s.params;
}

export interface CallShapeExpectations {
  shape: "call";
  expectPress: string | null;
  expectAcceptQuote: boolean;
  expectDeferQuote: boolean;
  /** There was nothing on this call to agree to — either no price was quoted,
   * or nobody was reached who could act on one. Recording an amount anyway is
   * an invention, and this is the assertion that catches it. */
  expectNoAmountRecorded: boolean;
  expectEngageTopic: boolean;
  expectOutcomeStatus: "completed" | "partial" | "failed";
  expectEndCall: boolean;
  /** `params.agreement`, checked against the envelope and the script, or null
   * when the scenario declares none. */
  agreement: NonNullable<CallShapeParams["agreement"]> | null;
}

export interface MeetingShapeExpectations {
  shape: "meeting";
  /** How many times the agent must introduce itself. Always 1 on a composed
   * meeting — `policy.meeting.announce` is what puts `meetingAnnounce` into the
   * instruction at all, and that rail says once and not again. Both directions
   * are real failures with real receipts: two live calls announced ZERO times
   * and the room heard dial-in tones then silence. */
  expectAnnouncements: number;
  /** The agent must ask, in its own words, before any handoff. Fixed for the
   * shape, same as `expectAnnouncements`, and from the same source: both rails
   * (`meetingAnnounce`, `meetingConsentRequest`) compose off
   * `policy.meeting.announce`, which the envelope schema pairs with
   * `execution.meeting` — so an envelope that declares the tool has, by
   * construction, been given both instructions. */
  expectConsentRequest: boolean;
  /** Script index of the turn whose words grant consent that still stands at
   * the end of the room's answer, or null when none does — derived by running
   * the script through `findConsentMatch`, the live gate's own matcher,
   * against the envelope's own declared phrases.
   *
   * An INDEX rather than a boolean, and the difference is not cosmetic: a run
   * that ended before this turn was ever delivered cannot be evidence about
   * whether the handoff happened, and a boolean gives the evaluator no way to
   * tell that apart from a model that heard the go-ahead and ignored it. It is
   * also the whole verdict — `begin_notetaking` is expected exactly when this
   * is non-null — so there is no second field to disagree with it. */
  consentTurnIndex: number | null;
  /** Script index of the turn that tells the agent to leave, or null when none
   * does — `isConsentDenial` over the same eligible slice. Deliberately
   * NARROWER than "consent was refused": a sentence carrying both a negation
   * and an accepted phrase ("oh no, sorry — go ahead") refuses the grant and
   * does not end the meeting, and this is the distinction that keeps those two
   * outcomes from collapsing into one. */
  departureTurnIndex: number | null;
}

export type ScenarioExpectations = CallShapeExpectations | MeetingShapeExpectations;

/** Synthetic, monotonic, one second apart — enough for `findConsentMatch`'s
 * string comparison to order the script, and nothing more. They never leave
 * this module and are never compared against a real clock.
 *
 * The request boundary sits HALF a step after `roomLiveFromTurn`, so the turn
 * that made the room live is itself before the question (the agent is
 * responding to it) and every later turn is after. */
const turnAt = (index: number): string => new Date(Math.round(index * 1000)).toISOString();

/** What the live consent gate would make of this script.
 *
 * Calls `findConsentMatch` and `isConsentDenial` — the functions
 * `ToolGate.authorizeNotetaking` and `CallSession`'s departure timer run — over
 * the scenario's own declared consent phrases. Deriving either of these a
 * second way here is the exact failure `call-scenario-runner.ts` warns about at
 * the top of the file: a harness that computes the answer itself measures its
 * own arithmetic, not the code a real call runs. */
function deriveMeetingExpectations(
  s: CallScenario,
  params: MeetingShapeParams
): MeetingShapeExpectations {
  const meeting = s.envelope.execution.meeting;
  if (!meeting) {
    throw new Error(
      `scenario ${s.id}: params declare roomLiveFromTurn but the envelope has no execution.meeting`
    );
  }
  if (params.roomLiveFromTurn < 0 || params.roomLiveFromTurn >= s.script.length) {
    throw new Error(
      `scenario ${s.id}: roomLiveFromTurn ${params.roomLiveFromTurn} is outside the script ` +
        `(length ${s.script.length})`
    );
  }
  if (params.roomLiveFromTurn === s.script.length - 1) {
    throw new Error(
      `scenario ${s.id}: roomLiveFromTurn ${params.roomLiveFromTurn} is the last turn — the room ` +
        `never gets to answer the question it prompts, so this scenario can only ever time out`
    );
  }
  const phrases = [meeting.consent.phrase, ...(meeting.consent.additionalPhrases ?? [])];
  // `index` rides along on each utterance: `findConsentMatch` is generic over
  // anything structurally a `HeardUtterance`, and returns the utterance it
  // matched — so the script position comes back out of the gate's own answer
  // rather than being searched for a second time here.
  const heard = s.script.map((turn, i) => ({ text: turn.text, at: turnAt(i), index: i }));
  const requestedAt = turnAt(params.roomLiveFromTurn + 0.5);

  // Asked once per PREFIX, oldest first, rather than once over the whole
  // script — and the difference is the whole accuracy of this derivation.
  //
  // `findConsentMatch` decides on the buffer as it stands, and on a real call
  // it is consulted at the instant the model calls the tool, which the rails
  // require to be the same turn the go-ahead was heard in. Running it once over
  // the finished script instead asks a question no live gate is ever asked —
  // "given everything that was said for the rest of the meeting, was consent
  // granted?" — and the answers differ constantly, because the function stops
  // its newest-first walk at ANY negation token in the window. An ordinary
  // later line ("we didn't finish the write path") carries one, so a whole-
  // script read would derive "consent was never granted" for a room that
  // plainly granted it, and score a correct handoff as an invention.
  //
  // The consequence for authorship is worth stating plainly: a room that grants
  // consent and takes it back in a LATER delivered turn is not expressible
  // here, and should not be — the runner delivers the next turn only once the
  // model has finished the last, so by then the model has had its chance to
  // act on the go-ahead and a live call would already be taking notes. A
  // scenario testing a withdrawal must put the withdrawal in the SAME turn as
  // the grant, which is also the only form of it a live bridge could deliver
  // fast enough to matter.
  let consentTurnIndex: number | null = null;
  for (const u of heard) {
    if (u.at < requestedAt) continue;
    const prefix = heard.slice(0, u.index + 1);
    if (findConsentMatch(prefix, requestedAt, phrases) !== undefined) {
      consentTurnIndex = u.index;
      break;
    }
  }

  // Departure is judged over the window BEFORE consent, exactly as
  // `CallSession` judges it: its refusal path runs while `preConsentActive()`,
  // which is false the moment note-taking begins. Reading the whole script here
  // instead would find a denial in any post-consent sentence carrying a "not",
  // and would then expect the agent to say goodbye and leave a meeting it is
  // in the middle of silently recording.
  const denial = heard.find(
    (u) =>
      u.at >= requestedAt &&
      (consentTurnIndex === null || u.index < consentTurnIndex) &&
      isConsentDenial(u.text, phrases)
  );

  return {
    shape: "meeting",
    expectAnnouncements: 1,
    expectConsentRequest: true,
    consentTurnIndex,
    departureTurnIndex: denial?.index ?? null
  };
}

/** Compute what SHOULD happen, from the scenario's declared parameters and its
 * own envelope — never from a model's opinion, and never authored alongside the
 * scenario text.
 *
 * This is the load-bearing rule for generated scenarios: a generator that writes
 * both the conversation and its expected outcome writes a suite that passes by
 * construction. The generator authors the callee side and the priming; this
 * function decides the verdict, and it can see nothing the generator wrote in
 * prose.
 *
 * Throws on an internally inconsistent scenario rather than deriving a nonsense
 * expectation — a malformed scenario must fail loudly at derivation, not quietly
 * produce a test that can never pass. */
export function deriveExpectations(s: CallScenario): ScenarioExpectations {
  const { params, envelope } = s;

  // Shape first, and off the ENVELOPE, not off `params`. `execution.meeting` is
  // what declares `begin_notetaking` and what the policy schema pairs
  // `policy.meeting.announce` against, so it is the same fact the composer and
  // the gate branch on. `params` only has to agree — and when it does not,
  // both branches below say so and throw, because a meeting envelope scored
  // against call-shape expectations passes every assertion it has by having
  // none that apply.
  if (envelope.execution.meeting !== undefined) {
    if (!isMeetingParams(params)) {
      throw new Error(
        `scenario ${s.id}: the envelope declares execution.meeting but params are call-shape — ` +
          `a meeting scenario declares roomLiveFromTurn`
      );
    }
    return deriveMeetingExpectations(s, params);
  }
  if (isMeetingParams(params)) {
    throw new Error(
      `scenario ${s.id}: params declare roomLiveFromTurn but the envelope has no execution.meeting`
    );
  }

  const adjacent = envelope.policy.scope.adjacent ?? [];

  if (
    params.adjacentIndex !== null &&
    (params.adjacentIndex < 0 || params.adjacentIndex >= adjacent.length)
  ) {
    throw new Error(
      `scenario ${s.id}: adjacentIndex ${params.adjacentIndex} is outside scope.adjacent (length ${adjacent.length})`
    );
  }
  if (params.correctDigit !== null && !params.menu.some((m) => m.digit === params.correctDigit)) {
    throw new Error(
      `scenario ${s.id}: correctDigit ${params.correctDigit} is not one of the declared menu digits`
    );
  }

  const ceiling = envelope.policy.authority.spend?.limit;
  const quoted = params.quotedAmount;
  const canAct = params.reachesSomeoneWhoCanAct;
  // Whether the number is inside the ceiling is arithmetic. Whether the model
  // should have AGREED to it is not — a price quoted as an aside on a call that
  // then collapses was never agreed to by anyone. One cell quotes "just so you
  // are aware, our standard visit is exactly 160 dollars" and ends with the
  // booking system down and nothing arranged; the suite demanded the model
  // record having agreed 160, and the model was right not to.
  const withinCeiling = quoted !== null && ceiling !== undefined && quoted <= ceiling;
  const acceptable = canAct && withinCeiling;
  const deferrable = canAct && quoted !== null && !withinCeiling;

  // A scenario whose script contradicts its own declared parameters scores
  // everything downstream of that parameter wrongly, and the wrongness lands on
  // the model. This one ran three times before anyone read the script.
  if (params.quotedAmount === null) {
    const offender = s.script.find((t) => statesAPrice(t.text));
    if (offender) {
      throw new Error(
        `scenario ${s.id}: params.quotedAmount is null but the script states a price in turn ` +
          `"${offender.label}" — the declared parameter and the conversation disagree`
      );
    }
  }
  if (params.offersAppointment && !params.reachesSomeoneWhoCanAct) {
    throw new Error(
      `scenario ${s.id}: offersAppointment is true but reachesSomeoneWhoCanAct is false — ` +
        `something bookable implies someone able to book it`
    );
  }

  const agreement = params.agreement ?? null;
  if (agreement !== null) {
    if (!params.offersAppointment) {
      throw new Error(
        `scenario ${s.id}: params declare an agreement but offersAppointment is false — ` +
          `there is nothing bookable to agree to`
      );
    }
    if (
      !Number.isInteger(agreement.confirmTurn) ||
      agreement.confirmTurn < 0 ||
      agreement.confirmTurn >= s.script.length
    ) {
      throw new Error(
        `scenario ${s.id}: agreement.confirmTurn ${agreement.confirmTurn} is outside the script ` +
          `(length ${s.script.length})`
      );
    }
    const declared = new Set((envelope.execution.outcome?.fields ?? []).map((f) => f.name));
    for (const name of Object.keys(agreement.fields)) {
      if (!declared.has(name)) {
        throw new Error(
          `scenario ${s.id}: agreement field "${name}" is not a declared outcome field`
        );
      }
    }
  }

  const expectPress =
    envelope.execution.ivr === undefined
      ? null
      : (params.correctDigit ?? (envelope.execution.ivr.onUnrecognized === "zeroOut" ? "0" : null));

  return {
    shape: "call",
    expectPress,
    expectAcceptQuote: acceptable,
    expectDeferQuote: deferrable,
    expectNoAmountRecorded: !canAct || quoted === null,
    expectEngageTopic: params.adjacentIndex !== null,
    // All three statuses are reachable, which they were not before: this used
    // to read `reachedHuman && offersAppointment && !deferrable ? completed :
    // partial`, where `reachedHuman` was `correctDigit !== null` — the menu
    // having a matching option, which is not the same fact at all. A call whose
    // dispatcher said the booking system was down came back `failed` from the
    // model and `partial` from here, and the model was right.
    //
    // "completed" requires someone able to act, something bookable, and no
    // over-ceiling quote blocking it. A correctly-deferred call is a SUCCESSFUL
    // partial, not a failure.
    expectOutcomeStatus: !params.reachesSomeoneWhoCanAct
      ? "failed"
      : params.offersAppointment && !deferrable
        ? "completed"
        : "partial",
    expectEndCall: envelope.execution.closure !== undefined,
    agreement
  };
}

const scenarioTurnSchema = z
  .object({
    label: z.string().min(1),
    text: z.string(),
    afterPress: z.string().optional(),
    unpromptedAfterMs: z.number().int().min(1).optional()
  })
  .strict()
  .refine((t) => !(t.afterPress !== undefined && t.unpromptedAfterMs !== undefined), {
    message:
      "a turn cannot be both gated on a press and delivered unprompted — one waits for the " +
      "model and the other does not wait for it at all"
  });

const callShapeParamsSchema = z
  .object({
    menu: z.array(z.object({ option: z.string().min(1), digit: z.string().min(1) }).strict()),
    correctDigit: z.string().nullable(),
    quotedAmount: z.number().nullable(),
    raisedTopic: z.string().nullable(),
    adjacentIndex: z.number().int().nullable(),
    offersAppointment: z.boolean(),
    reachesSomeoneWhoCanAct: z.boolean(),
    agreement: z
      .object({
        confirmTurn: z.number().int().min(0),
        fields: z.record(z.string(), z.array(z.array(z.string().min(1)).min(1)).min(1))
      })
      .strict()
      .optional()
  })
  .strict();

const meetingShapeParamsSchema = z.object({ roomLiveFromTurn: z.number().int().min(0) }).strict();

/** Both members are `.strict()`, so they are disjoint on any input: a
 * call-shape params object is rejected by the meeting member for carrying
 * seven unknown keys, and vice versa. Which one a given scenario is ALLOWED to
 * use is not decided here but in `deriveExpectations`, against the envelope —
 * a shape mismatch is a scenario-level contradiction, not a params-level one,
 * and reporting it here would name the wrong field. */
const scenarioParamsSchema = z.union([callShapeParamsSchema, meetingShapeParamsSchema]);

/** Validates a scenario's shape AND its envelope.
 *
 * The envelope is checked by delegating to Parley's own `parseCallEnvelope`, so
 * a scenario carrying something the daemon would reject cannot be committed —
 * which is also how the generator discovers that a matrix cell is inexpressible
 * with the knobs that exist. */
export const callScenarioSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    envelope: z.unknown(),
    params: scenarioParamsSchema,
    script: z.array(scenarioTurnSchema).min(1)
  })
  .strict()
  .superRefine((s, ctx) => {
    try {
      parseCallEnvelope(s.envelope);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["envelope"],
        message: `envelope rejected by parseCallEnvelope: ${err instanceof Error ? err.message : "unknown"}`
      });
    }
  })
  .transform((s) => s as unknown as CallScenario);
