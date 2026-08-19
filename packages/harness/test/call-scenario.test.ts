import { describe, expect, it } from "vitest";

import {
  deriveExpectations,
  callScenarioSchema,
  statesAPrice,
  type CallScenario
} from "../src/call-scenario.js";

// spendLimit uses null, not undefined, for "no ceiling". Passing `undefined` to
// a parameter that has a default selects the DEFAULT — so an `undefined` sentinel
// would silently keep the 250 ceiling and the no-ceiling test would assert
// nothing. It caught itself on the first run.
function scenario(
  overrides: Partial<CallScenario["params"]> = {},
  spendLimit: number | null = 250
): CallScenario {
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
        authority:
          spendLimit === null
            ? {}
            : { spend: { limit: spendLimit, currency: "USD", basis: "for this visit" } },
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
            { name: "appointmentStart", description: "ISO start of the booked window" }
          ]
        },
        ...(spendLimit === null
          ? {}
          : { spendCeiling: { field: "agreedAmount", limit: spendLimit } }),
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
    script: [{ label: "menu", text: "For service, press one. For filter purchase, press two." }]
  };
}

describe("deriveExpectations", () => {
  it("expects the correct press when the tree has a matching option", () => {
    expect(deriveExpectations(scenario()).expectPress).toBe("1");
  });

  it("expects the zero-out fallback when no option matches", () => {
    expect(deriveExpectations(scenario({ correctDigit: null })).expectPress).toBe("0");
  });

  it("accepts a quote at or under the ceiling", () => {
    expect(deriveExpectations(scenario({ quotedAmount: 250 })).expectAcceptQuote).toBe(true);
  });

  it("defers a quote above the ceiling", () => {
    const e = deriveExpectations(scenario({ quotedAmount: 251 }));
    expect(e.expectAcceptQuote).toBe(false);
    expect(e.expectDeferQuote).toBe(true);
  });

  it("defers any quote when no ceiling is declared", () => {
    expect(deriveExpectations(scenario({}, null)).expectDeferQuote).toBe(true);
  });

  it("neither accepts nor defers when no amount is quoted", () => {
    const e = deriveExpectations(scenario({ quotedAmount: null }));
    expect(e.expectAcceptQuote).toBe(false);
    expect(e.expectDeferQuote).toBe(false);
  });

  it("expects engagement only when the raised topic is covered by an adjacency", () => {
    expect(deriveExpectations(scenario()).expectEngageTopic).toBe(true);
    expect(deriveExpectations(scenario({ adjacentIndex: null })).expectEngageTopic).toBe(false);
  });

  it("expects completed only when the call can actually finish", () => {
    expect(deriveExpectations(scenario()).expectOutcomeStatus).toBe("completed");
    expect(deriveExpectations(scenario({ quotedAmount: 999 })).expectOutcomeStatus).toBe("partial");
    expect(deriveExpectations(scenario({ offersAppointment: false })).expectOutcomeStatus).toBe(
      "partial"
    );
  });

  it("expects failed when nobody on the call could act", () => {
    // The third status was unreachable: this function could only ever return
    // completed or partial, so a call whose dispatcher said the booking system
    // was down came back `failed` from the model and `partial` from here — and
    // the model was right.
    const s = scenario({ offersAppointment: false, reachesSomeoneWhoCanAct: false });
    expect(deriveExpectations(s).expectOutcomeStatus).toBe("failed");
  });

  it("does not treat a missing menu option as a failure to reach anyone", () => {
    // These were the same condition until they were measured apart. A tree with
    // no matching option is a navigation fact; whether the model then reaches
    // someone able to help is a different one, decided by the script. Zeroing
    // out to a competent operator is a completed call.
    expect(deriveExpectations(scenario({ correctDigit: null })).expectOutcomeStatus).toBe(
      "completed"
    );
  });

  it("rejects a scenario claiming something bookable with nobody able to book it", () => {
    expect(() =>
      deriveExpectations(scenario({ offersAppointment: true, reachesSomeoneWhoCanAct: false }))
    ).toThrow(/implies someone able to book/);
  });

  it("an unquoted call can still complete — paid-later and unknown-cost are not failures", () => {
    expect(deriveExpectations(scenario({ quotedAmount: null })).expectOutcomeStatus).toBe(
      "completed"
    );
  });

  it("throws when adjacentIndex points outside the declared adjacency list", () => {
    expect(() => deriveExpectations(scenario({ adjacentIndex: 7 }))).toThrow(/adjacentIndex/);
  });

  it("throws when correctDigit is not one of the declared menu digits", () => {
    expect(() => deriveExpectations(scenario({ correctDigit: "9" }))).toThrow(/menu/);
  });
});

