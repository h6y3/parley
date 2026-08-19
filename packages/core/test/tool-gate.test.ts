import { describe, expect, it } from "vitest";
import { ToolGate, TOOL_RESULTS, buildToolDeclarations, type CallExecution } from "../src/index.js";

const ivrExec: CallExecution = {
  ivr: { maxPresses: 3, allowedDigits: "0123456789", onUnrecognized: "zeroOut" }
};
const fullExec: CallExecution = {
  ...ivrExec,
  closure: { requireOutcomeBeforeEnd: true },
  outcome: { fields: [{ name: "appointmentStart", description: "ISO start" }] }
};

describe("declaration", () => {
  it("declares a tool only when its block is present", () => {
    expect(new ToolGate({}).declaredTools()).toEqual([]);
    expect(new ToolGate(ivrExec).declaredTools()).toEqual(["press_digits"]);
    expect(new ToolGate(fullExec).declaredTools()).toEqual([
      "press_digits",
      "end_call",
      "record_outcome"
    ]);
  });

  it("bakes the live budget and permitted keys into the press_digits description", () => {
    const decl = buildToolDeclarations(ivrExec).find((d) => d.name === "press_digits");
    expect(decl?.description).toContain("3");
    expect(decl?.description).toContain("0123456789");
  });

  it("lists every declared outcome field in the record_outcome description", () => {
    const decl = buildToolDeclarations(fullExec).find((d) => d.name === "record_outcome");
    expect(decl?.description).toContain("appointmentStart");
    expect(decl?.description).toContain("ISO start");
  });
});

describe("press gating", () => {
  it("refuses when no ivr block is declared", () => {
    expect(new ToolGate({}).authorizePress("1")).toBe("refused: tool not available");
  });

  it("refuses a digit outside the permitted set", () => {
    expect(new ToolGate(ivrExec).authorizePress("#")).toBe("refused: digit not permitted");
  });

  it("refuses an empty press", () => {
    expect(new ToolGate(ivrExec).authorizePress("")).toBe("refused: digit not permitted");
  });

  it("counts individual digits against the budget, not calls", () => {
    const g = new ToolGate(ivrExec);
    expect(g.authorizePress("12")).toBe("ok");
    g.commitPress("12");
    expect(g.authorizePress("34")).toBe("refused: press budget exhausted");
  });

  it("a carrier failure does NOT consume budget", () => {
    const g = new ToolGate(ivrExec);
    expect(g.authorizePress("1")).toBe("ok");
    expect(g.failPress()).toBe("refused: could not send");
    expect(g.authorizePress("1")).toBe("ok");
    g.commitPress("1");
    g.commitPress("2");
    g.commitPress("3");
    expect(g.authorizePress("4")).toBe("refused: press budget exhausted");
  });
});

describe("end gating", () => {
  it("refuses when no closure block is declared", () => {
    expect(new ToolGate(ivrExec).authorizeEnd()).toBe("refused: tool not available");
  });

  it("refuses ONCE when an outcome is required and none is recorded, then allows", () => {
    const g = new ToolGate(fullExec);
    expect(g.authorizeEnd()).toBe("refused: record the outcome first");
    expect(g.authorizeEnd()).toBe("ok");
  });

  it("allows immediately once an outcome exists", () => {
    const g = new ToolGate(fullExec);
    g.recordOutcome("completed", { appointmentStart: "2026-08-25T08:00" });
    expect(g.authorizeEnd()).toBe("ok");
  });

  it("allows immediately when requireOutcomeBeforeEnd is false", () => {
    const g = new ToolGate({ ...fullExec, closure: { requireOutcomeBeforeEnd: false } });
    expect(g.authorizeEnd()).toBe("ok");
  });

  it("allows immediately when closure is declared but no outcome block exists", () => {
    const g = new ToolGate({ ...ivrExec, closure: { requireOutcomeBeforeEnd: true } });
    expect(g.authorizeEnd()).toBe("ok");
  });
});

