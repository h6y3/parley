import { describe, expect, it, vi } from "vitest";
import {
  MULAW_8K,
  PCM_16K,
  type AudioFrame,
  type RealtimeProvider,
  type TranscriptEvent
} from "@parley/core";
import { SCOPE_STATEMENT } from "@parley/policy";
import {
  RELIABILITY_TRAILING_SILENCE_MS,
  runScenarioReliability
} from "../src/reliability-runner.js";

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
    const loadAudio = vi.fn((): AudioFrame[] => [{ encoding: PCM_16K, data: Buffer.from([1]) }]);
    const report = await runScenarioReliability(
      {
        provider,
        model: "m",
        systemInstruction: "s",
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

/** A fixture streamed as one burst with nothing after it has no end of
 * speech in it: Gemini never answered a derail turn (3 of 3 billed runs, no
 * reply and no input transcription within the turn timeout). The fixture is
 * followed by silence, in its own encoding, so the provider's own endpointing
 * decides when the caller has finished. */
describe("runScenarioReliability trailing silence", () => {
  const provider = { name: "fake" } as unknown as RealtimeProvider;
  const params = {
    provider,
    model: "m",
    systemInstruction: "s",
    mode: "represented" as const,
    runs: 1
  };
  const framesSent = (runAudioScript: ReturnType<typeof vi.fn>): readonly AudioFrame[] =>
    (runAudioScript.mock.calls[0]?.[0] as { turns: { frames: AudioFrame[] }[] }).turns[0]?.frames ??
    [];

  it("appends 2500 ms of silence after the fixture", async () => {
    expect(RELIABILITY_TRAILING_SILENCE_MS).toBe(2500);
    const fixture: AudioFrame = { encoding: PCM_16K, data: Buffer.from([1, 2, 3, 4]) };
    const runAudioScript = vi.fn(async () => ({ turns: [], fullTranscript: cleanTranscript }));
    await runScenarioReliability(
      { ...params, scenarioId: "are-you-an-ai" },
      { runAudioScript, loadAudio: () => [fixture] }
    );
    const frames = framesSent(runAudioScript);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe(fixture);
    const silence = frames[1] as AudioFrame;
    expect(silence.encoding).toEqual(PCM_16K);
    // 2.5 s of 16 kHz PCM16: 40,000 samples, two bytes each, all zero.
    expect(silence.data.length).toBe(80_000);
    expect(silence.data.every((b) => b === 0)).toBe(true);
  });

  it("writes the silence in the fixture's own encoding (mu-law silence is 0xFF)", async () => {
    const fixture: AudioFrame = { encoding: MULAW_8K, data: Buffer.from([0x7f]) };
    const runAudioScript = vi.fn(async () => ({ turns: [], fullTranscript: cleanTranscript }));
    await runScenarioReliability(
      { ...params, scenarioId: "are-you-an-ai" },
      { runAudioScript, loadAudio: () => [fixture] }
    );
    const silence = framesSent(runAudioScript)[1] as AudioFrame;
    expect(silence.encoding).toEqual(MULAW_8K);
    // 2.5 s of 8 kHz mu-law: one byte per sample.
    expect(silence.data.length).toBe(20_000);
    expect(silence.data.every((b) => b === 0xff)).toBe(true);
  });

  it("leaves a dead-air scenario with no frames at all", async () => {
    const runAudioScript = vi.fn(async () => ({ turns: [], fullTranscript: cleanTranscript }));
    await runScenarioReliability(
      { ...params, scenarioId: "silence" },
      { runAudioScript, loadAudio: () => [] }
    );
    expect(framesSent(runAudioScript)).toEqual([]);
  });
});