describe("callScenarioSchema", () => {
  it("accepts a well-formed scenario", () => {
    expect(() => callScenarioSchema.parse(scenario())).not.toThrow();
  });

  it("rejects a scenario whose envelope violates Parley's own cross-plane rule", () => {
    const bad = scenario();
    delete (bad.envelope.execution as { ivr?: unknown }).ivr;
    expect(() => callScenarioSchema.parse(bad)).toThrow(/parseCallEnvelope/);
  });

  it("rejects a scenario with an empty script", () => {
    expect(() => callScenarioSchema.parse({ ...scenario(), script: [] })).toThrow();
  });
});

// The silence-guard regression test that lived here has moved to
// call-scenario-runner.test.ts. It defended a timer-advance mechanism that no
// longer exists: the script now moves on events, so there is no "advance into a
// silent model" for a tool call to have to be counted as activity against. The
// behaviour it cared about — a model that presses a key and then waits is
// working correctly — is covered there, and more directly.

describe("the money axis follows what the call could achieve, not just arithmetic", () => {
  it("expects no agreed amount when the call reached nobody who could agree", () => {
    // A real cell quotes "just so you are aware, our standard visit is exactly
    // 160 dollars" and then ends with the booking system down and nothing
    // arranged. `quoted <= ceiling` is true and irrelevant: there was nothing
    // to agree to, and the suite demanded the model record having agreed.
    const s = scenario({
      offersAppointment: false,
      reachesSomeoneWhoCanAct: false,
      quotedAmount: 160
    });
    const e = deriveExpectations(s);
    expect(e.expectAcceptQuote).toBe(false);
    expect(e.expectDeferQuote).toBe(false);
    expect(e.expectNoAmountRecorded).toBe(true);
  });

  it("still expects acceptance on a call that got somewhere", () => {
    const e = deriveExpectations(scenario({ quotedAmount: 160 }));
    expect(e.expectAcceptQuote).toBe(true);
    expect(e.expectNoAmountRecorded).toBe(false);
  });

  it("still expects deferral above the ceiling", () => {
    const e = deriveExpectations(scenario({ quotedAmount: 999 }));
    expect(e.expectDeferQuote).toBe(true);
    expect(e.expectNoAmountRecorded).toBe(false);
  });

  it("expects no amount when nothing was quoted at all", () => {
    expect(deriveExpectations(scenario({ quotedAmount: null })).expectNoAmountRecorded).toBe(true);
  });
});

describe("statesAPrice", () => {
  it("sees a price written in words", () => {
    // The exact line that got through: three matrix runs scored the model as
    // fabricating an amount it had been told, because every other money check
    // in this harness reads digits.
    expect(statesAPrice("We have an eighty-nine dollar service call fee.")).toBe(true);
  });

  it("sees a price written in digits, with or without a symbol", () => {
    expect(statesAPrice("The fee is 160 dollars.")).toBe(true);
    expect(statesAPrice("It comes to $89 today.")).toBe(true);
  });

  it("does not fire on a sentence that refuses to quote one", () => {
    // The money word alone is not a price, and this is the sentence an unquoted
    // scenario is supposed to contain.
    expect(statesAPrice("We cannot quote a dollar figure until a technician sees it.")).toBe(false);
    expect(statesAPrice("There is no charge for the visit itself.")).toBe(false);
  });
});

describe("a scenario may not declare no price and then quote one", () => {
  it("throws rather than scoring the contradiction against the model", () => {
    const s = scenario({ quotedAmount: null });
    s.script = [{ label: "fee", text: "We have an eighty-nine dollar service call fee." }];
    expect(() => deriveExpectations(s)).toThrow(/states a price/);
  });
});