describe("outcome recording", () => {
  it("refuses when no outcome block is declared", () => {
    expect(new ToolGate(ivrExec).recordOutcome("completed", {})).toBe(
      "refused: tool not available"
    );
  });

  it("drops undeclared fields and keeps declared ones", () => {
    const g = new ToolGate(fullExec);
    expect(g.recordOutcome("completed", { appointmentStart: "X", smuggled: "Y" })).toBe("recorded");
    expect(g.snapshot().outcome?.fields).toEqual({ appointmentStart: "X" });
  });

  it("last write wins", () => {
    const g = new ToolGate(fullExec);
    g.recordOutcome("partial", { appointmentStart: "A" });
    g.recordOutcome("completed", { appointmentStart: "B" });
    expect(g.snapshot().outcome?.status).toBe("completed");
    expect(g.snapshot().outcome?.fields.appointmentStart).toBe("B");
  });
});

describe("snapshot", () => {
  it("reports presses and refusals when an ivr block exists", () => {
    const g = new ToolGate(ivrExec);
    g.authorizePress("1");
    g.commitPress("1");
    g.authorizePress("#");
    expect(g.snapshot().dtmf).toEqual({ pressed: ["1"], refused: 1 });
  });

  it("omits dtmf entirely when no ivr block exists", () => {
    expect(new ToolGate({}).snapshot().dtmf).toBeUndefined();
  });
});

describe("INJECTION GATE: every result is a declared literal", () => {
  it("no gate method can return a string outside TOOL_RESULTS", () => {
    const g = new ToolGate(fullExec);
    const produced = [
      g.authorizePress("1"),
      g.failPress(),
      g.authorizePress("#"),
      g.authorizePress(""),
      g.authorizeEnd(),
      g.recordOutcome("completed", {}),
      g.authorizeEnd(),
      new ToolGate({}).authorizePress("1"),
      new ToolGate({}).authorizeEnd(),
      new ToolGate({}).recordOutcome("failed", {})
    ];
    for (const r of produced) expect(TOOL_RESULTS).toContain(r);
  });

  it("a refusal never echoes the argument that caused it", () => {
    const g = new ToolGate(ivrExec);
    expect(g.authorizePress("999")).not.toContain("999");
  });
});

describe("record_outcome declares each field as a typed property", () => {
  // Regression guard for a measured failure: with `fields` declared as a bare
  // {type:"object"} and the names only in prose, a live model called
  // record_outcome with fields:{} after audibly agreeing a price and a date.
  it("emits one property per declared field, not an untyped bag", () => {
    const decl = buildToolDeclarations(fullExec).find((d) => d.name === "record_outcome");
    const schema = decl?.parametersJsonSchema as {
      properties: { fields: { properties?: Record<string, unknown>; required?: string[] } };
    };
    expect(Object.keys(schema.properties.fields.properties ?? {})).toEqual(["appointmentStart"]);
    expect(schema.properties.fields.required).toEqual(["appointmentStart"]);
  });

  it("carries each field's description into its property", () => {
    const decl = buildToolDeclarations(fullExec).find((d) => d.name === "record_outcome");
    const schema = decl?.parametersJsonSchema as {
      properties: { fields: { properties: Record<string, { description: string }> } };
    };
    expect(schema.properties.fields.properties.appointmentStart.description).toBe("ISO start");
  });
});

