import { describe, expect, it } from "vitest";
import {
  matrixCells,
  buildScenarioRequest,
  authorPrompt,
  generateScenarios,
  AXIS_MATRIX
} from "../src/generate-scenarios.js";
import type { AuthoredContent } from "../src/generate-scenarios.js";
import type { CallScenario } from "../src/call-scenario.js";

const seed: CallScenario = {
  id: "seed",
  description: "seed",
  envelope: {
    version: 2,
    brief: { to: "+15555550142", persona: "p", objective: "o", facts: [], preferences: [] },
    policy: {
      principalName: "Jordan Rivera",
      identity: { style: "silent" },
      disclosure: { honestIfAsked: true, volunteer: false },
      scope: {
        lock: true,
        adjacent: ["Also arrange service for the second unit if they raise it."]
      },
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
      spendCeiling: { field: "agreedAmount", limit: 250 },
      limits: { maxDurationSeconds: 600 }
    }
  },
  params: {
    menu: [{ option: "service", digit: "1" }],
    correctDigit: "1",
    quotedAmount: 160,
    raisedTopic: null,
    adjacentIndex: null,
    offersAppointment: true,
    reachesSomeoneWhoCanAct: true
  },
  script: [{ label: "menu", text: "For service, press one." }]
};

const validAuthored = (): AuthoredContent => ({
  script: [
    { label: "menu", text: "For service, press one. For billing, press two." },
    { label: "human", text: "Service scheduling, how can I help?", afterPress: "1" }
  ],
  briefFacts: ["The unit was last serviced two years ago."],
  briefPreferences: ["Jordan Rivera prefers morning windows."],
  objective: "Book a service visit in the next two weeks.",
  menuWording: ["For service, press one."]
});

describe("the matrix", () => {
  it("emits one cell per cost-structure x complication pair", () => {
    const cells = matrixCells();
    expect(cells).toHaveLength(20);
    expect(new Set(cells.map((c) => c.costStructure)).size).toBe(4);
    expect(new Set(cells.map((c) => c.complication)).size).toBe(5);
  });

  it("covers every domain and both tree depths across the matrix", () => {
    const cells = matrixCells();
    expect(new Set(cells.map((c) => c.domain)).size).toBe(AXIS_MATRIX.domain.length);
    expect(new Set(cells.map((c) => c.treeDepth))).toEqual(new Set([1, 2]));
  });

  it("gives every cell a stable, unique id and is deterministic across calls", () => {
    const ids = matrixCells().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(matrixCells().map((c) => c.id)).toEqual(ids);
  });
});

describe("buildScenarioRequest — parameters decided before any model runs", () => {
  it("quotes nothing for the unknown-at-call-time and paid-later structures", () => {
    for (const cell of matrixCells().filter(
      (c) =>
        (c.costStructure === "unknownAtCallTime" || c.costStructure === "paidLater") &&
        c.complication !== "quoteAboveCeiling"
    )) {
      expect(buildScenarioRequest(seed, cell).params.quotedAmount).toBeNull();
    }
  });

  it("quotes above the ceiling for the over-ceiling complication", () => {
    const cell = matrixCells().find(
      (c) => c.complication === "quoteAboveCeiling" && c.costStructure === "initialVisitCharge"
    );
    const req = buildScenarioRequest(seed, cell!);
    expect(req.params.quotedAmount).toBeGreaterThan(req.envelope.policy.authority.spend!.limit);
  });

  it("quotes under the ceiling for the bounded structure", () => {
    const cell = matrixCells().find(
      (c) => c.costStructure === "bounded" && c.complication === "holdMidCall"
    );
    const req = buildScenarioRequest(seed, cell!);
    expect(req.params.quotedAmount).toBeLessThan(req.envelope.policy.authority.spend!.limit);
  });

  it("has no correct digit and no bookable appointment when no menu option matches", () => {
    const cell = matrixCells().find((c) => c.complication === "noMatchingMenuOption");
    const req = buildScenarioRequest(seed, cell!);
    expect(req.params.correctDigit).toBeNull();
    expect(req.params.offersAppointment).toBe(false);
  });

  it("points adjacentIndex at a real adjacency only when scope expansion is offered", () => {
    const withExpansion = buildScenarioRequest(
      seed,
      matrixCells().find((c) => c.complication === "scopeExpansionOffered")!
    );
    expect(withExpansion.params.adjacentIndex).toBe(0);
    const without = buildScenarioRequest(
      seed,
      matrixCells().find((c) => c.complication === "holdMidCall")!
    );
    expect(without.params.adjacentIndex).toBeNull();
  });

  it("rewrites the spend basis for the cost structure", () => {
    const paidLater = buildScenarioRequest(
      seed,
      matrixCells().find((c) => c.costStructure === "paidLater")!
    );
    expect(paidLater.envelope.policy.authority.spend?.basis).toContain("invoiced");
  });
});

