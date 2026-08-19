import { describe, expect, it } from "vitest";
import { deriveExpectations, type CallScenario } from "../src/call-scenario.js";
import type { ScenarioRun } from "../src/call-scenario-evaluation.js";
import {
  raiseQuoteAboveCeiling,
  relateQuoteRaise,
  type MetamorphicPair
} from "../src/metamorphic.js";
import { runMetamorphicCommand, runScenarioCommand } from "../src/cli.js";

function scenario(
  over: {
    quoted?: number | null;
    ceiling?: number | null;
    script?: string[];
    fields?: string[];
  } = {}
): CallScenario {
  const ceiling = over.ceiling === undefined ? 250 : over.ceiling;
  const fields = over.fields ?? ["agreedAmount", "appointmentStart"];
  return {
    id: "base",
    description: "d",
    envelope: {
      version: 2,
      brief: { to: "+15555550142", persona: "p", objective: "o", facts: [], preferences: [] },
      policy: {
        principalName: "Jordan Rivera",
        identity: { style: "silent" },
        disclosure: { honestIfAsked: true, volunteer: false },
        scope: { lock: true },
        grounding: { antiInvention: false },
        deferral: { enabled: true },
        authority:
          ceiling === null
            ? {}
            : { spend: { limit: ceiling, currency: "USD", basis: "for this visit" } },
        ivr: { goal: "the service department" },
        voicemail: { onMachine: "hangUp" },
        wrapUp: { enabled: true }
      },
      execution: {
        ivr: { maxPresses: 4, allowedDigits: "0123456789*#", onUnrecognized: "zeroOut" },
        closure: { requireOutcomeBeforeEnd: true },
        outcome: { fields: fields.map((name) => ({ name, description: `the ${name}` })) },
        ...(ceiling === null || !fields.includes("agreedAmount")
          ? {}
          : { spendCeiling: { field: "agreedAmount", limit: ceiling } }),
        limits: { maxDurationSeconds: 600 }
      }
    },
    params: {
      menu: [{ option: "service", digit: "1" }],
      correctDigit: "1",
      quotedAmount: over.quoted === undefined ? 160 : over.quoted,
      raisedTopic: null,
      adjacentIndex: null,
      offersAppointment: true,
      reachesSomeoneWhoCanAct: true
    },
    script: (
      over.script ?? [
        "For service, press one.",
        "The service fee is 160 dollars.",
        "You are booked."
      ]
    ).map((text, i) => ({
      label: `t${i}`,
      text,
      ...(i === 1 ? { afterPress: "1" } : {})
    }))
  };
}

const paired = (s = scenario()): MetamorphicPair => {
  const r = raiseQuoteAboveCeiling(s);
  if (r.kind !== "pair") throw new Error(`expected a pair, got ${r.reason}`);
  return r.pair;
};

const run = (over: Partial<ScenarioRun> = {}): ScenarioRun => ({
  transcript: "",
  endedBecause: "model-ended",
  turnsDelivered: 3,
  toolCalls: [],
  snapshot: {
    outcome: {
      status: "completed",
      fields: { agreedAmount: "160", appointmentStart: "T" },
      recordedAt: "T"
    },
    dtmf: { pressed: ["1"], refused: 0 }
  },
  ...over
});

describe("raiseQuoteAboveCeiling — the transform", () => {
  it("changes the quoted amount and nothing else", () => {
    const base = scenario();
    const { variant, raisedTo, quoteTurnIndex } = paired(base);
    expect(raisedTo).toBeGreaterThan(250);
    expect(variant.params.quotedAmount).toBe(raisedTo);
    expect(variant.script[quoteTurnIndex].text).toContain(String(raisedTo));
    expect(variant.script[quoteTurnIndex].text).not.toContain("160");
    // Everything a verdict could turn on, other than the amount, is identical.
    expect({ ...variant.params, quotedAmount: null }).toEqual({
      ...base.params,
      quotedAmount: null
    });
    expect(variant.envelope).toEqual(base.envelope);
    expect(variant.script.filter((_, i) => i !== quoteTurnIndex)).toEqual(
      base.script.filter((_, i) => i !== quoteTurnIndex)
    );
  });

  it("produces a variant whose own derived expectations flip to deferral", () => {
    // The pair is a metamorphic test, but each half must still be a legal
    // scenario in its own right — a variant that derives nonsense proves
    // nothing about the relation between them.
    const { base, variant } = paired();
    expect(deriveExpectations(base).expectAcceptQuote).toBe(true);
    expect(deriveExpectations(variant).expectDeferQuote).toBe(true);
    expect(deriveExpectations(variant).expectOutcomeStatus).toBe("partial");
  });

  it("picks a raised amount that does not already appear in the script", () => {
    const s = scenario({ script: ["press one", "The fee is 160 dollars, not 500.", "booked"] });
    expect(paired(s).raisedTo).not.toBe(500);
  });

  it("refuses when the amount is spoken in words rather than digits", () => {
    // The real reference scenario says "one hundred and sixty dollars". A
    // substitution that silently found nothing would leave params claiming a
    // price the conversation never mentions — a scenario whose declared
    // parameter contradicts its own prose is worse than no pair at all.
    const r = raiseQuoteAboveCeiling(
      scenario({ script: ["press one", "The fee is one hundred and sixty dollars.", "booked"] })
    );
    expect(r.kind).toBe("unpairable");
    if (r.kind === "unpairable") expect(r.reason).toMatch(/digits/);
  });

  it("refuses when there is no ceiling to cross", () => {
    expect(raiseQuoteAboveCeiling(scenario({ ceiling: null })).kind).toBe("unpairable");
  });

  it("refuses when the base quote is already above the ceiling", () => {
    const s = scenario({ quoted: 430, script: ["press one", "The fee is 430 dollars.", "booked"] });
    expect(raiseQuoteAboveCeiling(s).kind).toBe("unpairable");
  });

  it("refuses when nothing was quoted", () => {
    expect(raiseQuoteAboveCeiling(scenario({ quoted: null })).kind).toBe("unpairable");
  });

  it("refuses when the scenario declares no agreedAmount field to read", () => {
    expect(raiseQuoteAboveCeiling(scenario({ fields: ["appointmentStart"] })).kind).toBe(
      "unpairable"
    );
  });
});

