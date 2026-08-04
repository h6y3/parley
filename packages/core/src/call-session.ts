import type { Brief } from "./brief.js";
import { OPENING_TRIGGER, renderSystemInstruction } from "./render.js";
import type {
  AudioCodec,
  MediaStreamHandle,
  OriginateResult,
  RealtimeProvider,
  RealtimeSession,
  TelephonyProvider,
  TranscriptEvent,
  WebSocketLike
} from "./types.js";

export interface CallSessionParams {
  brief: Brief;
  guardrails: readonly string[];
  telephony: TelephonyProvider;
  realtime: RealtimeProvider;
  codec: AudioCodec;
  /** The verified caller ID to originate from. */
  from: string;
  /** Public URL the carrier calls back when the callee answers. */
  answerWebhookUrl: string;
  /** Realtime model id (e.g. @parley/realtime-gemini DEFAULT_GEMINI_MODEL). */
  model: string;
  statusCallbackUrl?: string;
}

export interface CallSessionHandle {
  readonly transcript: readonly TranscriptEvent[];
  stop(reason?: string): Promise<void>;
}

/** Orchestrates a single outbound call: assembles the per-call systemInstruction,
 * originates via the TelephonyProvider, and bridges audio both ways between the
 * carrier and the RealtimeProvider, fanning barge-in out to the telephony layer.
 * Depends only on the three injected interfaces — no telephony/DSP dependency in
 * @parley/core (design spec §7, §8). No global state; one instance per call. */
export class CallSession {
  private session?: RealtimeSession;
  private media?: MediaStreamHandle;
  private readonly transcriptLog: TranscriptEvent[] = [];

  constructor(private readonly params: CallSessionParams) {}

  /** Render the fresh per-call systemInstruction from the brief's pure caller
   * content plus the injected, already-composed `guardrails` (policy
   * composition happens upstream — see @parley/policy). Pure — no side effects. */
  resolveSystemInstruction(): string {
    return renderSystemInstruction({
      persona: this.params.brief.persona,
      objective: this.params.brief.objective,
      facts: this.params.brief.facts,
      guardrails: this.params.guardrails
    });
  }

  /** Place the outbound call. The carrier answers asynchronously and opens a
   * media stream, whose socket the caller then passes to `attach`. */
  async originate(): Promise<OriginateResult> {
    return this.params.telephony.originate({
      to: this.params.brief.to,
      from: this.params.from,
      answerWebhookUrl: this.params.answerWebhookUrl,
      statusCallbackUrl: this.params.statusCallbackUrl
    });
  }

  /** Wire the realtime session and the media stream together once the carrier's
   * media socket is available, then send the opening trigger. */
  async attach(callId: string, socket: WebSocketLike): Promise<CallSessionHandle> {
    const { codec, telephony, realtime } = this.params;

    // Attach the media stream FIRST — before the realtime connect round-trip.
    // The telephony provider registers its socket listener synchronously here;
    // a WebSocket buffers nothing before a listener exists, so awaiting connect()
    // first would drop the carrier's one-time `start` frame (which carries the
    // streamSid every outbound frame needs) and the call would be silent
    // outbound. Inbound audio that arrives before the session is ready is
    // harmlessly ignored (`this.session` is still undefined — the callee hasn't
    // been prompted to speak yet). Discovered at the M3 live gate.
    this.media = telephony.attachMediaStream({
      callId,
      socket,
      onInboundAudio: (frame) => {
        this.session?.sendAudio(codec.decodeInbound(frame));
      },
      onCallEvent: () => {}
    });

    let session: RealtimeSession;
    try {
      session = await realtime.connect({
        model: this.params.model,
        systemInstruction: this.resolveSystemInstruction(),
        responseModality: "audio",
        turnCoverage: "onlyActivity",
        contextWindowCompression: true,
        inputTranscription: true,
        outputTranscription: true,
        callbacks: {
          onAudio: (frame) => {
            this.media?.sendOutboundAudio(codec.encodeOutbound(frame));
          },
          onInterrupted: () => {
            this.media?.clearOutboundBuffer();
          },
          onTranscript: (event) => {
            this.transcriptLog.push(event);
          },
          onError: () => {},
          onClose: () => {}
        }
      });
    } catch (err) {
      // connect() failed after the media stream was already attached above —
      // tear it down (stops the pacer's interval and closes the socket) so a
      // failed connect (network / auth / quota) leaks no timer or listener.
      this.media.close();
      this.media = undefined;
      throw err;
    }
    this.session = session;

    session.sendOpeningTrigger(OPENING_TRIGGER);

    return {
      transcript: this.transcriptLog,
      stop: async () => {
        this.media?.close();
        await this.session?.close();
      }
    };
  }
}
