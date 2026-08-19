import type { Brief } from "./brief.js";
import { buildToolDeclarations, routeToolCall, ToolGate, type CallExecution } from "./execution.js";
import { OPENING_TRIGGER, renderSystemInstruction } from "./render.js";
import type {
  AudioCodec,
  CallLifecycleEvent,
  MediaStreamHandle,
  OriginateResult,
  RealtimeProvider,
  RealtimeSession,
  TelephonyProvider,
  ToolCallRequest,
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
  /** The BINDING plane. Absent means no tools are declared and no caps are
   * armed — identical to Parley before the execution plane existed. */
  execution?: CallExecution;
  /** Diagnostic sink for events that end a call without anyone asking.
   *
   * Not optional decoration. `onError` used to be `() => {}` and `onClose`
   * discarded the reason the provider had already built for it, so a realtime
   * session that died on connect hung up the phone the instant the callee
   * answered and left nothing anywhere saying why — no log line, no call
   * record, because the record is written on a clean end. Never carries call
   * content; only why the transport ended. */
  onDiagnostic?: (message: string) => void;
}

/** Why a call ended. `remote` means the far end hung up (so there is nothing to
 * ask the carrier to do); `error` means our own teardown failed. */
/** Ceiling on waiting for the carrier to confirm playout. Generous next to a
 * closing sentence and short next to a call: it bounds a confirmation that
 * never arrives, and is never the thing being waited for. */
const DRAIN_TIMEOUT_MS = 5_000;

/** Ceiling on waiting for the model to finish generating the turn it ended the
 * call in. A tool call can land before the audio of the same turn exists, so
 * without this the drain has nothing to wait for and the farewell is cut off
 * upstream of anything we can see. */
const TURN_FINISH_TIMEOUT_MS = 4_000;

export type EndReason = "model" | "durationCap" | "silenceCap" | "remote" | "error";

