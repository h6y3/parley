import { z } from "zod";
import type { Brief, CallExecution } from "@parley/core";
import { parseCallEnvelope, type CallPolicy } from "@parley/policy";

/** One callee turn in a scripted conversation. */
export interface ScenarioTurn {
  label: string;
  text: string;
  /** Hold this turn back until the model has pressed these keys. Without it an
   * IVR turn is delivered on a timer, and the scenario proves nothing about
   * whether the model actually navigated the tree. */
  afterPress?: string;
}

/** The declared facts a verdict is computed from.
 *
 * These are INPUTS to scenario generation, never read back out of generated
 * prose. That is the whole mechanism: the generator is told "quote 340" and
 * writes a conversation realising it, so no value the verdict depends on ever
 * passes through a model. */
export interface ScenarioParams {
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

export interface ScenarioExpectations {
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

  const expectPress =
    envelope.execution.ivr === undefined
      ? null
      : (params.correctDigit ?? (envelope.execution.ivr.onUnrecognized === "zeroOut" ? "0" : null));

  return {
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
    expectEndCall: envelope.execution.closure !== undefined
  };
}

const scenarioTurnSchema = z
  .object({ label: z.string().min(1), text: z.string(), afterPress: z.string().optional() })
  .strict();

const scenarioParamsSchema = z
  .object({
    menu: z.array(z.object({ option: z.string().min(1), digit: z.string().min(1) }).strict()),
    correctDigit: z.string().nullable(),
    quotedAmount: z.number().nullable(),
    raisedTopic: z.string().nullable(),
    adjacentIndex: z.number().int().nullable(),
    offersAppointment: z.boolean(),
    reachesSomeoneWhoCanAct: z.boolean()
  })
  .strict();

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
