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
