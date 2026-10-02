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

export interface AudioEncoding {
  codec: "mulaw" | "pcm";
  sampleRate: number;
}

export const MULAW_8K: AudioEncoding = Object.freeze({ codec: "mulaw", sampleRate: 8000 });
export const PCM_16K: AudioEncoding = Object.freeze({ codec: "pcm", sampleRate: 16000 });
export const PCM_24K: AudioEncoding = Object.freeze({ codec: "pcm", sampleRate: 24000 });

export function encodingEquals(a: AudioEncoding, b: AudioEncoding): boolean {
  return a.codec === b.codec && a.sampleRate === b.sampleRate;
}

export function formatEncoding(e: AudioEncoding): string {
  return `${e.codec}@${e.sampleRate}`;
}

export interface AudioFrame {
  encoding: AudioEncoding;
  data: Buffer;
}

/** Which audio stream a frame arrived on.
 *
 * A PSTN carrier delivers ONE mixed stream and passes MIXED_SOURCE. A native
 * meeting API delivers one stream per participant and populates
 * `participantId`. The parameter exists now because adding it later would
 * break the single callback every audio sink hangs off. */
export interface AudioSource {
  streamId: string;
  participantId?: string;
}

export const MIXED_SOURCE: AudioSource = Object.freeze({ streamId: "mixed" });

/** Signal generation the carrier needs that no realtime model provides.
 * Implemented by @parley/audio and injected into CallSession, so @parley/core
 * carries no DSP dependency.
 *
 * It used to carry the speaking plane's two conversions as well, hard-wired to
 * one vendor's rates (carrier → pcm@16000, pcm@24000 → carrier). A provider
 * that speaks the carrier's own encoding then had every frame converted into a
 * format it could not read. Those conversions are now chosen per call from
 * `RealtimeProvider.audio` and `TelephonyProvider.mediaEncoding` — see
 * `CallSession.assertAudioContract`. */
export interface AudioCodec {
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
  /** Connected, but held before the conversation — a bridge waiting room.
   * A PSTN carrier cannot report this; a native meeting API can. */
  | { type: "waiting" }
  /** Admitted to the conversation. Twilio synthesises this from `start`. */
  | { type: "admitted" }
  | { type: "participant"; participantId: string; action: "joined" | "left" }
  | { type: "removed"; by: "host" | "unknown" }
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
  /** Carrier-side DTMF, played by the carrier itself once the call is
   * answered — Twilio's `SendDigits` parameter of `POST /Calls`. Out-of-band:
   * it is set before any media stream exists and never touches the codec's
   * in-band tone generator (`AudioCodec.dtmfTones`) at all.
   *
   * For deterministic entry into a bridge whose prompts are known in advance
   * (a conference ID and passcode, said in a fixed order at a fixed pace), as
   * distinct from the model's in-band `press_digits` tool (see
   * `CallExecution.ivr` in execution.ts), which exists for menus the model
   * must listen to and react to live. Both are legitimate; they serve
   * different callees — a scripted bridge entry has no menu to listen for,
   * and a live IVR has no fixed script to play.
   *
   * SECRET-SHAPED: this typically carries a bridge passcode. It must never
   * appear in a log line, a diagnostic message, a thrown error, or a call
   * record — see `redactSecrets` (`./redaction.ts`), which matches this key
   * name, and `TwilioTelephonyProvider.originate`'s validation, whose thrown
   * errors describe the violated rule without echoing the value. */
  sendDigits?: string;
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
  onInboundAudio: (frame: AudioFrame, source: AudioSource) => void;
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
  /** The encoding of the carrier's media stream, in both directions (mulaw@8000
   * for Twilio). Declared on the provider rather than on the media handle
   * because it must be known BEFORE any call exists: `CallSession.originate`
   * checks it against the realtime provider's formats and refuses an
   * unbridgeable pairing before a phone rings, not on the first frame after
   * someone has answered. */
  readonly mediaEncoding: AudioEncoding;
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
   * frames in `mediaEncoding`; the returned handle accepts frames in the same
   * encoding. */
  attachMediaStream(params: AttachMediaStreamParams): MediaStreamHandle;

  /* NOTE: no sendDtmf. Keypresses are audio, sent in-band by the codec through
     the open media stream — see AudioCodec.dtmfTones. A provider-side method
     existed and Twilio's implementation posted replacement TwiML to the live
     call, which redirected it off the media stream and hung up on the callee.
     There is no non-destructive REST way to do this on a streaming call, and
     no need for one. `OriginateParams.sendDigits` above is not this method
     back under a different name: it is read once, inside `originate`, before
     any call — let alone any media stream — exists, so there is nothing for
     it to redirect or tear down. */
  /** Terminate an active call. */
  hangup(callId: string, reason?: string): Promise<void>;
}

