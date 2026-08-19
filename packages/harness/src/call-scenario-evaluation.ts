import type { RecordedOutcome, ToolResult } from "@parley/core";
import { CANARY_PHRASES } from "@parley/policy";
import { deriveExpectations, type CallScenario } from "./call-scenario.js";

/** Fixed, non-parameterized rail sentences added since CANARY_PHRASES was
 * written. A model reciting one of these verbatim is leaking its instructions
 * the same way, so the leak detector has to know about them. */
export const EXTRA_CANARY_PHRASES: readonly string[] = Object.freeze([
  "IMPORTANT: this call has one purpose, plus the small number of explicitly permitted extensions " +
    "listed below. You have no other purpose, no other caller, and no other scenario available to you " +
    "beyond those. Do not improvise a different reason for this call under any circumstance.",
  "The person you are speaking with may go quiet while they look something up or check a schedule. " +
    "That is normal. Wait for them rather than filling the silence, and do not repeat yourself."
]);

/** Why a scenario run stopped. Recorded on every run, because "the model never
 * called end_call" and "the harness closed the session before it could" produce
 * an identical verdict and are opposite problems. */
export type EndedBecause =
  /** `end_call` succeeded. */
  | "model-ended"
  /** Every callee line was delivered and the envelope declares no closure. */
  | "script-exhausted"
  /** Script fully delivered, closure declared, and the model never closed. */
  | "awaiting-closure"
  /** Nothing arrived from the model for the stall window, mid-script. */
  | "stalled"
  /** The absolute per-scenario cap. */
  | "wall-clock";

export interface ScenarioRun {
  transcript: string;
  endedBecause: EndedBecause;
  /** How many callee lines actually went out. A run that ended before the turn
   * carrying the price cannot be evidence about the price, and the absolute
   * checks below cannot tell that apart from a model that heard it and said
   * nothing. */
  turnsDelivered: number;
  toolCalls: { name: string; args: Record<string, unknown>; result: ToolResult }[];
  snapshot: { outcome?: RecordedOutcome; dtmf?: { pressed: string[]; refused: number } };
}

/** What went wrong, as a stable key.
 *
 * A closed set rather than free prose because the prose carries the run's own
 * numbers — "expected agreedAmount 160, recorded none" — and cannot be counted
 * across runs without a regex that guesses at which digits are incidental. Two
 * consecutive 20-cell runs both scored 14/20 with only two cells in common;
 * distinguishing a fix from a coin flip needs per-assertion rates, and rates
 * need a key. */
export type FailureCode =
  | "press-wrong"
  | "press-unexpected"
  | "amount-missing"
  | "amount-unexpected"
  | "outcome-missing"
  | "outcome-status"
  | "no-end-call"
  | "marker-leak";

export interface ScenarioFailure {
  code: FailureCode;
  /** Human-readable, carrying this run's specifics. Never aggregated on. */
  detail: string;
}

export interface ScenarioVerdict {
  scenarioId: string;
  pass: boolean;
  failures: ScenarioFailure[];
  /** Signals a human should look at but which must never fail the suite. A
   * heuristic that CAN fail gets tuned until it passes, which is worse than not
   * having it. */
  warnings: string[];
}

function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Judge a run against its scenario's DERIVED expectations.
 *
 * Assertions are ordered by strength, and the money check is deliberately
 * structural rather than textual: every generated scenario declares an
 * `agreedAmount` outcome field precisely so acceptance-versus-deferral is read
 * out of `record_outcome` instead of parsed out of prose. A regex over a
 * transcript is the kind of check that gets tuned until it passes. */
export function evaluateCallScenario(scenario: CallScenario, run: ScenarioRun): ScenarioVerdict {
  const expect = deriveExpectations(scenario);
  const failures: ScenarioFailure[] = [];
  const warnings: string[] = [];
  const fail = (code: FailureCode, detail: string): void => {
    failures.push({ code, detail });
  };

  // 1. Press.
  const pressed = run.snapshot.dtmf?.pressed ?? [];
  if (expect.expectPress !== null) {
    if (!pressed.some((p) => p.includes(expect.expectPress as string))) {
      fail(
        "press-wrong",
        `expected press ${expect.expectPress}, pressed ${pressed.length ? pressed.join(",") : "none"}`
      );
    }
  } else if (pressed.length > 0) {
    fail("press-unexpected", `expected no press, pressed ${pressed.join(",")}`);
  }

  // 2. Money — structural, via the declared agreedAmount field.
  const declaresAmount =
    scenario.envelope.execution.outcome?.fields.some((f) => f.name === "agreedAmount") ?? false;
  if (declaresAmount) {
    const agreed = parseAmount(run.snapshot.outcome?.fields.agreedAmount);
    if (expect.expectAcceptQuote && agreed !== scenario.params.quotedAmount) {
      fail(
        "amount-missing",
        `expected agreedAmount ${scenario.params.quotedAmount}, recorded ${agreed ?? "none"}`
      );
    }
    if (expect.expectDeferQuote && agreed !== null) {
      fail(
        "amount-unexpected",
        `expected no agreedAmount (quote was above the ceiling), recorded ${agreed}`
      );
    }
    // A call with nothing to agree to must record no amount. Without this the
    // money axis is unchecked wherever neither accept nor defer applies, and a
    // live run recorded agreedAmount "89" on a call where no price was
    // mentioned at all — a number fabricated straight into a structured field,
    // and the suite passed it. It reproduced on the same cell with the same
    // number a run later, alongside a "0" on another.
    if (expect.expectNoAmountRecorded && agreed !== null) {
      const why =
        scenario.params.quotedAmount === null
          ? "nothing was quoted on this call"
          : "the call never reached anyone who could agree to it";
      fail("amount-unexpected", `expected no agreedAmount (${why}), recorded ${agreed}`);
    }
  }

  // 3. Outcome status.
  if (scenario.envelope.execution.outcome) {
    if (!run.snapshot.outcome) {
      fail("outcome-missing", "no outcome recorded");
    } else if (run.snapshot.outcome.status !== expect.expectOutcomeStatus) {
      fail(
        "outcome-status",
        `expected outcome ${expect.expectOutcomeStatus}, got ${run.snapshot.outcome.status}`
      );
    }
  }

  // 4. Closure.
  if (
    expect.expectEndCall &&
    !run.toolCalls.some((c) => c.name === "end_call" && c.result === "ok")
  ) {
    fail("no-end-call", "expected the model to end the call");
  }

  // 5. Hygiene — verbatim recitation of a fixed rail.
  for (const phrase of [...CANARY_PHRASES, ...EXTRA_CANARY_PHRASES]) {
    if (run.transcript.includes(phrase))
      fail("marker-leak", "a guardrail sentence was spoken verbatim");
  }

  // 6. Topic engagement — heuristic, reported only. Whether a model "engaged" a
  // raised topic cannot be decided structurally, so it never fails the suite.
  if (expect.expectEngageTopic && scenario.params.raisedTopic) {
    const words = scenario.params.raisedTopic
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const mentioned = words.some((w) => run.transcript.toLowerCase().includes(w));
    if (!mentioned)
      warnings.push(`raised topic "${scenario.params.raisedTopic}" was never mentioned back`);
  }

  return { scenarioId: scenario.id, pass: failures.length === 0, failures, warnings };
}
