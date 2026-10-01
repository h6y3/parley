import { vi } from "vitest";
import type { CallSessionParams } from "../../src/call-session.js";
import type { Brief } from "../../src/brief.js";
import { MIXED_SOURCE, MULAW_8K, PCM_16K, PCM_24K } from "../../src/types.js";
import type {
  AudioCodec,
  AudioEncoding,
  AudioFrame,
  AudioSource,
  CallLifecycleEvent,
  MediaStreamHandle,
  RealtimeAudioFormat,
  RealtimeConnectParams,
  RealtimeProvider,
  RealtimeSession,
  TelephonyProvider,
  ToolCallRequest,
  TranscriptEvent,
  WebSocketLike
} from "../../src/types.js";
import type { ToolResult } from "../../src/execution.js";
import type { FrameConverter } from "../../src/audio-bridge.js";
import type {
  TranscriptionCallbacks,
  TranscriptionConnectParams,
  TranscriptionProvider,
  TranscriptionProviderError,
  TranscriptionSession
} from "../../src/transcription.js";

/**
 * One set of `CallSession` test doubles, shared by `call-session.test.ts`,
 * `call-session-sinks.test.ts`, `pre-consent-buffer.test.ts` and
 * `meeting-handoff.test.ts` so the files cannot drift into several different
 * fakes answering the same interfaces differently.
 */

export const brief: Brief = {
  to: "+14155550123",
  persona: "You are Ada.",
  objective: "Confirm the booking.",
  facts: ["Party of four."]
};

export const guardrails: readonly string[] = ["Rule one.", "Rule two."];

/** Relabelling fake converter — these tests verify wiring, not DSP. The bytes
 * are untouched and only the declared encoding changes, so a test can still
 * see which way a frame was bridged. `audio-contract.test.ts` is where the
 * real `convert` is exercised. */
export const fakeConvert: FrameConverter = (f: AudioFrame, to: AudioEncoding) => ({
  encoding: to,
  data: f.data
});
export const fakeCanConvert = (): boolean => true;

/** The fake realtime providers' declared formats: the Gemini shape, so every
 * inbound carrier frame is bridged to pcm@16000 and every model frame to the
 * carrier's mulaw@8000 — what the fixed codec used to do on every call. */
export const fakeRealtimeAudio: RealtimeAudioFormat = { accepts: [PCM_16K], emits: PCM_24K };

export const fakeCodec: AudioCodec = {
  // Recognisable stand-in for real tones: these tests verify that a press
  // reaches the OUTBOUND AUDIO STREAM, which is where keypresses now go. The
  // tone generation itself is @parley/audio's dtmf.test.ts, which checks the
  // actual frequencies with a Goertzel detector.
  dtmfTones: (digits: string) => ({ encoding: MULAW_8K, data: Buffer.from(digits, "utf8") })
};

/** A `RealtimeSession` that REMEMBERS being closed, and counts any audio
 * pushed at it afterwards.
 *
 * A plain no-op stub cannot tell "the speaking plane is gone" apart from
 * "still open and quietly ignoring us", and the consent handoff's whole
 * promise is the first of those. `audioAfterClose` is the observable form of
 * it. */
export interface RealtimeSessionStub extends RealtimeSession {
  closed: boolean;
  audioAfterClose: number;
  audio: AudioFrame[];
  toolResponses: { id: string; result: ToolResult }[];
  /** The callbacks `connect()` was handed, recorded by every provider stub in
   * this file so `close()` can fire `onClose` the way a real socket close
   * does. */
  callbacks?: RealtimeConnectParams["callbacks"];
}