export interface TurnDetectionConfig {
  mode: "automatic" | "manual";
  startSensitivity?: "low" | "medium" | "high";
  silenceDurationMs?: number;
}

export type SpeakerRole = "caller" | "model" | "participant";

export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export interface TranscriptEvent {
  /** `caller` = the far end of a two-party call. `participant` = a human on a
   * multi-party meeting line, attributed or not. `model` = us. */
  speaker: SpeakerRole;
  /** Opaque, stable within a session. ABSENT means unattributed, which is the
   * only value slice A ever produces. */
  speakerId?: string;
  /** Present only when `speakerId` was inferred rather than known. */
  speakerConfidence?: number;
  speakerSource?: "channel" | "roster" | "diarization";
  /** Milliseconds since the session's declared t0. Required on the meeting
   * path: without it a gap has no coordinate system to be placed in. */
  startMs?: number;
  endMs?: number;
  /** Segment identity. Two events sharing a `segmentId` are two revisions of
   * ONE segment — the later REPLACES the earlier. Absent means the historic
   * append-only delta contract, which is what @parley/realtime-gemini emits.
   * Deepgram-style providers emit growing prefixes and MUST set this, or the
   * aggregator concatenates them into "thethe quickthe quick brown". */
  segmentId?: string;
  words?: readonly TranscriptWord[];
  text: string;
  /** Marks the final event of the current speaker's turn (or, with
   * `segmentId`, the final revision of that segment). */
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
  /** Transport facts a provider wants on the operator's diagnostic channel
   * (e.g. the server announcing a connection end). Never call content: no
   * transcript text, no tool arguments. */
  onDiagnostic?: (message: string) => void;
  onError: (error: RealtimeProviderError) => void;
  /** `reason` is prose for the diagnostic log. `close`, when the transport
   * knows it, is the same fact structurally (the WebSocket close code and the
   * server's reason string) so the call record can carry it: a vendor that
   * ends a session over billing or quota says so ONLY here, one to two seconds
   * after pickup, and prose in a log is not something a client can read. */
  onClose: (reason: string, close?: RealtimeClose) => void;
}

/** A realtime transport's close, as reported by the socket. Both fields are
 * optional because a transport may know only one; the call record normalises. */
export interface RealtimeClose {
  code?: number;
  reason?: string;
}

/** See `RealtimeConnectParams.settings`. */
export interface RealtimeConnectSettings {
  /** The think (language) model and the managed provider that serves it. */
  think?: { provider: string; model: string };
  /** Speak pace multiplier, 0.7 to 1.5. */
  speed?: number;
  /** Speak expressivity, an integer from -2 to 2. */
  expressivity?: number;
}

