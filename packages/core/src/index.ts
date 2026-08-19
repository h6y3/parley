export const PACKAGE_NAME = "@parley/core";

export type {
  AnswerResponse,
  AnswerResponseParams,
  AttachMediaStreamParams,
  AudioCodec,
  AudioFrame,
  CallLifecycleEvent,
  MediaStreamHandle,
  OriginateParams,
  OriginateResult,
  RealtimeConnectParams,
  RealtimeProvider,
  RealtimeProviderError,
  RealtimeSession,
  RealtimeSessionCallbacks,
  TelephonyProvider,
  ToolCallRequest,
  TranscriptEvent,
  TurnDetectionConfig,
  WebhookVerificationRequest,
  WebSocketLike
} from "./types.js";

export type { Brief } from "./brief.js";

export { redactPhoneNumber, redactSecrets } from "./redaction.js";

export { OPENING_TRIGGER, renderSystemInstruction } from "./render.js";
export type { RenderInput } from "./render.js";

export { CallSession } from "./call-session.js";
export type { CallSessionHandle, CallSessionParams, EndReason } from "./call-session.js";
export type {
  CallExecution,
  ToolName,
  ToolResult,
  RecordedOutcome,
  ToolDeclaration,
  ToolCarrier
} from "./execution.js";
export { TOOL_RESULTS, buildToolDeclarations, ToolGate, routeToolCall } from "./execution.js";
