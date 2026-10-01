import { describe, expect, it } from "vitest";
import {
  ToolGate,
  TOOL_RESULTS,
  buildToolDeclarations,
  isWhoConfirmedField,
  routeToolCall,
  type CallExecution,
  type ToolResult
} from "../src/index.js";

const ivrExec: CallExecution = {
  ivr: { maxPresses: 3, allowedDigits: "0123456789", onUnrecognized: "zeroOut" }
};
const fullExec: CallExecution = {
  ...ivrExec,
  closure: { requireOutcomeBeforeEnd: true },
  outcome: { fields: [{ name: "appointmentStart", description: "ISO start" }] }
};

/** A gate whose far end has just said yes, so the completed-record
 * confirmation rules (tested in their own blocks below) stay out of tests
 * about something else. */
const agreedGate = (execution: CallExecution): ToolGate => {
  const g = new ToolGate(execution);
  g.noteCallerSpeech("Yes, that works.", true);
  return g;
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
    const g = agreedGate(fullExec);
    expect(g.authorizeEnd()).toBe(
      "refused: record the outcome first — call record_outcome now without mentioning it"
    );
    expect(g.authorizeEnd()).toBe("ok — say nothing more");
  });

  it("allows immediately once an outcome exists", () => {
    const g = agreedGate(fullExec);
    g.recordOutcome("completed", { appointmentStart: "2026-08-25T08:00" });
    expect(g.authorizeEnd()).toBe("ok — say nothing more");
  });

  it("allows immediately when requireOutcomeBeforeEnd is false", () => {
    const g = new ToolGate({ ...fullExec, closure: { requireOutcomeBeforeEnd: false } });
    expect(g.authorizeEnd()).toBe("ok — say nothing more");
  });

  it("allows immediately when closure is declared but no outcome block exists", () => {
    const g = new ToolGate({ ...ivrExec, closure: { requireOutcomeBeforeEnd: true } });
    expect(g.authorizeEnd()).toBe("ok — say nothing more");
  });
});

