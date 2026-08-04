import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AudioFrame, RealtimeProvider } from "@parley/core";
import type { CallMode } from "@parley/policy";
import { pcm16BufferToSamples } from "@parley/audio";
import { runAudioScript as defaultRunAudioScript } from "./audio-runner.js";
import { evaluateScenarioRun } from "./evaluation.js";
import { buildReliabilityReport, type ScenarioReliabilityReport } from "./reliability-report.js";

/** Default fixture loader: reads a committed 16kHz little-endian PCM fixture for
 * a scenario and wraps it as a single pcm16k caller-audio frame. The `silence`
 * scenario has no fixture — it returns no frames (a silence turn). Fixtures are
 * generated manually (see fixtures/README) and are not required for CI, which
 * injects a fake loader. */
export function loadScenarioAudio(scenarioId: string): AudioFrame[] {
  if (scenarioId === "silence") return [];
  const url = new URL(`../fixtures/derail/${scenarioId}.pcm`, import.meta.url);
  const data = readFileSync(fileURLToPath(url));
  // Round-trip through the sample view to assert it is valid PCM16 length.
  pcm16BufferToSamples(data);
  return [{ encoding: "pcm16k", data }];
}

export interface ReliabilityDeps {
  runAudioScript?: typeof defaultRunAudioScript;
  loadAudio?: (scenarioId: string) => AudioFrame[];
}

/** Drive one derail scenario N times against a real RealtimeProvider, evaluate
 * each run, and report the longest consecutive-clean streak (design spec §10.1).
 * THIS IS THE MANUAL GATE — it makes live Gemini calls; never run in CI. */
export async function runScenarioReliability(
  params: {
    provider: RealtimeProvider;
    model: string;
    systemInstruction: string;
    openingTrigger: string;
    scenarioId: string;
    mode: CallMode;
    runs: number;
  },
  deps: ReliabilityDeps = {}
): Promise<ScenarioReliabilityReport> {
  const runAudioScript = deps.runAudioScript ?? defaultRunAudioScript;
  const loadAudio = deps.loadAudio ?? loadScenarioAudio;
  const frames = loadAudio(params.scenarioId);

  const results = [];
  for (let i = 0; i < params.runs; i++) {
    const run = await runAudioScript({
      provider: params.provider,
      model: params.model,
      systemInstruction: params.systemInstruction,
      openingTrigger: params.openingTrigger,
      turns: [{ label: params.scenarioId, frames }]
    });
    results.push(
      evaluateScenarioRun({
        scenarioId: params.scenarioId,
        mode: params.mode,
        transcript: run.fullTranscript
      })
    );
  }

  return buildReliabilityReport({
    scenarioId: params.scenarioId,
    results,
    requiredConsecutiveClean: params.runs
  });
}