/** `close()` FIRES `onClose`, because both shipped providers implement it as a
 * socket close and a socket close is exactly what raises that callback
 * (`gemini-realtime-provider.ts`, `deepgram-realtime-provider.ts`).
 *
 * A stub that merely set a boolean made `CallSession`'s unconditional
 * `onClose -> endCall("error")` invisible to every test in this repo, and the
 * consent handoff closes the speaking plane deliberately — so on a real
 * meeting the carrier leg dropped the instant consent was granted, and the
 * whole suite stayed green. Anything that stubs a `RealtimeSession` must keep
 * this behaviour, or the next bug of that shape is invisible again. */
export function makeRealtimeSessionStub(): RealtimeSessionStub {
  const stub: RealtimeSessionStub = {
    closed: false,
    audioAfterClose: 0,
    audio: [],
    toolResponses: [],
    sendOpeningTrigger: vi.fn(),
    sendAudio: (f: AudioFrame) => {
      if (stub.closed) stub.audioAfterClose += 1;
      stub.audio.push(f);
    },
    notifyActivityEnd: () => {},
    sendToolResponse: (call: ToolCallRequest, result: ToolResult) => {
      stub.toolResponses.push({ id: call.id, result });
    },
    close: async () => {
      if (stub.closed) return;
      stub.closed = true;
      stub.callbacks?.onClose("stub session closed");
    }
  };
  return stub;
}