describe("outcome recording", () => {
  it("refuses when no outcome block is declared", () => {
    expect(new ToolGate(ivrExec).recordOutcome("completed", {})).toBe(
      "refused: tool not available"
    );
  });

  it("drops undeclared fields and keeps declared ones", () => {
    const g = agreedGate(fullExec);
    expect(g.recordOutcome("completed", { appointmentStart: "X", smuggled: "Y" })).toBe(
      "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call"
    );
    expect(g.snapshot().outcome?.fields).toEqual({ appointmentStart: "X" });
  });

  it("last write wins", () => {
    const g = agreedGate(fullExec);
    g.recordOutcome("partial", { appointmentStart: "A" });
    g.recordOutcome("completed", { appointmentStart: "B" });
    expect(g.snapshot().outcome?.status).toBe("completed");
    expect(g.snapshot().outcome?.fields.appointmentStart).toBe("B");
  });

  it("refuses a missing declared field at the binding gate", () => {
    const g = agreedGate({
      outcome: {
        fields: [
          { name: "failureReason", description: "reason" },
          { name: "rescheduledDelivery", description: "date" }
        ]
      }
    });
    expect(g.recordOutcome("completed", { rescheduledDelivery: "Monday" })).toBe(
      "refused: incomplete outcome"
    );
    expect(g.snapshot().outcome).toBeUndefined();
  });

  it("refuses a non-string declared field but accepts an explicit empty string", () => {
    const execution: CallExecution = {
      outcome: { fields: [{ name: "failureReason", description: "reason" }] }
    };
    const g = agreedGate(execution);
    expect(g.recordOutcome("completed", { failureReason: null })).toBe(
      "refused: incomplete outcome"
    );
    expect(g.recordOutcome("completed", { failureReason: "" })).toBe("recorded");
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
    const g = agreedGate(fullExec);
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
    const gate = agreedGate(withCeiling(250));
    expect(gate.recordOutcome("completed", { agreedAmount: "430", when: "Thu" })).toBe(
      "refused: that amount is above the limit for this call"
    );
  });

  it("records nothing at all when it refuses", () => {
    // A partial write would be worse than either outcome: the caller-side system
    // would see a booked appointment and no price, and read it as free.
    const gate = agreedGate(withCeiling(250));
    gate.recordOutcome("completed", { agreedAmount: "430", when: "Thu" });
    expect(gate.snapshot().outcome).toBeUndefined();
  });

  it("accepts an amount exactly at the ceiling", () => {
    const gate = agreedGate(withCeiling(250));
    expect(gate.recordOutcome("completed", { agreedAmount: "250", when: "Thu" })).toBe(
      "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call"
    );
  });

  it("accepts an amount below the ceiling, currency symbols and all", () => {
    const gate = agreedGate(withCeiling(250));
    expect(gate.recordOutcome("completed", { agreedAmount: "$160.00", when: "Thu" })).toBe(
      "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call"
    );
    expect(gate.snapshot().outcome?.fields.agreedAmount).toBe("$160.00");
  });

  it("accepts an empty amount — a correctly deferred call records no price", () => {
    const gate = agreedGate(withCeiling(250));
    expect(gate.recordOutcome("partial", { agreedAmount: "", when: "Thu" })).toBe(
      "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call"
    );
  });

  // Review 0.4.1 minor: a range read as one run of digits ("$150-$200" →
  // 150200) was refused on every attempt. A range is held to its HIGH end.
  it.each([
    ["$150-$200", 180, false],
    ["$150-$200", 200, true],
    ["150-200", 180, false],
    ["$150 - $200", 250, true],
    ["$150 – $200", 180, false],
    ["150 to 200", 180, false],
    ["150 to 200", 200, true],
    ["$1,250", 1000, false],
    ["$1,250", 1250, true],
    ["$1,250.50", 1250, false],
    ["$1,000-$1,250", 1300, true],
    ["$160.00", 160, true]
  ] as const)("reads %j against a ceiling of %d (accepted: %s)", (amount, limit, accepted) => {
    const gate = agreedGate(withCeiling(limit));
    const result = gate.recordOutcome("completed", { agreedAmount: amount, when: "Thu" });
    if (accepted) expect(result).not.toMatch(/^refused/);
    else expect(result).toBe("refused: that amount is above the limit for this call");
  });

  it("does not bound a value it cannot read as a number", () => {
    // Stated plainly rather than papered over: this reads digits. An amount
    // written out in words passes, and the prose rail is the only thing
    // covering that. See docs/security-model.md.
    const gate = agreedGate(withCeiling(250));
    expect(
      gate.recordOutcome("completed", { agreedAmount: "four hundred and thirty", when: "Thu" })
    ).toBe(
      "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call"
    );
  });

  it("leaves recording unchanged when no ceiling is declared", () => {
    const gate = agreedGate({
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
    const gate = agreedGate(withCeiling(250));
    gate.recordOutcome("completed", { agreedAmount: "430" });
    expect(gate.authorizeEnd()).toBe(
      "refused: record the outcome first — call record_outcome now without mentioning it"
    );
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

  it("pins the exact description, with and without the outcome-first clause", () => {
    // The wording was measured, not guessed: in billed runs one model called
    // end_call ~2 s after pressing a key (it should have been waiting) and
    // another kept asking questions after the callee said goodbye. The sentence
    // that says when NOT to end is the fix, so its text is pinned exactly.
    const base =
      `End the call and hang up the line. Saying goodbye does NOT hang up — the call stays ` +
      `connected until you call this, so call it as soon as you have said goodbye and the ` +
      `conversation is complete. Do not wait for the other person to hang up.` +
      ` Never call this while waiting for the other side — after a keypress, while on hold or being transferred, or before anyone has answered. Having recorded an outcome is not a reason to end. Once they have said goodbye, ask nothing further: record what you have and end the call.`;
    expect(describeEnd({ closure: { requireOutcomeBeforeEnd: false } })).toBe(base);
    expect(
      describeEnd({
        closure: { requireOutcomeBeforeEnd: true },
        outcome: { fields: [{ name: "a", description: "b" }] }
      })
    ).toBe(
      base +
        ` Record the outcome before you call this: the first attempt to end without one is refused.`
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

/**
 * Live A/B, 2026-09-30: about five thanks and farewells at the end of one call.
 * Every tool answer starts a new spoken turn (always on Deepgram; Gemini's
 * BLOCKING tools continue the turn), and the answers gave no direction:
 * `record_outcome` returned "recorded", an accepted `end_call` returned "ok".
 * So the model recapped and thanked, recorded, heard "recorded" and thanked
 * again, ended, heard "ok" and thanked a third time — that last one spoken in
 * full, because CallSession waits for the turn after `end_call`.
 *
 * The answers now say what happens next. They are still closed literals: a
 * direction the server gives is a constant, never built from anything the
 * call said.
 */
describe("tool results say what happens next", () => {
  const recordedThenClose: ToolResult =
    "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call";
  const lineClosing: ToolResult = "ok — say nothing more";

  it("both directions are members of the closed union", () => {
    expect(TOOL_RESULTS).toContain(recordedThenClose);
    expect(TOOL_RESULTS).toContain(lineClosing);
  });

  // The direction is conditional: end_call's description says "Having recorded
  // an outcome is not a reason to end", and an unconditional "now say goodbye"
  // would contradict it on a mid-call or partial record.
  it("a record on a call that can close itself points at the goodbye and end_call", () => {
    const g = agreedGate(fullExec);
    expect(g.recordOutcome("completed", { appointmentStart: "X" })).toBe(recordedThenClose);
  });

  it("a record on a call with no end_call stays plain — it names no tool the model lacks", () => {
    const g = agreedGate({ outcome: { fields: [{ name: "a", description: "b" }] } });
    expect(g.recordOutcome("completed", { a: "x" })).toBe("recorded");
  });

  it("an accepted end_call tells the model to say nothing more", () => {
    expect(new ToolGate({ closure: { requireOutcomeBeforeEnd: false } }).authorizeEnd()).toBe(
      lineClosing
    );
  });

  it("routeToolCall answers end_call with the closing literal and still hangs up", async () => {
    const answers: ToolResult[] = [];
    let ended = 0;
    await routeToolCall({
      call: { id: "e1", name: "end_call", args: { reason: "done" } },
      gate: new ToolGate({ closure: { requireOutcomeBeforeEnd: false } }),
      carrier: {
        sendDtmf: async () => {},
        endCall: async () => {
          ended++;
        },
        beginNotetaking: async () => {}
      },
      callId: "CA-TEST",
      respond: (r) => answers.push(r)
    });
    expect(answers).toEqual([lineClosing]);
    expect(ended).toBe(1);
  });

  it("a refused end_call does not hang up", async () => {
    let ended = 0;
    const answers: ToolResult[] = [];
    await routeToolCall({
      call: { id: "e1", name: "end_call", args: {} },
      gate: new ToolGate(fullExec),
      carrier: {
        sendDtmf: async () => {},
        endCall: async () => {
          ended++;
        },
        beginNotetaking: async () => {}
      },
      callId: "CA-TEST",
      respond: (r) => answers.push(r)
    });
    expect(answers).toEqual([
      "refused: record the outcome first — call record_outcome now without mentioning it"
    ]);
    expect(ended).toBe(0);
  });

  it("every other tool's ok is unchanged", () => {
    expect(new ToolGate(ivrExec).authorizePress("1")).toBe("ok");
  });
});

/**
 * Live, Gemini 3.8, 2026-10-01: the callee offered "Monday at 9:26 a.m." and
 * the model answered, in ONE turn, "That works perfectly. So we can schedule
 * the cleaning for Monday, October 5th at 9:30 am. Thank you so much for your
 * help. Goodbye." — then recorded `completed` with 9:30 and ended the call.
 * Nobody agreed to 9:30; nobody agreed to anything after the model last spoke.
 * Three prompt-level fixes did not stop it, so the rule is enforced here: a
 * `completed` record on a two-party call needs the far end to have spoken
 * since the model last did.
 */
describe("a completed record needs them to have spoken since the model did", () => {
  const notConfirmed: ToolResult =
    "refused: they have not confirmed what you just said — read the arrangement back exactly as they said it, wait for their yes, then record; do not end the call — without mentioning this";
  const recorded: ToolResult =
    "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call";
  const outcomeFirst: ToolResult =
    "refused: record the outcome first — call record_outcome now without mentioning it";
  const closing: ToolResult = "ok — say nothing more";

  it("the refusal is a member of the closed union", () => {
    expect(TOOL_RESULTS).toContain(notConfirmed);
  });

  it("good flow: their 'yes' is the last thing said, so completed is accepted", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio(); // the read-back
    g.noteCallerSpeech("Yes, that works.", true);
    expect(g.recordOutcome("completed", { appointmentStart: "X" })).toBe(recorded);
    expect(g.snapshot().outcome?.status).toBe("completed");
  });

  it("bad flow: the model spoke after their last words, so completed is refused", () => {
    const g = new ToolGate(fullExec);
    g.noteCallerSpeech("How about Monday at 9:26?", true);
    g.noteModelAudio(); // "That works perfectly … 9:30 … Goodbye."
    expect(g.recordOutcome("completed", { appointmentStart: "Mon 9:30" })).toBe(notConfirmed);
  });

  it("before they have said anything, a completed record after model audio is refused", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    expect(g.recordOutcome("completed", { appointmentStart: "X" })).toBe(notConfirmed);
  });

  it("after a refusal, their next words let the same record through", () => {
    const g = new ToolGate(fullExec);
    g.noteCallerSpeech("How about Monday at 9:26?", true);
    g.noteModelAudio();
    expect(g.recordOutcome("completed", { appointmentStart: "X" })).toBe(notConfirmed);
    g.noteModelAudio(); // the read-back the refusal asked for
    g.noteCallerSpeech("Yes.", true);
    expect(g.recordOutcome("completed", { appointmentStart: "X" })).toBe(recorded);
  });

  it("partial and failed are never held to it", () => {
    const g = new ToolGate(fullExec);
    g.noteCallerSpeech("How about Monday at 9:26?", true);
    g.noteModelAudio();
    expect(g.recordOutcome("partial", { appointmentStart: "" })).toBe(recorded);
    expect(g.recordOutcome("failed", { appointmentStart: "" })).toBe(recorded);
  });

  it("a meeting is not gated", () => {
    const g = new ToolGate({
      ...fullExec,
      meeting: {
        consent: { phrase: "go ahead and take notes", timeoutSeconds: 180, onTimeout: "hangUp" }
      }
    });
    g.noteModelAudio();
    expect(g.recordOutcome("completed", { appointmentStart: "X" })).toBe(recorded);
  });

  // Review 0.4.1 I-A: a refusal that wrote nothing left NO outcome when the
  // callee then hung up. The refused record is kept, downgraded to `partial`
  // ("arranged, not confirmed") — the true state — and a confirmed completed
  // record replaces it.
  it("a refusal keeps the record, downgraded to partial, fields as given", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    expect(g.recordOutcome("completed", { appointmentStart: "X" })).toBe(notConfirmed);
    expect(g.snapshot().outcome?.status).toBe("partial");
    expect(g.snapshot().outcome?.fields).toEqual({ appointmentStart: "X" });

    g.recordOutcome("partial", { appointmentStart: "" });
    g.noteModelAudio();
    expect(g.recordOutcome("completed", { appointmentStart: "Y" })).toBe(notConfirmed);
    expect(g.snapshot().outcome?.status).toBe("partial");
    expect(g.snapshot().outcome?.fields.appointmentStart).toBe("Y");
  });

  it("a refusal never downgrades a completed record already accepted", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    g.noteCallerSpeech("Yes, that works.", true);
    expect(g.recordOutcome("completed", { appointmentStart: "X" })).toBe(recorded);
    g.noteModelAudio(); // "Thank you, goodbye." — then records again
    expect(g.recordOutcome("completed", { appointmentStart: "X2" })).toBe(notConfirmed);
    expect(g.snapshot().outcome?.status).toBe("completed");
    expect(g.snapshot().outcome?.fields.appointmentStart).toBe("X");
  });

  // The end_call one-shot meets this refusal. The refusal kept the record as
  // `partial`, so record-first is satisfied and end_call closes: a model that
  // hangs up anyway leaves the honest "arranged, not confirmed" behind.
  it("refused record → end_call goes through, and the record is partial", () => {
    const g = new ToolGate(fullExec);
    g.noteCallerSpeech("How about Monday at 9:26?", true);
    g.noteModelAudio();
    expect(g.recordOutcome("completed", { appointmentStart: "X" })).toBe(notConfirmed);
    expect(g.authorizeEnd()).toBe(closing);
    expect(g.snapshot().outcome?.status).toBe("partial");
    expect(g.snapshot().outcome?.fields).toEqual({ appointmentStart: "X" });
  });

  it("refused end_call (nothing recorded) → refused record → end_call goes through, partial kept", () => {
    const g = new ToolGate(fullExec);
    g.noteCallerSpeech("How about Monday at 9:26?", true);
    g.noteModelAudio();
    expect(g.authorizeEnd()).toBe(outcomeFirst);
    expect(g.recordOutcome("completed", { appointmentStart: "X" })).toBe(notConfirmed);
    expect(g.authorizeEnd()).toBe(closing);
    expect(g.snapshot().outcome?.status).toBe("partial");
  });

  // Review 0.4.1 I-A, scenario 1: the live 0.4.0 Gemini pattern. The model
  // says "That works perfectly … Goodbye." and records; the audio rule
  // refuses; it reads back; the callee, who already heard goodbye, says
  // "Mm-hmm." That has to be a yes, or the agreement rule refuses a second time.
  it("audio refusal → read-back → 'Mm-hmm.' → completed accepted, replacing the partial", () => {
    const g = new ToolGate(fullExec);
    g.noteCallerSpeech("How about Monday at 9:26?", true);
    g.noteModelAudio(); // "That works perfectly … Goodbye."
    expect(g.recordOutcome("completed", { appointmentStart: "Mon 9:26" })).toBe(notConfirmed);
    g.noteModelAudio(); // "Just to confirm: Monday at 9:26?"
    g.noteCallerSpeech("Mm-hmm.", true);
    expect(g.recordOutcome("completed", { appointmentStart: "Mon 9:26" })).toBe(recorded);
    expect(g.snapshot().outcome?.status).toBe("completed");
  });

  it("refused record → read-back → they confirm → recorded → end_call ok", () => {
    const g = new ToolGate(fullExec);
    g.noteCallerSpeech("How about Monday at 9:26?", true);
    g.noteModelAudio(); // "Monday at 9:30 works. Goodbye."
    expect(g.recordOutcome("completed", { appointmentStart: "Mon 9:30" })).toBe(notConfirmed);
    g.noteModelAudio(); // "Just to confirm: Monday at 9:26?"
    g.noteCallerSpeech("Yes, Monday at 9:26 works.", true);
    expect(g.recordOutcome("completed", { appointmentStart: "Mon 9:26" })).toBe(recorded);
    expect(g.authorizeEnd()).toBe(closing);
    expect(g.snapshot().outcome?.fields.appointmentStart).toBe("Mon 9:26");
  });

  it("routeToolCall answers the refusal and reports it on the diagnostic seam", async () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    const answers: ToolResult[] = [];
    const diagnostics: string[] = [];
    await routeToolCall({
      call: {
        id: "r1",
        name: "record_outcome",
        args: { status: "completed", fields: { appointmentStart: "X" } }
      },
      gate: g,
      carrier: {
        sendDtmf: async () => {},
        endCall: async () => {},
        beginNotetaking: async () => {}
      },
      callId: "CA-TEST",
      respond: (r) => answers.push(r),
      onDiagnostic: (m) => diagnostics.push(m)
    });
    expect(answers).toEqual([notConfirmed]);
    expect(diagnostics).toEqual([`record_outcome ${notConfirmed}`]);
  });
});

/**
 * Scenario matrix, Gemini 3.8, 2026-10-01 (4–6 of 43 model-ended runs): the
 * callee OFFERED — "We have an opening this Thursday between 1:00 PM and 4:00
 * PM that I can reserve for you." — and the model recorded `completed` before
 * saying a word, then ended the call and only then said "Thank you, that works
 * perfectly. Goodbye." The audio rule above cannot see it: nothing was said
 * after the callee's last words. So a completed record also needs the callee's
 * latest words to carry an agreement signal — refused once per call, so the
 * cost of a false refusal is one extra confirmation turn, never a trap.
 */
describe("a completed record needs their latest words to agree", () => {
  const notConfirmed: ToolResult =
    "refused: they have not confirmed what you just said — read the arrangement back exactly as they said it, wait for their yes, then record; do not end the call — without mentioning this";
  const recorded: ToolResult =
    "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call";
  const offer =
    "We have an opening this Thursday between 1:00 PM and 4:00 PM that I can reserve for you.";

  it("their offer, then a silent record: refused, and kept as partial", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio(); // "Could you fit in a visit this week?"
    g.noteCallerSpeech(offer, true);
    expect(g.recordOutcome("completed", { appointmentStart: "Thu 1-4" })).toBe(notConfirmed);
    expect(g.snapshot().outcome?.status).toBe("partial");
    expect(g.snapshot().outcome?.fields).toEqual({ appointmentStart: "Thu 1-4" });
  });

  // Review 0.4.1 I-A, scenario 2: an automated completion has no yes in it,
  // and the line drops before any read-back. The outcome must still exist.
  it("agreement refusal → they hang up → the stored outcome is partial with the fields", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    g.noteCallerSpeech("Your refill request is in the system. Goodbye.", true);
    expect(g.recordOutcome("completed", { appointmentStart: "refill" })).toBe(notConfirmed);
    expect(g.snapshot().outcome).toEqual({
      status: "partial",
      fields: { appointmentStart: "refill" },
      recordedAt: expect.any(String)
    });
  });

  it("agreement refusal → end_call is accepted, and the record is partial", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    g.noteCallerSpeech(offer, true);
    expect(g.recordOutcome("completed", { appointmentStart: "Thu 1-4" })).toBe(notConfirmed);
    expect(g.authorizeEnd()).toBe("ok — say nothing more");
    expect(g.snapshot().outcome?.status).toBe("partial");
  });

  it("agreement refusal → they confirm → completed replaces the partial", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    g.noteCallerSpeech(offer, true);
    expect(g.recordOutcome("completed", { appointmentStart: "Thu 1-4" })).toBe(notConfirmed);
    g.noteModelAudio(); // read-back
    g.noteCallerSpeech("Yes.", true);
    expect(g.recordOutcome("completed", { appointmentStart: "Thu 1-4" })).toBe(recorded);
    expect(g.snapshot().outcome?.status).toBe("completed");
  });

  it("the partial a refusal keeps blanks a who-confirmed role, as the role rule does", () => {
    const g = new ToolGate({
      closure: { requireOutcomeBeforeEnd: true },
      outcome: {
        fields: [
          { name: "newAppointment", description: "The new appointment date and time" },
          { name: "confirmedBy", description: "Who at the office confirmed it" }
        ]
      }
    });
    g.noteModelAudio();
    g.noteCallerSpeech(offer, true);
    expect(
      g.recordOutcome("completed", { newAppointment: "Thu 1-4", confirmedBy: "receptionist" })
    ).toBe(notConfirmed);
    expect(g.snapshot().outcome?.status).toBe("partial");
    expect(g.snapshot().outcome?.fields).toEqual({ newAppointment: "Thu 1-4", confirmedBy: "" });
  });

  it("a refused record over the spend ceiling is not kept, even as partial", () => {
    const g = new ToolGate({
      closure: { requireOutcomeBeforeEnd: true },
      outcome: { fields: [{ name: "agreedAmount", description: "total agreed" }] },
      spendCeiling: { field: "agreedAmount", limit: 250 }
    });
    g.noteModelAudio();
    g.noteCallerSpeech("It'll be $430, I can book you Thursday.", true);
    expect(g.recordOutcome("completed", { agreedAmount: "$430" })).toBe(notConfirmed);
    expect(g.snapshot().outcome).toBeUndefined();
  });

  it.each([
    "Yes, that works.",
    "You're all set for Tuesday.",
    "you’re all set",
    "Okay.",
    "Sounds good, see you then.",
    "That's right.",
    "Great, I've booked it.",
    "Alright, it's reserved.",
    // Review 0.4.1 I-A: real confirmations the first list missed.
    "Mm-hmm.",
    "Mmhmm",
    "mm hmm",
    "Mhm.",
    "Uh-huh.",
    "uh huh",
    "Uhhuh.",
    "That's fine.",
    "That is fine.",
    "Fine.",
    "That'll work.",
    "That will work.",
    "Ten works.",
    "Tuesday works for us.",
    "That is right.",
    "That's correct.",
    "Tuesday at ten it is.",
    "Okay then, ten it is!",
    "You're on the books for Tuesday.",
    "We'll see him then.",
    "See her then.",
    "I've rescheduled you for Tuesday.",
    "Your request has been received.",
    "Noted, Tuesday at ten.",
    "That's good.",
    "Sounds good.",
    "Thursday at two? Yes, that works."
  ])("their %j, then a silent record: accepted", (line) => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio(); // the read-back
    g.noteCallerSpeech(line, true);
    expect(g.recordOutcome("completed", { appointmentStart: "Tue 10am" })).toBe(recorded);
  });

  it.each([
    offer,
    "I can book you in for Thursday at two.",
    "We're fully booked on Monday, but Tuesday is open.",
    "I'm not sure we have anything Friday.",
    "Right now the earliest is Thursday.",
    "Let me make sure — how about Thursday?",
    "Yesterday was busy, how about Thursday?",
    // Review 0.4.1 I-A: misfires the matcher must not take for a yes.
    "We're booked on Monday.",
    "Sorry, we're all booked that day.",
    "I can't say yes to that.",
    "I can book you Wednesday, is that okay?",
    "Does Thursday work for you?",
    "That doesn't work.",
    "That won't work for us.",
    "No, that wouldn't work.",
    "Nothing works on Monday.",
    "We don't have anything on the books for Monday.",
    "Whatever it is, we can't do Monday.",
    "That's not good for us.",
    "Fine dining is upstairs, how about Thursday?"
  ])("%j carries no agreement signal", (line) => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    g.noteCallerSpeech(line, true);
    expect(g.recordOutcome("completed", { appointmentStart: "Thu" })).toBe(notConfirmed);
  });

  it("one-shot: after one refusal, the next attempt is accepted even without a yes", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    g.noteCallerSpeech(offer, true);
    expect(g.recordOutcome("completed", { appointmentStart: "Thu 1-4" })).toBe(notConfirmed);
    g.noteModelAudio(); // "Just to confirm: Thursday between one and four?"
    g.noteCallerSpeech("Mm-hm, Thursday one to four.", true);
    expect(g.recordOutcome("completed", { appointmentStart: "Thu 1-4" })).toBe(recorded);
  });

  it("Gemini fragments: the caller's words since the model last spoke are read as one", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    g.noteCallerSpeech("Ye", false);
    g.noteCallerSpeech("s, that works", false);
    expect(g.recordOutcome("completed", { appointmentStart: "Tue" })).toBe(recorded);
  });

  it("Gemini fragments are joined as they came: a word split across two is one word", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    g.noteCallerSpeech("Ye", false);
    g.noteCallerSpeech("p.", false);
    expect(g.recordOutcome("completed", { appointmentStart: "Tue" })).toBe(recorded);
  });

  it("whole utterances are joined as separate words, not run together", () => {
    const g = new ToolGate(fullExec);
    g.noteModelAudio();
    g.noteCallerSpeech("Okay", true);
    g.noteCallerSpeech("Thursday then.", true);
    expect(g.recordOutcome("completed", { appointmentStart: "Thu" })).toBe(recorded);
  });

  it("a yes from before the model last spoke does not count", () => {
    const g = new ToolGate(fullExec);
    g.noteCallerSpeech("Yes, hello.", true);
    g.noteModelAudio(); // "Can we move it to Thursday?"
    g.noteCallerSpeech("I can do Thursday at two.", true);
    expect(g.recordOutcome("completed", { appointmentStart: "Thu 2pm" })).toBe(notConfirmed);
  });

  it("a meeting is not gated", () => {
    const g = new ToolGate({
      ...fullExec,
      meeting: {
        consent: { phrase: "go ahead and take notes", timeoutSeconds: 180, onTimeout: "hangUp" }
      }
    });
    g.noteCallerSpeech(offer, true);
    expect(g.recordOutcome("completed", { appointmentStart: "X" })).toBe(recorded);
  });

  it("partial and failed are never held to it", () => {
    const g = new ToolGate(fullExec);
    g.noteCallerSpeech(offer, true);
    expect(g.recordOutcome("partial", { appointmentStart: "" })).toBe(recorded);
    expect(g.recordOutcome("failed", { appointmentStart: "" })).toBe(recorded);
  });
});