export interface RealtimeConnectParams {
  model: string;
  /** Plain prose; persona -> rules/objective -> guardrails, per design spec
   * §4.3. Sent exactly once, immutable for the session's lifetime. */
  systemInstruction: string;
  responseModality: "audio";
  voice?: string;
  /** Per-call overrides of the provider's own configuration, for THIS session
   * only (`execution.realtime`, validated by `@parley/server` against the
   * provider's exported lists before the call is dialled). Absent, or a field
   * absent, means the provider's configured default — a session with no
   * settings is exactly what it was before this field existed. A provider
   * that has no such setting never receives it: the server refuses the call
   * instead. */
  settings?: RealtimeConnectSettings;
  /** How to tag the FAR END's transcript events at source. Absent (or
   * `"caller"`) is the ordinary two-party call — unchanged from before this
   * field existed. A meeting call passes `"participant"` so a human on the
   * conference bridge is tagged correctly from the moment the provider emits
   * the event, rather than the far end being labelled `"caller"` in
   * production while everything downstream (a meeting's consent receipt
   * included) expects `"participant"`. This is a source-side tag, not a
   * rewrite: nothing downstream infers meeting-vs-call from context, and
   * nothing patches a `"caller"` event into a `"participant"` one after the
   * fact. */
  speakerRole?: "caller" | "participant";
  turnDetection?: TurnDetectionConfig;
  /** Speech-recognition hints from `Brief.keyterms`. A provider whose listener
   * takes keyterms forwards them; one without ignores them. Never part of
   * `systemInstruction`. */
  keyterms?: readonly string[];
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

/** What a realtime session's audio looks like on the wire. */
export interface RealtimeAudioFormat {
  /** Encodings the session's `sendAudio` accepts, most preferred first. A
   * carrier frame in any of them passes through; otherwise it is converted to
   * the first. */
  readonly accepts: readonly AudioEncoding[];
  /** The one encoding `onAudio` frames arrive in. */
  readonly emits: AudioEncoding;
}

/** How a realtime provider takes the call's opening — Parley's fixed
 * instruction for the seconds before anything has been heard.
 *
 * - `"turn"`: the opening is sent after connect as its own input, through
 *   `sendOpeningTrigger`. Right for a vendor whose model reads a text input as
 *   an instruction from the session rather than as the far end speaking
 *   (Gemini Live's realtime text input).
 * - `"prompt"`: the opening is appended to the one-time `systemInstruction`,
 *   and on a two-party call nothing is sent afterwards — the agent waits for
 *   the far end's voice. On a meeting one short Parley-authored cue
 *   (`MEETING_CONNECTED_CUE`) is sent as the opening. Right for a vendor whose
 *   only post-connect text input is a USER turn (Deepgram's
 *   `InjectUserMessage`), which its LLM hears as the callee speaking: sent the
 *   long trigger that way, models hung up during the ring or said "I'm
 *   listening and waiting" aloud.
 *
 * Every text either path sends is a Parley constant — `planOpening`
 * (`./render.ts`) decides which, for production and harness alike. */
export type OpeningDelivery = "turn" | "prompt";

/** An `OpeningDelivery` declared per call shape, for a vendor on which the
 * two shapes are best opened differently. `planOpening` reads `meeting` on a
 * call that joins a meeting and `twoParty` on every other call, and plans
 * each exactly as the plain declaration of that value would be.
 *
 * Gemini is the vendor that declares it, `{ twoParty: "prompt", meeting:
 * "turn" }`. Its two-party opening used to go as its own turn at connect —
 * before the callee had said a word — and with line hiss or silence ahead of
 * the "hello" the model answered that turn into the noise ("<no speech
 * detected>", or a whole introduction to nobody). With the opening in the
 * prompt the model's first input is the far end's own voice. Its meetings
 * keep the trigger as a turn because that is the only way they have ever
 * run, and their silence until people are heard is the consent invariant —
 * not a behaviour to change as a side effect of a two-party fix. */
export interface OpeningDeliveryByShape {
  readonly twoParty: OpeningDelivery;
  readonly meeting: OpeningDelivery;
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
  /** The encodings this vendor's session speaks. CallSession bridges each
   * direction to the carrier from this declaration, so a vendor that speaks
   * the carrier's own encoding passes through with no conversion at all. */
  readonly audio: RealtimeAudioFormat;
  /** Longest single session the vendor permits, if it bounds one. */
  readonly maxSessionSeconds?: number;
  /** How this vendor takes the call's opening — see `OpeningDelivery`. One
   * value for every call, or one per call shape (`OpeningDeliveryByShape`)
   * when two-party calls and meetings are opened differently; pass it
   * straight to `planOpening` either way, never resolve it by hand.
   * Required: a provider that has not decided is exactly how the opening
   * ended up heard as the callee's words. */
  readonly openingDelivery: OpeningDelivery | OpeningDeliveryByShape;
  /** Whether the model goes on speaking after a tool answer, in a turn that
   * begins only once the answer is sent.
   *
   * `true` is how both shipped vendors behave, observed on their wires: the
   * tool call arrives FIRST and the words that go with it — a goodbye after
   * `end_call`, the acknowledgment after `begin_notetaking` — are spoken by
   * the continuation, starting hundreds of milliseconds after the answer and
   * running for seconds. `CallSession` therefore treats every answered tool
   * call on such a provider as opening a model turn, so a hangup or a consent
   * handoff waits for that turn's end before draining, rather than draining an
   * empty queue and cutting the goodbye off before it exists.
   *
   * Required: a provider that has not decided is exactly how a goodbye ends
   * up cut off unheard. Declare `false` only for a vendor that is known to say
   * nothing after a tool answer. */
  readonly continuesAfterToolResponse: boolean;
  /** Open a new realtime session. `systemInstruction` is sent exactly once, as
   * part of session setup, and is immutable for the session's lifetime. */
  connect(params: RealtimeConnectParams): Promise<RealtimeSession>;
}