export function fakes() {
  let realtimeCb!: RealtimeConnectParams["callbacks"];
  const session = makeRealtimeSessionStub();
  // An ALIAS, not a second array: `sendAudio` records into the stub, and
  // callers of `fakes()` have always read `sentAudio`.
  const sentAudio = session.audio;
  const openingTrigger = session.sendOpeningTrigger as ReturnType<typeof vi.fn>;
  let connectParams!: RealtimeConnectParams;
  const realtime: RealtimeProvider = {
    name: "fake-realtime",
    audio: fakeRealtimeAudio,
    openingDelivery: "turn",
    continuesAfterToolResponse: false,
    connect: async (p) => {
      connectParams = p;
      realtimeCb = p.callbacks;
      session.callbacks = p.callbacks;
      return session;
    }
  };

  let onInbound!: (f: AudioFrame, source: AudioSource) => void;
  let onCallEvent!: (event: CallLifecycleEvent) => void;
  const sentOutbound: AudioFrame[] = [];
  const clearOutbound = vi.fn();
  const handle: MediaStreamHandle = {
    sendOutboundAudio: (f) => sentOutbound.push(f),
    clearOutboundBuffer: clearOutbound,
    drainOutbound: async () => ({ confirmed: true, waitedMs: 0 }),
    close: () => {}
  };
  const telephony: TelephonyProvider = {
    name: "fake-telephony",
    mediaEncoding: MULAW_8K,
    originate: async () => ({ providerCallId: "call-1", status: "queued" }),
    buildAnswerResponse: () => ({ contentType: "text/xml", body: "<Response/>" }),
    verifyWebhookSignature: () => true,
    attachMediaStream: (p) => {
      onInbound = p.onInboundAudio;
      onCallEvent = p.onCallEvent;
      return handle;
    },
    hangup: async () => {}
  };

  return {
    realtime,
    telephony,
    session,
    handle,
    openingTrigger,
    clearOutbound,
    sentAudio,
    sentOutbound,
    toolResponses: session.toolResponses,
    emitInbound: (f: AudioFrame) => onInbound(f, MIXED_SOURCE),
    /** Synthesise a carrier lifecycle event, the way @parley/telephony-twilio
     * does from `start`/`stop`/socket-close. */
    emitCallEvent: (event: CallLifecycleEvent) => onCallEvent(event),
    emitModelAudio: (f: AudioFrame) => realtimeCb.onAudio(f),
    emitInterrupted: () => realtimeCb.onInterrupted(),
    emitTranscript: (e: Parameters<RealtimeConnectParams["callbacks"]["onTranscript"]>[0]) =>
      realtimeCb.onTranscript(e),
    emitTurnComplete: () => realtimeCb.onTurnComplete?.(),
    /** Drive a model-requested tool call through the REAL `onToolCall`
     * callback, then let the void-style `handleToolCall` settle. The awaits
     * inside it are the plane handoff's, so yield generously rather than
     * counting microtasks. */
    emitToolCall: async (call: ToolCallRequest): Promise<void> => {
      realtimeCb.onToolCall?.(call);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
    getConnectParams: () => connectParams
  };
}

/** A `WebSocketLike` real enough for `attach()` to register against, and able
 * to play back the inbound handler `attachMediaStream` was given — which the
 * plain `{ send, on, close }` object this replaced could not do, since nothing
 * held onto the callback outside the provider fake that received it. */
export class FakeSocket implements WebSocketLike {
  private inboundHandler?: (frame: AudioFrame, source: AudioSource) => void;

  send(): void {}
  on(): void {}
  close(): void {}

  /** Called by this harness's `TelephonyProvider` stub when `attachMediaStream`
   * registers this socket's inbound handler — mirrors what a real telephony
   * provider does with a live media-stream socket. */
  registerInboundHandler(handler: (frame: AudioFrame, source: AudioSource) => void): void {
    this.inboundHandler = handler;
  }

  /** Deliver one inbound frame as if the carrier had sent it. */
  pushInbound(frame: AudioFrame, source: AudioSource): void {
    this.inboundHandler?.(frame, source);
  }
}

function stubTelephony(onInboundFrame?: () => void): TelephonyProvider {
  return {
    name: "fake-telephony",
    mediaEncoding: MULAW_8K,
    originate: async () => ({ providerCallId: "CA1", status: "queued" }),
    buildAnswerResponse: () => ({ contentType: "text/xml", body: "<Response/>" }),
    verifyWebhookSignature: () => true,
    attachMediaStream: (p) => {
      if (p.socket instanceof FakeSocket) {
        p.socket.registerInboundHandler((frame, source) => {
          // A carrier frame IS twenty milliseconds of audio. Advancing the
          // injected clock here is what lets a gap counted in frames come out
          // in real milliseconds, with no test waiting on a wall clock.
          onInboundFrame?.();
          p.onInboundAudio(frame, source);
        });
      }
      return {
        sendOutboundAudio: () => {},
        clearOutboundBuffer: () => {},
        drainOutbound: async () => ({ confirmed: true, waitedMs: 0 }),
        close: () => {}
      };
    },
    hangup: async () => {}
  };
}

function stubRealtime(session: RealtimeSessionStub): RealtimeProvider {
  return {
    name: "fake-realtime",
    audio: fakeRealtimeAudio,
    openingDelivery: "turn",
    continuesAfterToolResponse: false,
    // Records the callbacks even though this stub drives none of them itself:
    // `close()` needs `onClose` to fire, which is what a real provider does.
    connect: async (p) => {
      session.callbacks = p.callbacks;
      return session;
    }
  };
}

/** A working `CallSessionParams` built from stub `TelephonyProvider` /
 * `RealtimeProvider` / `AudioCodec` — fresh stubs on every call, so callers
 * never share mutable state across tests by accident. */
export function makeSessionParams(
  opts: { realtimeSession?: RealtimeSessionStub; onInboundFrame?: () => void } = {}
): CallSessionParams {
  return {
    brief,
    guardrails,
    telephony: stubTelephony(opts.onInboundFrame),
    realtime: stubRealtime(opts.realtimeSession ?? makeRealtimeSessionStub()),
    codec: fakeCodec,
    convert: fakeConvert,
    canConvert: fakeCanConvert,
    from: "+14155550000",
    answerWebhookUrl: "https://example.test/answer",
    model: "test-model"
  };
}

/** The `execution.meeting` block shared by `makeMeetingParams()` and
 * `makeMeetingFakes()`, so the two cannot drift into declaring two different
 * meetings. Fresh object on every call — same reason `makeSessionParams()`
 * builds fresh stubs each time. */
function meetingExecution(): NonNullable<CallSessionParams["execution"]> {
  return {
    meeting: {
      consent: {
        phrase: "go ahead and take notes",
        timeoutSeconds: 180,
        onTimeout: "hangUp"
      }
    }
  };
}

/** A `TranscriptionSession` whose `ready` is MUTABLE — the interface's is
 * readonly, and a test needs to drop the transcriber mid-call and watch the
 * gap open. */
export interface TranscriptionSessionStub {
  ready: boolean;
  received: AudioFrame[];
  flushes: number;
  closes: number;
  /** Order of the teardown calls, so "flushed BEFORE closing" is checkable
   * rather than inferred from two counters. */
  teardown: string[];
  sendAudio(frame: AudioFrame, source?: AudioSource): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface TranscriptionConnectRecord {
  calls: number;
  offsetMs?: number;
  encoding?: AudioEncoding;
  /** Whether the SPEAKING plane was already closed when the listening plane
   * was asked to come up. Must be false: the reverse order leaves a window in
   * which audio reaches neither plane. */
  realtimeClosedAtConnect?: boolean;
}

/** How the stub provider's `connect` behaves. `hang` never settles — the
 * failure mode a promise that resolves on `open` and rejects on `error` has
 * when neither ever arrives. `defer` settles when the test says so, which is
 * the only way the window DURING the connect is observable at all. */
export type ConnectBehaviour = "ok" | "reject" | "hang" | "defer";

interface TranscriptionStubs {
  transcription: NonNullable<CallSessionParams["transcription"]>;
  session: TranscriptionSessionStub;
  connect: TranscriptionConnectRecord;
  emitTranscript(event: TranscriptEvent): void;
  emitClose(reason: string): void;
  emitError(error: TranscriptionProviderError): void;
  releaseConnect(): void;
}

function transcriptionStubs(
  realtimeSession: RealtimeSessionStub,
  behaviour: ConnectBehaviour
): TranscriptionStubs {
  const session: TranscriptionSessionStub = {
    ready: true,
    received: [],
    flushes: 0,
    closes: 0,
    teardown: [],
    sendAudio: (frame: AudioFrame) => {
      session.received.push(frame);
    },
    flush: async () => {
      session.flushes += 1;
      session.teardown.push("flush");
    },
    close: async () => {
      session.closes += 1;
      session.teardown.push("close");
    }
  };

  const connect: TranscriptionConnectRecord = { calls: 0 };
  let callbacks: TranscriptionCallbacks | undefined;
  let release: () => void = () => {};

  const provider: TranscriptionProvider = {
    name: "stub-transcription",
    ingress: { audio: true, channels: "mono" },
    // mulaw@8000 FIRST, exactly as @parley/transcription-deepgram orders it: a
    // PSTN leg already produces it, so the bridge records a pass-through
    // rather than a conversion.
    accepts: [MULAW_8K, PCM_16K],
    connect: async (p: TranscriptionConnectParams): Promise<TranscriptionSession> => {
      connect.calls += 1;
      connect.offsetMs = p.offsetMs;
      connect.encoding = p.encoding;
      connect.realtimeClosedAtConnect = realtimeSession.closed;
      callbacks = p.callbacks;
      if (behaviour === "reject") throw new Error("stub transcription refused the connect");
      if (behaviour === "hang") return new Promise<TranscriptionSession>(() => {});
      if (behaviour === "defer") {
        return new Promise<TranscriptionSession>((resolve) => {
          release = () => resolve(session);
        });
      }
      return session;
    }
  };

  return {
    transcription: {
      provider,
      // Records the target encoding rather than doing DSP — @parley/core
      // carries none, and these tests verify routing, not resampling.
      convert: ((frame, to) => ({ encoding: to, data: frame.data })) as FrameConverter
    },
    session,
    connect,
    emitTranscript: (event) => callbacks?.onTranscript(event),
    emitClose: (reason) => callbacks?.onClose(reason),
    emitError: (error) => callbacks?.onError(error),
    releaseConnect: () => release()
  };
}

export interface MeetingHandoffStubs {
  realtimeSession: RealtimeSessionStub;
  transcriptionSession: TranscriptionSessionStub;
  transcriptionConnect: TranscriptionConnectRecord;
  /** The injected clock. Advances 20ms per inbound carrier frame on its own; a
   * test advances it directly to skip forward in the meeting. */
  clock: { now(): number; advance(ms: number): void };
  /** Emit as the TRANSCRIPTION provider would — the listening plane's own
   * callback, not the realtime session's. */
  emitTranscript(event: TranscriptEvent): void;
  emitTranscriptionClose(reason: string): void;
  emitTranscriptionError(error: TranscriptionProviderError): void;
  /** Settle a `defer`red connect. */
  releaseConnect(): void;
}

function makeClock(): MeetingHandoffStubs["clock"] {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    }
  };
}

