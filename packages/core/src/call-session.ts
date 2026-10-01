import { AudioBridge, type FrameConverter } from "./audio-bridge.js";
import type { Brief } from "./brief.js";
import {
  anchorConsentBoundary,
  buildToolDeclarations,
  findConsentMatch,
  isConsentDenial,
  routeToolCall,
  ToolGate,
  type CallExecution
} from "./execution.js";
import {
  PRE_CONSENT_BUFFER_MAX,
  type ConsentReceipt,
  type MeetingExecution,
  type TranscriptGap
} from "./meeting.js";
import { defaultTimeZone, planOpening, renderSystemInstruction, withOpening } from "./render.js";
import type { TranscriptionProvider, TranscriptionSession } from "./transcription.js";
import { encodingEquals, formatEncoding } from "./types.js";
import type {
  AudioCodec,
  AudioEncoding,
  AudioFrame,
  AudioSource,
  CallLifecycleEvent,
  MediaStreamHandle,
  OriginateResult,
  RealtimeProvider,
  RealtimeSession,
  SpeakerRole,
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
  /** Adapts frames between the carrier's `mediaEncoding` and the realtime
   * provider's declared `audio`, in both directions. Injected (the caller
   * passes @parley/audio's `convert`) for the same reason `codec` is. */
  convert: FrameConverter;
  /** Whether `convert` has a path between two encodings. Asked before the
   * carrier dials, so a pairing `convert` cannot bridge is refused up front
   * rather than thrown on the first frame of an answered call. */
  canConvert: (from: AudioEncoding, to: AudioEncoding) => boolean;
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
  /** The LISTENING plane. Required for a meeting; absent on an ordinary call,
   * where the session never leaves the speaking phase. `convert` is injected
   * for the same reason `codec` is — @parley/core carries no DSP. */
  transcription?: { provider: TranscriptionProvider; convert: FrameConverter };
  /** Injectable clock, so a test can advance the meeting without waiting. */
  now?: () => number;
  /** IANA zone the model is told "today" in (`PARLEY_TIMEZONE` on the daemon).
   * Defaults to the host's own zone. */
  timeZone?: string;
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

/** The realtime provider and the carrier speak encodings the injected
 * `convert` cannot bridge. Thrown by `assertAudioContract`, which `originate`
 * runs before dialling — so this is a refusal to place a call, never a failure
 * inside one. `from`/`to` are `formatEncoding` strings naming the missing
 * path. */
export class AudioContractError extends Error {
  readonly reason = "no_conversion_path" as const;

  constructor(
    readonly from: string,
    readonly to: string
  ) {
    super(`no audio conversion path from ${from} to ${to}`);
    this.name = "AudioContractError";
  }
}

/** Frame counts for one bridged direction. See `CallSession.audioBridgeStats`. */
export interface BridgeCounts {
  conversions: number;
  passThroughs: number;
}

/** Why a call ended. `remote` means the far end hung up (so there is nothing to
 * ask the carrier to do); `error` means our own teardown failed. */
/** Ceiling on waiting for the carrier to confirm playout. Generous next to a
 * closing sentence and short next to a call: it bounds a confirmation that
 * never arrives, and is never the thing being waited for. */
const DRAIN_TIMEOUT_MS = 5_000;

/** How long waiting for the model to finish the turn it ended the call in may
 * go with NO model audio. A tool call can land before the audio of its turn
 * exists, so without a wait the drain has nothing to wait for and the farewell
 * is cut off upstream of anything we can see; without a bound, a turn end that
 * never comes holds a live call open.
 *
 * Idle, not total: every model audio frame re-arms it. A Deepgram goodbye
 * after `end_call` ran 6.7 s on the wire, and a fixed four seconds from the
 * start of the wait hung up over the last third of it. The total is bounded
 * by TURN_FINISH_CEILING_MS instead. */
const TURN_FINISH_TIMEOUT_MS = 4_000;

/** The absolute bound on the same wait, from when it began, however much
 * audio keeps arriving — so a model that never ends its turn cannot keep a
 * call up by talking. Generous next to any goodbye or acknowledgment. */
const TURN_FINISH_CEILING_MS = 15_000;

/** On a provider that goes on speaking after a tool answer, how much model
 * audio may reach the line after `end_call` is accepted when no goodbye has
 * been said. Found live on Gemini 3.8 (CAb4dc604bca32abd05a6a4b009faa65be):
 * after `end_call` the model said "Thank you very much. Goodbye." and then
 * "I have successfully rescheduled the appointment." — a report to the
 * principal, spoken to the callee. Measured in AUDIO forwarded, not wall
 * clock: a vendor streams faster than real time, so a wall-clock bound would
 * let a burst of any length through. */
const AFTER_END_CALL_AUDIO_CAP_MS = 3_000;

/** How much more audio a goodbye gets once its words have completed in the
 * transcript — at least this, or GOODBYE_MS_PER_CHAR of its sentence if
 * longer. Not an instant cut, because the transcript LEADS the audio it
 * describes. Measured 2026-10-01 (four Gemini 3.8 sessions, the end of the
 * goodbye located by the silence after it): the text completing "Goodbye."
 * arrived 720, 750, 1,120 and 1,140 ms of audio before that audio ended — text
 * comes about one ~1 s audio burst ahead. 1,500 ms covers the worst by 360 ms
 * and let 100–420 ms of the next sentence through ("I ha—"). Deepgram's
 * `ConversationText` arrives as its sentence's audio STARTS (t20 wire logs:
 * "Thanks and goodbye." 1,610 ms of audio before `AgentAudioDone`), so there
 * the lead is the whole sentence — hence the per-character term.
 *
 * And no `clearOutboundBuffer` at the stop: since the text leads, the audio
 * still queued for playout when the hold ends is the goodbye itself. */
const GOODBYE_TEXT_LEAD_MS = 1_500;
/** Generous next to measured TTS pace (~65–85 ms a character, trailing
 * silence included) — a hold that runs long leaks a word, one that runs short
 * clips the goodbye. */
const GOODBYE_MS_PER_CHAR = 90;

/** "bye", "goodbye", "good bye", "bye-bye" as words — never "bypass". */
const BYE_WORD = /(?:\bgood[\s-]?|\b)bye\b/i;
/** A completed sentence: anything up to its terminal punctuation. */
const COMPLETED_SENTENCE = /[^.!?]*[.!?]+/g;

/** Ceiling on bringing the listening plane up.
 *
 * A TranscriptionProvider's `connect` resolves on `open` and rejects on
 * `error` — and settles on NEITHER if the socket simply never answers. Without
 * a ceiling `beginNotetaking()` then never returns. The symptom is not a
 * stalled tool call (routeToolCall answers the model before the handoff): it is
 * a live, billing call left with consent granted, the pre-consent buffer
 * emptied, and nothing listening, for the rest of the meeting. Exported so a
 * test can wait exactly this long rather than guessing. */
export const TRANSCRIPTION_CONNECT_TIMEOUT_MS = 10_000;

/** The longest the speaking plane can outlive the consent timer on a meeting.
 *
 * `beginNotetaking` clears `consentTimer` FIRST and only then retires the
 * speaking plane, after bringing the listening plane up (bounded by
 * TRANSCRIPTION_CONNECT_TIMEOUT_MS) and letting the acknowledging turn finish
 * (TURN_FINISH_CEILING_MS at most) and drain (DRAIN_TIMEOUT_MS). Every other way out
 * of the pre-consent window is `endCall`, which waits on at most the last two.
 * So a meeting's realtime session lives no longer than
 * `consent.timeoutSeconds` plus this — which is what a caller comparing that
 * lifetime against a provider's `maxSessionSeconds` needs, and why it is
 * derived here from the timeouts themselves rather than restated elsewhere. */
export const CONSENT_HANDOFF_MAX_MS =
  TRANSCRIPTION_CONNECT_TIMEOUT_MS + TURN_FINISH_CEILING_MS + DRAIN_TIMEOUT_MS;

/** One carrier media frame is twenty milliseconds of audio. Coverage and gaps
 * are both counted in frames and reported in milliseconds through this. */
const FRAME_MS = 20;

/** Margin added on top of a DTMF burst's own computed duration before
 * barge-in is allowed to clear the outbound buffer again.
 *
 * Found on a real call, not offline: a live IVR presses back against a
 * keypress by talking, and the realtime model's VAD fires `onInterrupted`
 * repeatedly while it does. `onInterrupted` clears BOTH our locally queued
 * audio and the carrier's own playout buffer (see the callback below), and
 * `sendDtmf` queues a keypress into that exact same outbound queue as several
 * seconds of tone audio (`packages/audio/src/dtmf.ts`) — so an interrupt that
 * lands mid-press erases the tones before they finish playing. The agent
 * pressed a 12-digit meeting ID three times on that call and never reached
 * the passcode prompt. No offline test caught it, because every DTMF test
 * asserts tones were *generated*, never that they *survive to the wire* —
 * nothing here exercises the barge-in / outbound-buffer interaction at all.
 * The margin itself only covers scheduling jitter between "audio enqueued"
 * and the provider firing `onInterrupted`; it is not a safety net for
 * anything acoustic. */
const DTMF_BARGE_IN_MARGIN_MS = 200;

/** How long a REFUSED meeting stays on the line before hanging up.
 *
 * A refused meeting used to sit silently on the bridge until the far end
 * dropped it, which is not what a room that just said no asked for. It now
 * leaves — and leaves having said so, because hanging up mid-sentence on
 * someone who declined is worse than lingering.
 *
 * The goodbye itself is SPEECH, so it is composed as a rail
 * (`meetingConsentDeclined`, @parley/policy) rather than commanded from here:
 * there is no path in `RealtimeSession` for re-instructing a live model and
 * this must not become one. What this window buys is the part a rail cannot
 * guarantee — that the call is still up while the sentence is said. Sized from
 * the two things that have to happen inside it: the model hearing the refusal
 * and beginning a turn (two seconds), and that turn finishing
 * (`TURN_FINISH_TIMEOUT_MS`, this file's own ceiling for exactly that). It
 * bounds the SILENCE before a goodbye, not the goodbye: `endCall` then waits
 * on any turn still generating and drains the outbound buffer, the same as it
 * does for a model-requested hangup.
 *
 * A model that says nothing costs the room six seconds of quiet before the
 * line drops. That is the price of not cutting off the one that does. */
const CONSENT_DEPARTURE_GRACE_MS = TURN_FINISH_TIMEOUT_MS + 2_000;

/** How long one frame plays: mu-law is a byte a sample, PCM two. */
function frameDurationMs(frame: AudioFrame): number {
  const bytesPerSample = frame.encoding.codec === "pcm" ? 2 : 1;
  return (frame.data.length / bytesPerSample / frame.encoding.sampleRate) * 1000;
}

/** One carrier lifecycle event as a single content-free line.
 *
 * `removed` deliberately says it proves nothing: @parley/telephony-twilio
 * synthesises it on every socket close, normal hangups included, because a
 * PSTN carrier cannot tell a host removal from a hangup. Printing it as though
 * it were evidence of a removal is how a value that can never be established
 * ends up in a record. */
export function describeLifecycleEvent(event: CallLifecycleEvent): string {
  switch (event.type) {
    case "answered":
      return `answered${event.answeredBy ? ` by ${event.answeredBy}` : ""}`;
    case "participant":
      return `participant ${event.participantId} ${event.action}`;
    case "removed":
      return event.by === "host"
        ? "removed by the host"
        : "leg ended (the carrier cannot tell a host removal from a hangup)";
    case "completed":
      return `completed after ${event.durationSeconds}s`;
    case "failed":
      return `failed: ${event.reason}`;
    default:
      return event.type;
  }
}

export type EndReason =
  | "model"
  | "durationCap"
  | "silenceCap"
  | "remote"
  | "error"
  /** The consent phrase was never spoken inside the meeting's consent window. */
  | "consentTimeout"
  /** The room REFUSED. Distinct from `consentTimeout`, which is the same
   * absence of a yes arrived at by nobody answering — a distinction the record
   * should keep, because "they said no" and "nobody replied" are different
   * facts about a room's wishes. Only a plain refusal produces this: see
   * `isConsentDenial` for the deliberately narrow test, and
   * `CONSENT_DEPARTURE_GRACE_MS` for the pause that lets the goodbye land. */
  | "consentDenied"
  /** The transcription plane could not be restored, so notes stopped. Ending
   * beats sitting on a live, billing call that is no longer taking any. */
  | "transcriptionLost";

/* NOTE: no "removed". A host removing us from a bridge is a real thing that
   happens, and no transport Parley has can see it: a PSTN carrier reports a
   socket close and nothing else, which is why
   @parley/telephony-twilio synthesises `{ type: "removed", by: "unknown" }`
   on EVERY call end, normal hangups included. An EndReason fed from that would
   label every completed call "removed". The member existed here, in
   MeetingRecord's `endedReason` enum and in the committed JSON Schema, and
   nothing could ever produce it — a value A2 would read about and never see.
   A native meeting API (the deferred MeetingIngress) can report a host action
   for real; re-adding the member then is additive, and it will arrive with a
   producer attached. */

export type CallPhase = "speaking" | "listening";

export interface AudioSink {
  readonly id: string;
  accept(frame: AudioFrame, source: AudioSource): void;
}

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
  /** Whether `openModelEntry` has already been pushed into `transcriptLog`.
   *
   * Set once, at the entry's creation, and read at its close — NOT re-derived
   * from `preConsentActive()` at close time. That predicate can flip between
   * open and close (consent is granted mid-turn: the model hears the
   * go-ahead and keeps talking in the same turn it calls begin_notetaking),
   * and re-deriving it there answered a question — "is this entry already
   * logged?" — with the state of a DIFFERENT question — "is consent granted
   * right now?" — silently dropping the open turn instead of routing it. */
  private openModelEntryLogged = false;
  private readonly turnFinishedWaiters = new Set<() => void>();
  /** One per pending `awaitTurnFinished`: restarts its idle timer. Called on
   * every model audio frame — see TURN_FINISH_TIMEOUT_MS. */
  private readonly turnWaitRearms = new Set<() => void>();
  /** Set when `end_call` is accepted on a continuing provider: the model's
   * text and audio since then, and where its audio stops reaching the line.
   * See AFTER_END_CALL_AUDIO_CAP_MS. */
  private afterEndCall?: {
    text: string;
    audioMs: number;
    /** Audio position the goodbye is held until, once its words completed. */
    stopAtMs?: number;
    stopped: boolean;
  };
  private answeredByValue?: "human" | "machine" | "fax" | "unknown";
  private settled = false;
  private durationTimer?: ReturnType<typeof setTimeout>;
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private readonly sinks: AudioSink[] = [];
  private readonly phaseSet = new Set<CallPhase>();
  private preConsent: { speaker: SpeakerRole; text: string; at: string }[] = [];
  private modelTurnsCompletedCount = 0;
  /** Offset from `startedAtMs` of the model's first audio frame — see
   * `firstModelAudioAtMs`. Set once, on the first frame, and never moved. */
  private firstModelAudioOffsetMs?: number;
  private consentTimer?: ReturnType<typeof setTimeout>;
  /** Armed when the room refuses, disarmed if it changes its mind before the
   * grace window is out. Separate from `consentTimer`: that one fires because
   * nobody answered, this one because somebody did. */
  private departureTimer?: ReturnType<typeof setTimeout>;
  private receipt?: ConsentReceipt;
  private notetaking = false;
  /** The ordering boundary EVERY consent decision on this call is judged
   * against, pinned at the instant a go-ahead was first heard. `undefined`
   * until then, which also makes it the "has a go-ahead ever matched?" signal
   * the turn-complete diagnostic below reads.
   *
   * Pinned rather than recomputed later, because `lastModelUtteranceAt()`
   * returns the model's MOST RECENT utterance and an acknowledgment turn —
   * which `meetingConsentRequest` (@parley/policy) requires in the same turn
   * as the tool call — is itself a later model utterance. Recomputed after
   * that acknowledgment closes into the buffer, the go-ahead looks
   * "ineligible" against a requestedAt that has since moved past it. That cost
   * a real meeting its notes: the room said "go ahead", the agent said aloud
   * it was going quiet to take them, and the gate refused the phrase it had
   * already matched. Set in `noteTranscript`, the instant the matching
   * utterance itself arrives — before anything the agent says next can shift
   * the boundary.
   *
   * Holds the BOUNDARY, never the match. See `anchorConsentBoundary`
   * (`./execution.js`) for why storing the verdict here would trade the
   * ordering defect for the withdrawal one. */
  private consentAnchorAt?: string;
  /** Guards the diagnostic below to ONE line per call. Per-turn or per-frame
   * would be noise a reader filters out — see the brief this shipped under. */
  private consentMissLogged = false;
  private transcriptionSession?: TranscriptionSession;
  /** Set the instant before the consent handoff closes the speaking plane on
   * purpose, and read by the realtime `onClose` handler.
   *
   * An EXPLICIT flag, not `this.session === undefined` — which is already true
   * at that point and would work by accident. `onClose` hangs the carrier leg
   * up, because a realtime session that dies unasked leaves a live, billing
   * call with nothing on our end of it. The handoff closes that same session
   * deliberately, so without this the line dropped at the exact instant
   * consent was granted, and `classifyMeetingOutcome("error", true)` then
   * wrote `status: "completed"` over an empty transcript: a record asserting a
   * meeting that never happened. Reading intent off an incidental `undefined`
   * is how that comes back. */
  private speakingPlaneRetired = false;
  /** The listening plane's bridge, carrier → transcriber. Set in
   * `beginNotetaking`. */
  private bridge?: AudioBridge;
  /** The speaking plane's bridges, set in `attach`: carrier → the realtime
   * provider's `audio.accepts`, and its `audio.emits` → carrier. */
  private inboundBridge?: AudioBridge;
  private outboundBridge?: AudioBridge;
  private readonly gapLog: TranscriptGap[] = [];
  /** A hole that has been opened and not yet sealed. `undefined` means the
   * record is currently whole.
   *
   * Carries its own reason rather than taking one at close time, because the
   * two things that open a hole — the connect window, and a transcriber that
   * dropped out mid-meeting — are different facts about the meeting, and the
   * one sealing it is not the one that knows which happened. */
  private openGap?: { fromMs: number; reason: string };
  private coveredFrames = 0;
  /** Wall-clock anchor for every meeting-relative millisecond this class
   * reports. Set in `attach`, which is when the call's audio actually starts. */
  private startedAtMs = 0;
  /** `nowMs()` deadline before which `onInterrupted` must not clear the
   * outbound buffer — see `DTMF_BARGE_IN_MARGIN_MS` and the `sendDtmf` /
   * `onInterrupted` callbacks below. `0` (its initial value) is always in
   * the past, so "no burst in flight" needs no separate sentinel. */
  private dtmfInFlightUntilMs = 0;

  constructor(private readonly params: CallSessionParams) {}

  /** A content-free timeline line: `<what> at +<ms>ms` since the session's
   * start. Live calls said goodbye twice and the only way to see why was to
   * line up tool calls, turn ends and caller finals by time. */
  private logAt(what: string): void {
    this.params.onDiagnostic?.(`${what} at +${this.nowMs() - this.startedAtMs}ms`);
  }

  private nowMs(): number {
    return (this.params.now ?? Date.now)();
  }

  /** The full systemInstruction this call sends at connect: the brief's pure
   * caller content plus the injected, already-composed `guardrails` (policy
   * composition happens upstream — see @parley/policy), with the opening
   * appended where the provider takes it in the prompt (`planOpening`,
   * `withOpening`). Exactly what `attach` sends — never a prompt that differs
   * from the one the model was given. Pure — no side effects. */
  resolveSystemInstruction(): string {
    const rendered = renderSystemInstruction({
      persona: this.params.brief.persona,
      objective: this.params.brief.objective,
      facts: this.params.brief.facts,
      guardrails: this.params.guardrails,
      // Computed once, here at connect, from the injected clock — the model
      // has no clock of its own and the outcome schema wants ISO dates.
      today: {
        now: new Date(this.nowMs()),
        timeZone: this.params.timeZone ?? defaultTimeZone()
      }
    });
    return withOpening(rendered, planOpening(this.params.realtime.openingDelivery, this.isMeeting));
  }

  /** Place the outbound call. The carrier answers asynchronously and opens a
   * media stream, whose socket the caller then passes to `attach`.
   *
   * Checks the audio contract FIRST: a pairing that cannot be bridged rejects
   * with `AudioContractError` before the carrier is asked to dial, because the
   * alternative is a phone that rings, is answered, and goes dead. */
  async originate(): Promise<OriginateResult> {
    this.assertAudioContract();
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
        : {}),
      // Passed straight through, untouched and unlogged — see
      // OriginateParams.sendDigits. This is the ONLY place CallSession reads
      // execution.dial; nothing else on this class ever inspects it, and
      // nothing here writes it to onDiagnostic or anywhere else.
      ...(this.params.execution?.dial ? { sendDigits: this.params.execution.dial.sendDigits } : {})
    });
  }

  /** Throw `AudioContractError` unless the injected `convert` can carry audio
   * both ways between the carrier's `mediaEncoding` and the realtime
   * provider's declared `audio`. Needs no call to exist — every input is a
   * declaration — which is what lets `originate` run it before dialling.
   *
   * Inbound mirrors `AudioBridge.adapt` exactly: a carrier frame the provider
   * accepts as-is passes through, otherwise it is converted to `accepts[0]`,
   * so that is the one path that has to exist. */
  assertAudioContract(): void {
    const { telephony, realtime, canConvert } = this.params;
    const carrier = telephony.mediaEncoding;
    const { accepts, emits } = realtime.audio;
    const first = accepts[0];
    if (first === undefined) {
      throw new AudioContractError(formatEncoding(carrier), "(nothing)");
    }
    const passesThrough = accepts.some((e) => encodingEquals(e, carrier));
    if (!passesThrough && !canConvert(carrier, first)) {
      throw new AudioContractError(formatEncoding(carrier), formatEncoding(first));
    }
    if (!canConvert(emits, carrier)) {
      throw new AudioContractError(formatEncoding(emits), formatEncoding(carrier));
    }
  }

  /** Wire the realtime session and the media stream together once the carrier's
   * media socket is available, then send the opening trigger. */
  async attach(callId: string, socket: WebSocketLike): Promise<CallSessionHandle> {
    const { telephony, realtime, convert } = this.params;
    // Built before either end is live, so a frame can never reach a sink
    // without its bridge. The inbound bridge feeds the realtime provider;
    // the outbound one targets the carrier's single encoding.
    const inbound = new AudioBridge(realtime.audio.accepts, convert);
    const outbound = new AudioBridge([telephony.mediaEncoding], convert);
    this.inboundBridge = inbound;
    this.outboundBridge = outbound;
    const execution = this.params.execution ?? {};
    this.callId = callId;
    this.gate = new ToolGate(execution);
    // t0 for every meeting-relative millisecond: the transcriber's connect
    // offset, gap bounds, and covered time are all measured from here.
    this.startedAtMs = this.nowMs();

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
      onInboundAudio: (frame, source) => {
        // A LIST, not a slot. Slice A swaps the realtime sink for a transcription
        // sink at the consent handoff; slice B registers both at once, because a
        // live answer that is not grounded in the running transcript is worse than
        // no answer, and a listening plane paused while the model speaks records
        // the model's own turn as a transcription hole.
        //
        // Snapshot the list before iterating: a sink can remove another sink
        // from inside its own `accept` (Task 12's consent-handoff swap does
        // exactly this), and splicing the live array under a running for-of
        // shifts the next entry into the removed slot, silently skipping it —
        // a dropped audio frame on a live call, with no error anywhere. And
        // isolate each sink's own failure: one sink throwing must not abort
        // delivery to the sinks registered after it, or the fan-out's safety
        // depends on registration order rather than being true by
        // construction. `onDiagnostic` carries only why a sink misbehaved,
        // never the frame's bytes — the same content-free contract every
        // other diagnostic on this class already holds to.
        const reportSinkFailure = (id: string, err: unknown): void => {
          this.params.onDiagnostic?.(
            `audio sink "${id}" threw: ${err instanceof Error ? err.message : String(err)}`
          );
        };
        for (const sink of [...this.sinks]) {
          try {
            // `accept` is typed `void`, and TypeScript assigns an `async`
            // function to a void-returning slot without a word — so the
            // try/catch here, which isolates SYNCHRONOUS throws only, would
            // silently stop covering a sink the day one is written that way.
            // Its rejection would then land outside every guard on this path:
            // an unhandled rejection, which ends the process rather than one
            // sink's frame — precisely what this isolation exists to prevent.
            // Catch it where it can still be reported, by the same route.
            const returned: unknown = sink.accept(frame, source);
            if (typeof (returned as PromiseLike<void> | undefined)?.then === "function") {
              void Promise.resolve(returned).catch((err: unknown) =>
                reportSinkFailure(sink.id, err)
              );
            }
          } catch (err) {
            reportSinkFailure(sink.id, err);
          }
        }
      },
      // Routed, not discarded. This was `() => {}` — so `admitted`, `waiting`,
      // `participant`, `removed`, `completed` and `failed` all reached a
      // function that dropped them, and the carrier's whole lifecycle channel
      // existed without a consumer.
      onCallEvent: (event) => this.noteLifecycleEvent(event)
    });

    // One decision for both halves of the opening: what (if anything) rides
    // in the system instruction, and what (if anything) is sent after
    // connect. `isMeeting` is the same discriminator the post-call record
    // reads.
    const opening = planOpening(realtime.openingDelivery, this.isMeeting);
    // The prompt half is already in the resolved instruction (`withOpening`):
    // `OPENING_TRIGGER` or `MEETING_OPENING_TRIGGER`, a Parley constant, never
    // caller content — so the one-shot system instruction is exactly rendered
    // brief plus fixed text, sent once here and never touched again.
    const systemInstruction = this.resolveSystemInstruction();

    let session: RealtimeSession;
    try {
      session = await realtime.connect({
        model: this.params.model,
        systemInstruction,
        responseModality: "audio",
        tools: buildToolDeclarations(execution),
        // Tag the far end at source: "participant" on a declared meeting,
        // absent (provider default "caller") on an ordinary two-party call.
        // See RealtimeConnectParams.speakerRole and the far-end branch in
        // onTranscript below, which this pairs with.
        ...(this.isMeeting ? { speakerRole: "participant" as const } : {}),
        // A recognition hint for the listener only; resolveSystemInstruction
        // never sees it.
        ...(this.params.brief.keyterms ? { keyterms: this.params.brief.keyterms } : {}),
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
          onDiagnostic: (message) => this.params.onDiagnostic?.(message),
          onAudio: (frame) => {
            // A turn is in flight from its first audio frame, not only from
            // its first transcript fragment: Gemini's outputTranscription can
            // trail the audio it describes, and a turn opened by transcript
            // alone looked idle while its goodbye was already playing — so an
            // end_call in that window drained and hung up over the rest of
            // it. Both providers end every audible turn with a turn-end
            // signal (Gemini `turnComplete`; Deepgram `AgentAudioDone` once its
            // audio has then gone quiet — see DEEPGRAM_TURN_QUIET_MS), and
            // TURN_FINISH_TIMEOUT_MS still bounds the wait if one never comes.
            // Only the flag: turn counting and transcript coalescing are
            // driven by onTurnComplete and onTranscript, unchanged.
            //
            // After an accepted end_call has been cut (at the goodbye or the
            // cap), the rest is not ours to play: dropped before it can
            // re-arm a wait the cut has already released.
            if (this.afterEndCall?.stopped) return;
            this.modelTurnOpen = true;
            // The confirmation rule on a completed record (ToolGate) keys on
            // AUDIO, not the transcript: the transcript can trail this frame,
            // and this frame precedes the tool call it leads to.
            this.gate?.noteModelAudio();
            // A turn still producing audio is not a stalled one: a pending
            // wait for it restarts its idle timer (TURN_FINISH_CEILING_MS
            // still bounds the total).
            for (const rearm of this.turnWaitRearms) rearm();
            this.firstModelAudioOffsetMs ??= this.nowMs() - this.startedAtMs;
            this.media?.sendOutboundAudio(outbound.adapt(frame));
            if (this.afterEndCall) {
              this.afterEndCall.audioMs += frameDurationMs(frame);
              this.checkAfterEndCallStop();
            }
          },
          onInterrupted: () => {
            // A DTMF burst in flight must survive this. See
            // DTMF_BARGE_IN_MARGIN_MS above for the full story; the summary
            // is that clearing here can wipe a keypress mid-press, and a
            // real call proved it does. Outside a burst this still clears on
            // every interrupt exactly as before — that path is a live-call
            // fix in its own right (barge-in must keep working).
            if (this.nowMs() < this.dtmfInFlightUntilMs) return;
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
            // The far end — "caller" on an ordinary two-party call,
            // "participant" on a meeting (RealtimeConnectParams.speakerRole
            // tags it at source; see call site below). This branch means
            // "not us", and must stay keyed that way: keying it to one
            // literal tag (it used to check `=== "caller"` alone) means the
            // OTHER far-end tag falls through into the model-fragment
            // coalescing path below and gets appended into the agent's own
            // speech — on a meeting, that is a participant's words recorded
            // as the agent's, in the consent receipt.
            if (event.speaker !== "model") {
              // Timeline only, no text: when the far end finished a sentence,
              // to read against `model turn complete` and the tool lines.
              if (event.isFinal) this.logAt("caller final");
              // Any words, final or not: Gemini never marks its input
              // transcription final (every caller entry on the 2026-10-01
              // incident call was `isFinal: false`), and keyed to `isFinal`
              // the gate would refuse every completed record there.
              if (event.text !== "") this.gate?.noteCallerSpeech();
              this.closeModelEntry();
              this.noteTranscript(event);
              return;
            }
            if (event.text === "") {
              if (event.isFinal) this.closeModelEntry();
              return;
            }
            this.modelTurnOpen = true;
            this.noteTextAfterEndCall(event.text);
            if (this.openModelEntry) this.openModelEntry.text += event.text;
            else {
              const entry = { speaker: "model" as const, text: event.text, isFinal: false };
              this.openModelEntry = entry;
              // Pre-consent, the growing entry stays purely local and is only
              // committed once — via closeModelEntry — on close, as one
              // coalesced utterance rather than a fragment per push. Outside
              // that window this preserves the exact prior behaviour: the
              // entry lives in the transcript from its first fragment,
              // mutated in place, so a turn cut off mid-generation still
              // shows up (unfinished) in the call record. Recorded explicitly
              // in `openModelEntryLogged` — see its declaration for why this
              // cannot be re-derived from `preConsentActive()` at close time.
              this.openModelEntryLogged = !this.preConsentActive();
              if (this.openModelEntryLogged) this.transcriptLog.push(entry);
            }
            if (event.isFinal) this.closeModelEntry();
          },
          onTurnComplete: () => {
            this.logAt("model turn complete");
            // The turn ending completes a sentence too. Its audio has all
            // arrived by now, so a goodbye in it stops anything after.
            const after = this.afterEndCall;
            if (after && !after.stopped && BYE_WORD.test(after.text)) {
              this.stopAfterEndCall("goodbye");
            }
            this.closeModelEntry();
            this.modelTurnOpen = false;
            this.modelTurnsCompletedCount += 1;
            // The specific silence Defect 4 left no trace of: a go-ahead
            // already matched, a turn just finished, and `begin_notetaking`
            // still hasn't arrived. `onToolCall` runs synchronously ahead of
            // this callback within the same provider message (see the
            // fire-and-forget note below), so a turn that DID call the tool
            // has already flipped `notetaking` by the time this line runs —
            // this only fires on the turn that didn't.
            if (this.consentAnchorAt !== undefined && !this.notetaking && !this.consentMissLogged) {
              this.consentMissLogged = true;
              this.params.onDiagnostic?.(
                `begin_notetaking: consent already matched but not called — ` +
                  `turnsCompleted=${this.modelTurnsCompletedCount}`
              );
            }
            for (const waiter of [...this.turnFinishedWaiters]) waiter();
          },
          onToolCall: (call) => {
            // Fire-and-forget: the provider's onmessage handler is synchronous,
            // and every path inside handleToolCall answers the call itself.
            //
            // The `catch` is load-bearing, not decoration. `begin_notetaking`
            // now performs a real plane handoff, and that handoff throws when
            // the listening plane cannot be brought up (having already ended
            // the call by then) or when the receipt cannot be built. An
            // unhandled rejection out of a fire-and-forget callback takes the
            // whole daemon down, which would turn one failed handoff into
            // every call on the host dropping at once.
            void this.handleToolCall(call).catch((err: unknown) => {
              this.params.onDiagnostic?.(
                `tool call "${call.name}" failed: ${err instanceof Error ? err.message : String(err)}`
              );
            });
          },
          onError: (error) => {
            this.params.onDiagnostic?.(
              `realtime error: ${error.code} ${error.message} fatal=${error.fatal}`
            );
          },
          onClose: (reason) => {
            // WE closed it, at the consent handoff, and the call goes on
            // without a speaking plane. Report it and stop — the hangup below
            // is for a session that died unasked.
            if (this.speakingPlaneRetired) {
              this.params.onDiagnostic?.(
                `realtime session closed after the consent handoff retired it: ${reason}`
              );
              return;
            }
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

    this.addSink({
      id: "realtime",
      accept: (frame) => {
        this.session?.sendAudio(inbound.adapt(frame));
      }
    });
    this.enterPhase("speaking");

    // A meeting gets its own trigger. `OPENING_TRIGGER`'s only affirmative
    // instruction is transactional — greet a person, or work a recorded menu —
    // so sent into a bridge it resolves to "keep waiting", and two live
    // meeting calls sat silent through their whole duration on it. See
    // `MEETING_OPENING_TRIGGER` for the evidence. `isMeeting` is the same
    // discriminator the post-call record reads, so the trigger and the record
    // can never disagree about which shape of call this was.
    //
    // HOW it is delivered is the provider's declaration — see
    // `OpeningDelivery`. `opening` was planned before connect, so the prompt
    // suffix and the trigger come from one decision. On a "prompt" provider a
    // two-party call sends nothing here: the callee's own "hello" opens it.
    if (opening.trigger !== undefined) session.sendOpeningTrigger(opening.trigger);
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
   * ends stays `isFinal: false`, which is honest — the turn was cut off.
   *
   * If it was never logged at creation (see `openModelEntryLogged`), this is
   * the one point it is committed, as a single coalesced utterance, through
   * `noteTranscript` — which reads the CURRENT consent state, so an entry
   * that opened pre-consent and closes after `beginNotetaking()` flipped
   * `notetaking` lands in the live transcript rather than being silently
   * lost. Outside that window it was already live in `transcriptLog` by
   * reference, so sealing it here is enough. */
  private closeModelEntry(): void {
    if (!this.openModelEntry) return;
    this.openModelEntry.isFinal = true;
    if (!this.openModelEntryLogged) this.noteTranscript(this.openModelEntry);
    this.openModelEntry = undefined;
  }

  /** True while a declared meeting's consent has not yet been granted — the
   * one condition that routes `noteTranscript` to the volatile buffer instead
   * of the call transcript. */
  private preConsentActive(): boolean {
    return this.params.execution?.meeting !== undefined && !this.notetaking;
  }

  /** Record one transcript event. Before consent on a meeting call, caller
   * speech goes to the volatile pre-consent buffer and NOTHING reaches the
   * call transcript — "no notetaking before consent" is where the bytes go,
   * not a rule the model is asked to follow. The single entry point both the
   * realtime callback and the tests use, so there is one path rather than
   * two. */
  noteTranscript(event: TranscriptEvent): void {
    if (this.preConsentActive()) {
      this.preConsent.push({
        speaker: event.speaker,
        text: event.text,
        at: new Date().toISOString()
      });
      if (this.preConsent.length > PRE_CONSENT_BUFFER_MAX) {
        this.preConsent.splice(0, this.preConsent.length - PRE_CONSENT_BUFFER_MAX);
      }
      if (event.speaker !== "model") {
        this.resetSilenceTimer();
        // Pin the boundary HERE, on the utterance that could be the go-ahead
        // itself — not later. `lastModelUtteranceAt()` right now is the
        // request the agent has actually made so far; checking again after
        // any later model speech would judge this same utterance against a
        // boundary that has since moved. See `consentAnchorAt`'s doc for the
        // meeting that lost its notes to exactly that.
        this.latchConsentBoundary();
        this.reviewConsentDeparture();
      }
      return;
    }
    this.transcriptLog.push(event);
    if (event.speaker !== "model") this.resetSilenceTimer();
  }

  /** Pin `consentAnchorAt` the first time the pre-consent buffer holds a
   * go-ahead the gate would accept RIGHT NOW — same `findConsentMatch` the
   * gate itself decides with, so this can never disagree with what the real
   * gate would decide at this instant. No-ops once pinned, and no-ops before
   * the agent has asked at all (`requestedAt === undefined`, the same guard
   * `findConsentMatch` applies). */
  private latchConsentBoundary(): void {
    const meeting = this.params.execution?.meeting;
    if (!meeting) return;
    const phrases = [meeting.consent.phrase, ...(meeting.consent.additionalPhrases ?? [])];
    this.consentAnchorAt = anchorConsentBoundary(
      this.consentAnchorAt,
      this.heardBeforeConsentTimed,
      this.lastModelUtteranceAt(),
      phrases
    );
  }

  /** The ordering boundary a consent decision — the gate's, or the receipt's
   * — is judged against.
   *
   * The anchor once a go-ahead has been heard; the agent's most recent
   * utterance until then. The fallback is what the gate used to use
   * unconditionally, and on its own it is correct: before any go-ahead there
   * is nothing to be judged against a stale boundary. What it cannot survive
   * is the agent speaking AFTER the answer, which is the one thing the
   * consent rail guarantees it will do. */
  private consentBoundaryAt(): string | undefined {
    return this.consentAnchorAt ?? this.lastModelUtteranceAt();
  }

  /** Decide, on each caller utterance, whether this meeting is leaving.
   *
   * A DENIAL, not "consent not yet given". The ordinary state of a
   * pre-consent meeting is waiting for an answer, and waiting must never end
   * a call — that is `consentTimeout`'s job, at the timeout the caller
   * configured, and it stays a separate `EndReason` because "they said no" and
   * "nobody replied" are different facts. Three things have to hold before
   * anything is armed: the room must be answering a question the agent
   * actually asked (an utterance at or after the consent boundary), the buffer
   * must not currently amount to consent, and the utterance itself must be an
   * unambiguous refusal (`isConsentDenial`, which is narrower than the gate's
   * own refusal on purpose — see its doc).
   *
   * Re-run on every later utterance rather than latched, so the room can take
   * it back: anything that would now grant consent disarms the departure. That
   * is not politeness, it is consistency — `findConsentMatch` already accepts a
   * later go-ahead after an earlier refusal ("no, don't" then "actually, go
   * ahead"), and a departure that could not be called off would make that
   * documented behaviour unreachable on a live call. */
  private reviewConsentDeparture(): void {
    const meeting = this.params.execution?.meeting;
    if (!meeting || this.notetaking || this.settled) return;
    const boundary = this.consentBoundaryAt();
    if (boundary === undefined) return;
    const phrases = [meeting.consent.phrase, ...(meeting.consent.additionalPhrases ?? [])];
    const said = this.heardBeforeConsentTimed;
    if (findConsentMatch(said, boundary, phrases)) {
      // The room is agreeing right now. Any refusal behind this is one it has
      // itself overridden.
      clearTimeout(this.departureTimer);
      this.departureTimer = undefined;
      return;
    }
    const latest = said.at(-1);
    if (!latest || latest.at < boundary) return;
    if (!isConsentDenial(latest.text, phrases)) return;
    if (this.departureTimer !== undefined) return;
    // Content-free, like every other diagnostic on this class: that a refusal
    // was heard and what happens next, never what was said.
    this.params.onDiagnostic?.(
      `consent refused by the room — leaving in ${CONSENT_DEPARTURE_GRACE_MS}ms`
    );
    this.departureTimer = setTimeout(
      () => void this.endCall("consentDenied"),
      CONSENT_DEPARTURE_GRACE_MS
    );
  }

  /** Everything heard before consent, EXCLUDING the model's own speech — a
   * model that said the go-ahead phrase itself must never be able to
   * authorize its own handoff. Text only; derived from
   * `heardBeforeConsentTimed`, which is what actually feeds
   * `ToolGate.authorizeNotetaking` now that the gate must know WHEN each
   * utterance arrived, not just what it said. */
  get heardBeforeConsent(): readonly string[] {
    return this.heardBeforeConsentTimed.map((e) => e.text);
  }

  /** The ordering-aware counterpart to `heardBeforeConsent`: the same
   * caller-side utterances, each still carrying its `speaker` and `at`.
   * `ToolGate.authorizeNotetaking` needs `at` to enforce that an utterance
   * only counts as consent if it arrived after the agent's request; this
   * class needs `speaker` to attribute the go-ahead correctly in the
   * receipt (a meeting's far end is tagged "participant", not "caller" —
   * see `RealtimeConnectParams.speakerRole`). */
  get heardBeforeConsentTimed(): readonly { speaker: SpeakerRole; text: string; at: string }[] {
    return this.preConsent.filter((e) => e.speaker !== "model");
  }

  /** The timestamp of the agent's own most recent utterance in the
   * pre-consent buffer — the ordering boundary `findConsentMatch` enforces.
   * The LAST model entry, not the first: the announcement and the consent
   * request are usually two separate turns, and the first would let anything
   * said between them also count as an answer to a question not yet asked.
   * `undefined` when the agent has not spoken at all yet. */
  private lastModelUtteranceAt(): string | undefined {
    const models = this.preConsent.filter((e) => e.speaker === "model");
    return models.at(-1)?.at;
  }

  /** Whether this call was configured as a meeting (conference-bridge join
   * with a consent gate) at all — the one signal a post-call reader needs
   * that `consentReceipt`/`gaps`/`gapMs`/`coveredMs` cannot supply on their
   * own: an ordinary two-party call and a meeting whose consent was refused
   * or timed out are otherwise bit-for-bit identical on those four (no
   * receipt, no gaps, zero covered ms), because the listening plane never
   * engages in either case. Added for the post-call record's `kind:
   * "meeting"` discriminator (see @parley/cli's meeting-record.ts) — without
   * it, a caller outside this class cannot tell "not a meeting" from
   * "meeting that never got consent" apart. */
  get isMeeting(): boolean {
    return this.params.execution?.meeting !== undefined;
  }

  /** The caller-supplied `execution.meeting.brief`, read once from config and
   * passed through unchanged — never mutated, never derived from `Brief`.
   * Undefined both for an ordinary call (no `execution.meeting` at all) and
   * for a declared meeting whose caller supplied no brief; the two look
   * identical from here, which is correct — `@parley/server`'s
   * `CompletedCallRecord.brief` and, from there, `MeetingRecord.brief`
   * (`@parley/cli`) both stay absent for either case rather than being
   * stamped with placeholder content. */
  get meetingBrief(): MeetingExecution["brief"] {
    return this.params.execution?.meeting?.brief;
  }

  /** Caller-owned retry lineage. Kept out of the rendered instruction and
   * exposed only for the completed-call record. */
  get operation(): Brief["operation"] {
    return this.params.brief.operation;
  }

  /** Declared structured-result fields, for post-call completeness checks. */
  get expectedOutcomeFields(): readonly string[] | undefined {
    return this.params.execution?.outcome?.fields.map((field) => field.name);
  }

  /** The receipt built at the consent handoff, or undefined before it happens
   * or after a call that never got one. */
  get consentReceipt(): ConsentReceipt | undefined {
    return this.receipt;
  }

  /** The announcement, the request, and the go-ahead — and nothing else.
   *
   * The last two model utterances before the gate are the announcement and
   * the consent request — `requestedAt` is the LATER of the two, the actual
   * request, not the opening announcement. The newest utterance that arrived
   * at or after that request and matches `phrase` or one of
   * `additionalPhrases` is the go-ahead. Everything else in the buffer —
   * including anything said BEFORE the request — is dropped: heard, but not
   * consent to anything, because nothing had been asked yet.
   *
   * Uses the SAME `findConsentMatch` the gate itself decides with
   * (`execution.ts`), against the SAME boundary (`consentBoundaryAt()`), not a
   * second copy of either — two independently maintained copies agreed today
   * and would have silently drifted apart the next time either changed. The
   * boundary half is not hypothetical: while this read `lastModelUtteranceAt()`
   * directly, a gate fixed on its own would have answered the model "ok" and
   * then thrown in here, mid-handoff, on the very call the fix was for.
   *
   * That boundary is also what makes the receipt COHERENT. `modelSaid` is the
   * last two model utterances AT OR BEFORE it — the announcement and the
   * request — never whatever the model said after the room answered. Dated
   * from the model's latest utterance instead, a receipt for the live failure
   * would carry `requestedAt` = the acknowledgment, i.e. later than its own
   * `grantedAt`, contradicting the schema's own words for the field ("at or
   * after requestedAt", `meetingRecordSchema` in @parley/cli).
   *
   * Refuses rather than fabricates: this is the audit artifact for a promise
   * made aloud to a room, and `beginNotetaking()` is public with no phrase
   * check of its own upstream of this — a caller with no go-ahead in the
   * buffer must get a thrown error, never a receipt that asserts consent
   * was granted "now" with no go-ahead in its own utterances array. */
  private buildConsentReceipt(
    phrase: string,
    additionalPhrases: readonly string[] = []
  ): ConsentReceipt {
    const requestedAt = this.consentBoundaryAt();
    const match = findConsentMatch(this.heardBeforeConsentTimed, requestedAt, [
      phrase,
      ...additionalPhrases
    ]);
    if (!match) {
      throw new Error(
        "buildConsentReceipt: no go-ahead utterance in the pre-consent buffer — refusing to " +
          "fabricate a receipt"
      );
    }
    // Reached only with a match in hand, which `findConsentMatch` never
    // returns for an undefined boundary — so the filter below always has one.
    const modelSaid =
      requestedAt === undefined
        ? []
        : this.preConsent.filter((e) => e.speaker === "model" && e.at <= requestedAt).slice(-2);
    // A go-ahead with no announcement or request behind it is not consent to
    // anything — it is someone in the room saying a sentence. Refuse rather
    // than date the (nonexistent) request "now": that would assert the agent
    // announced itself and asked when the buffer shows neither ever happened.
    if (modelSaid.length === 0) {
      throw new Error(
        "buildConsentReceipt: no announcement or request in the pre-consent buffer — refusing " +
          "to fabricate a receipt"
      );
    }
    return {
      requestedAt: modelSaid.at(-1)!.at,
      grantedAt: match.utterance.at,
      phrase,
      matchedPhrase: match.phrase,
      utterances: [
        ...modelSaid.map((e) => ({ speaker: e.speaker, text: e.text })),
        { speaker: match.utterance.speaker, text: match.utterance.text }
      ]
    };
  }

  /** Close the speaking plane and open the listening plane.
   *
   * Consent side first: build the receipt from the buffer while the words are
   * still in it, clear the buffer, clear the consent timer, mark note-taking
   * begun. Then the plane work: connect the transcriber, swap the audio sink,
   * change phase, close the realtime session.
   *
   * Throws — and changes NOTHING — if note-taking has already begun, if no
   * meeting or no transcription plane is declared, or if
   * `buildConsentReceipt` finds no go-ahead in the buffer, or finds a
   * go-ahead with no announcement or request behind it (a model turn can
   * complete carrying no words, so `modelTurnsCompleted >= 1` alone does not
   * guarantee the buffer holds anything the model said). Every one of those
   * checks runs BEFORE any state changes, so a refusal leaves the buffer, the
   * consent timer, and `notetaking` exactly as they were: the call stays in
   * its pre-consent state rather than being half handed off.
   *
   * Ordered so the transcriber is live BEFORE the realtime session closes: the
   * reverse order leaves a window in which audio reaches neither plane, and the
   * meeting's first sentence after consent is exactly what a notetaker is there
   * for. That connect window is itself recorded as a gap, because no sink
   * exists across it.
   *
   * Resolves WITHOUT handing off if the call ended while the transcriber was
   * connecting: the session it was handed is closed and nothing else changes.
   * Rejects, having already ended the call as `transcriptionLost`, if the
   * transcriber could not be brought up at all. */
  async beginNotetaking(): Promise<void> {
    // First, and before the `await` below rather than after it. Two model
    // turns can each call begin_notetaking, and a guard that only ran once the
    // connect had resolved would let both through — two listening planes, one
    // of them unreachable and never closed.
    if (this.notetaking) throw new Error("note-taking has already begun on this call");
    const meeting = this.params.execution?.meeting;
    if (!meeting) throw new Error("beginNotetaking called with no meeting declared");
    const transcription = this.params.transcription;
    if (!transcription) {
      throw new Error("beginNotetaking called with no transcription plane declared");
    }
    // AudioBridge refuses a sink that accepts nothing, but only once it is
    // constructed — which is after the receipt is built and the buffer
    // emptied. Refuse the same misconfiguration here, while refusing is still
    // free.
    if (transcription.provider.accepts.length === 0) {
      throw new Error("beginNotetaking: the transcription provider accepts no audio encoding");
    }

    this.receipt = this.buildConsentReceipt(
      meeting.consent.phrase,
      meeting.consent.additionalPhrases ?? []
    );
    this.preConsent = [];
    clearTimeout(this.consentTimer);
    // Consent was granted, so any departure armed by an earlier refusal is
    // moot. `reviewConsentDeparture` disarms on the go-ahead that overrode it;
    // this is the same statement made where the handoff itself commits, so a
    // future caller reaching `beginNotetaking` by another route cannot end a
    // consented meeting six seconds in.
    clearTimeout(this.departureTimer);
    this.departureTimer = undefined;
    // Before the connect, not after. Consent has been granted, so from this
    // instant `noteTranscript` must write to the call transcript rather than
    // to the buffer it has just emptied — and the model is typically still
    // finishing the turn it called the tool in. Flipping this after the await
    // would route the first words of a consented meeting into a buffer that is
    // never read again.
    this.notetaking = true;

    const offsetMs = this.nowMs() - this.startedAtMs;
    // The hole starts HERE, not when the sink exists. Between this line and a
    // live transcriber there is no sink at all, so every frame the carrier
    // delivers in that window is dropped by something that keeps no record of
    // it — and the connect is bounded at ten seconds, so the window can be
    // seconds of consented meeting audio. Left unmarked, a readout built over
    // it reads exactly like a readout of a complete meeting, which is the one
    // failure `TranscriptGap` exists to prevent. Sealed either by the first
    // frame that reaches a live transcriber, or by the hangup.
    this.openGapAt(offsetMs, "transcriber_connecting");
    let listening: TranscriptionSession;
    try {
      listening = await this.connectTranscription(transcription.provider, offsetMs);
    } catch (err) {
      // `routeToolCall` answered the model "ok" upstream of this, the buffer
      // is gone and consent is granted: there is no way back to the
      // pre-consent state, and after the receipt there is no apology to make.
      // Sitting on a live, billing call pretending to take notes is the one
      // outcome that must not happen, so the call ends instead. The receipt
      // survives — consent WAS given, and that is what it records.
      this.params.onDiagnostic?.(
        `transcription connect failed: ${err instanceof Error ? err.message : String(err)}`
      );
      await this.endCall("transcriptionLost");
      throw err;
    }

    // The call can end DURING the connect — the duration cap, the silence cap,
    // the far end hanging up, and the realtime session's own onClose all fire
    // on their own schedule, and this await is up to ten seconds long. endCall
    // has already cleared the sinks and the phases and found
    // `transcriptionSession` still undefined, so it flushed and closed
    // nothing. Resuming from here would re-add a sink, re-enter the
    // "listening" phase on a call whose `endedBy` says it is over, and strand
    // an open vendor socket that nothing will ever close. Close it and stop.
    if (this.settled) {
      try {
        await listening.close();
      } catch {
        /* the call is already over; a transcriber that will not close cannot
           make it more over */
      }
      return;
    }

    // The transcriber is live, so the connect window is over. Seal it here
    // rather than leaving it for the first frame: `nowMs()` is the end of the
    // last audio the carrier delivered, which is exactly where the hole stops,
    // and a provider that answered inside the same millisecond leaves a
    // zero-length gap that `closeOpenGap` drops rather than records.
    this.closeOpenGap(this.nowMs() - this.startedAtMs);

    this.transcriptionSession = listening;
    const bridge = new AudioBridge(transcription.provider.accepts, transcription.convert);
    this.bridge = bridge;

    this.addSink({
      id: "transcription",
      // SYNCHRONOUS, deliberately. `AudioSink.accept` returns void and this is
      // the hot path: 50 frames a second, every second of a meeting that can
      // run four hours. An `async accept` would allocate a promise per frame
      // and put this sink's failures on a different execution path from its
      // successes, for a body that does no I/O of its own. The fan-out now
      // reports a rejected sink as well as a throwing one, but that is a
      // backstop against a future edit, not licence to make this one async.
      accept: (frame) => {
        // A frame ARRIVES at the end of the twenty milliseconds it carries, so
        // the audio inside it starts one frame earlier. Gap bounds are audio
        // coordinates, not arrival coordinates: a hole in the record has to
        // name the audio it lost, and an arrival-stamped bound both claims
        // twenty milliseconds that were covered and omits twenty that were not.
        const at = this.nowMs() - this.startedAtMs - FRAME_MS;
        if (!listening.ready) {
          // Drop, and REMEMBER dropping. The alternative is an unbounded queue
          // followed by a flood, and a transcript minutes late is worse than
          // one with a hole in it that says so.
          this.openGapAt(at, "transcriber_not_ready");
          return;
        }
        this.closeOpenGap(at);
        this.coveredFrames += 1;
        listening.sendAudio(bridge.adapt(frame));
      }
    });

    // The listening plane is live; now the speaking plane goes away. There is
    // no outbound sink on a TranscriptionSession, so from here the compiler is
    // what keeps the agent quiet.
    this.removeSink("realtime");
    this.leavePhase("speaking");
    this.enterPhase("listening");

    // Let the turn that called begin_notetaking finish generating, then drain
    // it, before the close below cuts it off — same defect as `endCall`'s
    // `reason === "model"` branch, on the same measurement: outbound audio is
    // paced at 20ms/frame and the carrier holds its own playout buffer, so
    // the model's acknowledgment can still be in flight when the socket
    // closes. Call CAa717b30c25f88b2d1b0966da77940a6b (2026-08-20) completed
    // a meeting and the operator heard nothing back — `modelTurnsCompleted:
    // 2` proved the turn finished; the audio just never arrived.
    //
    // `this.session` is deliberately left assigned through this block rather
    // than nulled into `speaking` first: if the call settles mid-drain,
    // `endCall`'s own `await this.session?.close()` is what closes it, and
    // this method finds out below rather than reaching into a session it no
    // longer owns.
    try {
      await this.awaitTurnFinished();
      const drained = await this.media?.drainOutbound(DRAIN_TIMEOUT_MS);
      if (drained) {
        this.params.onDiagnostic?.(
          `drain before handoff: ${drained.confirmed ? "confirmed by carrier" : "TIMED OUT"} after ${drained.waitedMs}ms`
        );
      }
    } catch {
      /* draining is best-effort — never let it block the handoff */
    }

    // The far end can hang up mid-drain. `endCall` has already closed
    // `this.session`, cleared the sinks and phases, and recorded why by the
    // time control returns here — resuming would flip `speakingPlaneRetired`
    // and re-close a session that is already gone, on a call that is already
    // over. Same reasoning as the post-connect `if (this.settled)` check
    // above, for the same reason: do not resume a handoff on a call that has
    // ended underneath it.
    if (this.settled) return;

    const speaking = this.session;
    this.session = undefined;
    // BEFORE the close, not after: `close()` is a socket close on both shipped
    // providers and raises `onClose` synchronously, so a flag set afterwards
    // is set too late to be read.
    this.speakingPlaneRetired = true;
    await speaking?.close();
  }

  /** Bring the listening plane up, bounded by TRANSCRIPTION_CONNECT_TIMEOUT_MS.
   *
   * Separated from `beginNotetaking` only so the timeout plumbing does not
   * bury the ordering that method exists to get right. */
  private async connectTranscription(
    provider: TranscriptionProvider,
    offsetMs: number
  ): Promise<TranscriptionSession> {
    const connecting = provider.connect({
      encoding: provider.accepts[0],
      channels: 1,
      interimResults: true,
      wordTimestamps: true,
      diarize: false,
      offsetMs,
      callbacks: {
        onTranscript: (event) => this.noteTranscript(event),
        onError: (error) =>
          this.params.onDiagnostic?.(`transcription error: ${error.code} ${error.message}`),
        onClose: (reason) => {
          // Symmetric with the realtime session's onClose, and for the same
          // reason. A TranscriptionProvider does not reconnect itself, so this
          // is terminal — and after the handoff there is no speaking plane
          // left, which makes taking notes the call's only remaining purpose.
          // Report BEFORE ending, so a call that hangs up on its own says why.
          // A close code with no reason payload comes through here as `""`,
          // not `undefined` (`Buffer.toString()` on an empty buffer is still
          // a string), so `reason || ` is required — `reason ?? ` leaves this
          // printing "transcription closed: " with nothing after the colon,
          // observed on the same live call as the handoff fix above.
          this.params.onDiagnostic?.(`transcription closed: ${reason || "no reason given"}`);
          void this.endCall("transcriptionLost");
        }
      }
    });

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A connect that wins the race LATE still opened a socket. Close it rather
    // than leaking it into a call that has already been hung up, and absorb a
    // late rejection that no longer has anyone waiting on it.
    void connecting.then(
      (late) => {
        if (timedOut) void late.close().catch(() => {});
      },
      () => {}
    );

    try {
      return await Promise.race([
        connecting,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              new Error(
                `transcription connect timed out after ${TRANSCRIPTION_CONNECT_TIMEOUT_MS}ms`
              )
            );
          }, TRANSCRIPTION_CONNECT_TIMEOUT_MS);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Open a hole at `fromMs`, unless one is already open.
   *
   * First reason wins, for the same reason `endCall`'s does: it is the one
   * that actually started the hole. A transcriber that drops out inside a
   * connect window that never closed is one hole, not two. */
  private openGapAt(fromMs: number, reason: string): void {
    this.openGap ??= { fromMs, reason };
  }

  /** Seal a hole in the record at `atMs` into the meeting.
   *
   * Called where the transcriber recovers AND at hangup: a transcriber that
   * never came back is a gap that would otherwise be left open, and an open
   * gap is one that `gaps` and `gapMs` never report — a hole in the record
   * that the record does not admit to.
   *
   * A hole of zero length is not a hole. The connect window opens one on every
   * single handoff and a provider that answers inside the same millisecond
   * seals it immediately; recording that would put a row in an audit artifact
   * for something that never happened, on every meeting. */
  private closeOpenGap(atMs: number): void {
    const open = this.openGap;
    if (!open) return;
    this.openGap = undefined;
    if (atMs <= open.fromMs) return;
    this.gapLog.push({ fromMs: open.fromMs, toMs: atMs, reason: open.reason });
  }

  /** Every stretch of the meeting the transcriber did not cover, in real
   * milliseconds from the start of the call. */
  get gaps(): readonly TranscriptGap[] {
    return this.gapLog;
  }

  /** How much of the meeting actually reached the transcriber. Together with
   * `gapMs` this is what a downstream readout uses to decide whether it may
   * state anything confidently. */
  get coveredMs(): number {
    return this.coveredFrames * FRAME_MS;
  }

  get gapMs(): number {
    return this.gapLog.reduce((total, g) => total + (g.toMs - g.fromMs), 0);
  }

  /** How many of the model's turns actually completed — on every call, not
   * only a meeting. This is the evidence that the agent was ever given a
   * chance to speak at all: a call that never got past a dial-in IVR ends
   * with this at `0`, which is what tells `classifyMeetingOutcome`
   * (`@parley/cli`) apart "we asked for consent and were refused" from "we
   * never reached anyone to ask". */
  get modelTurnsCompleted(): number {
    return this.modelTurnsCompletedCount;
  }

  /** Milliseconds from the call's start (`attach`) to the first frame of
   * model audio, or `undefined` if the model never produced any.
   *
   * Audio, not transcript: the transcript can trail the audio it describes,
   * and a provider that transcribes its own speech late would otherwise look
   * slow to answer when it was not. The first frame is the same instant for
   * every realtime provider, which is what makes this comparable across them
   * — the answer-to-first-word evidence a provider A/B reads. */
  get firstModelAudioAtMs(): number | undefined {
    return this.firstModelAudioOffsetMs;
  }

  /** Which realtime provider and model this call's speaking plane runs on —
   * the provider's own `name` and the model the session was connected with.
   * For the call record, so a record says what it ran on without anyone
   * having to reconstruct the daemon's configuration at the time. */
  get realtime(): { provider: string; model: string } {
    return { provider: this.params.realtime.name, model: this.params.model };
  }

  /** Per direction, whether frames were handed straight across or converted
   * first: `inbound` is carrier → realtime model, `outbound` is realtime model
   * → carrier, `listening` is carrier → transcriber. "It worked because both
   * vendors spoke mu-law" and "it worked because we converted" must not look
   * identical from outside. DTMF tones are not counted: they are generated in
   * the carrier's encoding and bypass the bridge. */
  get audioBridgeStats(): {
    inbound: BridgeCounts;
    outbound: BridgeCounts;
    listening: BridgeCounts;
  } {
    const counts = (b: AudioBridge | undefined): BridgeCounts => ({
      conversions: b?.conversions ?? 0,
      passThroughs: b?.passThroughs ?? 0
    });
    return {
      inbound: counts(this.inboundBridge),
      outbound: counts(this.outboundBridge),
      listening: counts(this.bridge)
    };
  }

  /** Model text after an accepted `end_call`: the first completed sentence
   * with a "bye" in it fixes where the audio stops — GOODBYE_TEXT_LEAD_MS, or
   * the sentence's own length, past the audio forwarded so far. Accumulated
   * rather than tested per fragment, because a word can arrive split
   * ("Good" + "bye."). */
  private noteTextAfterEndCall(text: string): void {
    const after = this.afterEndCall;
    if (!after || after.stopped || after.stopAtMs !== undefined) return;
    after.text += text;
    for (const [sentence] of after.text.matchAll(COMPLETED_SENTENCE)) {
      if (!BYE_WORD.test(sentence)) continue;
      const hold = Math.max(GOODBYE_TEXT_LEAD_MS, sentence.trim().length * GOODBYE_MS_PER_CHAR);
      after.stopAtMs = after.audioMs + hold;
      return;
    }
  }

  /** On each forwarded frame after `end_call`: has the goodbye's hold run out,
   * or — with no goodbye yet — the audio cap? */
  private checkAfterEndCallStop(): void {
    const after = this.afterEndCall;
    if (!after || after.stopped) return;
    if (after.stopAtMs !== undefined) {
      if (after.audioMs >= after.stopAtMs) this.stopAfterEndCall("goodbye");
    } else if (after.audioMs >= AFTER_END_CALL_AUDIO_CAP_MS) {
      this.stopAfterEndCall(`${AFTER_END_CALL_AUDIO_CAP_MS} ms cap`);
    }
  }

  /** Stop forwarding model audio and let `endCall` go on to drain and hang up
   * without waiting for the turn to complete: the turn's remainder is the part
   * nobody should hear. What is already queued still plays — see
   * GOODBYE_TEXT_LEAD_MS for why it is not cleared. */
  private stopAfterEndCall(at: string): void {
    const after = this.afterEndCall;
    if (!after || after.stopped) return;
    after.stopped = true;
    this.params.onDiagnostic?.(
      `after end_call: stopped at ${at} at +${Math.round(after.audioMs)}ms`
    );
    for (const waiter of [...this.turnFinishedWaiters]) waiter();
  }

  /** Resolve when the model finishes its current turn — or once it has sent no
   * audio for TURN_FINISH_TIMEOUT_MS, or TURN_FINISH_CEILING_MS after the wait
   * began, whichever comes first. */
  private awaitTurnFinished(): Promise<void> {
    if (!this.modelTurnOpen || this.afterEndCall?.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(idle);
        clearTimeout(ceiling);
        this.turnFinishedWaiters.delete(done);
        this.turnWaitRearms.delete(rearm);
        resolve();
      };
      const rearm = (): void => {
        clearTimeout(idle);
        idle = setTimeout(done, TURN_FINISH_TIMEOUT_MS);
      };
      let idle = setTimeout(done, TURN_FINISH_TIMEOUT_MS);
      const ceiling = setTimeout(done, TURN_FINISH_CEILING_MS);
      this.turnFinishedWaiters.add(done);
      this.turnWaitRearms.add(rearm);
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
          const frame = this.params.codec.dtmfTones(digits);
          // mu-law @ 8 kHz: one byte per sample, 8 samples per millisecond.
          // Computed from the frame itself rather than from `digits.length`
          // so this stays correct if the codec's tone/gap timing ever
          // changes. See DTMF_BARGE_IN_MARGIN_MS for why this deadline
          // exists at all.
          const burstMs = frame.data.length / 8;
          this.dtmfInFlightUntilMs = this.nowMs() + burstMs + DTMF_BARGE_IN_MARGIN_MS;
          this.media?.sendOutboundAudio(frame);
        },
        // The model's free-text reason is deliberately dropped here: endedBy is
        // a closed enum the caller can branch on, not prose to parse.
        endCall: () => this.endCall("model"),
        // The real plane swap. It throws rather than no-opping when it cannot
        // happen — a silent success here would make a missing handoff look
        // like a completed one, and the catch at the `onToolCall` call site is
        // what keeps that throw from taking the process with it.
        beginNotetaking: () => this.beginNotetaking()
      },
      respond: (result) => {
        // One timing line per routed call: the tool, the KIND of answer (the
        // literal up to its first " —", which is the part that names the
        // outcome and not the instruction after it) and the offset. Never
        // `call.args` — a record's fields are the call's content.
        this.logAt(`tool ${call.name} → ${result.split(" —")[0]}`);
        // On a vendor that goes on speaking after the answer, the answer
        // opens the turn the call's words are spoken in: the goodbye after
        // `end_call`, the acknowledgment after `begin_notetaking`. Opened
        // BEFORE `carrier.endCall` / `carrier.beginNotetaking` run —
        // `routeToolCall` responds first — so their `awaitTurnFinished` waits
        // for that turn's end instead of draining a queue it has not reached.
        // Only the flag: the continuation's own turn end closes it, and turn
        // counting and transcript coalescing stay with onTurnComplete and
        // onTranscript. See `RealtimeProvider.continuesAfterToolResponse`.
        if (this.params.realtime.continuesAfterToolResponse) this.modelTurnOpen = true;
        session.sendToolResponse(call, result);
      },
      // The evidence the gate decides on. Until this was passed, every
      // `begin_notetaking` from a real call was refused with "the go-ahead
      // phrase has not been spoken" no matter what the room had said, because
      // `routeToolCall` defaults both to empty. `requestedAt` is the newer
      // half of that fix: without it the gate had what was heard but not
      // WHEN, so it could only fall back to matching against everything ever
      // heard pre-consent — including anything said before the agent asked.
      //
      // The ANCHORED boundary, not `lastModelUtteranceAt()`. The rail requires
      // the acknowledgment and this call in one turn, so by the time the call
      // is routed the model has already spoken past the answer it is calling
      // ABOUT — see `consentAnchorAt`.
      heard: this.heardBeforeConsentTimed,
      requestedAt: this.consentBoundaryAt(),
      modelTurnsCompleted: this.modelTurnsCompletedCount,
      // Same seam every other diagnostic in this file already reports
      // through — see the doc on `CallSessionParams.onDiagnostic`. Without
      // this, a refused `begin_notetaking` was invisible: see the doc on
      // `routeToolCall`'s own `onDiagnostic` param for the call that found it.
      onDiagnostic: this.params.onDiagnostic
    });
  }

  addSink(sink: AudioSink): void {
    if (this.sinks.some((s) => s.id === sink.id)) {
      throw new Error(`audio sink "${sink.id}" is already registered`);
    }
    this.sinks.push(sink);
  }

  removeSink(id: string): void {
    const at = this.sinks.findIndex((s) => s.id === id);
    if (at >= 0) this.sinks.splice(at, 1);
  }

  /** A SET, not an enum: "speaking" and "listening" are simultaneous states
   * from slice B onward, and an enum would have to be torn out to allow it. */
  enterPhase(phase: CallPhase): void {
    this.phaseSet.add(phase);
  }
  leavePhase(phase: CallPhase): void {
    this.phaseSet.delete(phase);
  }
  get phases(): ReadonlySet<CallPhase> {
    return this.phaseSet;
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
    clearTimeout(this.consentTimer);
    clearTimeout(this.departureTimer);
    // Nothing said before consent survives a call that never got it. Not an
    // optimisation — it is the promise the announcement made.
    //
    // Read the condition literally: the receipt survives a call that DID get
    // consent, including one that then failed to bring the listening plane up
    // and ended as `transcriptionLost`. That is deliberate — consent was
    // granted aloud and the receipt is the audit artifact of that, not a claim
    // that notes were taken. It depends entirely on `beginNotetaking` setting
    // `notetaking` BEFORE it awaits the transcriber connect (see the comment
    // there); move that assignment after the await and this line silently
    // deletes the consent record on the failure path.
    if (!this.notetaking) {
      this.preConsent = [];
      this.receipt = undefined;
    }
    if (reason !== "remote" && this.callId !== undefined) {
      // Let the closing words actually land. Outbound audio is paced at 20ms a
      // frame and the carrier holds its own playout buffer, so a hangup issued
      // the instant the model calls end_call truncates its last sentence
      // mid-word — measured on the first live call that ever completed its
      // objective, where the caller heard the confirmation cut off.
      //
      // Only when there are closing words to land. The model choosing to end
      // is one such moment; a room refusing consent is the other, because the
      // agent has been asked to say goodbye before dropping off
      // (`meetingConsentDeclined`, @parley/policy) and cutting that off
      // mid-sentence is the rudeness the departure exists to avoid. A cap
      // firing or a transport error is not a goodbye, and neither is worth
      // holding a live, billing call open for.
      if (reason === "model" || reason === "consentDenied") {
        // From here, what the model says after `end_call` is watched for its
        // goodbye — see AFTER_END_CALL_AUDIO_CAP_MS. Before the await below,
        // so no frame of the continuation escapes the count.
        if (reason === "model" && this.params.realtime.continuesAfterToolResponse) {
          this.afterEndCall = { text: "", audioMs: 0, stopped: false };
        }
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
    this.sinks.length = 0;
    this.phaseSet.clear();
    // A hole still open at hangup is a transcriber that never came back.
    // Record it, or `gaps` reports nothing and a readout built over it reads
    // exactly like a readout of a complete meeting.
    this.closeOpenGap(this.nowMs() - this.startedAtMs);
    // The listening plane comes down BEFORE the media handle, so the meeting's
    // last utterance is flushed into the transcript rather than dying with the
    // socket that was carrying it.
    if (this.transcriptionSession) {
      const listening = this.transcriptionSession;
      this.transcriptionSession = undefined;
      try {
        await listening.flush();
      } catch {
        /* best effort — never block the hangup */
      }
      try {
        await listening.close();
      } catch {
        /* same: a transcriber that will not close must not strand the call */
      }
    }
    this.media?.close();
    this.media = undefined;
    await this.session?.close();
  }

  private armTimers(): void {
    const limits = this.params.execution?.limits;
    if (limits) {
      this.durationTimer = setTimeout(
        () => void this.endCall("durationCap"),
        limits.maxDurationSeconds * 1000
      );
      if (limits.maxSilenceSeconds !== undefined) this.resetSilenceTimer();
    }
    const meeting = this.params.execution?.meeting;
    if (meeting) {
      this.consentTimer = setTimeout(
        () => void this.endCall("consentTimeout"),
        meeting.consent.timeoutSeconds * 1000
      );
    }
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

  /** Feed a carrier lifecycle event into the session.
   *
   * `answered` is the one event that changes recorded state (how the call was
   * picked up). Every other member is REPORTED — the timers and the exit are
   * driven elsewhere, and a lifecycle channel whose events reach nothing at
   * all is a channel that cannot be debugged. Content-free, like every other
   * diagnostic on this class: it carries what the carrier said about the leg,
   * never anything anyone said on it. */
  noteLifecycleEvent(event: CallLifecycleEvent): void {
    if (event.type === "answered" && event.answeredBy) this.answeredByValue = event.answeredBy;
    this.params.onDiagnostic?.(`carrier lifecycle: ${describeLifecycleEvent(event)}`);
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
