import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canConvert, convert, createAudioCodec } from "@parley/audio";
import {
  CALL_ANSWERED_CUE,
  CallSession,
  MEETING_CONNECTED_CUE,
  MEETING_OPENING_TRIGGER,
  MISSED_GREETING_NUDGE_MS,
  MIXED_SOURCE,
  MULAW_8K,
  OPENING_TRIGGER,
  encodingEquals,
  type AudioFrame,
  type Brief,
  type CallExecution,
  type CallLifecycleEvent,
  type CallSessionHandle,
  type TelephonyProvider,
  type TranscriptionProvider,
  type TranscriptionSession,
  type WebSocketLike
} from "@parley/core";
import { providerWireFakes, type ProviderWireFake } from "./helpers/provider-wire-fakes.js";

/**
 * CallSession's safety and lifecycle invariants, run end to end over EVERY
 * realtime provider — the real Gemini and Deepgram implementations, each over
 * a fake of its own vendor's wire.
 *
 * Every one of these came out of a live incident, and every one was proven
 * only against a generic fake realtime in `packages/core/test/`: a farewell
 * cut mid-word, a meeting that went silent at consent, a keypress wiped by
 * barge-in, a support call that recorded half an outcome. A generic fake
 * speaks whatever callback order its author assumed. A vendor speaks its own
 * — Deepgram ends a turn with `AgentAudioDone`, signals barge-in with
 * `UserStartedSpeaking`, and sends each utterance whole — so an invariant that
 * holds on the fake has to be shown to hold on each vendor's order too.
 *
 * Driven only through the vendor wire and the carrier; asserted only on what
 * CallSession does to the carrier, what it answers the model, and what it
 * records. Nothing here calls a provider session method directly.
 */

const brief: Brief = {
  to: "+14155550123",
  persona: "You are Ava, calling for Jordan Rivera.",
  objective: "Confirm the booking.",
  facts: ["Party of four."]
};

const codec = createAudioCodec();

/** Core's `DTMF_BARGE_IN_MARGIN_MS` (`packages/core/src/call-session.ts`),
 * which is not exported. Restated so the test can land an interrupt on each
 * side of it. */
const DTMF_BARGE_IN_MARGIN_MS = 200;

/** Let fire-and-forget work (`handleToolCall`, the drains) settle. Microtasks
 * only, so it behaves the same under fake timers as under real ones. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** The carrier, re-created locally: core's test harness is not importable
 * from here, and these tests need its handle to record ORDER — drain, hangup,
 * barge-in clears — rather than only occurrence. */
function makeCarrier() {
  const order: string[] = [];
  const outbound: AudioFrame[] = [];
  const hangups: (string | undefined)[] = [];
  let clears = 0;
  let heldDrain: Promise<void> | undefined;
  let onInbound: ((frame: AudioFrame) => void) | undefined;
  let onCallEvent: ((event: CallLifecycleEvent) => void) | undefined;

  const telephony: TelephonyProvider = {
    name: "fake-telephony",
    mediaEncoding: MULAW_8K,
    originate: async () => ({ providerCallId: "CA-parity", status: "queued" }),
    buildAnswerResponse: () => ({ contentType: "text/xml", body: "<Response/>" }),
    verifyWebhookSignature: () => true,
    attachMediaStream: (p) => {
      onInbound = (frame) => p.onInboundAudio(frame, MIXED_SOURCE);
      onCallEvent = p.onCallEvent;
      return {
        sendOutboundAudio: (frame) => void outbound.push(frame),
        clearOutboundBuffer: () => {
          clears += 1;
        },
        drainOutbound: async () => {
          order.push("drain");
          if (heldDrain) await heldDrain;
          return { confirmed: true, waitedMs: 0 };
        },
        close: () => {}
      };
    },
    hangup: async (_callId, reason) => {
      order.push("hangup");
      hangups.push(reason);
    }
  };

  return {
    telephony,
    order,
    outbound,
    hangups,
    get clears() {
      return clears;
    },
    pushInbound: (frame: AudioFrame) => onInbound?.(frame),
    lifecycle: (event: CallLifecycleEvent) => onCallEvent?.(event),
    /** Make the next drain pend until the returned release is called — the
     * only way "drained BEFORE X" is distinguishable from "X, and a drain that
     * happened to resolve first". */
    holdDrain(): () => void {
      let release!: () => void;
      heldDrain = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    }
  };
}

/** A listening plane that accepts the carrier's own encoding, as
 * `@parley/transcription-deepgram` does, and counts what it is given. */
