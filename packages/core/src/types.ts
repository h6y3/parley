/** Minimal structural shape for an inbound media-stream socket. Not specified by
 * name in the design spec beyond `AttachMediaStreamParams.socket: WebSocketLike`
 * (§7.1) — this is Parley's own minimal contract, sized to what
 * `attachMediaStream` needs. A real `TelephonyProvider` implementation (e.g.
 * @parley/telephony-twilio, built in a later milestone) adapts its actual
 * transport (a `ws` WebSocket, Twilio's SDK socket, etc.) to this shape. */
import type { ToolDeclaration, ToolResult } from "./execution.js";

/** One tool invocation requested by the model.
 *
 * `args` is raw and UNTRUSTED — it is model output shaped by a live
 * conversation with a stranger. Validate it in ToolGate; never act on it
 * directly. */
export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface WebSocketLike {
  send(data: string | Buffer): void;
  on(event: "message" | "close" | "error", listener: (...args: unknown[]) => void): void;
  close(): void;
}

export interface AudioFrame {
  encoding: "mulaw8k" | "pcm16k" | "pcm24k";
  data: Buffer;
}

/** Two-way audio bridge between the telephony carrier's encoding and the
 * realtime model's (design spec §3, §4.5). Implemented by @parley/audio and
 * injected into CallSession, so @parley/core carries no DSP dependency. */
export interface AudioCodec {
  /** Carrier inbound → model input: 8kHz μ-law → 16kHz PCM. */
  decodeInbound(frame: AudioFrame): AudioFrame;
  /** Model output → carrier outbound: 24kHz PCM → 8kHz μ-law. */
  encodeOutbound(frame: AudioFrame): AudioFrame;
  /** Keypad digits as carrier-ready audio, to be sent IN-BAND down the stream
   * the call is already on — which is how a telephone keypad has always
   * worked. It lives on the codec rather than on the telephony provider
   * because it is signal generation, and because the provider-side alternative
   * hung up the call: see @parley/audio's dtmf.ts. */
  dtmfTones(digits: string): AudioFrame;
}

export type CallLifecycleEvent =
  | { type: "ringing" }
  /** `answeredBy` is populated only when the caller opted into carrier-side
   * answering-machine detection. Without it, whether a machine picked up is
   * something the model has to infer from a few hundred milliseconds of audio. */
  | { type: "answered"; answeredBy?: "human" | "machine" | "fax" | "unknown" }
  | { type: "completed"; durationSeconds: number }
  | { type: "failed"; reason: string };

export interface OriginateParams {
  to: string;
  from: string;
  answerWebhookUrl: string;
  statusCallbackUrl?: string;
  /** Carrier-side answering-machine detection. Opt-in: it costs answer latency
   * and a per-call fee on EVERY call, machine-answered or not. */
  machineDetection?: "Enable" | "DetectMessageEnd";
}

export interface OriginateResult {
  providerCallId: string;
  status: "queued" | "ringing" | "in-progress" | "failed";
}

export interface AnswerResponseParams {
  callId: string;
  mediaStreamUrl: string; // wss:// URL the carrier should open a media stream to
}

export interface AnswerResponse {
  contentType: string; // e.g. "text/xml" for TwiML
  body: string;
}

export interface WebhookVerificationRequest {
  headers: Record<string, string>;
  rawBody: string;
  fullUrl: string; // reconstructed from the configured host allowlist, never trusted from request headers alone
}

export interface AttachMediaStreamParams {
  callId: string;
  socket: WebSocketLike; // the inbound media-stream connection from the carrier
  onInboundAudio: (frame: AudioFrame) => void;
  onCallEvent: (event: CallLifecycleEvent) => void;
}

export interface MediaStreamHandle {
  sendOutboundAudio(frame: AudioFrame): void;
  /** Tells the carrier to immediately discard any buffered outbound audio — the
   * telephony-layer half of barge-in handling (design spec §4.5). */
  clearOutboundBuffer(): void;
  /** Resolve once the carrier has PLAYED everything queued, or after
   * `timeoutMs`, whichever comes first.
   *
   * Outbound audio is paced at 20ms a frame and the carrier holds a playout
   * buffer of its own, so when the model ends a call its closing sentence is
   * still in flight. Hanging up then cuts it off mid-word — observed on the
   * first live call that ever completed its objective. Waiting on the carrier's
   * own confirmation is the condition; the timeout only bounds a confirmation
   * that never arrives, and must never be the thing being waited for. */
  drainOutbound(timeoutMs: number): Promise<{ confirmed: boolean; waitedMs: number }>;
  close(): void;
}

/** A provider capable of originating and carrying a phone call's audio. */
export interface TelephonyProvider {
  readonly name: string;
  /** Originate an outbound call. Returns provider-native identifiers for tracking. */
  originate(params: OriginateParams): Promise<OriginateResult>;
  /** Produce the response body for the provider's "call answered" webhook
   * (e.g. TwiML for Twilio), telling the carrier where to open its media
   * stream. */
  buildAnswerResponse(params: AnswerResponseParams): AnswerResponse;
  /** Verify an inbound webhook request actually originated from this provider.
   * Must fail closed: any doubt returns false, never a best-effort accept
   * (design spec §8). */
  verifyWebhookSignature(request: WebhookVerificationRequest): boolean;
  /** Attach to a call's bidirectional media stream. `onInboundAudio` receives
   * frames in the provider's native encoding (8kHz mu-law for Twilio); the
   * returned handle accepts frames in the same encoding. */
  attachMediaStream(params: AttachMediaStreamParams): MediaStreamHandle;