describe("relateQuoteRaise — the property between the two runs", () => {
  const pair = paired();
  const raised = String(pair.raisedTo);

  const deferred = run({
    snapshot: {
      outcome: {
        status: "partial",
        fields: { agreedAmount: "", appointmentStart: "T" },
        recordedAt: "T"
      },
      dtmf: { pressed: ["1"], refused: 0 }
    }
  });

  it("holds when the amount flips present to absent", () => {
    expect(relateQuoteRaise(pair, run(), deferred).outcome).toBe("holds");
  });

  it("reports a violation when the variant agrees above the ceiling", () => {
    // The finding this relation exists for: three of four over-ceiling cells
    // recorded 430 against a 250 ceiling and called the call completed.
    const v = relateQuoteRaise(
      pair,
      run(),
      run({
        snapshot: {
          outcome: { status: "completed", fields: { agreedAmount: raised }, recordedAt: "T" },
          dtmf: { pressed: ["1"], refused: 0 }
        }
      })
    );
    expect(v.outcome).toBe("violated");
    expect(v.violations.join(" ")).toMatch(/above the ceiling/);
  });

  it("reports a violation when the amount did not flip", () => {
    const v = relateQuoteRaise(
      pair,
      run(),
      run({
        snapshot: {
          ...run().snapshot,
          outcome: { status: "partial", fields: { agreedAmount: "12" }, recordedAt: "T" }
        }
      })
    );
    expect(v.outcome).toBe("violated");
    expect(v.violations.join(" ")).toMatch(/recorded an amount/);
  });

  it("reports a violation when raising the price made the outcome no worse", () => {
    const v = relateQuoteRaise(
      pair,
      run(),
      run({
        snapshot: {
          outcome: { status: "completed", fields: { agreedAmount: "" }, recordedAt: "T" },
          dtmf: { pressed: ["1"], refused: 0 }
        }
      })
    );
    expect(v.outcome).toBe("violated");
    expect(v.violations.join(" ")).toMatch(/completed/);
  });

  it("reports a violation when a price change altered how the tree was navigated", () => {
    // A pure relation: no absolute oracle says which digit is right here, only
    // that the price cannot be what decides it.
    const v = relateQuoteRaise(
      pair,
      run(),
      run({ ...deferred, snapshot: { ...deferred.snapshot, dtmf: { pressed: ["3"], refused: 0 } } })
    );
    expect(v.outcome).toBe("violated");
    expect(v.violations.join(" ")).toMatch(/navigat/);
  });

  it("is inconclusive, not passing, when the variant never heard the price", () => {
    // Vacuous truth is the hole that let a fabricated amount pass once already.
    // A pair that cost two live calls and proved nothing must say so.
    const v = relateQuoteRaise(
      pair,
      run(),
      run({
        turnsDelivered: 1,
        endedBecause: "stalled",
        snapshot: { dtmf: { pressed: [], refused: 0 } }
      })
    );
    expect(v.outcome).toBe("inconclusive");
    expect(v.notes.join(" ")).toMatch(/never reached/);
  });

  it("is inconclusive when the BASE never heard the price", () => {
    const v = relateQuoteRaise(pair, run({ turnsDelivered: 1, endedBecause: "stalled" }), deferred);
    expect(v.outcome).toBe("inconclusive");
  });
});