describe("press_digits tells the model what to do when no option matches", () => {
  // onUnrecognized was declared in the schema, validated, preset-defaulted and
  // read by the test harness's own expectations — and never reached the model
  // in any form. The same defect class as a provider method with no caller: a
  // knob that exists everywhere except where it would take effect. A live run
  // stalled on a menu with no matching option because the model had no idea a
  // fallback existed.
  const withMode = (mode: "zeroOut" | "waitForHuman" | "hangUp"): string =>
    buildToolDeclarations({
      ivr: { maxPresses: 4, allowedDigits: "0123456789*#", onUnrecognized: mode }
    }).find((d) => d.name === "press_digits")!.description;

  it("zeroOut tells it to press 0", () => {
    expect(withMode("zeroOut")).toContain("press 0 to reach an operator");
  });

  it("waitForHuman tells it to stay on the line rather than guess", () => {
    expect(withMode("waitForHuman")).toContain("stay on the line and wait for a person");
    expect(withMode("waitForHuman")).not.toContain("press 0");
  });

  it("hangUp tells it to end the call rather than guess", () => {
    expect(withMode("hangUp")).toContain("end the call");
    expect(withMode("hangUp")).not.toContain("press 0");
  });

  it("every mode says something — none is silently omitted", () => {
    for (const mode of ["zeroOut", "waitForHuman", "hangUp"] as const) {
      expect(withMode(mode)).toContain("If none of the options is the one you want");
    }
  });
});

/**
 * The spend ceiling was advisory-only, and a live matrix run showed exactly what
 * that buys: on three of four cells quoted 430 against a 250 ceiling, the model
 * agreed and recorded `agreedAmount: "430"` with `status: completed`. The prose
 * rail asked it not to; nothing stopped it.
 *
 * A binding counterpart cannot un-say what was said on the call — no amount of
 * server code makes a sentence unspoken. What it can do is refuse to WRITE the
 * claim down, and tell the model so while the call is still live. Everything
 * downstream acts on `record_outcome`, so a record that never carries an
 * unauthorised commitment is the difference that matters.
 */
describe("ToolGate — the spend ceiling is enforced, not merely stated", () => {
  const withCeiling = (limit: number): CallExecution => ({
    closure: { requireOutcomeBeforeEnd: true },
    outcome: {
      fields: [
        { name: "agreedAmount", description: "total agreed" },
        { name: "when", description: "date" }
      ]
    },
    spendCeiling: { field: "agreedAmount", limit }
  });

  it("refuses an amount above the ceiling", () => {
    const gate = new ToolGate(withCeiling(250));
    expect(gate.recordOutcome("completed", { agreedAmount: "430", when: "Thu" })).toBe(
      "refused: that amount is above the limit for this call"
    );
  });

  it("records nothing at all when it refuses", () => {
    // A partial write would be worse than either outcome: the caller-side system
    // would see a booked appointment and no price, and read it as free.
    const gate = new ToolGate(withCeiling(250));
    gate.recordOutcome("completed", { agreedAmount: "430", when: "Thu" });
    expect(gate.snapshot().outcome).toBeUndefined();
  });

  it("accepts an amount exactly at the ceiling", () => {
    const gate = new ToolGate(withCeiling(250));
    expect(gate.recordOutcome("completed", { agreedAmount: "250", when: "Thu" })).toBe("recorded");
  });

  it("accepts an amount below the ceiling, currency symbols and all", () => {
    const gate = new ToolGate(withCeiling(250));
    expect(gate.recordOutcome("completed", { agreedAmount: "$160.00", when: "Thu" })).toBe(
      "recorded"
    );
    expect(gate.snapshot().outcome?.fields.agreedAmount).toBe("$160.00");
  });

  it("accepts an empty amount — a correctly deferred call records no price", () => {
    const gate = new ToolGate(withCeiling(250));
    expect(gate.recordOutcome("partial", { agreedAmount: "", when: "Thu" })).toBe("recorded");
  });

  it("does not bound a value it cannot read as a number", () => {
    // Stated plainly rather than papered over: this reads digits. An amount
    // written out in words passes, and the prose rail is the only thing
    // covering that. See docs/security-model.md.
    const gate = new ToolGate(withCeiling(250));
    expect(
      gate.recordOutcome("completed", { agreedAmount: "four hundred and thirty", when: "Thu" })
    ).toBe("recorded");
  });

  it("leaves recording unchanged when no ceiling is declared", () => {
    const gate = new ToolGate({
      outcome: { fields: [{ name: "agreedAmount", description: "total agreed" }] }
    });
    expect(gate.recordOutcome("completed", { agreedAmount: "99999" })).toBe("recorded");
  });

  it("tells the model the bound before it hits it", () => {
    const decl = buildToolDeclarations(withCeiling(250)).find((d) => d.name === "record_outcome");
    expect(decl?.description).toContain("above 250");
    expect(decl?.description).toContain("refused");
  });

  it("says nothing about a ceiling when none is declared", () => {
    const decl = buildToolDeclarations({
      outcome: { fields: [{ name: "a", description: "b" }] }
    }).find((d) => d.name === "record_outcome");
    expect(decl?.description).not.toContain("refused");
  });

  it("still holds end_call's one-shot refusal after a rejected record", () => {
    // The refusal must not accidentally satisfy requireOutcomeBeforeEnd, or an
    // over-ceiling call could hang up with nothing recorded at all.
    const gate = new ToolGate(withCeiling(250));
    gate.recordOutcome("completed", { agreedAmount: "430" });
    expect(gate.authorizeEnd()).toBe("refused: record the outcome first");
  });
});