export interface CallSessionHandle {
  readonly transcript: readonly TranscriptEvent[];
  readonly endedBy: EndReason | undefined;
  stop(reason?: EndReason): Promise<void>;
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
  private gate?: ToolGate;
  private callId?: string;
  private endedByReason?: EndReason;
  private modelTurnOpen = false;
  /** The model entry currently being appended to, if a turn is in progress. */
  private openModelEntry?: { speaker: "model"; text: string; isFinal: boolean };
  private readonly turnFinishedWaiters = new Set<() => void>();
  private answeredByValue?: "human" | "machine" | "fax" | "unknown";
  private settled = false;
  private durationTimer?: ReturnType<typeof setTimeout>;
  private silenceTimer?: ReturnType<typeof setTimeout>;

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
      statusCallbackUrl: this.params.statusCallbackUrl,
      ...(this.params.execution?.detection
        ? {
            machineDetection:
              this.params.execution.detection.mode === "enable"
                ? ("Enable" as const)
                : ("DetectMessageEnd" as const)
          }
        : {})
    });
  }

  /** Wire the realtime session and the media stream together once the carrier's
   * media socket is available, then send the opening trigger. */
  async attach(callId: string, socket: WebSocketLike): Promise<CallSessionHandle> {
    const { codec, telephony, realtime } = this.params;
    const execution = this.params.execution ?? {};
    this.callId = callId;
    this.gate = new ToolGate(execution);

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
        tools: buildToolDeclarations(execution),
        ...(execution.turnDetection
          ? {
              turnDetection: {
                mode: "automatic" as const,
                silenceDurationMs: execution.turnDetection.silenceMs
              }
            }
          : {}),
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
            // The model's speech arrives as word-level fragments — one real
            // call produced 132 of them for 13 turns — so storing each as its
            // own entry makes the call record unreadable as a record. Caller
            // utterances already arrive whole. Coalesce a turn into one entry,
            // bounded by onTurnComplete, which is a real signal; the empty
            // `isFinal` markers the provider synthesises are not, since it only
            // emits them when it did not already see a final.
            if (event.speaker === "caller") {
              this.closeModelEntry();
              this.transcriptLog.push(event);
              this.resetSilenceTimer();
              return;
            }
            if (event.text === "") {
              if (event.isFinal) this.closeModelEntry();
              return;
            }
            this.modelTurnOpen = true;
            if (this.openModelEntry) this.openModelEntry.text += event.text;
            else {
              const entry = { speaker: "model" as const, text: event.text, isFinal: false };
              this.transcriptLog.push(entry);
              this.openModelEntry = entry;
            }
            if (event.isFinal) this.closeModelEntry();
          },
          onTurnComplete: () => {
            this.closeModelEntry();
            this.modelTurnOpen = false;
            for (const waiter of [...this.turnFinishedWaiters]) waiter();
          },
          onToolCall: (call) => {
            // Fire-and-forget: the provider's onmessage handler is synchronous,
            // and every path inside handleToolCall answers the call itself.
            void this.handleToolCall(call);
          },
          onError: (error) => {
            this.params.onDiagnostic?.(
              `realtime error: ${error.code} ${error.message} fatal=${error.fatal}`
            );
          },
          onClose: (reason) => {
            // The realtime session dropped. Without this the carrier leg stays
            // up: a live, billing phone call with nothing on our end of it.
            // Report BEFORE ending: this path hangs up a live call, and until
            // it said why, the only symptom was a phone that went dead on
            // answer.
            this.params.onDiagnostic?.(`realtime session closed: ${reason}`);
            void this.endCall("error");
          }
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
    this.armTimers();

    // An arrow captures `this` lexically, so the getter reads the LIVE value
    // rather than a snapshot — a cap can fire long after attach() returned.
    const readEndedBy = (): EndReason | undefined => this.endedByReason;

    return {
      transcript: this.transcriptLog,
      get endedBy() {
        return readEndedBy();
      },
      stop: async (reason?: EndReason) => {
        await this.endCall(reason ?? "remote");
      }
    };
  }

  /** Route one model-requested tool call. The decision logic lives in
   * routeToolCall so this and the scenario harness exercise the same code. */
  /** Seal the model entry being appended to. An entry left open when the call
   * ends stays `isFinal: false`, which is honest — the turn was cut off. */
  private closeModelEntry(): void {
    if (!this.openModelEntry) return;
    this.openModelEntry.isFinal = true;
    this.openModelEntry = undefined;
  }

  /** Resolve when the model finishes its current turn, or after a cap. */
  private awaitTurnFinished(): Promise<void> {
    if (!this.modelTurnOpen) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.turnFinishedWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, TURN_FINISH_TIMEOUT_MS);
      this.turnFinishedWaiters.add(done);
    });
  }

  private async handleToolCall(call: ToolCallRequest): Promise<void> {
    const gate = this.gate;
    const session = this.session;
    const callId = this.callId;
    if (!gate || !session || callId === undefined) return;

    await routeToolCall({
      call,
      gate,
      callId,
      carrier: {
        // IN-BAND, down the stream the call is already on. The provider-side
        // REST implementation posted replacement TwiML, which redirects a live
        // call: it tore down the media stream, played the tone into the void,
        // ran off the end of the new document and hung up. A keypress ended
        // every call that made one.
        sendDtmf: async (_id, digits) => {
          this.media?.sendOutboundAudio(this.params.codec.dtmfTones(digits));
        },
        // The model's free-text reason is deliberately dropped here: endedBy is
        // a closed enum the caller can branch on, not prose to parse.
        endCall: () => this.endCall("model")
      },
      respond: (result) => session.sendToolResponse(call, result)
    });
  }

  /** THE single exit. Four things end a call — the model, the duration cap, the
   * silence cap, and the far end — and a timer racing a model hangup must not
   * hang up twice or write two records. `settled` is that guard, and the FIRST
   * reason wins because it is the one that actually ended the call. */
  async endCall(reason: EndReason): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.endedByReason = reason;
    clearTimeout(this.durationTimer);
    clearTimeout(this.silenceTimer);
    if (reason !== "remote" && this.callId !== undefined) {
      // Let the closing words actually land. Outbound audio is paced at 20ms a
      // frame and the carrier holds its own playout buffer, so a hangup issued
      // the instant the model calls end_call truncates its last sentence
      // mid-word — measured on the first live call that ever completed its
      // objective, where the caller heard the confirmation cut off.
      //
      // Only when the model chose to end. A cap firing or a transport error is
      // not a goodbye, and neither is worth holding a live, billing call open
      // for.
      if (reason === "model") {
        try {
          // The model asked to end the call, possibly mid-turn. Let the turn
          // finish generating before draining, or the drain waits on a queue
          // the rest of the goodbye has not reached yet.
          await this.awaitTurnFinished();
          const drained = await this.media?.drainOutbound(DRAIN_TIMEOUT_MS);
          if (drained) {
            this.params.onDiagnostic?.(
              `drain before hangup: ${drained.confirmed ? "confirmed by carrier" : "TIMED OUT"} after ${drained.waitedMs}ms`
            );
          }
        } catch {
          /* draining is best-effort — never let it block the hangup */
        }
      }
      try {
        await this.params.telephony.hangup(this.callId, reason);
      } catch {
        // The carrier refused the hangup. Tear our side down regardless — a
        // half-open call is worse than a recorded error.
        this.endedByReason = "error";
      }
    }
    this.media?.close();
    this.media = undefined;
    await this.session?.close();
  }

  private armTimers(): void {
    const limits = this.params.execution?.limits;
    if (!limits) return;
    this.durationTimer = setTimeout(
      () => void this.endCall("durationCap"),
      limits.maxDurationSeconds * 1000
    );
    if (limits.maxSilenceSeconds !== undefined) this.resetSilenceTimer();
  }

  /** Re-armed on every caller transcript event, NOT on inbound audio frames:
   * Twilio streams continuously whether or not anyone is speaking, so a
   * frame-based detector would never fire. A transcript event means speech. */
  private resetSilenceTimer(): void {
    const seconds = this.params.execution?.limits?.maxSilenceSeconds;
    if (seconds === undefined || this.settled) return;
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => void this.endCall("silenceCap"), seconds * 1000);
  }

  /** Feed a carrier lifecycle event into the session. Today this only records
   * how the call was answered; the timers and the exit are driven elsewhere. */
  noteLifecycleEvent(event: CallLifecycleEvent): void {
    if (event.type === "answered" && event.answeredBy) this.answeredByValue = event.answeredBy;
  }

  /** Who or what picked up, when the caller opted into carrier-side detection. */
  get answeredBy(): "human" | "machine" | "fax" | "unknown" | undefined {
    return this.answeredByValue;
  }

  /** What the gate recorded, for the completed-call record. */
  gateSnapshot(): ReturnType<ToolGate["snapshot"]> {
    return (this.gate ?? new ToolGate({})).snapshot();
  }
}