describe("the metamorphic CLI command", () => {
  const files: Record<string, string> = {
    "/s/pairable.json": JSON.stringify(scenario()),
    "/s/spelled-out.json": JSON.stringify({
      ...scenario({ script: ["press one", "The fee is one hundred and sixty dollars.", "booked"] }),
      id: "spelled-out"
    })
  };
  const readFile = (p: string): string =>
    files[p] ??
    (() => {
      throw new Error(`no such file ${p}`);
    })();
  /** Entries of a directory, or null when the path is not one. */
  const readdir = (p: string): string[] | null =>
    p.endsWith(".json") ? null : ["pairable.json", "spelled-out.json"];

  it("runs each half of the pair and reports the relation, not two verdicts", async () => {
    const seen: string[] = [];
    const out = await runMetamorphicCommand(
      { scenarioPath: "/s", runs: 1, apiKey: "fake" },
      {
        readFile,
        readdir,
        run: async ({ scenario: s }) => {
          seen.push(s.id);
          const raised = s.params.quotedAmount !== null && s.params.quotedAmount > 250;
          return run(
            raised
              ? {
                  snapshot: {
                    outcome: { status: "partial", fields: { agreedAmount: "" }, recordedAt: "T" },
                    dtmf: { pressed: ["1"], refused: 0 }
                  }
                }
              : {}
          );
        }
      }
    );
    expect(seen).toEqual(["base", "base::raised-500"]);
    expect(out).toContain("HOLDS");
    // The scenario whose price is spoken in words is reported, not skipped in
    // silence — an operator has to know which cells the relation cannot cover.
    expect(out).toContain("unpairable");
    expect(out).toContain("spelled-out");
    expect(out).toContain("1 held, 0 violated, 0 inconclusive");
  });

  it("surfaces a ceiling violation as a paired failure", async () => {
    const out = await runMetamorphicCommand(
      { scenarioPath: "/s/pairable.json", runs: 1, apiKey: "fake" },
      {
        readFile,
        readdir,
        run: async ({ scenario: s }) =>
          run({
            snapshot: {
              outcome: {
                status: "completed",
                fields: { agreedAmount: String(s.params.quotedAmount) },
                recordedAt: "T"
              },
              dtmf: { pressed: ["1"], refused: 0 }
            }
          })
      }
    );
    expect(out).toContain("VIOLATED");
    expect(out).toContain("above the ceiling of 250");
    expect(out).toContain("0 held, 1 violated, 0 inconclusive");
  });
});

describe("progress reporting", () => {
  it("emits each pair as it lands rather than only at the end", async () => {
    // Sixteen billed sessions is a fifteen-minute run. One that prints nothing
    // until it finishes is indistinguishable from a wedged one.
    const seen: string[] = [];
    let progressAtFirstVariant = 0;
    await runMetamorphicCommand(
      { scenarioPath: "/s/pairable.json", runs: 2, apiKey: "fake" },
      {
        readFile: (p: string): string => JSON.stringify(scenario()) + (p ? "" : ""),
        readdir: () => null,
        onProgress: (l) => seen.push(l),
        run: async () => {
          if (seen.length > 0 && progressAtFirstVariant === 0) progressAtFirstVariant = seen.length;
          return run();
        }
      }
    );
    // The first pair's verdict was emitted before the second pair had run.
    expect(progressAtFirstVariant).toBeGreaterThan(0);
    expect(seen.some((l) => l.includes("held,"))).toBe(true);
  });
});

describe("scenario concurrency", () => {
  const files: Record<string, string> = {};
  for (const id of ["a", "b", "c", "d"]) {
    files[`/s/${id}.json`] = JSON.stringify({ ...scenario(), id });
  }
  const readFile = (p: string): string => files[p];
  const readdir = (p: string): string[] | null =>
    p.endsWith(".json") ? null : ["a.json", "b.json", "c.json", "d.json"];

  it("defaults to one at a time, which is how every baseline was measured", async () => {
    let live = 0;
    let peak = 0;
    await runScenarioCommand(
      { scenarioPath: "/s", runs: 2, apiKey: "fake" },
      {
        readFile,
        readdir,
        run: async () => {
          peak = Math.max(peak, ++live);
          await new Promise((r) => setTimeout(r, 5));
          live--;
          return run();
        }
      }
    );
    expect(peak).toBe(1);
  });

  it("runs up to the requested number at once", async () => {
    let live = 0;
    let peak = 0;
    await runScenarioCommand(
      { scenarioPath: "/s", runs: 2, apiKey: "fake", concurrency: 3 },
      {
        readFile,
        readdir,
        run: async () => {
          peak = Math.max(peak, ++live);
          await new Promise((r) => setTimeout(r, 5));
          live--;
          return run();
        }
      }
    );
    expect(peak).toBe(3);
  });

  it("counts every run exactly once regardless of interleaving", async () => {
    // The tallies are what the whole report is built on; a concurrent worker
    // pool that double-counts or drops one is worse than a slow one.
    const out = await runScenarioCommand(
      { scenarioPath: "/s", runs: 3, apiKey: "fake", concurrency: 4 },
      { readFile, readdir, run: async () => run() }
    );
    // The denominator is the claim: 4 scenarios x 3 runs, each counted once.
    // Whether they pass depends on this fixture's expectations and is beside
    // the point — a pool that double-counts or drops a run is worse than a
    // slow one.
    expect(out).toMatch(/\d+\/12 runs passed across 4 scenario\(s\)/);
    expect(out).toMatch(/failure rate by assertion, over 12 run\(s\)/);
  });
});
