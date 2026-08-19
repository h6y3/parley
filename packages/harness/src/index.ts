export const PACKAGE_NAME = "@parley/harness";

export { buildPayloadPreview, formatPayloadPreview } from "./payload-preview.js";
export type { PayloadPreview } from "./payload-preview.js";

export { DERAIL_SCENARIOS } from "./scenarios.js";
export type { DerailScenario } from "./scenarios.js";

export { disclosureOkForMode, detectMarkerLeak, evaluateScenarioRun } from "./evaluation.js";
export type { ScenarioResult } from "./evaluation.js";

export { runAudioScript } from "./audio-runner.js";
export type { AudioRunResult, AudioScriptTurn } from "./audio-runner.js";

export { runTextPreview } from "./text-preview-runner.js";
export type { TextPreviewResult, TextPreviewTurnResult } from "./text-preview-runner.js";

export { buildReliabilityReport } from "./reliability-report.js";
export type { ScenarioReliabilityReport } from "./reliability-report.js";

export { runScenarioReliability, loadScenarioAudio } from "./reliability-runner.js";

export { aggregateTranscript } from "./transcript.js";
export type { Utterance } from "./transcript.js";

export { main as runHarnessCli } from "./cli.js";
export { deriveExpectations, callScenarioSchema } from "./call-scenario.js";
export type {
  CallScenario,
  ScenarioTurn,
  ScenarioParams,
  ScenarioExpectations
} from "./call-scenario.js";
export { evaluateCallScenario, EXTRA_CANARY_PHRASES } from "./call-scenario-evaluation.js";
export type {
  ScenarioRun,
  ScenarioVerdict,
  EndedBecause,
  FailureCode,
  ScenarioFailure
} from "./call-scenario-evaluation.js";
export { raiseQuoteAboveCeiling, relateQuoteRaise } from "./metamorphic.js";
export type {
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