/**
 * A 20-cell live matrix had every failing cell end `awaiting-closure` — the
 * model said goodbye and stopped, leaving the line open. One cell had nothing
 * else wrong: right outcome, right amount, no hangup.
 *
 * The knock-on is worse than an open line. `requireOutcomeBeforeEnd` is armed
 * on `end_call`, so a model that never ends never gets the nudge to record —
 * and one cell that failed to close recorded nothing at all. The structured
 * record, which is the entire product of the call, is lost to a missing hangup.
 */
describe("end_call tells the model that goodbye is not a hangup", () => {
  const describeEnd = (execution: CallExecution): string =>
    buildToolDeclarations(execution).find((d) => d.name === "end_call")?.description ?? "";

  it("states the consequence the model cannot observe", () => {
    const d = describeEnd({ closure: { requireOutcomeBeforeEnd: false } });
    expect(d).toMatch(/does NOT hang up/);
    expect(d).toMatch(/stays connected until you call this/);
  });

  it("tells it not to wait for the other side to hang up", () => {
    // The common real-world case: the callee waits for the caller to end, and
    // both sides sit on an open line.
    expect(describeEnd({ closure: { requireOutcomeBeforeEnd: false } })).toMatch(
      /not wait for the other person/i
    );
  });

  it("names the outcome-first refusal when that gate is armed", () => {
    const armed = describeEnd({
      closure: { requireOutcomeBeforeEnd: true },
      outcome: { fields: [{ name: "a", description: "b" }] }
    });
    expect(armed).toMatch(/Record the outcome before you call this/);
  });

  it("says nothing about recording when there is no outcome to record", () => {
    // requireOutcomeBeforeEnd with no outcome block is inert in the gate, so
    // promising a refusal that cannot happen would be a lie to the model.
    expect(describeEnd({ closure: { requireOutcomeBeforeEnd: true } })).not.toMatch(
      /Record the outcome/
    );
  });
});

/**
 * `record_outcome`'s description names three statuses and a field set. A live
 * 20-cell matrix showed each undefined term getting filled in by the model:
 *
 *  - status was named, never defined: one call booked exactly what it set out
 *    to book and was recorded `partial`; another, where the dispatcher said the
 *    booking system was down, was recorded `failed`.
 *  - every field is `required` (which is what stopped the model calling this
 *    with an empty bag) and "leave it empty" was never made concrete, so it
 *    invented: `agreedAmount: "89"` on a call where no price was ever
 *    mentioned, and `"0"` on another.
 */
