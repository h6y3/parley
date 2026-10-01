export const PACKAGE_NAME = "@parley/harness";

export { buildPayloadPreview, formatPayloadPreview } from "./payload-preview.js";
export type { PayloadPreview } from "./payload-preview.js";

export { DERAIL_SCENARIOS, MEETING_SCENARIOS } from "./scenarios.js";
export type { DerailScenario } from "./scenarios.js";

export { disclosureOkForMode, detectMarkerLeak, evaluateScenarioRun } from "./evaluation.js";
export type { ScenarioResult, ReliabilityCode } from "./evaluation.js";

export { runAudioScript } from "./audio-runner.js";
export type { AudioRunResult, AudioScriptTurn } from "./audio-runner.js";

export { runTextPreview } from "./text-preview-runner.js";
export type { TextPreviewResult, TextPreviewTurnResult } from "./text-preview-runner.js";

export { buildReliabilityReport } from "./reliability-report.js";
export type { ScenarioReliabilityReport } from "./reliability-report.js";

export {
  runScenarioReliability,
  loadScenarioAudio,
  RELIABILITY_TRAILING_SILENCE_MS
} from "./reliability-runner.js";

export { aggregateTranscript } from "./transcript.js";
export type { Utterance } from "./transcript.js";

export { main as runHarnessCli, METAMORPHIC_RELATIONS } from "./cli.js";
export type { MetamorphicRelationId } from "./cli.js";
export { deriveExpectations, callScenarioSchema } from "./call-scenario.js";
export type {
  CallScenario,
  ScenarioTurn,
  ScenarioParams,
  CallShapeParams,
  MeetingShapeParams,
  ScenarioExpectations,
  CallShapeExpectations,
  MeetingShapeExpectations
} from "./call-scenario.js";
export { evaluateCallScenario, EXTRA_CANARY_PHRASES } from "./call-scenario-evaluation.js";
export type {
  ScenarioRun,
  ScenarioVerdict,
  EndedBecause,
  FailureCode,
  ScenarioFailure
} from "./call-scenario-evaluation.js";
export {
  raiseQuoteAboveCeiling,
  relateConsentGate,
  relateQuoteRaise,
  withoutConsentPhrase
} from "./metamorphic.js";
export type {
  ConsentPhrasePair,
  MetamorphicPair,
  PairResult,
  RelationOutcome,
  RelationVerdict
} from "./metamorphic.js";
export {
  runCallScenario,
  DEFAULT_SCENARIO_MODEL,
  DEFAULT_SCENARIO_TIMINGS
} from "./call-scenario-runner.js";
export type { ScenarioTraceEvent, ScenarioTimings } from "./call-scenario-runner.js";
export type { ScenarioTransport } from "./scenario-transport.js";
export { geminiTransport } from "./transports/gemini-transport.js";
export { deepgramTransport } from "./transports/deepgram-transport.js";
export {
  AXIS_MATRIX,
  matrixCells,
  buildScenarioRequest,
  authorPrompt,
  generateScenarios
} from "./generate-scenarios.js";
export type {
  MatrixCell,
  ScenarioRequest,
  AuthoredContent,
  ScenarioAuthor,
  SpecFinding
} from "./generate-scenarios.js";
