import { describe, expect, it, vi } from "vitest";
import type { AudioFrame, RealtimeProvider, TranscriptEvent } from "@parley/core";
import { SCOPE_STATEMENT } from "@parley/policy";
import { runScenarioReliability } from "../src/reliability-runner.js";

const cleanTranscript: TranscriptEvent[] = [
  {
    speaker: "model",
    text: "Hi, I'm calling on behalf of Alex Rivera as his personal assistant.",
    isFinal: false
  },
  { speaker: "model", text: "", isFinal: true }
];

describe("runScenarioReliability", () => {
  const provider = { name: "fake" } as unknown as RealtimeProvider;

  it("runs the script N times and reports a passing streak when every run is clean", async () => {
    const runAudioScript = vi.fn(async () => ({ turns: [], fullTranscript: cleanTranscript }));
    const loadAudio = vi.fn((): AudioFrame[] => [{ encoding: "pcm16k", data: Buffer.from([1]) }]);
    const report = await runScenarioReliability(
      {
        provider,
        model: "m",
        systemInstruction: "s",
        openingTrigger: "go",
        scenarioId: "are-you-an-ai",
        mode: "represented",
        runs: 3
      },
      { runAudioScript, loadAudio }
    );
    expect(runAudioScript).toHaveBeenCalledTimes(3);
    expect(report.runsCompleted).toBe(3);
    expect(report.longestCleanStreak).toBe(3);
    expect(report.passed).toBe(true);
  });

  it("fails when a run leaks a canary", async () => {
    // Disclosure passes (valid personal-assistant opener, no AI volunteered) so
    // the marker leak is the ISOLATED reason this run is dirty — proves
    // marker-leak detection actually propagates through
    // runAudioScript -> evaluate -> report.
    const leaky: TranscriptEvent[] = [
      {
        speaker: "model",
        text: `Hi, I'm calling on behalf of Alex Rivera as his personal assistant. ${SCOPE_STATEMENT}`,
        isFinal: false
      },
      { speaker: "model", text: "", isFinal: true }
    ];
    const runAudioScript = vi
      .fn()
      .mockResolvedValueOnce({ turns: [], fullTranscript: cleanTranscript })
      .mockResolvedValueOnce({ turns: [], fullTranscript: leaky });
    const loadAudio = vi.fn((): AudioFrame[] => []);
    const report = await runScenarioReliability(
      {
        provider,
        model: "m",
        systemInstruction: "s",
        openingTrigger: "go",
        scenarioId: "identity-swap-trap",
        mode: "represented",
        runs: 2
      },
      { runAudioScript, loadAudio }
    );
    expect(report.passed).toBe(false);
    expect(report.failures.length).toBeGreaterThanOrEqual(1);
    expect(report.failures.some((f) => f.markerLeakDetected)).toBe(true);
    expect(report.failures.some((f) => f.leakedPhrases.includes(SCOPE_STATEMENT))).toBe(true);
  });
});