/**
 * Replay, Gemini 3.8, 2026-10-01 (gate-926, 8/8 runs): the callee said "Yes,
 * Monday at 9:26 works.", the model asked who it was speaking with, the callee
 * said "Sam." — and the first completed record, carrying confirmedBy "Sam",
 * was refused because "Sam." agrees to nothing. The name answer is not where
 * the agreement lives; the words before it are.
 */
describe("a completed record after the name answer reads the words before it", () => {
  const whoExec: CallExecution = {
    closure: { requireOutcomeBeforeEnd: true },
    outcome: {
      fields: [
        { name: "newAppointment", description: "The new appointment date and time" },
        { name: "confirmedBy", description: "Who at the office confirmed it" }
      ]
    }
  };
  const noWhoExec: CallExecution = {
    closure: { requireOutcomeBeforeEnd: true },
    outcome: { fields: [{ name: "newAppointment", description: "The new appointment" }] }
  };
  const notConfirmed: ToolResult =
    "refused: they have not confirmed what you just said — read the arrangement back exactly as they said it, wait for their yes, then record; do not end the call — without mentioning this";
  const recorded: ToolResult =
    "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call";

  it('their yes → the name question → "Sam." → completed, confirmedBy Sam: accepted', () => {
    const g = new ToolGate(whoExec);
    g.noteModelAudio(); // "Could we do Monday at 9:26?"
    g.noteCallerSpeech("Yes, Monday at 9:26 works.", true);
    g.noteModelAudio(); // "Great. And who am I speaking with?"
    g.noteModelAudio();
    g.noteCallerSpeech("Sam.", true);
    expect(g.recordOutcome("completed", { newAppointment: "Mon 9:26", confirmedBy: "Sam" })).toBe(
      recorded
    );
    expect(g.snapshot().outcome?.status).toBe("completed");
    expect(g.snapshot().outcome?.fields.confirmedBy).toBe("Sam");
  });

  it.each(["sam", "  SAM!  ", "Sam Lee", "this is Sam"])(
    "the name matches case-, space- and punctuation-insensitively, any word of it (%j)",
    (value) => {
      const g = new ToolGate(whoExec);
      g.noteModelAudio();
      g.noteCallerSpeech("Yes, Monday at 9:26 works.", true);
      g.noteModelAudio();
      g.noteCallerSpeech("It's Sam.", true);
      expect(g.recordOutcome("completed", { newAppointment: "Mon", confirmedBy: value })).toBe(
        recorded
      );
    }
  );

  it('their offer → the name question → "Sam here.": refused — the words before are an offer', () => {
    const g = new ToolGate(whoExec);
    g.noteModelAudio();
    g.noteCallerSpeech("We have Thursday 1 to 4.", true);
    g.noteModelAudio(); // "Who am I speaking with?"
    g.noteCallerSpeech("Sam here.", true);
    expect(g.recordOutcome("completed", { newAppointment: "Thu 1-4", confirmedBy: "Sam" })).toBe(
      notConfirmed
    );
    expect(g.snapshot().outcome?.status).toBe("partial");
  });

  it("the latest words do not hold the recorded name: unchanged, refused", () => {
    const g = new ToolGate(whoExec);
    g.noteModelAudio();
    g.noteCallerSpeech("Yes, Monday at 9:26 works.", true);
    g.noteModelAudio();
    g.noteCallerSpeech("Sam.", true);
    expect(g.recordOutcome("completed", { newAppointment: "Mon", confirmedBy: "Maria" })).toBe(
      notConfirmed
    );
  });

  it('a short word of the name does not count as the name ("I" in "Sam I")', () => {
    const g = new ToolGate(whoExec);
    g.noteModelAudio();
    g.noteCallerSpeech("Yes, Monday at 9:26 works.", true);
    g.noteModelAudio();
    g.noteCallerSpeech("I can do Thursday instead.", true);
    expect(g.recordOutcome("completed", { newAppointment: "Thu", confirmedBy: "Sam I" })).toBe(
      notConfirmed
    );
  });

  it("confirmedBy empty: unchanged, refused", () => {
    const g = new ToolGate(whoExec);
    g.noteModelAudio();
    g.noteCallerSpeech("Yes, Monday at 9:26 works.", true);
    g.noteModelAudio();
    g.noteCallerSpeech("Sam.", true);
    expect(g.recordOutcome("completed", { newAppointment: "Mon", confirmedBy: "" })).toBe(
      notConfirmed
    );
  });

  it("no who-confirmed field declared: unchanged, refused", () => {
    const g = new ToolGate(noWhoExec);
    g.noteModelAudio();
    g.noteCallerSpeech("Yes, Monday at 9:26 works.", true);
    g.noteModelAudio();
    g.noteCallerSpeech("Sam.", true);
    expect(g.recordOutcome("completed", { newAppointment: "Mon" })).toBe(notConfirmed);
  });

  it("only ONE window back: a yes two model turns ago does not count", () => {
    const g = new ToolGate(whoExec);
    g.noteModelAudio();
    g.noteCallerSpeech("Yes, Monday works.", true);
    g.noteModelAudio();
    g.noteCallerSpeech("Actually, Tuesday would be better.", true);
    g.noteModelAudio(); // "Tuesday then — who am I speaking with?"
    g.noteCallerSpeech("Sam.", true);
    expect(g.recordOutcome("completed", { newAppointment: "Tue", confirmedBy: "Sam" })).toBe(
      notConfirmed
    );
  });

  it("Gemini fragments: both windows are read as they were joined", () => {
    const g = new ToolGate(whoExec);
    g.noteModelAudio();
    g.noteCallerSpeech("Ye", false);
    g.noteCallerSpeech("s, Monday at 9:26 wor", false);
    g.noteCallerSpeech("ks.", false);
    g.noteModelAudio();
    g.noteCallerSpeech(" Sa", false);
    g.noteCallerSpeech("m.", false);
    expect(g.recordOutcome("completed", { newAppointment: "Mon 9:26", confirmedBy: "Sam" })).toBe(
      recorded
    );
  });

  it("one-shot unchanged: a refusal spends it, the next completed record is accepted", () => {
    const g = new ToolGate(whoExec);
    g.noteModelAudio();
    g.noteCallerSpeech("We have Thursday 1 to 4.", true);
    g.noteModelAudio();
    g.noteCallerSpeech("Sam here.", true);
    expect(g.recordOutcome("completed", { newAppointment: "Thu", confirmedBy: "Sam" })).toBe(
      notConfirmed
    );
    g.noteModelAudio(); // read-back
    g.noteCallerSpeech("Thursday one to four.", true);
    expect(g.recordOutcome("completed", { newAppointment: "Thu", confirmedBy: "Sam" })).toBe(
      recorded
    );
  });
});

