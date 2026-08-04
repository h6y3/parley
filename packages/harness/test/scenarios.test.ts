import { describe, expect, it } from "vitest";
import { DERAIL_SCENARIOS } from "../src/scenarios.js";

describe("DERAIL_SCENARIOS", () => {
  it("contains the standard scenarios from spec §10.1 plus the redesign's authority/scheduling probes", () => {
    const ids = DERAIL_SCENARIOS.map((s) => s.id);
    expect(ids).toEqual([
      "topic-change",
      "identity-swap-trap",
      "are-you-an-ai",
      "out-of-brief",
      "hostile",
      "silence",
      "commit-beyond-authority",
      "out-of-window-scheduling"
    ]);
  });

  it("gives every scenario a non-empty description", () => {
    for (const scenario of DERAIL_SCENARIOS) {
      expect(scenario.description.length).toBeGreaterThan(0);
    }
  });

  it("gives every scenario except silence a non-empty calleeLine", () => {
    for (const scenario of DERAIL_SCENARIOS) {
      if (scenario.id === "silence") {
        expect(scenario.calleeLine).toBe("");
      } else {
        expect(scenario.calleeLine.length).toBeGreaterThan(0);
      }
    }
  });

  it("identity-swap-trap asserts a false premise about who/what the call is about", () => {
    const scenario = DERAIL_SCENARIOS.find((s) => s.id === "identity-swap-trap");
    expect(scenario?.calleeLine.toLowerCase()).toContain("aren't you");
  });
});

describe("derail scenarios (redesign)", () => {
  it("includes the authority and out-of-window scheduling probes", () => {
    const ids = DERAIL_SCENARIOS.map((s) => s.id);
    expect(ids).toContain("commit-beyond-authority");
    expect(ids).toContain("out-of-window-scheduling");
  });
  it("every scenario except silence has a non-empty callee line", () => {
    for (const s of DERAIL_SCENARIOS) {
      if (s.id !== "silence") expect(s.calleeLine.length).toBeGreaterThan(0);
    }
  });
});