function makeListeningPlane() {
  const received: AudioFrame[] = [];
  let connects = 0;
  const session: TranscriptionSession = {
    ready: true,
    sendAudio: (frame) => void received.push(frame),
    flush: async () => {},
    close: async () => {}
  };
  const provider: TranscriptionProvider = {
    name: "stub-transcription",
    ingress: { audio: true, channels: "mono" },
    accepts: [MULAW_8K],
    connect: async () => {
      connects += 1;
      return session;
    }
  };
  return {
    transcription: { provider, convert },
    received,
    get connects() {
      return connects;
    }
  };
}

const socket: WebSocketLike = { send: () => {}, on: () => {}, close: () => {} };

/** A frame of model audio in whatever encoding this provider says it emits:
 * 20ms of pcm@24000 for Gemini, 20ms of mulaw@8000 for Deepgram. */
function modelAudio(fake: ProviderWireFake): Buffer {
  return encodingEquals(fake.provider.audio.emits, MULAW_8K)
    ? Buffer.alloc(160, 0xff)
    : Buffer.alloc(960);
}

const carrierFrame = (): AudioFrame => ({ encoding: MULAW_8K, data: Buffer.alloc(160, 0xff) });

describe.each(["gemini", "deepgram"] as const)("CallSession invariants on %s", (name) => {
  let fake: ProviderWireFake;
  const open: CallSessionHandle[] = [];

  beforeEach(() => {
    // Fresh per test: a wire fake tracks the LATEST connect, so one shared
    // across tests would let one call's leftovers speak into the next.
    fake = providerWireFakes().find((f) => f.name === name)!;
  });

  afterEach(async () => {
    // Tear every call down, so no provider keep-alive or consent timer
    // outlives its test.
    for (const handle of open.splice(0)) await handle.stop("remote");
    vi.useRealTimers();
  });

  /** Place a call on this provider. `attach` runs synchronously up to the
   * provider's own handshake await, so the vendor handshake can be completed
   * straight after it is called — Deepgram's `connect` resolves only on
   * `SettingsApplied`, which `wire.ready()` delivers. */
  async function placeCall(
    opts: {
      execution?: CallExecution;
      now?: () => number;
      transcription?: ReturnType<typeof makeListeningPlane>["transcription"];
    } = {}
  ) {
    const carrier = makeCarrier();
    const diagnostics: string[] = [];
    const session = new CallSession({
      brief,
      guardrails: ["Rule one."],
      telephony: carrier.telephony,
      realtime: fake.provider,
      codec,
      convert,
      canConvert,
      from: "+15555550142",
      answerWebhookUrl: "https://voice.example.com/twilio/answer",
      model: "test-model",
      ...(opts.execution ? { execution: opts.execution } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.transcription ? { transcription: opts.transcription } : {}),
      onDiagnostic: (message) => {
        diagnostics.push(message);
        // CallSession's own report that the speaking plane's socket went
        // away — the CallSession-side record of the close, in order.
        if (message.startsWith("realtime session closed")) carrier.order.push("realtime closed");
      }
    });
    const attaching = session.attach("CA-parity", socket);
    fake.wire.ready();
    const handle = await attaching;
    open.push(handle);
    return { session, handle, carrier, diagnostics, wire: fake.wire };
  }

  /** Let the vendor's end-of-turn signal become a completed turn. Gemini's
   * `turnComplete` is final (`turnSettleMs` 0); Deepgram's `AgentAudioDone`
   * counts only after DEEPGRAM_TURN_QUIET_MS of quiet, because more of the
   * same reply can follow it. Needs fake timers. */
  async function settleTurn(): Promise<void> {
    await vi.advanceTimersByTimeAsync(fake.wire.turnSettleMs);
  }

  /** Just short of core's four-second turn-finish ceiling, leaving room for
   * the vendor's settle time — so the turn end, not the ceiling, is what
   * releases the wait. */
  const justShortOfCeiling = (): number => 3_900 - fake.wire.turnSettleMs;

  it("end_call inside an unfinished turn waits for turnComplete, then the drain, then hangs up", async () => {
    vi.useFakeTimers();
    const call = await placeCall({ execution: { closure: { requireOutcomeBeforeEnd: false } } });
    const { wire, carrier } = call;
    const release = carrier.holdDrain();

    // The model says goodbye and asks to hang up inside the SAME turn: the
    // tool call lands before the rest of the farewell's audio exists.
    wire.serverSays("transcript", { speaker: "model", text: "Thanks so much, have a" });
    wire.serverSays("audio", modelAudio(fake));
    wire.serverSays("toolCall", { id: "end-1", name: "end_call", args: { reason: "done" } });

    // Just short of core's four-second turn-finish ceiling: nothing may have
    // drained or hung up, or the rest of the goodbye is cut off upstream of
    // any buffer we could wait on.
    await vi.advanceTimersByTimeAsync(justShortOfCeiling());
    expect(carrier.order).toEqual([]);

    wire.serverSays("transcript", { speaker: "model", text: " good day." });
    wire.serverSays("audio", modelAudio(fake));
    wire.serverSays("turnComplete");
    await settleTurn();
    await flush();

    // The turn finished, so the drain began — with the whole farewell already
    // handed to the carrier — and the hangup waits on it.
    expect(carrier.order).toEqual(["drain"]);
    expect(carrier.outbound).toHaveLength(2);
    expect(carrier.hangups).toEqual([]);

    release();
    await flush();
    // The speaking plane closes last, once the carrier leg is already down.
    expect(carrier.order).toEqual(["drain", "hangup", "realtime closed"]);
    expect(carrier.hangups).toEqual(["model"]);
    expect(call.handle.endedBy).toBe("model");
  });

  it("end_call after a turn's first audio but before any transcript still waits for the turn to end", async () => {
    vi.useFakeTimers();
    const call = await placeCall({ execution: { closure: { requireOutcomeBeforeEnd: false } } });
    const { wire, carrier } = call;

    // Audio first, words later — Gemini's outputTranscription trails the
    // audio it describes. The turn is in flight all the same.
    wire.serverSays("audio", modelAudio(fake));
    wire.serverSays("toolCall", { id: "end-2", name: "end_call", args: { reason: "done" } });
    await vi.advanceTimersByTimeAsync(justShortOfCeiling());
    expect(carrier.order).toEqual([]);

    wire.serverSays("audio", modelAudio(fake));
    wire.serverSays("turnComplete");
    await settleTurn();
    await flush();
    expect(carrier.order).toEqual(["drain", "hangup", "realtime closed"]);
    expect(carrier.outbound).toHaveLength(2);
    expect(call.session.modelTurnsCompleted).toBe(1);
    expect(call.handle.endedBy).toBe("model");
  });

  /** Billed wire log (t20 dghk-fix2, socket 2): `end_call`, an
   * `AgentAudioDone`, then ~1.3 s more agent audio, then a second
   * `AgentAudioDone`. When the first ended the turn, the farewell's wait
   * resolved, the drain covered only the audio queued by then, and the hangup
   * cut the rest of the goodbye. Deepgram-only: on Gemini a `turnComplete` is
   * final and audio after it is a new turn. */
  it.runIf(name === "deepgram")(
    "end_call: audio after an AgentAudioDone is still the goodbye, and is drained before the hangup",
    async () => {
      vi.useFakeTimers();
      const call = await placeCall({ execution: { closure: { requireOutcomeBeforeEnd: false } } });
      const { wire, carrier } = call;

      wire.serverSays("transcript", { speaker: "model", text: "Now I'll end the call." });
      wire.serverSays("audio", modelAudio(fake));
      wire.serverSays("toolCall", { id: "end-3", name: "end_call", args: { reason: "done" } });
      wire.serverSays("turnComplete");
      await vi.advanceTimersByTimeAsync(100);
      // More of the same goodbye, inside the quiet window.
      wire.serverSays("audio", modelAudio(fake));
      wire.serverSays("audio", modelAudio(fake));
      await vi.advanceTimersByTimeAsync(wire.turnSettleMs);
      await flush();
      expect(carrier.order).toEqual([]);

      wire.serverSays("turnComplete");
      await settleTurn();
      await flush();
      // All three frames reached the carrier before the drain began, so the
      // drain waits on the whole goodbye.
      expect(carrier.outbound).toHaveLength(3);
      expect(carrier.order).toEqual(["drain", "hangup", "realtime closed"]);
      expect(call.session.modelTurnsCompleted).toBe(1);
    }
  );

  /** Stream `ms` of model audio, one frame every 20ms, the way both vendors
   * deliver a spoken sentence. */
  async function speakFor(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 20) {
      fake.wire.serverSays("audio", modelAudio(fake));
      await vi.advanceTimersByTimeAsync(20);
    }
  }

  /** The order both vendors' wires show (t20 wire logs, dghk-fix2 and
   * dggpt-fix `transferToAnotherPerson`): the tool call FIRST with no turn
   * open, the answer, a few hundred ms of nothing, then the words that go with
   * the call — here a six-second goodbye, longer than the four-second idle
   * cap measured from the wait's start — then the turn end. The carrier's
   * order proves the hangup waited for all of it. */
  it("end_call before its goodbye: waits for the continuation, drains all of it, then hangs up", async () => {
    vi.useFakeTimers();
    const call = await placeCall({ execution: { closure: { requireOutcomeBeforeEnd: false } } });
    const { wire, carrier } = call;
    const release = carrier.holdDrain();

    wire.serverSays("toolCall", { id: "end-9", name: "end_call", args: { reason: "done" } });
    await flush();
    // An accepted end_call answers with the closing literal (2026-09-30), not a bare "ok".
    expect(wire.toolResponses()).toEqual([
      { id: "end-9", name: "end_call", result: "ok — say nothing more" }
    ]);
    await vi.advanceTimersByTimeAsync(300);
    expect(carrier.order).toEqual([]);

    // One long goodbye sentence: since 0.4.0's after-end_call stop, audio
    // after `end_call` is held only as long as a goodbye's words take to say
    // (90 ms a character here), so a six-second goodbye has to be one.
    wire.serverSays("transcript", {
      speaker: "model",
      text: "Thanks so much for all of your help today, Brenda, and goodbye for now, have a lovely evening."
    });
    await speakFor(6_000);
    expect(carrier.order).toEqual([]);

    wire.serverSays("turnComplete");
    await settleTurn();
    await flush();
    // The drain began only once every frame of the goodbye was with the
    // carrier.
    expect(carrier.order).toEqual(["drain"]);
    expect(carrier.outbound).toHaveLength(6_000 / 20);
    expect(carrier.hangups).toEqual([]);

    release();
    await flush();
    expect(carrier.order).toEqual(["drain", "hangup", "realtime closed"]);
    expect(carrier.hangups).toEqual(["model"]);
    expect(call.session.modelTurnsCompleted).toBe(1);
  });

  /** Live, Gemini 3.8: after `end_call` the model said its goodbye and then
   * narrated the outcome to the callee. Through each vendor's real wire
   * shape (pcm@24000 on Gemini, mu-law@8000 on Deepgram), audio stops 1.5 s
   * of audio after the goodbye's words complete — the text leads its audio —
   * and the hangup does not wait for the turn to end. */
  it("end_call, goodbye, then narration: the narration never reaches the carrier", async () => {
    vi.useFakeTimers();
    const call = await placeCall({ execution: { closure: { requireOutcomeBeforeEnd: false } } });
    const { wire, carrier } = call;

    wire.serverSays("toolCall", { id: "end-7", name: "end_call", args: { reason: "done" } });
    await flush();
    wire.serverSays("transcript", { speaker: "model", text: "Thank you very much. Goodbye." });
    await speakFor(1_000);
    wire.serverSays("transcript", {
      speaker: "model",
      text: "I have successfully rescheduled the appointment."
    });
    await speakFor(3_000);
    await flush();

    expect(carrier.outbound).toHaveLength(1_500 / 20);
    expect(carrier.order).toEqual(["drain", "hangup", "realtime closed"]);
    expect(carrier.hangups).toEqual(["model"]);
    expect(call.diagnostics).toContain("after end_call: stopped at goodbye at +1500ms");
  });

  it("begin_notetaking before its acknowledgment: waits for the continuation before retiring the speaking plane", async () => {
    vi.useFakeTimers();
    const listening = makeListeningPlane();
    const call = await placeCall({
      execution: {
        meeting: {
          consent: { phrase: "go ahead and take notes", timeoutSeconds: 180, onTimeout: "hangUp" }
        }
      },
      transcription: listening.transcription
    });
    const { wire, carrier } = call;

    wire.serverSays("transcript", {
      speaker: "model",
      text: "I'm an AI assistant sitting in for the host.",
      final: true
    });
    wire.serverSays("turnComplete");
    await settleTurn();
    wire.serverSays("transcript", { speaker: "model", text: "Any objection?", final: true });
    wire.serverSays("turnComplete");
    await settleTurn();
    wire.serverSays("transcript", { speaker: "caller", text: "go ahead and take notes" });

    const release = carrier.holdDrain();
    wire.serverSays("toolCall", { id: "consent-9", name: "begin_notetaking", args: {} });
    await flush();
    expect(wire.toolResponses()).toEqual([
      { id: "consent-9", name: "begin_notetaking", result: "ok" }
    ]);
    await vi.advanceTimersByTimeAsync(700);
    expect(carrier.order).toEqual([]);

    wire.serverSays("transcript", { speaker: "model", text: "Thanks, starting notes now." });
    await speakFor(3_000);
    expect(carrier.order).toEqual([]);

    wire.serverSays("turnComplete");
    await settleTurn();
    await flush();
    expect(carrier.order).toEqual(["drain"]);
    expect(carrier.outbound).toHaveLength(3_000 / 20);

    release();
    await flush();
    expect(carrier.order).toEqual(["drain", "realtime closed"]);
    expect(carrier.hangups).toEqual([]);
    expect([...call.session.phases]).toEqual(["listening"]);
  });

  it("the consent handoff drains the turn before retiring the speaking plane, and the call stays up", async () => {
    vi.useFakeTimers();
    const listening = makeListeningPlane();
    const call = await placeCall({
      execution: {
        meeting: {
          consent: { phrase: "go ahead and take notes", timeoutSeconds: 180, onTimeout: "hangUp" }
        }
      },
      transcription: listening.transcription
    });
    const { wire, carrier } = call;

    wire.serverSays("transcript", {
      speaker: "model",
      text: "I'm an AI assistant sitting in for the host.",
      final: true
    });
    wire.serverSays("turnComplete");
    await settleTurn();
    wire.serverSays("transcript", { speaker: "model", text: "Any objection?", final: true });
    wire.serverSays("turnComplete");
    await settleTurn();
    wire.serverSays("transcript", { speaker: "caller", text: "go ahead and take notes" });

    const release = carrier.holdDrain();
    // The model acknowledges and calls begin_notetaking in the same turn,
    // still talking — the live call where the room heard nothing back.
    wire.serverSays("transcript", { speaker: "model", text: "Great, starting notes now" });
    wire.serverSays("audio", modelAudio(fake));
    wire.serverSays("toolCall", { id: "consent-1", name: "begin_notetaking", args: {} });
    await flush();

    expect(wire.toolResponses()).toEqual([
      { id: "consent-1", name: "begin_notetaking", result: "ok" }
    ]);
    expect(listening.connects).toBe(1);
    // The turn is still open: nothing drained, the speaking plane still up.
    expect(carrier.order).toEqual([]);

    wire.serverSays("turnComplete");
    await settleTurn();
    await flush();
    // Draining — and the speaking plane must outlive the drain, because the
    // carrier's playout buffer still holds this turn's audio.
    expect(carrier.order).toEqual(["drain"]);

    release();
    await flush();
    expect(carrier.order).toEqual(["drain", "realtime closed"]);
    expect(call.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("realtime session closed after the consent handoff retired it")
      ])
    );
    // Retiring the speaking plane is a socket close, and a socket close must
    // not take the carrier leg down with it.
    expect(carrier.hangups).toEqual([]);
    expect(call.handle.endedBy).toBeUndefined();
    expect([...call.session.phases]).toEqual(["listening"]);

    // And the carrier's audio now reaches the listening plane.
    carrier.pushInbound(carrierFrame());
    expect(listening.received).toHaveLength(1);
  });

  /** Where the opening goes is each provider's declaration, planned once by
   * `planOpening`. On both vendors a two-party opening rides in the one
   * session setup and NOTHING is sent at connect: the callee's own voice is
   * the model's first input. On Deepgram the only post-connect text input is
   * a USER turn, heard as the callee; on Gemini a trigger sent as its own
   * turn was answered into line hiss before anyone spoke. */
  it("puts the two-party opening in the setup and sends nothing at connect", async () => {
    const { wire } = await placeCall();
    const sent = JSON.stringify(wire.sent());
    const count = (needle: string): number => sent.split(needle).length - 1;
    // Exactly once on the wire: never both a prompt suffix and a turn.
    expect(count(OPENING_TRIGGER)).toBe(1);
    expect(JSON.stringify(wire.sent()[0])).toContain(OPENING_TRIGGER);
    // The setup is the only message on the wire until the far end is heard.
    expect(wire.sent()).toHaveLength(1);
  });

  it("puts the meeting opening where the provider declares it takes it", async () => {
    const { wire } = await placeCall({
      execution: {
        meeting: {
          consent: { phrase: "go ahead and take notes", timeoutSeconds: 180, onTimeout: "hangUp" }
        }
      }
    });
    const setup = JSON.stringify(wire.sent()[0]);
    if (name === "deepgram") {
      expect(setup).toContain(MEETING_OPENING_TRIGGER);
      expect(wire.sent().slice(1)).toEqual([
        { type: "InjectUserMessage", content: MEETING_CONNECTED_CUE }
      ]);
    } else {
      expect(setup).not.toContain(MEETING_OPENING_TRIGGER);
      expect(wire.sent().slice(1)).toEqual([
        { via: "sendRealtimeInput", input: { text: MEETING_OPENING_TRIGGER } }
      ]);
    }
  });

  /** The two-party "prompt" opening's one fallback: a greeting the model
   * missed (answered instantly, or clipped — a live smoke call transcribed
   * only "de Sesame") left the agent silent. Once the far end has spoken and
   * the model has produced nothing for MISSED_GREETING_NUDGE_MS, the answered
   * cue goes out once, as each vendor takes its opening line: a user turn on
   * Deepgram, a realtime text input on Gemini. */
  describe("missed greeting", () => {
    const cueOnWire = (): unknown =>
      name === "deepgram"
        ? { type: "InjectUserMessage", content: CALL_ANSWERED_CUE }
        : { via: "sendRealtimeInput", input: { text: CALL_ANSWERED_CUE } };
    const cues = (sent: unknown[]): unknown[] =>
      sent.filter((m) => JSON.stringify(m).includes(CALL_ANSWERED_CUE));

    it("far end speaks and the model stays silent: the cue goes out once, on the vendor's opening path", async () => {
      vi.useFakeTimers();
      const { wire, diagnostics } = await placeCall();
      wire.serverSays("transcript", { speaker: "caller", text: "de Sesame" });
      await vi.advanceTimersByTimeAsync(MISSED_GREETING_NUDGE_MS - 1);
      expect(cues(wire.sent())).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(cues(wire.sent())).toEqual([cueOnWire()]);
      expect(diagnostics.filter((d) => d.startsWith("missed greeting: opening re-sent"))).toEqual([
        `missed greeting: opening re-sent at +${MISSED_GREETING_NUDGE_MS}ms`
      ]);

      // The far end tries again; the cue is never repeated.
      wire.serverSays("transcript", { speaker: "caller", text: "Hello? Anyone there?" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cues(wire.sent())).toEqual([cueOnWire()]);
      // The opening itself is still delivered exactly once, in the setup.
      expect(JSON.stringify(wire.sent()).split(OPENING_TRIGGER).length - 1).toBe(1);
    });

    /** Deepgram sends an utterance's text only when it ends: a short "Hi."
     * then a long introduction must not get the cue mid-speech. The vendor's
     * speech-start signal holds the window; the next transcript restarts it. */
    it("far-end speech starting holds the window until its transcript", async () => {
      vi.useFakeTimers();
      const { wire } = await placeCall();
      wire.serverSays("transcript", { speaker: "caller", text: "Hi." });
      await vi.advanceTimersByTimeAsync(1_000);
      wire.serverSays("interrupted");
      await vi.advanceTimersByTimeAsync(4_000);
      expect(cues(wire.sent())).toEqual([]);
      wire.serverSays("transcript", {
        speaker: "caller",
        text: "This is the front desk, how can I help you today?"
      });
      await vi.advanceTimersByTimeAsync(MISSED_GREETING_NUDGE_MS);
      expect(cues(wire.sent())).toEqual([cueOnWire()]);
    });

    it("model audio inside the window: the cue never goes out", async () => {
      vi.useFakeTimers();
      const { wire } = await placeCall();
      wire.serverSays("transcript", { speaker: "caller", text: "Hello?" });
      await vi.advanceTimersByTimeAsync(2_000);
      wire.serverSays("audio", modelAudio(fake));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cues(wire.sent())).toEqual([]);
    });

    it("a meeting is never nudged", async () => {
      vi.useFakeTimers();
      const { wire } = await placeCall({
        execution: {
          meeting: {
            consent: { phrase: "go ahead and take notes", timeoutSeconds: 180, onTimeout: "hangUp" }
          }
        }
      });
      wire.serverSays("transcript", { speaker: "caller", text: "Hi everyone, let's start." });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cues(wire.sent())).toEqual([]);
    });
  });

  it("modelTurnsCompleted counts one per turnComplete", async () => {
    vi.useFakeTimers();
    const { session, wire } = await placeCall();
    expect(session.modelTurnsCompleted).toBe(0);
    for (const n of [1, 2, 3]) {
      wire.serverSays("transcript", { speaker: "model", text: `Turn ${n}.`, final: true });
      wire.serverSays("audio", modelAudio(fake));
      wire.serverSays("turnComplete");
      await settleTurn();
      expect(session.modelTurnsCompleted).toBe(n);
    }
    // A barge-in is not a completed turn.
    wire.serverSays("audio", modelAudio(fake));
    wire.serverSays("interrupted");
    expect(session.modelTurnsCompleted).toBe(3);
  });

  it("a DTMF burst survives a barge-in inside its margin; one after the margin still clears", async () => {
    let t = 1_000_000;
    const digits = "5550142#";
    const { carrier, wire } = await placeCall({
      execution: {
        ivr: { maxPresses: 20, allowedDigits: "0123456789#", onUnrecognized: "zeroOut" }
      },
      now: () => t
    });

    wire.serverSays("toolCall", { id: "press-1", name: "press_digits", args: { digits } });
    await flush();
    const tones = codec.dtmfTones(digits);
    expect(carrier.outbound).toHaveLength(1);
    expect(carrier.outbound[0]!.data.equals(tones.data)).toBe(true);
    expect(wire.toolResponses()).toEqual([{ id: "press-1", name: "press_digits", result: "ok" }]);

    // mu-law @ 8 kHz: eight bytes a millisecond.
    const burstMs = tones.data.length / 8;
    t += burstMs + DTMF_BARGE_IN_MARGIN_MS - 50;
    wire.serverSays("interrupted");
    expect(carrier.clears).toBe(0);

    t += 100;
    wire.serverSays("interrupted");
    expect(carrier.clears).toBe(1);
  });

  it("record_outcome missing a declared field is refused and records nothing", async () => {
    const { session, wire } = await placeCall({
      execution: {
        outcome: {
          fields: [
            { name: "price", description: "The quoted price." },
            { name: "date", description: "The booked date." }
          ]
        }
      }
    });

    wire.serverSays("transcript", { speaker: "caller", text: "Yes, that works." });
    wire.serverSays("toolCall", {
      id: "rec-1",
      name: "record_outcome",
      args: { status: "completed", fields: { price: "$40" } }
    });
    await flush();
    expect(wire.toolResponses()).toEqual([
      { id: "rec-1", name: "record_outcome", result: "refused: incomplete outcome" }
    ]);
    expect(session.gateSnapshot().outcome).toBeUndefined();

    wire.serverSays("toolCall", {
      id: "rec-2",
      name: "record_outcome",
      args: { status: "completed", fields: { price: "$40", date: "" } }
    });
    await flush();
    expect(wire.toolResponses()[1]).toEqual({
      id: "rec-2",
      name: "record_outcome",
      result: "recorded"
    });
    expect(session.gateSnapshot().outcome?.fields).toEqual({ price: "$40", date: "" });
  });

  // Scenario matrix, Gemini 3.8, 2026-10-01: the callee offered, and the model
  // recorded `completed` before saying a word. The far end's latest words have
  // to agree, whichever provider carried them.
  it("a completed record made right after their offer is refused, and kept only as partial", async () => {
    const { session, wire } = await placeCall({
      execution: { outcome: { fields: [{ name: "date", description: "The booked date." }] } }
    });

    wire.serverSays("transcript", {
      speaker: "caller",
      text: "We have Thursday at two that I can reserve for you."
    });
    wire.serverSays("toolCall", {
      id: "rec-1",
      name: "record_outcome",
      args: { status: "completed", fields: { date: "Thursday 2pm" } }
    });
    await flush();
    expect(wire.toolResponses()).toEqual([
      {
        id: "rec-1",
        name: "record_outcome",
        result:
          "refused: they have not confirmed what you just said — read the arrangement back exactly as they said it, wait for their yes, then record; do not end the call — without mentioning this"
      }
    ]);
    // Kept, downgraded: arranged, not confirmed (review 0.4.1 I-A).
    expect(session.gateSnapshot().outcome?.status).toBe("partial");
  });

  it("the completed record carries endedBy, dtmf, answeredBy and modelTurnsCompleted", async () => {
    vi.useFakeTimers();
    const { session, handle, carrier, wire } = await placeCall({
      execution: {
        ivr: { maxPresses: 20, allowedDigits: "0123456789", onUnrecognized: "zeroOut" },
        closure: { requireOutcomeBeforeEnd: false }
      }
    });
    carrier.lifecycle({ type: "answered", answeredBy: "human" });

    wire.serverSays("transcript", { speaker: "model", text: "Pressing one.", final: true });
    wire.serverSays("audio", modelAudio(fake));
    wire.serverSays("turnComplete");
    await settleTurn();
    wire.serverSays("toolCall", { id: "press-1", name: "press_digits", args: { digits: "1" } });
    await flush();
    // The wire's order: the call first, the goodbye in the turn that
    // continues after the answer.
    wire.serverSays("toolCall", { id: "end-1", name: "end_call", args: { reason: "done" } });
    await flush();
    wire.serverSays("transcript", { speaker: "model", text: "Goodbye.", final: true });
    wire.serverSays("audio", modelAudio(fake));
    wire.serverSays("turnComplete");
    await settleTurn();
    await flush();

    // Read exactly the surfaces `@parley/server`'s `handleMediaConnection`
    // builds the CompletedCallRecord from.
    const record = {
      endedBy: handle.endedBy,
      modelTurnsCompleted: session.modelTurnsCompleted,
      ...(session.answeredBy ? { answeredBy: session.answeredBy } : {}),
      ...session.gateSnapshot()
    };
    expect(record).toEqual({
      endedBy: "model",
      modelTurnsCompleted: 2,
      answeredBy: "human",
      dtmf: { pressed: ["1"], refused: 0 }
    });
    expect(carrier.hangups).toEqual(["model"]);
  });

  it("bridges audio with no needless work: pass-through where the vendor speaks mulaw, conversion where it cannot", async () => {
    const { session, carrier, wire } = await placeCall();
    for (let i = 0; i < 3; i += 1) carrier.pushInbound(carrierFrame());
    wire.serverSays("audio", modelAudio(fake));
    wire.serverSays("audio", modelAudio(fake));

    // Every frame reached the carrier in the carrier's own encoding.
    expect(carrier.outbound).toHaveLength(2);
    for (const frame of carrier.outbound)
      expect(encodingEquals(frame.encoding, MULAW_8K)).toBe(true);

    const stats = session.audioBridgeStats;
    if (name === "deepgram") {
      expect(stats.inbound).toEqual({ conversions: 0, passThroughs: 3 });
      expect(stats.outbound).toEqual({ conversions: 0, passThroughs: 2 });
    } else {
      expect(stats.inbound).toEqual({ conversions: 3, passThroughs: 0 });
      expect(stats.outbound).toEqual({ conversions: 2, passThroughs: 0 });
    }
    expect(stats.listening).toEqual({ conversions: 0, passThroughs: 0 });
  });

  it("a tool call followed by a barge-in routes exactly once and is still answered", async () => {
    const { session, carrier, wire } = await placeCall({
      execution: {
        ivr: { maxPresses: 20, allowedDigits: "0123456789", onUnrecognized: "zeroOut" }
      }
    });

    // The interrupt lands on the same tick as the tool call, before the
    // routed call has answered.
    wire.serverSays("toolCall", { id: "press-7", name: "press_digits", args: { digits: "7" } });
    wire.serverSays("interrupted");
    await flush();

    expect(session.gateSnapshot().dtmf).toEqual({ pressed: ["7"], refused: 0 });
    expect(carrier.outbound).toHaveLength(1);
    // An unanswered tool call stalls the model's turn; the barge-in must not
    // swallow the answer, nor produce a second one.
    expect(wire.toolResponses()).toEqual([{ id: "press-7", name: "press_digits", result: "ok" }]);
  });
});