describe("record_outcome defines its terms", () => {
  const describeRecord = (execution: CallExecution): string =>
    buildToolDeclarations(execution).find((d) => d.name === "record_outcome")?.description ?? "";
  const base: CallExecution = {
    outcome: { fields: [{ name: "agreedAmount", description: "total" }] }
  };

  it("defines all three statuses rather than only naming them", () => {
    const d = describeRecord(base);
    expect(d).toMatch(/"completed" — the thing you called to arrange is arranged/);
    expect(d).toMatch(/"partial" — you reached someone and moved it forward/);
    expect(d).toMatch(/"failed" — nothing was arranged and nothing moved forward/);
  });

  it("names the empty string as the right answer, and rules out placeholders", () => {
    const d = describeRecord(base);
    expect(d).toMatch(/set it to an empty string/);
    expect(d).toMatch(/placeholder such as 0/);
  });

  it("scopes the ceiling instruction to an over-ceiling quote only", () => {
    // Without "if and only if", a model on a call where nothing was quoted read
    // the partial instruction as applying to it.
    const d = describeRecord({ ...base, spendCeiling: { field: "agreedAmount", limit: 250 } });
    expect(d).toMatch(/If — and only if — they quote a price above 250/);
  });

  it("says nothing about a ceiling when none is declared", () => {
    expect(describeRecord(base)).not.toMatch(/refused/);
  });
});

/**
 * Two prose defects a 20-cell matrix isolated after the first round of fixes,
 * both the same shape: an instruction that said what to do and never said what
 * NOT to do. Google's own function-calling guidance names vague descriptions as
 * the top cause of the wrong tool firing, and both of these were vague in
 * exactly that way.
 */
describe("descriptions name the near-miss they have to refuse", () => {
  const press = (onUnrecognized: NonNullable<CallExecution["ivr"]>["onUnrecognized"]): string =>
    buildToolDeclarations({
      ivr: { maxPresses: 4, allowedDigits: "0123456789*#", onUnrecognized }
    }).find((d) => d.name === "press_digits")?.description ?? "";

  it("refuses the closest-match press, in every fallback mode", () => {
    // "If no option matches, press 0" was in place for a full matrix and the
    // model pressed 1 for "new installations" when it wanted service
    // scheduling, twice. It had decided an option DID match.
    for (const mode of ["zeroOut", "waitForHuman", "hangUp"] as const) {
      expect(press(mode)).toMatch(/Do NOT press an option that is merely the closest match/);
    }
  });

  it("still names the mode-specific action", () => {
    expect(press("zeroOut")).toMatch(/press 0 to reach an operator/);
    expect(press("waitForHuman")).toMatch(/stay on the line/);
    expect(press("hangUp")).toMatch(/end the call/);
  });

  it("tells the model to judge status by the objective, not by what it learned", () => {
    const d =
      buildToolDeclarations({ outcome: { fields: [{ name: "a", description: "b" }] } }).find(
        (x) => x.name === "record_outcome"
      )?.description ?? "";
    expect(d).toMatch(/NOT by how much you found out/);
    expect(d).toMatch(/A question they could not answer is not a failure/);
  });
});

/* The block that lived here — "record_outcome asks to be called early, not
   last" — is superseded by the one below. It pinned an earlier wording that
   asked the model to judge when a call had "settled"; that wording is gone
   because the model kept judging the moment to be the end, or never. The
   behaviour it cared about is tested more sharply below, against an observable
   act rather than a judgement. */

describe("record_outcome names the moment, not a judgement", () => {
  const d = (): string =>
    buildToolDeclarations({ outcome: { fields: [{ name: "a", description: "b" }] } }).find(
      (x) => x.name === "record_outcome"
    )?.description ?? "";

  it("puts the record before the goodbye", () => {
    expect(d()).toMatch(/BEFORE you say goodbye/);
    expect(d()).toMatch(/not after, and not while you are wrapping up/);
  });

  it("gives the reason the model cannot observe", () => {
    expect(d()).toMatch(/may hang up at any moment/);
  });

  it("keeps re-recording explicitly safe", () => {
    // Without this, moving the record earlier trades a missing record for an
    // incomplete one.
    expect(d()).toMatch(/call this again; the most recent call is the one that counts/);
  });
});
