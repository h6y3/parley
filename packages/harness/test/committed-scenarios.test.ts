import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ToolGate } from "@parley/core";
import {
  callScenarioSchema,
  deriveExpectations,
  type CallScenario,
  type CallShapeExpectations,
  type CallShapeParams
} from "../src/call-scenario.js";
import { DEFAULT_SCENARIO_TIMINGS } from "../src/call-scenario-runner.js";

/** The committed two-party scenarios: the reference seed and the generated
 * matrix. Meetings are judged by their own derivation and are not here.
 *
 * These are shape checks on the FIXTURES, not on the model. Every one of them
 * is a way a fixture once made a correct model fail: a line gated on a key the
 * model is right not to press, a booking with no line agreeing to it, a hold
 * that only ends when the caller talks. A matrix reads each of those as a
 * model defect, and only reading transcripts found them. */
const DIR = fileURLToPath(new URL("../scenarios/", import.meta.url));
const files = [
  join(DIR, "reference-service-visit.json"),
  ...readdirSync(join(DIR, "generated"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(DIR, "generated", f))
];
const load = (path: string): CallScenario =>
  callScenarioSchema.parse(JSON.parse(readFileSync(path, "utf8")));
const scenarios = files.map(load);

const callExpect = (s: CallScenario): CallShapeExpectations => {
  const e = deriveExpectations(s);
  if (e.shape !== "call") throw new Error(`expected a call-shape scenario: ${s.id}`);
  return e;
};

describe("committed call scenarios", () => {
  it("are all here: the reference and twenty generated cells", () => {
    expect(scenarios).toHaveLength(21);
  });

  it.each(scenarios.map((s) => [s.id, s] as const))(
    "%s gates only on the press a correct model makes",
    (_id, s) => {
      // A gate on any other key holds until the stall timer: the model pressed
      // the right key and the script waits for the wrong one.
      const { expectPress } = callExpect(s);
      const gates = s.script.flatMap((t) => (t.afterPress ? [t.afterPress] : []));
      expect(gates.length).toBeGreaterThan(0);
      for (const g of gates) expect(g).toBe(expectPress);
    }
  );

  it.each(scenarios.map((s) => [s.id, s] as const))(
    "%s delivers every unprompted line before a silent model would stall",
    (_id, s) => {
      for (const t of s.script) {
        if (t.unpromptedAfterMs !== undefined) {
          expect(t.unpromptedAfterMs).toBeLessThan(DEFAULT_SCENARIO_TIMINGS.stallMs);
        }
      }
    }
  );

  const settled = scenarios.filter((s) => callExpect(s).expectOutcomeStatus === "completed");

  it.each(settled.map((s) => [s.id, s] as const))(
    "%s declares the agreement, on a line the product's gate accepts as one",
    (_id, s) => {
      const agreement = (s.params as CallShapeParams).agreement;
      expect(agreement).toBeDefined();
      // Asked of `ToolGate` itself rather than of a copy of its word list: the
      // confirming line must be one a real call would accept a `completed`
      // record after, or the fixture costs a correct model a refusal.
      const gate = new ToolGate(s.envelope.execution);
      gate.noteCallerSpeech(s.script[agreement!.confirmTurn].text, true);
      const fields = Object.fromEntries(
        (s.envelope.execution.outcome?.fields ?? []).map((f) => [
          f.name,
          f.name === "confirmedBy" ? "Sam" : ""
        ])
      );
      expect(gate.recordOutcome("completed", fields)).toMatch(/^recorded/);
    }
  );

  it("expects every over-ceiling cell to defer, record partial, and agree to nothing", () => {
    // `record_outcome`'s own description: "If — and only if — they quote a
    // price above <limit>, leave <field> empty and set status to partial."
    // Not `failed`: the call reached someone who could act and learned the
    // price, which is the follow-up the principal needs. The deferral rail
    // says not to go ahead, so no arrangement is declared either.
    const over = scenarios.filter((s) => s.id.endsWith("quoteAboveCeiling"));
    expect(over).toHaveLength(4);
    for (const s of over) {
      const e = callExpect(s);
      expect(e.expectDeferQuote).toBe(true);
      expect(e.expectOutcomeStatus).toBe("partial");
      expect(e.agreement).toBeNull();
    }
  });
});
