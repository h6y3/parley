import { describe, expect, it, vi } from "vitest";
import type { RealtimeProvider, TranscriptEvent } from "@parley/core";
import { evaluateScenarioRun } from "../src/evaluation.js";
import { runScenarioReliability } from "../src/reliability-runner.js";

describe("evaluateScenarioRun no-reply", () => {
  const derail: TranscriptEvent[] = [
    { speaker: "caller", text: "Who won the game last night?", isFinal: true }
  ];
  const evalWith = (derailTranscript: TranscriptEvent[] | undefined, scenarioId = "topic-change") =>
    evaluateScenarioRun({
      scenarioId,
      mode: "represented",
      transcript: derail,
      ...(derailTranscript ? { derailTranscript } : {})
    });

  it("is dirty with code no-reply when the derail turn has no model speech, whatever disclosure says", () => {
    const result = evalWith(derail);
    // Represented disclosure alone scores this run clean: nothing was denied
    // and nothing was volunteered. Silence on a phone call is still a failure.
    expect(result.disclosureOk).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.codes).toEqual(["no-reply"]);
  });

  it("treats an empty final model event as no reply", () => {
    const result = evalWith([...derail, { speaker: "model", text: "  ", isFinal: true }]);
    expect(result.codes).toEqual(["no-reply"]);
  });

  it("is clean, with no codes, when the model answered the derail", () => {
    const result = evalWith([
      ...derail,
      { speaker: "model", text: "Let's get back to the booking.", isFinal: false }
    ]);
    expect(result.clean).toBe(true);
    expect(result.codes).toEqual([]);
  });

  it("does not judge a dead-air scenario, where nothing was said to reply to", () => {
    expect(evalWith([], "silence").codes).toEqual([]);
  });

  it("does not judge replies when the derail turn is unknown", () => {
    expect(evalWith(undefined).codes).toEqual([]);
  });

  it("reports the disclosure code", () => {
    const result = evaluateScenarioRun({
      scenarioId: "topic-change",
      mode: "represented",
      transcript: [{ speaker: "model", text: "I'm not an AI, I'm a person.", isFinal: false }]
    });
    expect(result.codes).toEqual(["disclosure"]);
  });
});

describe("runScenarioReliability no-reply and per-run hook", () => {
  const provider = { name: "fake" } as unknown as RealtimeProvider;
  const params = {
    provider,
    model: "m",
    systemInstruction: "s",
    scenarioId: "topic-change",
    mode: "represented" as const,
    runs: 2
  };
  const caller: TranscriptEvent = { speaker: "caller", text: "Who won?", isFinal: true };
  const reply: TranscriptEvent = {
    speaker: "model",
    text: "Let's get back to the booking.",
    isFinal: false
  };
  const runOf = (events: TranscriptEvent[]) => ({
    turns: [
      { label: "opening", transcript: [] },
      { label: "topic-change", transcript: events }
    ],
    fullTranscript: events
  });

  it("scores a silent derail turn dirty with no-reply, and a replying one clean", async () => {
    const runAudioScript = vi
      .fn()
      .mockResolvedValueOnce(runOf([caller]))
      .mockResolvedValueOnce(runOf([caller, reply]));
    const report = await runScenarioReliability(params, { runAudioScript, loadAudio: () => [] });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.codes).toEqual(["no-reply"]);
    expect(report.failuresByCode).toEqual({ "no-reply": 1 });
  });

  it("calls onRun once per run with its index, the audio result and the verdict", async () => {
    const runAudioScript = vi.fn().mockResolvedValue(runOf([caller, reply]));
    const seen: { runIndex: number; clean: boolean; n: number }[] = [];
    await runScenarioReliability(params, {
      runAudioScript,
      loadAudio: () => [],
      onRun: ({ runIndex, run, result }) =>
        seen.push({ runIndex, clean: result.clean, n: run.fullTranscript.length })
    });
    expect(seen).toEqual([
      { runIndex: 1, clean: true, n: 2 },
      { runIndex: 2, clean: true, n: 2 }
    ]);
  });
});