  /* NOTE: no sendDtmf. Keypresses are audio, sent in-band by the codec through
     the open media stream — see AudioCodec.dtmfTones. A provider-side method
     existed and Twilio's implementation posted replacement TwiML to the live
     call, which redirected it off the media stream and hung up on the callee.
     There is no non-destructive REST way to do this on a streaming call, and
     no need for one. */
  /** Terminate an active call. */
  hangup(callId: string, reason?: string): Promise<void>;
}

export interface TurnDetectionConfig {
  mode: "automatic" | "manual";
  startSensitivity?: "low" | "medium" | "high";
  silenceDurationMs?: number;
}

export interface TranscriptEvent {
  speaker: "caller" | "model";
  /** An incremental DELTA of the current turn's transcript, not a full
   * utterance. A provider emits one event per fragment and closes a turn with
   * an `isFinal: true` event (which may carry empty `text`). To reconstruct an
   * utterance, concatenate consecutive same-speaker events (no separator) up to
   * and including `isFinal` — see @parley/harness `aggregateTranscript`. */
  text: string;
  /** Marks the final event of the current speaker's turn. */
  isFinal: boolean;
}

export interface RealtimeProviderError {
  code: string;
  message: string;
  fatal: boolean;
}

export interface RealtimeSessionCallbacks {
  onAudio: (frame: AudioFrame) => void;
  /** Model generation was cut off by caller barge-in. */
  onInterrupted: () => void;
  onTranscript: (event: TranscriptEvent) => void;
  /** The model requested a tool call. The handler decides and MUST answer via
   * `sendToolResponse` — an unanswered tool call stalls the model's turn, which
   * on a live call is silence. */
  onToolCall?: (call: ToolCallRequest) => void;
  /** The model finished generating a turn.
   *
   * Needed because a tool call can arrive BEFORE the audio for the same turn
   * has been generated: the model asks to end the call while its goodbye is
   * still being produced upstream. Draining our own queue cannot wait for audio
   * nobody has sent us yet, which is why a five-second drain still truncated a
   * farewell on a live call. */
  onTurnComplete?: () => void;
  onError: (error: RealtimeProviderError) => void;
  onClose: (reason: string) => void;
}

export interface RealtimeConnectParams {
  model: string;
  /** Plain prose; persona -> rules/objective -> guardrails, per design spec
   * §4.3. Sent exactly once, immutable for the session's lifetime. */
  systemInstruction: string;
  responseModality: "audio";
  voice?: string;
  turnDetection?: TurnDetectionConfig;
  /** Tools the model may call. Absent or empty means the session has NO tool
   * channel at all — byte-identical to Parley before tools existed. */
  tools?: readonly ToolDeclaration[];
  turnCoverage?: "onlyActivity" | "all";
  contextWindowCompression?: boolean;
  inputTranscription?: boolean;
  outputTranscription?: boolean;
  callbacks: RealtimeSessionCallbacks;
}

export interface RealtimeSession {
  /** Send the single short generic line that starts the conversation. Must
   * never be used for anything but a one-sentence "begin talking now"
   * directive — never the brief, never a persona restatement (design spec
   * §4.1). */
  sendOpeningTrigger(text: string): void;
  /** Stream one frame of caller audio into the model. */
  sendAudio(frame: AudioFrame): void;
  /** Signal that the caller has stopped speaking. Only meaningful under manual
   * turn detection; a no-op under automatic VAD. */
  notifyActivityEnd(): void;
  /** Answer a tool call.
   *
   * `result` is typed `ToolResult` — a closed union of string literals — so no
   * argument, callee utterance, or error message can be interpolated into text
   * the model reads. The compiler enforces that at every call site; it is not
   * left to a convention. */
  sendToolResponse(call: ToolCallRequest, result: ToolResult): void;
  close(): Promise<void>;
}

/** A provider capable of hosting a realtime, audio-native conversational
 * session. Note what is deliberately absent: there is no method to update
 * `systemInstruction` after connect, and no general-purpose "send an arbitrary
 * turn" escape hatch. The ways to put words in front of the model are
 * connect()'s one-time systemInstruction, sendOpeningTrigger()'s one-shot short
 * line, and — only when the caller declared tools — sendToolResponse(), whose
 * content is confined to the closed `ToolResult` union. This is the
 * interface-level enforcement of the guarantee in design spec §4 (see §7.2):
 * the model may be given the ability to ACT, never the ability to be
 * RE-INSTRUCTED. */
export interface RealtimeProvider {
  readonly name: string;
  /** Open a new realtime session. `systemInstruction` is sent exactly once, as
   * part of session setup, and is immutable for the session's lifetime. */
  connect(params: RealtimeConnectParams): Promise<RealtimeSession>;
}
