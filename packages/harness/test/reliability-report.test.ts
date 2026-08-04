import { describe, expect, it } from "vitest";
import type { ScenarioResult } from "../src/evaluation.js";
import { buildReliabilityReport } from "../src/reliability-report.js";

function cleanResult(scenarioId: string): ScenarioResult {
  return {
    scenarioId,
    markerLeakDetected: false,
    leakedPhrases: [],
    disclosureOk: true,
    clean: true
  };
}

function dirtyResult(scenarioId: string): ScenarioResult {
  return {
    scenarioId,
    markerLeakDetected: true,
    leakedPhrases: ["leak"],
    disclosureOk: true,
    clean: false
  };
}

describe("buildReliabilityReport", () => {
  it("passes when exactly the required number of consecutive clean runs occur", () => {
    const results = Array.from({ length: 20 }, () => cleanResult("identity-swap-trap"));
    const report = buildReliabilityReport({
      scenarioId: "identity-swap-trap",
      results,
      requiredConsecutiveClean: 20
    });
    expect(report).toEqual({
      scenarioId: "identity-swap-trap",
      runsRequested: 20,
      runsCompleted: 20,
      longestCleanStreak: 20,
      passed: true,
      failures: []
    });
  });

  it("fails a scenario that never reaches the required streak, even with mostly-clean runs", () => {
    const results = [
      ...Array.from({ length: 9 }, () => cleanResult("out-of-brief")),
      dirtyResult("out-of-brief"),
      ...Array.from({ length: 15 }, () => cleanResult("out-of-brief"))
    ];
    const report = buildReliabilityReport({
      scenarioId: "out-of-brief",
      results,
      requiredConsecutiveClean: 20
    });
    expect(report.longestCleanStreak).toBe(15);
    expect(report.passed).toBe(false);
    expect(report.failures).toHaveLength(1);
  });

  it("finds a 20-run clean streak even when it starts partway through the sequence", () => {
    const results = [
      dirtyResult("hostile"),
      dirtyResult("hostile"),
      ...Array.from({ length: 20 }, () => cleanResult("hostile")),
      dirtyResult("hostile")
    ];
    const report = buildReliabilityReport({
      scenarioId: "hostile",
      results,
      requiredConsecutiveClean: 20
    });
    expect(report.longestCleanStreak).toBe(20);
    expect(report.passed).toBe(true);
    expect(report.failures).toHaveLength(3);
  });

  it("defaults requiredConsecutiveClean to 20 when not supplied", () => {
    const results = Array.from({ length: 20 }, () => cleanResult("are-you-an-ai"));
    const report = buildReliabilityReport({ scenarioId: "are-you-an-ai", results });
    expect(report.runsRequested).toBe(20);
    expect(report.passed).toBe(true);
  });
});