/** A meeting on Gemini is the one call shape the two-party "prompt" opening
 * does not touch: Gemini meetings never ran with the opening in the prompt,
 * and saying nothing until people are heard is the consent invariant. So the
 * meeting's wire is pinned to what the provider sent when it declared plain
 * `"turn"` — the same session setup and the same trigger, byte for byte. */
describe("Gemini meeting opening, pinned to its shipped wire", () => {
  const meeting: CallExecution = {
    meeting: {
      consent: { phrase: "go ahead and take notes", timeoutSeconds: 180, onTimeout: "hangUp" }
    }
  };

  async function wireOf(asShipped: boolean, execution?: CallExecution): Promise<unknown[]> {
    const fake = providerWireFakes().find((f) => f.name === "gemini")!;
    // The same provider instance, re-declared with the delivery Gemini shipped
    // with — everything else (key, factory, connect) is inherited untouched.
    const realtime = asShipped
      ? (Object.assign(Object.create(fake.provider), {
          openingDelivery: "turn"
        }) as typeof fake.provider)
      : fake.provider;
    const carrier = makeCarrier();
    const session = new CallSession({
      brief,
      guardrails: ["Rule one."],
      telephony: carrier.telephony,
      realtime,
      codec,
      convert,
      canConvert,
      from: "+15555550142",
      answerWebhookUrl: "https://voice.example.com/twilio/answer",
      model: "test-model",
      now: () => Date.UTC(2026, 8, 30, 19, 0, 0),
      timeZone: "America/Los_Angeles",
      ...(execution ? { execution } : {})
    });
    const attaching = session.attach("CA-parity", socket);
    fake.wire.ready();
    const handle = await attaching;
    const sent = JSON.parse(JSON.stringify(fake.wire.sent())) as unknown[];
    await handle.stop("remote");
    return sent;
  }

  it('sends a meeting exactly the messages the shipped "turn" declaration sent', async () => {
    const shipped = await wireOf(true, meeting);
    const now = await wireOf(false, meeting);
    expect(JSON.stringify(now)).toBe(JSON.stringify(shipped));
    expect(now.slice(1)).toEqual([
      { via: "sendRealtimeInput", input: { text: MEETING_OPENING_TRIGGER } }
    ]);
    expect(JSON.stringify(now[0])).not.toContain(MEETING_OPENING_TRIGGER);
    expect(JSON.stringify(now)).not.toContain(MEETING_CONNECTED_CUE);
  });

  it("sends a two-party call nothing at connect: the setup alone, carrying the opening", async () => {
    const shipped = await wireOf(true);
    const now = await wireOf(false);
    expect(now).toHaveLength(1);
    expect(JSON.stringify(now[0])).toContain(OPENING_TRIGGER);
    // The opening moved, and nothing else did: the shipped wire was this
    // setup without the suffix, plus the trigger as its own turn.
    const instruction = (m: unknown): string =>
      (m as { config: { systemInstruction: string } }).config.systemInstruction;
    expect(instruction(now[0])).toBe(`${instruction(shipped[0])}\n\n${OPENING_TRIGGER}`);
    expect(shipped.slice(1)).toEqual([
      { via: "sendRealtimeInput", input: { text: OPENING_TRIGGER } }
    ]);
  });
});