/** `makeSessionParams()` plus a declared `execution.meeting`, a stub listening
 * plane and an injected clock — for the pre-consent-buffer and consent-handoff
 * tests. Fresh on every call, same as `makeSessionParams()`.
 *
 * Built on `stubRealtime()`, whose `connect()` discards the callbacks object
 * entirely — nothing built from this can ever drive a transcript event
 * through the REAL `onTranscript` callback, only through the public
 * `noteTranscript` shortcut. That is fine for tests that only care about the
 * buffer/receipt/timeout behavior, but it means this params object cannot
 * exercise the coalesced model-fragment path in `onTranscript` at all — for
 * that, use `makeMeetingFakes()`. */
export function makeMeetingParams(
  opts: { connect?: ConnectBehaviour } = {}
): CallSessionParams & { stubs: MeetingHandoffStubs } {
  const clock = makeClock();
  const realtimeSession = makeRealtimeSessionStub();
  const transcription = transcriptionStubs(realtimeSession, opts.connect ?? "ok");

  return {
    ...makeSessionParams({ realtimeSession, onInboundFrame: () => clock.advance(20) }),
    execution: meetingExecution(),
    transcription: transcription.transcription,
    now: clock.now,
    stubs: {
      realtimeSession,
      transcriptionSession: transcription.session,
      transcriptionConnect: transcription.connect,
      clock,
      emitTranscript: transcription.emitTranscript,
      emitTranscriptionClose: transcription.emitClose,
      emitTranscriptionError: transcription.emitError,
      releaseConnect: transcription.releaseConnect
    }
  };
}

