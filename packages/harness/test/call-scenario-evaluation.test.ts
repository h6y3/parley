import { describe, expect, it } from "vitest";
import { evaluateCallScenario, type ScenarioRun } from "../src/call-scenario-evaluation.js";
import { callScenarioSchema, deriveExpectations, type CallScenario } from "../src/call-scenario.js";

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
    // What a closure-declaring call answers since 2026-09-30: the tool results
    // say what happens next instead of a bare "recorded" / "ok".
    {
      name: "record_outcome",
      args: {},
      result:
        "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call"
    },
    { name: "end_call", args: {}, result: "ok — say nothing more" }
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

  it("a refused end_call is not an ended call", () => {
    const v = evaluateCallScenario(
      scenario(),
      run({
        toolCalls: [
          {
            name: "end_call",
            args: {},
            result:
              "refused: record the outcome first — call record_outcome now without mentioning it"
          }
        ]
      })
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

/** A call that settles one arrangement: the callee offers it, then agrees to it
 * in their own words. Measured on a billed batch: the model recorded
 * `completed` with a "Monday" the callee never offered, and the suite passed
 * it; and on most runs it recorded and hung up on the OFFER, before the
 * callee had agreed to anything. Neither was visible to any assertion. */
describe("a declared agreement is checked against the script", () => {
  const ACCEPTED =
    "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call";
  const agreed = (): CallScenario => {
    const s = scenario({
      quotedAmount: null,
      raisedTopic: null,
      adjacentIndex: 0,
      agreement: {
        confirmTurn: 2,
        fields: {
          appointmentStart: [
            ["tuesday", "10"],
            ["2026", "10", "6", "10"]
          ]
        }
      }
    });
    return {
      ...s,
      script: [
        { label: "menu", text: "For service, press one." },
        { label: "offer", text: "We have Tuesday at ten." },
        { label: "confirm", text: "Yes, that works." },
        { label: "bye", text: "Thanks, bye." }
      ]
    };
  };
  const record = (
    status: string,
    appointmentStart: string,
    turnsDelivered: number,
    result: ScenarioRun["toolCalls"][number]["result"] = ACCEPTED
  ): ScenarioRun["toolCalls"][number] => ({
    name: "record_outcome",
    args: { status, fields: { agreedAmount: "", appointmentStart } },
    result,
    turnsDelivered
  });
  const runWith = (records: ScenarioRun["toolCalls"]): ScenarioRun => {
    const last = [...records].reverse().find((r) => String(r.result).startsWith("recorded"));
    const args = last?.args as { status: "completed"; fields: Record<string, string> } | undefined;
    return run({
      turnsDelivered: 4,
      transcript: "Tuesday at ten works. Thank you, goodbye.",
      toolCalls: [
        { name: "press_digits", args: { digits: "1" }, result: "ok", turnsDelivered: 1 },
        ...records,
        {
          name: "end_call",
          args: {},
          result: "ok — say nothing more",
          turnsDelivered: 4
        }
      ],
      snapshot: {
        ...(args ? { outcome: { status: args.status, fields: args.fields, recordedAt: "T" } } : {}),
        dtmf: { pressed: ["1"], refused: 0 }
      }
    });
  };

  it("passes a record of what was offered, made after the callee agreed", () => {
    const v = evaluateCallScenario(agreed(), runWith([record("completed", "Tuesday 10 AM", 3)]));
    expect(v.failures).toEqual([]);
  });

  it("accepts any declared form of the value, such as an ISO date", () => {
    const v = evaluateCallScenario(agreed(), runWith([record("completed", "2026-10-06T10:00", 3)]));
    expect(v.failures).toEqual([]);
  });

  it("fails premature-record for a completed record made on the offer, before the agreement", () => {
    // turnsDelivered 2: the offer (index 1) is out, the confirm (index 2) is not.
    const v = evaluateCallScenario(agreed(), runWith([record("completed", "Tuesday 10 AM", 2)]));
    expect(codes(v)).toEqual(["premature-record"]);
  });

  it("does not count a partial record mid-call, re-recorded after the agreement", () => {
    const v = evaluateCallScenario(
      agreed(),
      runWith([record("partial", "", 2), record("completed", "Tuesday at 10", 3)])
    );
    expect(v.failures).toEqual([]);
  });

  it("fails unsupported-outcome for a value the callee never offered", () => {
    const v = evaluateCallScenario(
      agreed(),
      runWith([record("completed", "Monday October 5th before noon", 3)])
    );
    expect(codes(v)).toEqual(["unsupported-outcome"]);
  });

  it("fails unsupported-outcome even when a later record is right", () => {
    // The first record is what exists if the line drops in between.
    const v = evaluateCallScenario(
      agreed(),
      runWith([record("completed", "Monday 9am", 3), record("completed", "Tuesday 10am", 3)])
    );
    expect(codes(v)).toEqual(["unsupported-outcome"]);
  });

  it("treats an empty value as not established, not as an invention", () => {
    const v = evaluateCallScenario(
      agreed(),
      runWith([record("partial", "", 2), record("completed", "Tuesday 10:00", 3)])
    );
    expect(codes(v)).not.toContain("unsupported-outcome");
  });

  it("ignores a record the gate refused", () => {
    const v = evaluateCallScenario(
      agreed(),
      runWith([
        record("completed", "Monday", 2, "refused: incomplete outcome"),
        record("completed", "Tuesday 10", 3)
      ])
    );
    expect(v.failures).toEqual([]);
  });

  it("checks nothing on a scenario that declares no agreement", () => {
    const s = { ...agreed(), params: { ...agreed().params, agreement: undefined } };
    const v = evaluateCallScenario(s, runWith([record("completed", "Monday", 2)]));
    expect(codes(v)).not.toContain("premature-record");
    expect(codes(v)).not.toContain("unsupported-outcome");
  });

  it("refuses an agreement that points outside the script or at an undeclared field", () => {
    const base = agreed();
    const withAgreement = (agreement: unknown): CallScenario =>
      ({ ...base, params: { ...base.params, agreement } }) as CallScenario;
    expect(() =>
      deriveExpectations(withAgreement({ confirmTurn: 9, fields: { appointmentStart: [["x"]] } }))
    ).toThrow(/confirmTurn/);
    expect(() =>
      deriveExpectations(withAgreement({ confirmTurn: 2, fields: { nope: [["x"]] } }))
    ).toThrow(/not a declared outcome field/);
    expect(() =>
      deriveExpectations({
        ...base,
        params: { ...base.params, offersAppointment: false }
      } as CallScenario)
    ).toThrow(/offersAppointment/);
  });

  it("is accepted by the scenario schema", () => {
    // The shared fixture grants spend authority without binding a ceiling,
    // which the envelope schema refuses; that is beside the point here.
    const s = agreed();
    const valid = {
      ...s,
      envelope: { ...s.envelope, policy: { ...s.envelope.policy, authority: {} } }
    };
    expect(() => callScenarioSchema.parse(valid)).not.toThrow();
    expect(() =>
      callScenarioSchema.parse({
        ...valid,
        params: { ...valid.params, agreement: { confirmTurn: 2, fields: { x: [] } } }
      })
    ).toThrow();
  });
});
