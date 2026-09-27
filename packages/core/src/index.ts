export const PACKAGE_NAME = "@parley/core";

export type {
  AnswerResponse,
  AnswerResponseParams,
  AttachMediaStreamParams,
  AudioCodec,
  AudioEncoding,
  AudioFrame,
  AudioSource,
  CallLifecycleEvent,
  MediaStreamHandle,
  OriginateParams,
  OriginateResult,
  RealtimeConnectParams,
  RealtimeProvider,
  RealtimeProviderError,
  RealtimeSession,
  RealtimeSessionCallbacks,
  SpeakerRole,
  TelephonyProvider,
  ToolCallRequest,
  TranscriptEvent,
  TranscriptWord,
  TurnDetectionConfig,
  WebhookVerificationRequest,
  WebSocketLike
} from "./types.js";

export {
  encodingEquals,
  formatEncoding,
  MIXED_SOURCE,
  MULAW_8K,
  PCM_16K,
  PCM_24K
} from "./types.js";

export type { Brief } from "./brief.js";

export { redactPhoneNumber, redactSecrets } from "./redaction.js";

export { MEETING_OPENING_TRIGGER, OPENING_TRIGGER, renderSystemInstruction } from "./render.js";
export type { RenderInput } from "./render.js";

export {
  CallSession,
  describeLifecycleEvent,
  TRANSCRIPTION_CONNECT_TIMEOUT_MS
} from "./call-session.js";
export type {
  AudioSink,
  CallPhase,
  CallSessionHandle,
  CallSessionParams,
  EndReason
} from "./call-session.js";

export { AudioBridge } from "./audio-bridge.js";
export type { FrameConverter } from "./audio-bridge.js";

export { TRANSCRIPTION_PLANE_HAS_NO_OUTBOUND } from "./transcription.js";
export type {
  TranscriptionCallbacks,
  TranscriptionConnectParams,
  TranscriptionProvider,
  TranscriptionProviderError,
  TranscriptionSession
} from "./transcription.js";

export type {
  CallExecution,
  HeardUtterance,
  ToolName,
  ToolResult,
  RecordedOutcome,
  ToolDeclaration,
  ToolCarrier
} from "./execution.js";
export {
  TOOL_RESULTS,
  SEND_DIGITS_PATTERN,
  SEND_DIGITS_MAX_LENGTH,
  anchorConsentBoundary,
  buildToolDeclarations,
  findConsentMatch,
  isConsentDenial,
  ToolGate,
  routeToolCall
} from "./execution.js";

export type {
  MeetingExecution,
  ConsentReceipt,
  JoinOutcome,
  MeetingTransport,
  TranscriptGap
} from "./meeting.js";
export {
  CALL_MAX_DURATION_SECONDS,
  consentIsSpoken,
  DEFAULT_MEETING_TRANSPORT,
  JOIN_OUTCOMES,
  MEETING_TRANSPORTS,
  SPOKEN_CONSENT_TRANSPORTS,
  MEETING_MAX_DURATION_SECONDS,
  CALL_MAX_PRESSES,
  MEETING_MAX_PRESSES,
  PRE_CONSENT_BUFFER_MAX
} from "./meeting.js";