describe("authorPrompt — asks for prose, never for a verdict", () => {
  it("states the exact quoted amount rather than asking the author to choose one", () => {
    const req = buildScenarioRequest(
      seed,
      matrixCells().find((c) => c.costStructure === "bounded" && c.complication === "holdMidCall")!
    );
    expect(authorPrompt(req)).toContain(`${req.params.quotedAmount} dollars`);
  });

  it("never asks the author whether the caller should accept", () => {
    for (const cell of matrixCells()) {
      const p = authorPrompt(buildScenarioRequest(seed, cell));
      expect(p).toContain("do not state whether");
      expect(p).not.toMatch(/expect(ed|ation)/i);
    }
  });

  it("tells the author when no menu option leads anywhere", () => {
    const req = buildScenarioRequest(
      seed,
      matrixCells().find((c) => c.complication === "noMatchingMenuOption")!
    );
    expect(authorPrompt(req)).toContain("NO option");
  });
});

describe("generateScenarios — findings, never throws", () => {
  it("builds a valid scenario from valid authored content", async () => {
    const { scenarios, findings } = await generateScenarios({
      seed,
      cells: [matrixCells()[0]],
      author: async () => validAuthored()
    });
    expect(findings).toEqual([]);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].id).toBe(matrixCells()[0].id);
  });

  it("records a finding instead of throwing when authored content fails validation", async () => {
    const { scenarios, findings } = await generateScenarios({
      seed,
      cells: [matrixCells()[0]],
      author: async () => ({ ...validAuthored(), script: [] })
    });
    expect(scenarios).toHaveLength(0);
    expect(findings[0].kind).toBe("invalid-scenario");
  });

  it("records a finding instead of throwing when the author itself fails", async () => {
    const { findings } = await generateScenarios({
      seed,
      cells: [matrixCells()[0]],
      author: async () => {
        throw new Error("model unavailable");
      }
    });
    expect(findings[0].kind).toBe("invalid-scenario");
    expect(findings[0].detail).toContain("model unavailable");
  });

  it("classifies an envelope Parley rejects as an inexpressible cell, not a bad scenario", async () => {
    const brokenSeed: CallScenario = {
      ...seed,
      envelope: { ...seed.envelope, execution: { ...seed.envelope.execution, ivr: undefined } }
    };
    const { findings } = await generateScenarios({
      seed: brokenSeed,
      cells: [matrixCells()[0]],
      author: async () => validAuthored()
    });
    expect(findings.map((f) => f.kind)).toContain("inexpressible-cell");
  });

  it("keeps going after a bad cell rather than aborting the run", async () => {
    let n = 0;
    const { scenarios, findings } = await generateScenarios({
      seed,
      cells: matrixCells().slice(0, 3),
      author: async () => {
        n += 1;
        if (n === 2) throw new Error("transient");
        return validAuthored();
      }
    });
    expect(scenarios).toHaveLength(2);
    expect(findings).toHaveLength(1);
  });
});

describe("authorPrompt asks for the CALLER's objective", () => {
  // The one scenario a real run produced came back with objective "Handle an
  // incoming customer call seeking to book an auto service appointment" —
  // written from the COMPANY's point of view. The prompt asked for the callee's
  // script and the caller's objective in the same breath and the author
  // conflated them, which would have primed Parley to answer a call rather than
  // place one.
  it("says explicitly that objective is the caller's goal, not the company's", () => {
    const p = authorPrompt(buildScenarioRequest(seed, matrixCells()[0]));
    expect(p).toContain("CALLER's side");
    expect(p).toContain("the caller's goal, not");
  });
});

describe("incremental output", () => {
  it("emits each scenario as it is produced, not only at the end", async () => {
    const seen: string[] = [];
    let n = 0;
    await generateScenarios({
      seed,
      cells: matrixCells().slice(0, 3),
      author: async () => {
        n += 1;
        // Fail the LAST cell: without incremental writes an interrupted or
        // partially-failing run would surface nothing.
        if (n === 3) throw new Error("interrupted");
        return validAuthored();
      },
      onScenario: (s) => seen.push(s.id)
    });
    expect(seen).toHaveLength(2);
  });
});

describe("primed menu hints match the cell's own menu", () => {
  // A scenario whose policy contradicts its own script is worse than no
  // scenario: it produces a confident FAIL that blames the model. Copying the
  // seed's hint verbatim told every no-matching-option cell "service is on one"
  // while its script offered new installations on one, so the model pressed 1,
  // looked like it was guessing, and the cell tested nothing about the fallback
  // it existed to exercise.
  it("derives the hint from params.menu rather than copying the seed's", () => {
    for (const cell of matrixCells()) {
      const req = buildScenarioRequest(seed, cell);
      const hint = req.envelope.policy.ivr?.menuHints?.[0] ?? "";
      for (const m of req.params.menu) {
        expect(hint).toContain(`${m.option} on ${m.digit}`);
      }
    }
  });

  it("a no-matching-option cell is never primed with an option its menu lacks", () => {
    const cell = matrixCells().find((c) => c.complication === "noMatchingMenuOption");
    const req = buildScenarioRequest(seed, cell!);
    const hint = req.envelope.policy.ivr?.menuHints?.[0] ?? "";
    // The seed's own wording must not survive into a cell with a different menu.
    expect(hint).not.toContain("filter purchase");
    expect(hint).not.toMatch(/\bservice on 1\b/);
  });
});
