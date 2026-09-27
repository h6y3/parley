export { DEFAULT_MAX_MEETING_SECONDS, JOIN_OUTCOMES } from "./types.js";
export type { BrowserMeetingConfig, CaptionCue, JoinOutcome, PlatformAdapter } from "./types.js";
export { ALIGN_WINDOW_MS, ROSTER_CONFIDENCE, attributeEvents } from "./attribution.js";
export { emitMeetingArtifacts } from "./artifacts.js";
export { createFrameCoverageClock, measureCoverage } from "./coverage.js";
export type { Coverage, CoverageInput, FrameCoverageClock } from "./coverage.js";
export { createCueLedger } from "./cue-ledger.js";
export type { CueLedger } from "./cue-ledger.js";
export type { EmitInput } from "./artifacts.js";
export {
  CAPTION_RESIDUAL_TOLERANCE_CHARS,
  ENSURE_CAPTIONS_ATTEMPTS,
  ENSURE_CAPTIONS_POLL_MS,
  IN_CALL_ANCHORS,
  IN_CALL_ANCHOR_SELECTOR,
  IN_CALL_ANCHOR_VISIBLE_SELECTOR,
  IN_CALL_CONTROLS,
  IN_MEETING_MARKERS,
  PRE_JOIN,
  SELECTORS,
  googleMeetAdapter
} from "./google-meet.js";
export {
  DEFAULT_FFMPEG_PATH,
  STOP_SIGKILL_GRACE_MS,
  STOP_SIGTERM_GRACE_MS,
  startAudioTap
} from "./audio-tap.js";
export type { AudioTap, AudioTapDeps, AudioTapOptions } from "./audio-tap.js";
export {
  DEFAULT_ENDED_POLL_MS,
  DEFAULT_PRE_JOIN_POLL_MS,
  DeviceStateUnknownError,
  DEFAULT_WAITING_ROOM_TIMEOUT_MS,
  HAS_ENDED_CONFIRM_MS,
  confirmPollsForWindow,
  classifyPreJoin,
  driveToggle,
  joinMeeting,
  waitUntilMeetingEnded
} from "./join-driver.js";
export type {
  JoinLocator,
  JoinMeetingOptions,
  JoinPage,
  PreJoinSelectors,
  ToggleResult,
  WaitUntilMeetingEndedOptions
} from "./join-driver.js";
export { CAPTION_POLL_MS, TEARDOWN_STEP_TIMEOUT_MS, runBrowserMeeting } from "./session.js";
export type { BrowserMeetingResult, SessionDeps } from "./session.js";
export { TranscriptionInterruptedError, partialTranscript } from "./transcription-interrupted.js";
export { DEFAULT_POST_CALL_TIMEOUT_MS, dispatchPostCall } from "./post-call.js";
export type { DispatchPostCallOptions } from "./post-call.js";
export {
  CDP_PROBE_TIMEOUT_MS,
  DEVICE_LIST_TIMEOUT_MS,
  MeetingPreflightError,
  chromeLaunchHint,
  parseAvfoundationAudioDevices,
  preflightMeeting,
  realPreflightDeps
} from "./preflight.js";
export type { PreflightDeps, PreflightSubject } from "./preflight.js";
export { OperatorFacingError, isOperatorFacingError } from "./operator-error.js";
export {
  DEFAULT_CDP_ENDPOINT,
  MEETING_EXIT_CAPTURE_FAULT,
  MEETING_EXIT_NEVER_JOINED,
  MEETING_EXIT_OK,
  MEETING_JOIN_USAGE,
  MeetingConfigError,
  createMeetingSession,
  defaultChromeProfileDir,
  describeMeetingResult,
  meetingExitCode,
  realConnectOverCdp,
  realConnectTranscription,
  realRuntimeDeps,
  realStartTap,
  resolveMeetingJoinConfig,
  runMeetingJoin
} from "./run.js";
export type {
  CdpBrowser,
  CdpBrowserContext,
  ClosablePage,
  ConnectOverCdp,
  ConnectTranscription,
  MeetingJoinConfig,
  MeetingJoinDeps,
  MeetingRuntimeDeps,
  MeetingSession,
  ResolveDeps,
  StartTap
} from "./run.js";