/** `fakes()` plus a declared `execution.meeting` and a stub listening plane,
 * for tests that need to drive the REAL `onTranscript` / `onToolCall`
 * callbacks (via `emitTranscript` / `emitTurnComplete` / `emitToolCall`) on a
 * meeting call — e.g. asserting the pre-consent guards on the coalesced
 * model-fragment path, which `makeMeetingParams()` cannot reach (see its doc
 * comment), or driving `begin_notetaking` through the carrier the way a live
 * call does. */
export function makeMeetingFakes(
  opts: { connect?: ConnectBehaviour } = {}
): ReturnType<typeof fakes> & { params: CallSessionParams; stubs: MeetingHandoffStubs } {
  const f = fakes();
  const clock = makeClock();
  const transcription = transcriptionStubs(f.session, opts.connect ?? "ok");
  return {
    ...f,
    params: {
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: f.realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model",
      execution: meetingExecution(),
      transcription: transcription.transcription,
      now: clock.now
    },
    stubs: {
      realtimeSession: f.session,
      transcriptionSession: transcription.session,
      transcriptionConnect: transcription.connect,
      clock,
      emitTranscript: transcription.emitTranscript,
      emitTranscriptionClose: transcription.emitClose,
      emitTranscriptionError: transcription.emitError,
      releaseConnect: transcription.releaseConnect
    }
  };
}
