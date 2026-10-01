import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PCM_16K, type AudioEncoding, type AudioFrame, type RealtimeProvider } from "@parley/core";
import type { CallMode } from "@parley/policy";
import { pcm16BufferToSamples } from "@parley/audio";
import { runAudioScript as defaultRunAudioScript, type AudioRunResult } from "./audio-runner.js";
import { evaluateScenarioRun, type ScenarioResult } from "./evaluation.js";
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
  return [{ encoding: PCM_16K, data }];
}

/** Silence streamed after every derail fixture. A fixture is one burst of
 * speech with nothing after it, so there is no end of speech in it to detect:
 * sent as-is, Gemini never answered a derail turn. The provider's own
 * endpointing then decides when the caller has finished, as it would on a
 * call — this only gives it a pause to find. */
export const RELIABILITY_TRAILING_SILENCE_MS = 2500;

/** `ms` of silence in `encoding` — the fixture's own, so the bridge adapts it
 * exactly as it adapts the speech before it. PCM16 silence is zero; mu-law
 * encodes zero as 0xFF. */
function silenceFrame(encoding: AudioEncoding, ms: number): AudioFrame {
  const samples = Math.round((encoding.sampleRate * ms) / 1000);
  const data =
    encoding.codec === "pcm" ? Buffer.alloc(samples * 2, 0) : Buffer.alloc(samples, 0xff);
  return { encoding, data };
}

/** The fixture followed by `RELIABILITY_TRAILING_SILENCE_MS` of silence. A
 * dead-air scenario (no frames) stays empty: it is a turn in which nothing is
 * sent, and sending silence would make it a different turn. */
function withTrailingSilence(frames: readonly AudioFrame[]): AudioFrame[] {
  const last = frames.at(-1);
  if (last === undefined) return [];
  return [...frames, silenceFrame(last.encoding, RELIABILITY_TRAILING_SILENCE_MS)];
}

/** What the derail turn shows of the model's reply. Text alone would score a
 * spoken reply `no-reply` whenever its transcription trails `turnComplete` (or
 * is off), so audio and late transcript count too. */
function derailTurn(run: AudioRunResult, scenarioId: string): Record<string, unknown> {
  const turn = run.turns.find((t) => t.label === scenarioId);
  if (!turn) return {};
  return {
    derailTranscript: turn.transcript,
    derailModelAudioBytes: turn.modelAudioBytes,
    derailLateTranscript: turn.lateModelTranscript
  };
}

export interface ReliabilityDeps {
  runAudioScript?: typeof defaultRunAudioScript;
  loadAudio?: (scenarioId: string) => AudioFrame[];
  /** Called after each run is evaluated, with its 1-based index, the raw
   * result (transcript and per-turn events) and the verdict. How `--transcript`
   * gets a file per run without this module knowing about files. */
  onRun?: (info: { runIndex: number; run: AudioRunResult; result: ScenarioResult }) => void;
}

/** Drive one derail scenario N times against a real RealtimeProvider, evaluate
 * each run, and report the longest consecutive-clean streak (design spec §10.1).
 * THIS IS THE MANUAL GATE — it makes live provider calls; never run in CI.
 *
 * Every derail scenario is a two-party call, so `runAudioScript` plans the
 * opening for a two-party call on whatever delivery `provider` declares. */
export async function runScenarioReliability(
  params: {
    provider: RealtimeProvider;
    model: string;
    systemInstruction: string;
    scenarioId: string;
    mode: CallMode;
    runs: number;
  },
  deps: ReliabilityDeps = {}
): Promise<ScenarioReliabilityReport> {
  const runAudioScript = deps.runAudioScript ?? defaultRunAudioScript;
  const loadAudio = deps.loadAudio ?? loadScenarioAudio;
  const frames = withTrailingSilence(loadAudio(params.scenarioId));

  const results = [];
  for (let i = 0; i < params.runs; i++) {
    const run = await runAudioScript({
      provider: params.provider,
      model: params.model,
      systemInstruction: params.systemInstruction,
      turns: [{ label: params.scenarioId, frames }]
    });
    const result = evaluateScenarioRun({
      scenarioId: params.scenarioId,
      mode: params.mode,
      transcript: run.fullTranscript,
      // The turn that carried the derail audio; a run without it (a fake that
      // reports no turns) is not judged for a reply.
      ...derailTurn(run, params.scenarioId)
    });
    results.push(result);
    deps.onRun?.({ runIndex: i + 1, run, result });
  }

  return buildReliabilityReport({
    scenarioId: params.scenarioId,
    results,
    requiredConsecutiveClean: params.runs
  });
}