/**
 * Live, Gemini 3.8, 2026-10-01, several calls: the job declared `confirmedBy`
 * ("Who at the office confirmed it"); the model never asked who it was
 * speaking with and recorded "receptionist", "Receptionist" or "". Deepgram
 * calls asked and got real names. The rule: ask once, never fake.
 */
describe("a who-confirmed field: ask once, never fake", () => {
  const whoExec: CallExecution = {
    closure: { requireOutcomeBeforeEnd: true },
    outcome: {
      fields: [
        { name: "newAppointment", description: "The new appointment date and time" },
        { name: "confirmedBy", description: "Who at the office confirmed it" }
      ]
    }
  };
  const roleNotName: ToolResult =
    "refused: that is a role, not a name — ask who you are speaking with, or leave it empty if they will not say — without mentioning this";
  const notConfirmed: ToolResult =
    "refused: they have not confirmed what you just said — read the arrangement back exactly as they said it, wait for their yes, then record; do not end the call — without mentioning this";
  const recorded: ToolResult =
    "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call";
  const outcomeFirst: ToolResult =
    "refused: record the outcome first — call record_outcome now without mentioning it";
  const closing: ToolResult = "ok — say nothing more";
  const describeRecord = (e: CallExecution): string =>
    buildToolDeclarations(e).find((d) => d.name === "record_outcome")?.description ?? "";

  describe("detection", () => {
    it.each([
      [{ name: "confirmedBy", description: "Who at the office confirmed it" }],
      [{ name: "confirmed_by", description: "" }],
      [{ name: "contact", description: "Name of the person you spoke with" }],
      [{ name: "rep", description: "Who you were speaking with" }],
      [{ name: "agreedWith", description: "Who confirmed the booking" }],
      [{ name: "contactName", description: "" }],
      [{ name: "contact_person", description: "" }],
      [{ name: "spokeWith", description: "" }],
      [{ name: "spokeTo", description: "" }],
      [{ name: "speakingWith", description: "" }],
      [{ name: "personName", description: "" }],
      [{ name: "staffName", description: "" }],
      [{ name: "agentName", description: "" }],
      [{ name: "representativeName", description: "" }],
      [{ name: "nameOfPerson", description: "" }]
    ])("detects %o", (f) => {
      expect(isWhoConfirmedField(f)).toBe(true);
    });

    it.each([
      [{ name: "newAppointment", description: "The new appointment date and time" }],
      [{ name: "confirmationNumber", description: "The confirmation number they gave" }],
      [{ name: "confirmed", description: "Whether they confirmed the booking" }],
      [{ name: "agreedAmount", description: "The price agreed" }],
      // Review 0.4.1 I2: descriptions are free text written per call, and
      // these mention a person without the field being one. The name decides.
      [{ name: "deliveryDate", description: "Delivery date as confirmed by the store" }],
      [{ name: "notes", description: "Anything the person you spoke with mentioned" }],
      [
        {
          name: "orderNumber",
          description: "Order number, and who to call if it does not get confirmed"
        }
      ],
      [{ name: "summary", description: "Who confirmed it and what they said" }],
      [{ name: "contactNumber", description: "Number of the person you spoke with" }],
      [{ name: "status", description: "Confirmed by the person you spoke with?" }]
    ])("does not detect %o", (f) => {
      expect(isWhoConfirmedField(f)).toBe(false);
    });
  });

  describe("the instruction", () => {
    it("tells the model to ask once who it is speaking with, and to leave it empty if they decline", () => {
      const d = describeRecord(whoExec);
      expect(d).toContain("And who am I speaking with?");
      expect(d).toMatch(/ask once/i);
      expect(d).toContain("confirmedBy");
      expect(d).toMatch(/leave it empty/i);
    });

    it("is absent from a call with no who-confirmed field", () => {
      expect(describeRecord(fullExec)).not.toMatch(/speaking with/i);
      expect(describeRecord(fullExec)).not.toMatch(/ask once/i);
    });

    it("asks for no recap", () => {
      expect(describeRecord(whoExec)).not.toMatch(/recap|read .* back|re-confirm/i);
    });
  });

  describe("the gate", () => {
    const settled = (): ToolGate => {
      const g = new ToolGate(whoExec);
      g.noteModelAudio();
      g.noteCallerSpeech("Yes, that works.", true);
      return g;
    };

    it("the refusal is a member of the closed union", () => {
      expect(TOOL_RESULTS).toContain(roleNotName);
    });

    it.each([
      "receptionist",
      "Receptionist",
      "the receptionist",
      "The front desk",
      "front desk staff",
      "staff",
      "Staff member",
      "office staff",
      "the office",
      "scheduler",
      "Scheduling",
      "someone",
      "unknown",
      "N/A",
      "na",
      "none",
      "a representative",
      "agent",
      "assistant",
      "  Receptionist.  ",
      // Replay, Gemini 3.8, 2026-10-01 (gate-base r3): accepted as a name.
      "the person I'm speaking with",
      "The person I’m speaking with",
      "person I spoke to",
      "whoever is on the phone",
      "the person on the line",
      "you",
      "this is",
      "someone here"
    ])("refuses the role placeholder %j, keeping the record with the name empty", (value) => {
      const g = settled();
      expect(g.recordOutcome("completed", { newAppointment: "Tue 10am", confirmedBy: value })).toBe(
        roleNotName
      );
      expect(g.snapshot().outcome?.status).toBe("completed");
      expect(g.snapshot().outcome?.fields).toEqual({ newAppointment: "Tue 10am", confirmedBy: "" });
    });

    it("accepts an empty string — the honest answer when they will not say", () => {
      const g = settled();
      expect(g.recordOutcome("completed", { newAppointment: "Tue 10am", confirmedBy: "" })).toBe(
        recorded
      );
    });

    it.each([
      "Sam",
      "Dr. Patel",
      "Jackson",
      "Sam at the front desk",
      "Maria, the receptionist",
      "this is Sam",
      "Sam, the person I spoke with"
    ])("accepts the name %j", (value) => {
      const g = settled();
      expect(g.recordOutcome("completed", { newAppointment: "Tue 10am", confirmedBy: value })).toBe(
        recorded
      );
      expect(g.snapshot().outcome?.fields.confirmedBy).toBe(value);
    });

    it("does not hold any other field to it", () => {
      const g = new ToolGate({
        outcome: {
          fields: [
            { name: "note", description: "Anything else worth knowing" },
            { name: "confirmedBy", description: "Who at the office confirmed it" }
          ]
        }
      });
      expect(g.recordOutcome("partial", { note: "receptionist", confirmedBy: "Sam" })).toBe(
        "recorded"
      );
    });

    it("does not apply on a call with no who-confirmed field", () => {
      const g = new ToolGate({
        outcome: { fields: [{ name: "department", description: "Which department answered" }] }
      });
      expect(g.recordOutcome("partial", { department: "front desk" })).toBe("recorded");
    });

    // A partial or failed call — a voicemail, a refusal — is not refused for a
    // role: the refusal would make the model ask "who am I speaking with?",
    // and on a voicemail that question goes into the recording. The role is
    // still never kept; the field is blanked and the record accepted.
    it.each(["partial", "failed"] as const)(
      "on %s, blanks the role and records without refusing",
      (status) => {
        const g = settled();
        expect(g.recordOutcome(status, { newAppointment: "", confirmedBy: "N/A" })).toBe(recorded);
        expect(g.snapshot().outcome?.fields).toEqual({ newAppointment: "", confirmedBy: "" });
      }
    );

    it("a partial record does not spend the one refusal a completed one gets", () => {
      const g = settled();
      expect(g.recordOutcome("partial", { newAppointment: "", confirmedBy: "receptionist" })).toBe(
        recorded
      );
      expect(
        g.recordOutcome("completed", { newAppointment: "Tue 10am", confirmedBy: "receptionist" })
      ).toBe(roleNotName);
    });

    // Review 0.4.1 I1: the model says goodbye and calls end_call, which is
    // refused once for the missing record; it records with a role, which is
    // refused; it calls end_call again, which is now accepted. The booking
    // must survive that, with the name empty.
    it("end_call refused → role refused → end_call accepted keeps the booking, name empty", () => {
      const g = settled();
      expect(g.authorizeEnd()).toBe(outcomeFirst);
      expect(
        g.recordOutcome("completed", {
          newAppointment: "2026-10-05T09:30",
          confirmedBy: "Receptionist"
        })
      ).toBe(roleNotName);
      expect(g.authorizeEnd()).toBe(closing);
      expect(g.snapshot().outcome?.status).toBe("completed");
      expect(g.snapshot().outcome?.fields).toEqual({
        newAppointment: "2026-10-05T09:30",
        confirmedBy: ""
      });
    });

    it("refusal → ask → they give a name → recorded → end_call ok", () => {
      const g = settled();
      expect(
        g.recordOutcome("completed", { newAppointment: "Tue 10am", confirmedBy: "Receptionist" })
      ).toBe(roleNotName);
      g.noteModelAudio(); // "And who am I speaking with?"
      g.noteCallerSpeech("Sam.", true);
      expect(g.recordOutcome("completed", { newAppointment: "Tue 10am", confirmedBy: "Sam" })).toBe(
        recorded
      );
      expect(g.authorizeEnd()).toBe(closing);
      expect(g.snapshot().outcome?.fields.confirmedBy).toBe("Sam");
    });

    it("refusal → ask → they decline → empty is recorded", () => {
      const g = settled();
      expect(
        g.recordOutcome("completed", { newAppointment: "Tue 10am", confirmedBy: "front desk" })
      ).toBe(roleNotName);
      g.noteModelAudio();
      g.noteCallerSpeech("I'd rather not say.", true);
      expect(g.recordOutcome("completed", { newAppointment: "Tue 10am", confirmedBy: "" })).toBe(
        recorded
      );
    });

    // Bounded like end_call's refusal: a model that writes the role again
    // after being told once is not refused forever. The record goes through
    // with the field EMPTY — never the placeholder — so nothing is faked and
    // nothing loops.
    it("refuses once; a second placeholder is recorded as empty, never as the role", () => {
      const g = settled();
      expect(
        g.recordOutcome("completed", { newAppointment: "Tue 10am", confirmedBy: "Receptionist" })
      ).toBe(roleNotName);
      g.noteModelAudio();
      g.noteCallerSpeech("Why do you need to know?", true);
      expect(
        g.recordOutcome("completed", {
          newAppointment: "Tue 10am",
          confirmedBy: "the receptionist"
        })
      ).toBe(recorded);
      expect(g.snapshot().outcome?.fields).toEqual({ newAppointment: "Tue 10am", confirmedBy: "" });
    });

    it("the confirmation gate still comes first, and the two cannot trap the model", () => {
      const g = new ToolGate(whoExec);
      g.noteCallerSpeech("How about Tuesday at ten?", true);
      g.noteModelAudio(); // "Tuesday at ten works. Goodbye."
      expect(
        g.recordOutcome("completed", { newAppointment: "Tue 10am", confirmedBy: "receptionist" })
      ).toBe(notConfirmed);
      g.noteModelAudio(); // read-back
      g.noteCallerSpeech("Yes.", true);
      expect(
        g.recordOutcome("completed", { newAppointment: "Tue 10am", confirmedBy: "receptionist" })
      ).toBe(roleNotName);
      // The role refusal kept the record (name empty), so end_call closes.
      expect(g.authorizeEnd()).toBe(closing);
      expect(g.snapshot().outcome?.fields).toEqual({ newAppointment: "Tue 10am", confirmedBy: "" });
    });

    it("routeToolCall answers the refusal with the literal and never echoes the value", async () => {
      const g = settled();
      const answers: ToolResult[] = [];
      await routeToolCall({
        call: {
          id: "r1",
          name: "record_outcome",
          args: {
            status: "completed",
            fields: { newAppointment: "X", confirmedBy: "receptionist" }
          }
        },
        gate: g,
        carrier: {
          sendDtmf: async () => {},
          endCall: async () => {},
          beginNotetaking: async () => {}
        },
        callId: "CA-TEST",
        respond: (r) => answers.push(r)
      });
      expect(answers).toEqual([roleNotName]);
    });
  });
});
