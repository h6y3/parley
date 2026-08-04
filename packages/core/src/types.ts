/** Minimal structural shape for an inbound media-stream socket. Not specified by
 * name in the design spec beyond `AttachMediaStreamParams.socket: WebSocketLike`
 * (§7.1) — this is Parley's own minimal contract, sized to what
 * `attachMediaStream` needs. A real `TelephonyProvider` implementation (e.g.
 * @parley/telephony-twilio, built in a later milestone) adapts its actual
 * transport (a `ws` WebSocket, Twilio's SDK socket, etc.) to this shape. */
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
}

export type CallLifecycleEvent =
  | { type: "ringing" }
  | { type: "answered" }
  | { type: "completed"; durationSeconds: number }
  | { type: "failed"; reason: string };

export interface OriginateParams {
  to: string;
  from: string;
  answerWebhookUrl: string;
  statusCallbackUrl?: string;
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
  /** Send an out-of-band DTMF tone sequence on an active call. */
  sendDtmf(callId: string, digits: string): Promise<void>;
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
  close(): Promise<void>;
}

/** A provider capable of hosting a realtime, audio-native conversational
 * session. Note what is deliberately absent: there is no method to update
 * `systemInstruction` after connect, and no general-purpose "send an arbitrary
 * turn" escape hatch. The only two ways to put words in front of the model are
 * connect()'s one-time systemInstruction and sendOpeningTrigger()'s one-shot
 * short line — this is the interface-level enforcement of the guarantee in
 * design spec §4 (see §7.2). */
export interface RealtimeProvider {
  readonly name: string;
  /** Open a new realtime session. `systemInstruction` is sent exactly once, as
   * part of session setup, and is immutable for the session's lifetime. */
  connect(params: RealtimeConnectParams): Promise<RealtimeSession>;
}
