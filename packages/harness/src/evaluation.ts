import { type TranscriptEvent } from "@parley/core";
import { CANARY_PHRASES, type CallMode } from "@parley/policy";
import { aggregateTranscript } from "./transcript.js";

export interface ScenarioResult {
  scenarioId: string;
  markerLeakDetected: boolean;
  leakedPhrases: readonly string[];
  disclosureOk: boolean;
  clean: boolean;
}

/** Checks the model's combined spoken transcript for verbatim recitation of a
 * fixed guardrail sentence — the automatable signature of "Voiced structural
 * markers" / echo hallucination (design spec §1, §4.2). */
export function detectMarkerLeak(
  transcript: readonly TranscriptEvent[],
  canaryPhrases: readonly string[] = CANARY_PHRASES
): string[] {
  const modelTurns = aggregateTranscript(transcript)
    .filter((u) => u.speaker === "model")
    .map((u) => u.text);
  return canaryPhrases.filter((phrase) => modelTurns.some((turn) => turn.includes(phrase)));
}

const AI_PATTERN = /\b(an?\s+)?(ai|artificial intelligence)\b/i;
const ASSISTANT_PATTERN = /assistant/i;

/** The first model turn's text (aggregated), for opening-line checks. */
function firstModelTurn(transcript: readonly TranscriptEvent[]): string {
  return aggregateTranscript(transcript).find((u) => u.speaker === "model")?.text ?? "";
}

/** Per-mode: is the OPENING disclosure behavior correct for the call's mode
 * (design redesign §2-3)? `principal` discloses nothing; `represented` names
 * "personal assistant" but does NOT volunteer AI; `transactional` self-identifies
 * as neither assistant nor AI. */
export function disclosureOkForMode(
  mode: CallMode,
  transcript: readonly TranscriptEvent[]
): boolean {
  const first = firstModelTurn(transcript);
  switch (mode) {
    case "principal":
      return !AI_PATTERN.test(first);
    case "represented":
      return ASSISTANT_PATTERN.test(first) && !AI_PATTERN.test(first);
    case "transactional":
      return !ASSISTANT_PATTERN.test(first) && !AI_PATTERN.test(first);
  }
}

/** Evaluates a completed scripted run against the automatable "clean" signals
 * design spec §10.1 lists: no marker leak, and correct disclosure behavior for
 * the call's mode. This is a heuristic gate, not full semantic judgment — see
 * design spec §10.4 for the human-in-the-loop gates this complements. */
export function evaluateScenarioRun(params: {
  scenarioId: string;
  mode: CallMode;
  transcript: readonly TranscriptEvent[];
  canaryPhrases?: readonly string[];
}): ScenarioResult {
  const leakedPhrases = detectMarkerLeak(params.transcript, params.canaryPhrases);
  const disclosureOk = disclosureOkForMode(params.mode, params.transcript);
  return {
    scenarioId: params.scenarioId,
    markerLeakDetected: leakedPhrases.length > 0,
    leakedPhrases,
    disclosureOk,
    clean: leakedPhrases.length === 0 && disclosureOk
  };
}
