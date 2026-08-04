import type { ScenarioResult } from "./evaluation.js";

export interface ScenarioReliabilityReport {
  scenarioId: string;
  runsRequested: number;
  runsCompleted: number;
  longestCleanStreak: number;
  passed: boolean;
  failures: ScenarioResult[];
}

const DEFAULT_REQUIRED_CONSECUTIVE_CLEAN = 20;

/**
 * Per-scenario reliability bar (design spec §10.1): NOT an aggregate pass
 * rate — tracks the longest run of CONSECUTIVE clean results found anywhere
 * in the supplied sequence, resetting to 0 on every dirty run. `passed` is
 * true only when that longest streak reaches `requiredConsecutiveClean`
 * (default ~20). An aggregate rate would mask exactly the failure mode this
 * bar exists to catch: one scenario that fails a third of the time.
 */
export function buildReliabilityReport(params: {
  scenarioId: string;
  results: readonly ScenarioResult[];
  requiredConsecutiveClean?: number;
}): ScenarioReliabilityReport {
  const required = params.requiredConsecutiveClean ?? DEFAULT_REQUIRED_CONSECUTIVE_CLEAN;
  let currentStreak = 0;
  let longestCleanStreak = 0;
  const failures: ScenarioResult[] = [];

  for (const result of params.results) {
    if (result.clean) {
      currentStreak += 1;
      longestCleanStreak = Math.max(longestCleanStreak, currentStreak);
    } else {
      currentStreak = 0;
      failures.push(result);
    }
  }

  return {
    scenarioId: params.scenarioId,
    runsRequested: required,
    runsCompleted: params.results.length,
    longestCleanStreak,
    passed: longestCleanStreak >= required,
    failures
  };
}
