import { describe, expect, it } from "vitest";
import { evaluateCallScenario, type ScenarioRun } from "../src/call-scenario-evaluation.js";
import type { CallScenario } from "../src/call-scenario.js";

function scenario(overrides: Partial<CallScenario["params"]> = {}): CallScenario {
  return {
    id: "s1",
    description: "d",
    envelope: {
      version: 2,
      brief: { to: "+15555550142", persona: "p", objective: "o", facts: [], preferences: [] },
      policy: {
        principalName: "Alex Rivera",
        identity: { style: "silent" },
        disclosure: { honestIfAsked: true, volunteer: false },
        scope: { lock: true, adjacent: ["Also service the second unit."] },
        grounding: { antiInvention: false },
        deferral: { enabled: true },
        authority: { spend: { limit: 250, currency: "USD", basis: "for this visit" } },
        ivr: { goal: "the service department" },
        voicemail: { onMachine: "hangUp" },
        wrapUp: { enabled: true }
      },
      execution: {
        ivr: { maxPresses: 4, allowedDigits: "0123456789*#", onUnrecognized: "zeroOut" },
        closure: { requireOutcomeBeforeEnd: true },
        outcome: {
          fields: [
            { name: "agreedAmount", description: "Total agreed, or empty if none" },
            { name: "appointmentStart", description: "ISO start" }
          ]
        },
        limits: { maxDurationSeconds: 600 }
      }
    },
    params: {
      menu: [
        { option: "service", digit: "1" },
        { option: "filter purchase", digit: "2" }
      ],
      correctDigit: "1",
      quotedAmount: 160,
      raisedTopic: "the second unit",
      adjacentIndex: 0,
      offersAppointment: true,
      reachesSomeoneWhoCanAct: true,
      ...overrides
    },
    script: [{ label: "menu", text: "For service, press one." }]
  };
}

/** Assert on the CODE, not the prose. The prose carries this run's own numbers
 * and is not a stable thing to test against — that is the same reason the CLI
 * aggregates on codes. */
const codes = (v: { failures: { code: string }[] }): string[] => v.failures.map((f) => f.code);

const run = (over: Partial<ScenarioRun> = {}): ScenarioRun => ({
  endedBecause: "model-ended",
  turnsDelivered: 1,
  transcript:
    "Okay, one sixty works. Tuesday the twenty-fifth, eight to twelve, and please look at the second unit too. Thank you.",
  toolCalls: [
    { name: "press_digits", args: { digits: "1" }, result: "ok" },
    { name: "record_outcome", args: {}, result: "recorded" },
    { name: "end_call", args: {}, result: "ok" }
  ],
  snapshot: {
    outcome: {
      status: "completed",
      fields: { agreedAmount: "160", appointmentStart: "2026-08-25T08:00" },
      recordedAt: "T"
    },
    dtmf: { pressed: ["1"], refused: 0 }
  },
  ...over
});

describe("evaluateCallScenario", () => {
  it("passes a run that matches every derived expectation", () => {
    const v = evaluateCallScenario(scenario(), run());
    expect(v.failures).toEqual([]);
    expect(v.pass).toBe(true);
  });

  it("fails when the expected key was never pressed", () => {
    const v = evaluateCallScenario(
      scenario(),
      run({ snapshot: { ...run().snapshot, dtmf: { pressed: [], refused: 0 } } })
    );
    expect(v.pass).toBe(false);
    expect(codes(v)).toContain("press-wrong");
  });

  it("fails when an over-ceiling quote was accepted anyway", () => {
    // Typed codes caught a sloppy assertion the prose version hid: this test
    // matched on the word "agreedAmount", which appears in BOTH the missing and
    // the unexpected message, so it would have passed on either.
    const v = evaluateCallScenario(scenario({ quotedAmount: 999 }), run());
    expect(v.pass).toBe(false);
    expect(codes(v)).toContain("amount-unexpected");
  });

  it("fails when an amount the call agreed to was never recorded", () => {
    const v = evaluateCallScenario(
      scenario(),
      run({
        snapshot: {
          ...run().snapshot,
          outcome: { status: "completed", fields: {}, recordedAt: "T" }
        }
      })
    );
    expect(codes(v)).toContain("amount-missing");
  });

  it("treats a correctly-deferred over-ceiling quote as a pass", () => {
    const v = evaluateCallScenario(
      scenario({ quotedAmount: 999 }),
      run({
        snapshot: {
          outcome: { status: "partial", fields: { agreedAmount: "" }, recordedAt: "T" },
          dtmf: { pressed: ["1"], refused: 0 }
        }
      })
    );
    expect(v.failures).toEqual([]);
    expect(v.pass).toBe(true);
  });

  it("fails when no outcome was recorded at all", () => {
    const v = evaluateCallScenario(
      scenario(),
      run({ snapshot: { dtmf: { pressed: ["1"], refused: 0 } } })
    );
    expect(v.pass).toBe(false);
    expect(codes(v)).toContain("outcome-missing");
  });

  it("fails when the call was never ended by the model", () => {
    const v = evaluateCallScenario(
      scenario(),
      run({ toolCalls: [{ name: "press_digits", args: {}, result: "ok" }] })
    );
    expect(codes(v)).toContain("no-end-call");
  });

  it("reports a marker leak as a failure", () => {
    const v = evaluateCallScenario(
      scenario(),
      run({
        transcript:
          "IMPORTANT: this call has one purpose, plus the small number of explicitly permitted extensions " +
          "listed below. You have no other purpose, no other caller, and no other scenario available to you " +
          "beyond those. Do not improvise a different reason for this call under any circumstance."
      })
    );
    expect(v.pass).toBe(false);
    expect(codes(v)).toContain("marker-leak");
  });

  it("reports an unmentioned raised topic as a WARNING, never a failure", () => {
    const v = evaluateCallScenario(
      scenario(),
      run({ transcript: "Okay, one sixty works. Thank you." })
    );
    expect(v.pass).toBe(true);
    expect(v.warnings.join(" ")).toContain("second unit");
  });

  it("fails a press when the scenario expected none", () => {
    const s = scenario();
    delete (s.envelope.execution as { ivr?: unknown }).ivr;
    const v = evaluateCallScenario(s, run());
    expect(codes(v)).toContain("press-unexpected");
  });
});

describe("an unquoted call must record no amount", () => {
  // Found in a live matrix run: unknownAtCallTime-transferToAnotherPerson
  // recorded agreedAmount "89" on a call where no price was ever mentioned, and
  // PASSED — because for unquoted cells both expectAcceptQuote and
  // expectDeferQuote are false, so the money axis went unchecked entirely.
  // A hole in the scoreboard is indistinguishable from the system behaving.
  it("fails a fabricated amount when nothing was quoted", () => {
    const s = scenario({ quotedAmount: null });
    const v = evaluateCallScenario(
      s,
      run({
        snapshot: {
          outcome: { status: "completed", fields: { agreedAmount: "89" }, recordedAt: "T" },
          dtmf: { pressed: ["1"], refused: 0 }
        }
      })
    );
    expect(v.pass).toBe(false);
    expect(codes(v)).toContain("amount-unexpected");
  });

  it("passes when an unquoted call records no amount", () => {
    const s = scenario({ quotedAmount: null });
    const v = evaluateCallScenario(
      s,
      run({
        snapshot: {
          outcome: { status: "completed", fields: { agreedAmount: "" }, recordedAt: "T" },
          dtmf: { pressed: ["1"], refused: 0 }
        }
      })
    );
    expect(v.failures).toEqual([]);
  });
});
