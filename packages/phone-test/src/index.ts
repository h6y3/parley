export const PACKAGE_NAME = "@parley/phone-test";
export {
  loadScenario,
  loadConfigs,
  buildEnvelope,
  CALL_CEILING_SECONDS,
  parsePersona,
  personaPrompt,
  withoutDiagnosticPersonas
} from "./scenario.js";
export { CaptureRecorder, splitStereo } from "./capture.js";
export type { Timeline } from "./capture.js";
export type {
  CalleePersona,
  PhoneScenario,
  ScenarioBrief,
  ScenarioExecution,
  TestConfig
} from "./scenario.js";
export { createTwilioNumbersClient } from "./twilio-numbers.js";
export type {
  OwnedNumber,
  TwilioNumbersClient,
  TwilioNumbersClientOptions
} from "./twilio-numbers.js";
export {
  CALLEE_ANSWER_CUE,
  SIM_MAX_CALL_MS,
  SIM_PORT,
  WRONG_NUMBER_PERSONA,
  createSimHandler,
  createSimServer
} from "./sim-server.js";
export type {
  SimHandler,
  SimHandlerOptions,
  SimHttpRequest,
  SimHttpResponse,
  SimResult,
  SimServerOptions
} from "./sim-server.js";
export { CAMPAIGN_FRIENDLY_NAME, campaignStatus, startCampaign, stopCampaign } from "./campaign.js";
export type { CampaignDeps, CampaignState, CampaignStatus } from "./campaign.js";
export {
  RATES_USD_PER_MIN,
  appendSpend,
  callCostUsd,
  campaignSpendUsd,
  monthSpendUsd
} from "./spend.js";
export type { DeepgramTier, RealtimeProvider, SpendEntry } from "./spend.js";
export {
  HANGUP_WAIT_MS,
  RECORD_POLL_MS,
  RECORD_WAIT_MS,
  RESULT_POLL_MS,
  RESULT_TIMEOUT_MS,
  WORST_CASE_MINUTES,
  agentTier,
  assertDialable,
  runCampaign
} from "./runner.js";
export type { CallErrorCode, CallResult, RunCampaignOptions } from "./runner.js";
export { checkOutcome } from "./outcome.js";
export type { CompletedCallRecordLike } from "./outcome.js";
export { analyzeTiming, loadThresholds, parseThresholds, segments } from "./timing.js";
export type { Segment, Thresholds, TimingCode, TimingReport } from "./timing.js";
export {
  DEFAULT_JUDGE_MODEL,
  JUDGE_PROMPT,
  callTranscript,
  createGeminiJudge,
  judgePair,
  winRates
} from "./judge.js";
export { REPORT_NO_JUDGE, writeReport } from "./report.js";
export {
  CALLEE_VOICES,
  CAMPAIGN_STATE_FILE,
  DEFAULT_BUDGET_USD,
  PHONE_TEST_USAGE,
  SIM_LOG_FILE,
  SIM_PID_FILE,
  SPEND_LOG_FILE,
  WATCHDOG_HOURS,
  callRecordsPath,
  calleeFor,
  defaultOutDir,
  defaultStateDir,
  detachedSim,
  groupByProvider,
  judgePairs,
  parseCampaignArgs,
  parseSimArgs,
  requireEnvVars,
  runCampaignCli,
  runSimCli,
  scoreCall
} from "./cli.js";
export type { CampaignArgs, PhoneTestCliDeps, SimProcess, SimServeArgs } from "./cli.js";
export type { ReportCall, ReportResult, WriteReportOptions } from "./report.js";
export type {
  GeminiJudgeOptions,
  JudgeClient,
  JudgeInput,
  JudgeVerdict,
  PairJudgement
} from "./judge.js";
