import { afterEach, describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { MEETING_OPENING_TRIGGER, OPENING_TRIGGER } from "../src/render.js";
import { MULAW_8K, PCM_16K, PCM_24K } from "../src/types.js";
import type {
  AudioFrame,
  MediaStreamHandle,
  RealtimeConnectParams,
  RealtimeProvider,
  RealtimeSession,
  TelephonyProvider
} from "../src/types.js";
import {
  brief,
  guardrails,
  fakeCanConvert,
  fakeCodec,
  fakeConvert,
  fakeRealtimeAudio,
  fakes,
  makeMeetingFakes,
  FakeSocket
} from "./helpers/call-session-harness.js";

describe("CallSession", () => {
  it("resolves the systemInstruction via renderSystemInstruction from the brief and injected guardrails, and sends the fixed opening trigger", async () => {
    const f = fakes();
    const cs = new CallSession({
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
      // Pinned: every call now carries the date sentence.
      now: () => Date.UTC(2026, 8, 30, 19, 0, 0),
      timeZone: "America/Los_Angeles"
    });
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    expect(f.getConnectParams().systemInstruction).toBe(
      "You are Ada.\n\nConfirm the booking. Party of four.\n\nRule one. Rule two.\n\n" +
        'Today is Wednesday, 2026-09-30 (America/Los_Angeles). When the other person gives a relative date such as "tomorrow" or "next Tuesday", work out the calendar date from today before you record it. The next 14 days are: Thu Oct 1, Fri Oct 2, Sat Oct 3, Sun Oct 4, Mon Oct 5, Tue Oct 6, Wed Oct 7, Thu Oct 8, Fri Oct 9, Sat Oct 10, Sun Oct 11, Mon Oct 12, Tue Oct 13, Wed Oct 14. When you say a date, use the weekday and date together exactly as listed.'
    );
    expect(f.getConnectParams().responseModality).toBe("audio");
    expect(f.openingTrigger).toHaveBeenCalledWith(OPENING_TRIGGER);
  });

  /** The two live meeting calls that produced `MEETING_OPENING_TRIGGER` were
   * sent `OPENING_TRIGGER`, whose only affirmative instruction is to greet a
   * person or work a recorded menu — neither of which is joining a meeting —
   * so the whole line read as "keep waiting" and the model never spoke.
   *
   * Asserting the negative alongside the positive is the point: a send site
   * that sent BOTH would satisfy the positive assertion alone while handing a
   * live model two contradictory openings. */
  it("sends the meeting opening trigger, and not the generic one, when execution.meeting is declared", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession(f.params);
    await cs.attach("CA1", new FakeSocket());

    expect(f.openingTrigger).toHaveBeenCalledWith(MEETING_OPENING_TRIGGER);
    expect(f.openingTrigger).not.toHaveBeenCalledWith(OPENING_TRIGGER);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  it("attaches the media stream before starting realtime.connect (carrier start frame must not be missed)", async () => {
    const f = fakes();
    const order: string[] = [];
    // The carrier's one-time `start` frame (carrying streamSid) arrives on the
    // media socket immediately; awaiting the realtime connect round-trip before
    // registering the socket listener drops it and the call goes silent
    // outbound. Guard the ordering: attachMediaStream must run before connect.
    const telephony: TelephonyProvider = {
      ...f.telephony,
      attachMediaStream: (p) => {
        order.push("attach");
        return f.telephony.attachMediaStream(p);
      }
    };
    const realtime: RealtimeProvider = {
      name: "seq",
      audio: fakeRealtimeAudio,
      openingDelivery: "turn",
      continuesAfterToolResponse: false,
      connect: async (p) => {
        order.push("connect");
        return f.realtime.connect(p);
      }
    };
    const cs = new CallSession({
      brief,
      guardrails,
      telephony,
      realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    expect(order).toEqual(["attach", "connect"]);
  });

  it("closes the attached media stream if realtime.connect fails (no pacer/listener leak)", async () => {
    const f = fakes();
    const mediaClose = vi.fn();
    f.handle.close = mediaClose;
    // attachMediaStream runs before connect (see ordering above); if connect
    // then rejects, the already-live media stream must be torn down.
    const realtime: RealtimeProvider = {
      name: "boom",
      audio: fakeRealtimeAudio,
      openingDelivery: "turn",
      continuesAfterToolResponse: false,
      connect: async () => {
        throw new Error("connect failed");
      }
    };
    const cs = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    await cs.originate();
    await expect(cs.attach("call-1", new FakeSocket())).rejects.toThrow(/connect failed/);
    expect(mediaClose).toHaveBeenCalledTimes(1);
    // A failed connect must leave no phase behind — enterPhase("speaking")
    // runs only after the realtime session is assigned, which this path
    // never reaches.
    expect([...cs.phases]).toEqual([]);
  });

  it("bridges inbound audio through the codec into the realtime session", async () => {
    const f = fakes();
    const cs = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: f.realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    f.emitInbound({ encoding: MULAW_8K, data: Buffer.from([1, 2, 3]) });
    expect(f.sentAudio).toHaveLength(1);
    expect(f.sentAudio[0].encoding).toEqual(PCM_16K);
  });

  it("bridges model audio out through the codec to the media handle", async () => {
    const f = fakes();
    const cs = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: f.realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    f.emitModelAudio({ encoding: PCM_24K, data: Buffer.from([9, 9]) });
    expect(f.sentOutbound).toHaveLength(1);
    expect(f.sentOutbound[0].encoding).toEqual(MULAW_8K);
  });

  it("clears the telephony outbound buffer on barge-in", async () => {
    const f = fakes();
    const cs = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: f.realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    f.emitInterrupted();
    expect(f.clearOutbound).toHaveBeenCalledOnce();
  });

  it("collects the transcript", async () => {
    const f = fakes();
    const cs = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: f.realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    await cs.originate();
    const handle = await cs.attach("call-1", new FakeSocket());
    f.emitTranscript({ speaker: "model", text: "hello", isFinal: true });
    expect(handle.transcript).toEqual([{ speaker: "model", text: "hello", isFinal: true }]);
  });
});

// ---------------------------------------------------------------------------
// execution.dial.sendDigits — carrier-side DTMF at origination.
//
// Twilio plays `SendDigits` itself, out-of-band, before any media stream
// exists — distinct from the model's in-band `press_digits` tool, which goes
// out over the codec once the call is live. `originate()` is the ONLY place
// this value is read; nothing else in CallSession touches it.
// ---------------------------------------------------------------------------
describe("CallSession.originate — execution.dial passthrough", () => {
  it("passes execution.dial.sendDigits through to the telephony provider's originate params", async () => {
    const f = fakes();
    let captured: Parameters<TelephonyProvider["originate"]>[0] | undefined;
    const telephony: TelephonyProvider = {
      ...f.telephony,
      originate: async (params) => {
        captured = params;
        return f.telephony.originate(params);
      }
    };
    const cs = new CallSession({
      brief,
      guardrails,
      telephony,
      realtime: f.realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model",
      execution: { dial: { sendDigits: "1234#" } }
    });
    await cs.originate();

    expect(captured?.sendDigits).toBe("1234#");
  });

  it("omits sendDigits when no execution.dial block is declared", async () => {
    const f = fakes();
    let captured: Parameters<TelephonyProvider["originate"]>[0] | undefined;
    const telephony: TelephonyProvider = {
      ...f.telephony,
      originate: async (params) => {
        captured = params;
        return f.telephony.originate(params);
      }
    };
    const cs = new CallSession({
      brief,
      guardrails,
      telephony,
      realtime: f.realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    await cs.originate();

    expect(captured?.sendDigits).toBeUndefined();
  });

  it("never hands sendDigits to onDiagnostic — the only sink CallSession itself can write a log line to", async () => {
    const f = fakes();
    const diagnostics: string[] = [];
    const cs = new CallSession({
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
      execution: { dial: { sendDigits: "9999secretpasscode9999" } },
      onDiagnostic: (message) => diagnostics.push(message)
    });
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());
    f.emitInterrupted();

    expect(diagnostics.join("\n")).not.toContain("secretpasscode");
  });
});

describe("CallSessionHandle.stop", () => {
  it("closes the media stream and the realtime session exactly once", async () => {
    const f = fakes();
    // Reuse the file's fake telephony/realtime providers, but swap in spies for
    // the close() methods of the handle/session they hand back — this is the
    // minimal wiring needed since `fakes()`'s own handle/session use plain
    // no-op closes (M2-deferred: stop() had no dedicated coverage).
    const mediaClose = vi.fn();
    const sessionClose = vi.fn(async () => {});
    f.handle.close = mediaClose;
    f.session.close = sessionClose;

    const cs = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: f.realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    await cs.originate();
    const handle = await cs.attach("call-1", new FakeSocket());

    await handle.stop("remote");

    expect(mediaClose).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tool-channel and closure scaffolding.
//
// Richer than `fakes()` above because these tests need to observe SIDE EFFECTS
// on the carrier (dtmf sent, hangups issued, media closed) and to drive the
// model's half of a tool call, not just its audio.
// ---------------------------------------------------------------------------

import type { CallExecution, ToolResult } from "../src/execution.js";
import type { ToolCallRequest } from "../src/types.js";

interface ToolFakeOpts {
  execution?: CallExecution;
  dtmfThrows?: boolean;
  hangupThrows?: boolean;
  /** Injectable clock — see `CallSessionParams.now`. Only the DTMF
   * barge-in tests need control over it; everything else is fine with the
   * default (`Date.now`), which never lands inside a burst window because
   * the fake burst durations are sub-millisecond. */
  now?: () => number;
  onDiagnostic?: (message: string) => void;
  /** The provider's `continuesAfterToolResponse`. Off by default: most of
   * these tests model a vendor that says nothing after a tool answer. */
  continuesAfterToolResponse?: boolean;
}

async function attachWith(opts: ToolFakeOpts) {
  const sentDtmf: string[] = [];
  const order: string[] = [];
  const hangups: Array<{ callId: string; reason?: string }> = [];
  const responses: Array<{ id: string; result: ToolResult }> = [];
  let clearCount = 0;
  let mediaClosed = false;
  /** Model audio that reached the carrier, in ms. `fakeConvert` relabels
   * without touching bytes, so a model frame arrives still 48 bytes a
   * millisecond (pcm@24000) — and still zero-filled, which is how it is told
   * apart from `fakeCodec`'s tones (ASCII digits). */
  let outboundAudioMs = 0;
  let realtimeCb!: RealtimeConnectParams["callbacks"];
  let connectParams!: RealtimeConnectParams;

  const session: RealtimeSession = {
    sendOpeningTrigger: () => {},
    sendAudio: () => {},
    notifyActivityEnd: () => {},
    sendToolResponse: (call: ToolCallRequest, result: ToolResult) =>
      responses.push({ id: call.id, result }),
    close: async () => {}
  };
  const realtime: RealtimeProvider = {
    name: "fake-realtime",
    audio: fakeRealtimeAudio,
    openingDelivery: "turn",
    continuesAfterToolResponse: opts.continuesAfterToolResponse ?? false,
    connect: async (p) => {
      connectParams = p;
      realtimeCb = p.callbacks;
      return session;
    }
  };
  const handle: MediaStreamHandle = {
    sendOutboundAudio: (f: AudioFrame) => {
      // The press path is the audio path now, so a carrier failure is a failure
      // to write audio.
      if (opts.dtmfThrows) throw new Error("carrier refused");
      if (f.data.length > 0 && f.data.every((b) => b === 0)) {
        outboundAudioMs += f.data.length / 48;
        return;
      }
      sentDtmf.push(f.data.toString("utf8"));
    },
    clearOutboundBuffer: () => {
      clearCount += 1;
    },
    drainOutbound: async () => {
      order.push("drain");
      return { confirmed: true, waitedMs: 0 };
    },
    close: () => {
      mediaClosed = true;
    }
  };
  const telephony: TelephonyProvider = {
    name: "fake-telephony",
    mediaEncoding: MULAW_8K,
    originate: async () => ({ providerCallId: "CA1", status: "queued" }),
    buildAnswerResponse: () => ({ contentType: "text/xml", body: "<Response/>" }),
    verifyWebhookSignature: () => true,
    attachMediaStream: () => handle,
    hangup: async (callId, reason) => {
      order.push("hangup");
      if (opts.hangupThrows) throw new Error("carrier refused");
      hangups.push({ callId, reason });
    }
  };

  const cs = new CallSession({
    brief,
    guardrails,
    telephony,
    realtime,
    codec: fakeCodec,
    convert: fakeConvert,
    canConvert: fakeCanConvert,
    from: "+15555550142",
    answerWebhookUrl: "https://voice.example.com/twilio/answer",
    model: "test-model",
    ...(opts.execution ? { execution: opts.execution } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {})
  });
  const handleOut = await cs.attach("CA1", new FakeSocket());

  return {
    session: cs,
    handle: handleOut,
    sentDtmf,
    order,
    get clearCount() {
      return clearCount;
    },
    emitInterrupted: () => realtimeCb.onInterrupted(),
    /** One frame of model audio, `ms` long (default one 20 ms frame). */
    emitModelAudio: (ms = 20) =>
      realtimeCb.onAudio({ encoding: PCM_24K, data: Buffer.alloc(ms * 48) }),
    get outboundAudioMs() {
      return outboundAudioMs;
    },
    emitTranscript: (e: { speaker: "model" | "caller"; text: string; isFinal: boolean }) =>
      connectParams.callbacks.onTranscript(e),
    finishTurn: () => connectParams.callbacks.onTurnComplete?.(),
    /** Wait until `order` contains `step`, or give up. A fixed number of
     * microtask yields breaks the moment the code under test grows an await —
     * which is exactly what happened when the hangup path learned to wait for
     * the model's turn. */
    settledOn: async (step: string): Promise<void> => {
      for (let i = 0; i < 200 && !order.includes(step); i++)
        await new Promise((r) => setTimeout(r, 1));
    },
    hangups,
    responses,
    get mediaClosed() {
      return mediaClosed;
    },
    connectParams,
    fireToolCall: async (call: ToolCallRequest) => {
      realtimeCb.onToolCall?.(call);
      // handleToolCall is async and fired void-style from the provider callback;
      // yield twice so its awaited carrier call settles before we assert.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    fireRealtimeClose: async (reason: string) => {
      realtimeCb.onClose(reason);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    emitCallerTranscript: (text: string) =>
      realtimeCb.onTranscript({ speaker: "caller", text, isFinal: true })
  };
}

describe("CallSession tool channel", () => {
  it("declares no tools when no execution block is given", async () => {
    const f = await attachWith({});
    expect(f.connectParams.tools ?? []).toEqual([]);
  });

  it("declares exactly the tools its execution blocks imply", async () => {
    const f = await attachWith({
      execution: { ivr: { maxPresses: 3, allowedDigits: "0123456789", onUnrecognized: "zeroOut" } }
    });
    expect(f.connectParams.tools?.map((t) => t.name)).toEqual(["press_digits"]);
  });

  it("passes turnDetection.silenceMs through to connect", async () => {
    const f = await attachWith({ execution: { turnDetection: { silenceMs: 1800 } } });
    expect(f.connectParams.turnDetection?.silenceDurationMs).toBe(1800);
  });

  it("an authorized press goes out as AUDIO on the open stream, and answers ok", async () => {
    const f = await attachWith({
      execution: { ivr: { maxPresses: 3, allowedDigits: "0123456789", onUnrecognized: "zeroOut" } }
    });
    await f.fireToolCall({ id: "c1", name: "press_digits", args: { digits: "1" } });
    expect(f.sentDtmf).toEqual(["1"]);
    expect(f.responses).toEqual([{ id: "c1", result: "ok" }]);
  });

  it("a refused press puts nothing on the stream", async () => {
    const f = await attachWith({
      execution: { ivr: { maxPresses: 3, allowedDigits: "12", onUnrecognized: "zeroOut" } }
    });
    await f.fireToolCall({ id: "c1", name: "press_digits", args: { digits: "9" } });
    expect(f.sentDtmf).toEqual([]);
    expect(f.responses).toEqual([{ id: "c1", result: "refused: digit not permitted" }]);
  });

  it("a carrier failure answers 'could not send' and leaves budget intact", async () => {
    const f = await attachWith({
      execution: { ivr: { maxPresses: 1, allowedDigits: "0123456789", onUnrecognized: "zeroOut" } },
      dtmfThrows: true
    });
    await f.fireToolCall({ id: "c1", name: "press_digits", args: { digits: "1" } });
    expect(f.responses).toEqual([{ id: "c1", result: "refused: could not send" }]);
    expect(f.session.gateSnapshot().dtmf).toEqual({ pressed: [], refused: 1 });
  });

  it("a non-string digits argument is refused as invalid arguments", async () => {
    const f = await attachWith({
      execution: { ivr: { maxPresses: 3, allowedDigits: "0123456789", onUnrecognized: "zeroOut" } }
    });
    await f.fireToolCall({ id: "c1", name: "press_digits", args: { digits: 1 } });
    expect(f.sentDtmf).toEqual([]);
    expect(f.responses).toEqual([{ id: "c1", result: "refused: invalid arguments" }]);
  });

  it("an unknown status on record_outcome is refused as invalid arguments", async () => {
    const f = await attachWith({
      execution: { outcome: { fields: [{ name: "x", description: "d" }] } }
    });
    await f.fireToolCall({
      id: "c1",
      name: "record_outcome",
      args: { status: "maybe", fields: {} }
    });
    expect(f.responses).toEqual([{ id: "c1", result: "refused: invalid arguments" }]);
  });

  it("an array passed as fields is refused as invalid arguments", async () => {
    const f = await attachWith({
      execution: { outcome: { fields: [{ name: "x", description: "d" }] } }
    });
    await f.fireToolCall({
      id: "c1",
      name: "record_outcome",
      args: { status: "completed", fields: [] }
    });
    expect(f.responses).toEqual([{ id: "c1", result: "refused: invalid arguments" }]);
  });

  it("record_outcome keeps declared fields and reports them in the snapshot", async () => {
    const f = await attachWith({
      execution: { outcome: { fields: [{ name: "x", description: "d" }] } }
    });
    await f.fireToolCall({
      id: "c1",
      name: "record_outcome",
      args: { status: "completed", fields: { x: "v", nope: "z" } }
    });
    expect(f.session.gateSnapshot().outcome?.fields).toEqual({ x: "v" });
  });

  it("a tool call naming an undeclared tool is refused", async () => {
    const f = await attachWith({});
    await f.fireToolCall({ id: "c1", name: "press_digits", args: { digits: "1" } });
    expect(f.responses).toEqual([{ id: "c1", result: "refused: tool not available" }]);
  });

  it("a tool call naming a tool that does not exist at all is refused", async () => {
    const f = await attachWith({});
    await f.fireToolCall({ id: "c1", name: "transfer_funds", args: {} });
    expect(f.responses).toEqual([{ id: "c1", result: "refused: tool not available" }]);
  });
});

describe("DTMF barge-in protection", () => {
  // Found on a REAL live call, not by any of the 742 tests that were passing
  // at the time. The realtime model's VAD fires onInterrupted continuously
  // while an IVR talks, and onInterrupted used to clear the outbound buffer
  // unconditionally — including a keypress still mid-press, which is ~3
  // seconds of tone audio on a real call (DEFAULT_TONE_MS/DEFAULT_GAP_MS,
  // @parley/audio's dtmf.ts). The agent pressed a 12-digit meeting ID three
  // times and never reached the passcode prompt. Every existing DTMF test
  // asserted tones were GENERATED, never that they SURVIVED an interrupt —
  // these are the ones that would have caught it.
  const digits = "55501234567#";
  const ivrExecution: CallExecution = {
    ivr: { maxPresses: 20, allowedDigits: "0123456789#", onUnrecognized: "zeroOut" }
  };

  it("a barge-in that lands while a DTMF burst is in flight does not clear the outbound buffer", async () => {
    const t = 1_000_000;
    const f = await attachWith({ execution: ivrExecution, now: () => t });

    await f.fireToolCall({ id: "c1", name: "press_digits", args: { digits } });
    // The press itself must still have gone out as audio — this fix must not
    // make barge-in protection come at the cost of the press never sending.
    expect(f.sentDtmf).toEqual([digits]);

    // No time has passed since the press: exactly the window an IVR's own
    // talking falls inside on a real call.
    f.emitInterrupted();

    expect(f.clearCount).toBe(0);
  });

  it("a barge-in after the burst's window has elapsed still clears — barge-in must keep working", async () => {
    let t = 1_000_000;
    const f = await attachWith({ execution: ivrExecution, now: () => t });

    await f.fireToolCall({ id: "c1", name: "press_digits", args: { digits } });

    // Comfortably past the burst's own duration (well under 1ms for this
    // fake codec) plus its margin.
    t += 1_000;
    f.emitInterrupted();

    expect(f.clearCount).toBe(1);
  });

  it("a barge-in with no DTMF ever pressed still clears immediately — unaffected by this fix", async () => {
    const f = await attachWith({});
    f.emitInterrupted();
    expect(f.clearCount).toBe(1);
  });
});

describe("CallSession closure", () => {
  it("hangs up exactly once when a timer and the model race", async () => {
    const f = await attachWith({ execution: { limits: { maxDurationSeconds: 30 } } });
    await Promise.all([f.session.endCall("model"), f.session.endCall("durationCap")]);
    expect(f.hangups).toHaveLength(1);
  });

  it("records the FIRST reason when two exits race", async () => {
    const f = await attachWith({ execution: { limits: { maxDurationSeconds: 30 } } });
    await f.session.endCall("model");
    await f.session.endCall("durationCap");
    expect(f.handle.endedBy).toBe("model");
  });

  it("the duration cap hangs up on its own", async () => {
    vi.useFakeTimers();
    try {
      const f = await attachWith({ execution: { limits: { maxDurationSeconds: 30 } } });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.hangups).toHaveLength(1);
      expect(f.handle.endedBy).toBe("durationCap");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the silence cap is reset by caller speech and fires only after real silence", async () => {
    vi.useFakeTimers();
    try {
      const f = await attachWith({
        execution: { limits: { maxDurationSeconds: 600, maxSilenceSeconds: 20 } }
      });
      await vi.advanceTimersByTimeAsync(15_000);
      f.emitCallerTranscript("still here");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.hangups).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(f.hangups).toHaveLength(1);
      expect(f.handle.endedBy).toBe("silenceCap");
    } finally {
      vi.useRealTimers();
    }
  });

  it("no timers are armed when no limits block is given", async () => {
    vi.useFakeTimers();
    try {
      const f = await attachWith({});
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(f.hangups).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a dropped realtime session hangs up the carrier leg", async () => {
    const f = await attachWith({});
    await f.fireRealtimeClose("code=1011");
    expect(f.hangups).toHaveLength(1);
    expect(f.handle.endedBy).toBe("error");
  });

  it("a carrier hangup failure still closes the media socket and records error", async () => {
    const f = await attachWith({ hangupThrows: true });
    await f.session.endCall("model");
    expect(f.mediaClosed).toBe(true);
    expect(f.handle.endedBy).toBe("error");
  });

  it("stop() routes through the single exit and reports a remote end", async () => {
    const f = await attachWith({});
    await f.handle.stop();
    expect(f.handle.endedBy).toBe("remote");
    // A remote hangup means the far end already dropped: do not call the
    // carrier asking it to hang up a call that is over.
    expect(f.hangups).toHaveLength(0);
  });

  it("an end_call tool call reaches the carrier through the guarded exit", async () => {
    const f = await attachWith({ execution: { closure: { requireOutcomeBeforeEnd: false } } });
    await f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    // An accepted end_call answers with the closing literal (2026-09-30), not a bare "ok".
    expect(f.responses).toEqual([{ id: "c1", result: "ok — say nothing more" }]);
    expect(f.hangups).toHaveLength(1);
    expect(f.handle.endedBy).toBe("model");
  });
});

/**
 * From the first live call that completed its objective: the model confirmed
 * the booking, said goodbye, called end_call — and the caller heard the last
 * sentence cut off mid-word.
 *
 * Outbound audio is paced at 20ms a frame and the carrier buffers its own
 * playout, so at the moment end_call fires the goodbye is still in flight.
 * Hanging up then is hanging up over yourself.
 */
describe("a model hangup waits for its own goodbye to land", () => {
  it("drains outbound audio before telling the carrier to hang up", async () => {
    const f = await attachWith({ execution: { closure: { requireOutcomeBeforeEnd: false } } });
    await f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    expect(f.order).toEqual(["drain", "hangup"]);
  });

  it("does not wait when a cap or an error ended the call", async () => {
    // A duration cap firing is not a goodbye, and a dead transport has nothing
    // left to play. Neither is worth holding a live, billing call open for.
    const f = await attachWith({ execution: { limits: { maxDurationSeconds: 30 } } });
    await f.session.endCall("durationCap");
    expect(f.order).toEqual(["hangup"]);
  });
});

/**
 * A five-second drain still truncated a goodbye on a live call, and the reason
 * is upstream of the queue: the model emits `end_call` as part of a turn whose
 * AUDIO has not been generated yet. Draining our own buffer cannot wait for
 * frames nobody has sent us.
 */
describe("a model hangup waits for the turn it was asked in to finish", () => {
  it("does not drain or hang up while the model is still generating", async () => {
    const f = await attachWith({ execution: { closure: { requireOutcomeBeforeEnd: false } } });
    f.emitTranscript({ speaker: "model", text: "Thanks for your help,", isFinal: false });
    const ending = f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(f.order).toEqual([]); // still speaking
    f.finishTurn();
    await ending;
    await f.settledOn("hangup");
    expect(f.order).toEqual(["drain", "hangup"]);
  });

  it("hangs up straight away when no turn is in flight", async () => {
    const f = await attachWith({ execution: { closure: { requireOutcomeBeforeEnd: false } } });
    await f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    expect(f.order).toEqual(["drain", "hangup"]);
  });

  // A turn is in flight from its first audio frame, not only from its first
  // transcript fragment. Gemini's outputTranscription can trail the audio it
  // describes, so a turn opened by transcript alone looked idle while its
  // goodbye was already playing — and an end_call in that window drained and
  // hung up over the rest of it.
  it("waits on a turn whose audio has started but whose transcript has not", async () => {
    vi.useFakeTimers();
    try {
      const f = await attachWith({ execution: { closure: { requireOutcomeBeforeEnd: false } } });
      f.emitModelAudio();
      void f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
      // Short of the turn-finish ceiling: only the turn's own end may release it.
      await vi.advanceTimersByTimeAsync(3_900);
      expect(f.order).toEqual([]);
      f.finishTurn();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.order).toEqual(["drain", "hangup"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an audio-opened turn on turnComplete, and counts it once", async () => {
    const f = await attachWith({ execution: { closure: { requireOutcomeBeforeEnd: false } } });
    f.emitModelAudio();
    f.emitTranscript({ speaker: "model", text: "Goodbye.", isFinal: false });
    f.emitModelAudio();
    f.finishTurn();
    expect(f.session.modelTurnsCompleted).toBe(1);
    // Audio did not change how the words are stored: one coalesced entry.
    expect(f.handle.transcript).toEqual([{ speaker: "model", text: "Goodbye.", isFinal: true }]);
    // The turn is closed, so a hangup now does not wait.
    await f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    expect(f.order).toEqual(["drain", "hangup"]);
  });
});

/**
 * Wire-observed on both shipped vendors (t20 wire logs): the model emits the
 * tool call FIRST, and the goodbye is spoken by the turn that continues after
 * the tool answer. Deepgram's `end_call` at 160123 ms had its goodbye audio
 * start ~190 ms after the `FunctionCallResponse` and run 6.7 s. With no turn
 * open at the moment of the call, `endCall` drained an empty queue and hung
 * up over the whole goodbye.
 */
describe("a tool answer on a continuing provider opens the turn the goodbye is spoken in", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Frames every 20ms for `ms`, the way a vendor streams a spoken sentence. */
  async function speakFor(f: Awaited<ReturnType<typeof attachWith>>, ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 20) {
      f.emitModelAudio();
      await vi.advanceTimersByTimeAsync(20);
    }
  }

  const closure = { closure: { requireOutcomeBeforeEnd: false } };

  it("end_call answered with no turn open waits for the continuation, then drains, then hangs up", async () => {
    vi.useFakeTimers();
    const f = await attachWith({ execution: closure, continuesAfterToolResponse: true });
    void f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    await vi.advanceTimersByTimeAsync(0);
    // An accepted end_call answers with the closing literal (2026-09-30), not a bare "ok".
    expect(f.responses).toEqual([{ id: "c1", result: "ok — say nothing more" }]);
    // No audio yet, and no turn was open when the call landed: the goodbye
    // does not exist yet. Nothing may drain or hang up.
    await vi.advanceTimersByTimeAsync(300);
    expect(f.order).toEqual([]);

    await speakFor(f, 1_000);
    expect(f.order).toEqual([]);
    f.finishTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.order).toEqual(["drain", "hangup"]);
    expect(f.handle.endedBy).toBe("model");
  });

  it("a six-second goodbye streamed every 20ms does not hit the four-second turn-finish cap", async () => {
    vi.useFakeTimers();
    const f = await attachWith({ execution: closure, continuesAfterToolResponse: true });
    void f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    await vi.advanceTimersByTimeAsync(300);
    // A goodbye this long is one long sentence: without its words, the
    // after-end_call audio cap would cut it at three seconds (see below).
    f.emitTranscript({
      speaker: "model",
      text: "Thank you so much for all of your help today, and goodbye for now, have a lovely afternoon!",
      isFinal: false
    });
    await speakFor(f, 6_000);
    // Well past four seconds since the wait began: each frame re-armed it.
    expect(f.order).toEqual([]);
    f.finishTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.order).toEqual(["drain", "hangup"]);
  });

  it("stops waiting four seconds after the last frame when no turn end ever comes", async () => {
    vi.useFakeTimers();
    const f = await attachWith({ execution: closure, continuesAfterToolResponse: true });
    void f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    await speakFor(f, 2_000);
    await vi.advanceTimersByTimeAsync(3_900);
    expect(f.order).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.order).toEqual(["drain", "hangup"]);
  });

  it("stops waiting at the fifteen-second ceiling even while audio keeps coming", async () => {
    vi.useFakeTimers();
    const f = await attachWith({ execution: closure, continuesAfterToolResponse: true });
    void f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    // One goodbye sentence long enough to outlast the ceiling, so neither the
    // after-end_call audio cap nor its goodbye hold ends the wait first.
    f.emitTranscript({
      speaker: "model",
      text: `Goodbye${", and thank you".repeat(13)}.`,
      isFinal: false
    });
    await speakFor(f, 14_900);
    expect(f.order).toEqual([]);
    await speakFor(f, 200);
    expect(f.order).toEqual(["drain", "hangup"]);
  });

  it("a provider that does not continue still hangs up straight away", async () => {
    const f = await attachWith({ execution: closure, continuesAfterToolResponse: false });
    await f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    expect(f.order).toEqual(["drain", "hangup"]);
  });

  it("an answered press opens the continuation without counting a turn or touching the transcript", async () => {
    const f = await attachWith({
      execution: {
        ivr: { maxPresses: 3, allowedDigits: "0123456789", onUnrecognized: "zeroOut" },
        ...closure
      },
      continuesAfterToolResponse: true
    });
    await f.fireToolCall({ id: "p1", name: "press_digits", args: { digits: "1" } });
    expect(f.session.modelTurnsCompleted).toBe(0);
    expect(f.handle.transcript).toEqual([]);
    f.emitTranscript({ speaker: "model", text: "Pressed one.", isFinal: false });
    f.finishTurn();
    expect(f.session.modelTurnsCompleted).toBe(1);
    expect(f.handle.transcript).toEqual([
      { speaker: "model", text: "Pressed one.", isFinal: true }
    ]);
    // The continuation closed, so a hangup now does not wait on it.
    await f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    f.finishTurn();
    await f.settledOn("hangup");
    expect(f.order).toEqual(["drain", "hangup"]);
  });
});

/**
 * Live, Gemini 3.8 (call CAb4dc604bca32abd05a6a4b009faa65be): the callee
 * confirmed, the model called `record_outcome` then `end_call`, and then said
 * "Thank you very much. Goodbye. I have successfully rescheduled the
 * appointment." — the last sentence narration to the principal, heard by the
 * callee. Once `end_call` is accepted, audio stops reaching the line once the
 * goodbye has been spoken, or after AFTER_END_CALL_AUDIO_CAP_MS of audio.
 *
 * The model's transcript text LEADS its audio (measured: 0.72–1.14 s on
 * Gemini; a whole sentence on Deepgram), so the stop is a hold of audio after
 * the goodbye's words complete, not an instant cut.
 */
describe("after end_call, audio stops at the goodbye", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const closure = { closure: { requireOutcomeBeforeEnd: false } };

  async function acceptedEndCall() {
    vi.useFakeTimers();
    const diagnostics: string[] = [];
    const f = await attachWith({
      execution: closure,
      continuesAfterToolResponse: true,
      onDiagnostic: (m) => diagnostics.push(m)
    });
    void f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    await vi.advanceTimersByTimeAsync(0);
    const cut = () => diagnostics.filter((d) => d.startsWith("after end_call:"));
    return { f, cut };
  }

  async function speak(f: Awaited<ReturnType<typeof attachWith>>, ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 20) {
      f.emitModelAudio();
      await vi.advanceTimersByTimeAsync(20);
    }
  }

  it("goodbye then narration: the narration's audio is not forwarded and the hangup proceeds", async () => {
    const { f, cut } = await acceptedEndCall();
    // Text first, as Gemini sends it: the words lead the audio they describe.
    f.emitTranscript({ speaker: "model", text: "Thank you very ", isFinal: false });
    await speak(f, 760);
    f.emitTranscript({ speaker: "model", text: "much. Goodbye.", isFinal: false });
    await speak(f, 1_000);
    f.emitTranscript({
      speaker: "model",
      text: " I have successfully rescheduled",
      isFinal: false
    });
    await speak(f, 3_000);
    // 760 ms when the goodbye's words completed, then the 1500 ms hold.
    expect(f.outboundAudioMs).toBe(2_260);
    expect(f.order).toEqual(["drain", "hangup"]);
    expect(f.handle.endedBy).toBe("model");
    expect(cut()).toEqual(["after end_call: stopped at goodbye at +2260ms"]);
  });

  it("does not wait for the model's turn to complete", async () => {
    const { f } = await acceptedEndCall();
    f.emitTranscript({ speaker: "model", text: "Goodbye. I have", isFinal: false });
    await speak(f, 1_600);
    expect(f.order).toEqual(["drain", "hangup"]);
  });

  it("with no goodbye, stops at three seconds of audio", async () => {
    const { f, cut } = await acceptedEndCall();
    f.emitTranscript({
      speaker: "model",
      text: "I have rescheduled the appointment.",
      isFinal: false
    });
    await speak(f, 5_000);
    expect(f.outboundAudioMs).toBe(3_000);
    expect(f.order).toEqual(["drain", "hangup"]);
    expect(cut()).toEqual(["after end_call: stopped at 3000 ms cap at +3000ms"]);
  });

  it("measures the cap in audio, not wall-clock time", async () => {
    const { f } = await acceptedEndCall();
    // Two seconds of audio delivered in a burst, then three seconds of quiet.
    for (let i = 0; i < 100; i += 1) f.emitModelAudio();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.order).toEqual([]);
    await speak(f, 2_000);
    expect(f.outboundAudioMs).toBe(3_000);
  });

  it("detects a goodbye split across transcript fragments", async () => {
    const { f, cut } = await acceptedEndCall();
    f.emitTranscript({ speaker: "model", text: "Good", isFinal: false });
    f.emitTranscript({ speaker: "model", text: "bye.", isFinal: false });
    await speak(f, 4_000);
    expect(f.outboundAudioMs).toBe(1_500);
    expect(cut()).toEqual(["after end_call: stopped at goodbye at +1500ms"]);
  });

  it("counts bye and bye-bye, case-insensitive", async () => {
    for (const text of ["Okay, BYE!", "Bye-bye now."]) {
      const { f } = await acceptedEndCall();
      f.emitTranscript({ speaker: "model", text, isFinal: false });
      await speak(f, 4_000);
      expect(f.outboundAudioMs).toBe(1_500);
      vi.useRealTimers();
    }
  });

  it("does not count bye inside another word", async () => {
    const { f, cut } = await acceptedEndCall();
    f.emitTranscript({ speaker: "model", text: "We can bypass the queue.", isFinal: false });
    await speak(f, 4_000);
    expect(f.outboundAudioMs).toBe(3_000);
    expect(cut()).toEqual(["after end_call: stopped at 3000 ms cap at +3000ms"]);
  });

  it("does not stop on a goodbye sentence that has not finished", async () => {
    const { f } = await acceptedEndCall();
    f.emitTranscript({ speaker: "model", text: "Goodbye and thank", isFinal: false });
    await speak(f, 2_000);
    // Neither the hold (no sentence has completed) nor the cap yet.
    expect(f.order).toEqual([]);
    expect(f.outboundAudioMs).toBe(2_000);
  });

  it("holds a long goodbye sentence for as long as its words take to say", async () => {
    // Deepgram sends a sentence's text as its audio starts, so its lead is the
    // whole sentence: 54 characters is 4860 ms at 90 ms a character.
    const { f } = await acceptedEndCall();
    f.emitTranscript({
      speaker: "model",
      text: "Thank you so much for all of your help today, goodbye!",
      isFinal: true
    });
    await speak(f, 4_000);
    expect(f.order).toEqual([]);
    f.finishTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.outboundAudioMs).toBe(4_000);
    expect(f.order).toEqual(["drain", "hangup"]);
  });

  it("before end_call, nothing changes", async () => {
    vi.useFakeTimers();
    const diagnostics: string[] = [];
    const f = await attachWith({
      execution: closure,
      continuesAfterToolResponse: true,
      onDiagnostic: (m) => diagnostics.push(m)
    });
    f.emitTranscript({ speaker: "model", text: "Goodbye. I have rescheduled it.", isFinal: false });
    await speak(f, 5_000);
    expect(f.outboundAudioMs).toBe(5_000);
    expect(f.order).toEqual([]);
    expect(diagnostics.filter((d) => d.startsWith("after end_call:"))).toEqual([]);
  });

  it("a goodbye said before end_call (Deepgram-style) hangs up as before", async () => {
    vi.useFakeTimers();
    const diagnostics: string[] = [];
    const f = await attachWith({
      execution: closure,
      continuesAfterToolResponse: true,
      onDiagnostic: (m) => diagnostics.push(m)
    });
    f.emitTranscript({ speaker: "model", text: "Thanks, Brenda. Goodbye.", isFinal: true });
    await speak(f, 800);
    void f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    await vi.advanceTimersByTimeAsync(0);
    // The rest of that goodbye's audio, still streaming after the answer.
    await speak(f, 1_200);
    f.finishTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.outboundAudioMs).toBe(2_000);
    expect(f.order).toEqual(["drain", "hangup"]);
    expect(diagnostics.filter((d) => d.startsWith("after end_call:"))).toEqual([]);
  });

  it("a provider that does not continue is untouched", async () => {
    const f = await attachWith({ execution: closure, continuesAfterToolResponse: false });
    await f.fireToolCall({ id: "c1", name: "end_call", args: { reason: "done" } });
    expect(f.order).toEqual(["drain", "hangup"]);
  });
});

/**
 * A real call produced 157 transcript events for a 13-turn conversation: the
 * model's speech arrives as word-level fragments, so the call record — the
 * durable artifact anyone reads afterwards — was unreadable as a record.
 */
describe("the transcript stores turns, not word fragments", () => {
  it("coalesces a model turn into one entry", async () => {
    const f = await attachWith({});
    f.emitTranscript({ speaker: "model", text: "Hello Caitlyn,", isFinal: false });
    f.emitTranscript({ speaker: "model", text: " I'd", isFinal: false });
    f.emitTranscript({ speaker: "model", text: " like to book.", isFinal: false });
    f.finishTurn();
    expect(f.handle.transcript).toEqual([
      { speaker: "model", text: "Hello Caitlyn, I'd like to book.", isFinal: true }
    ]);
  });

  it("keeps caller utterances whole and separate", async () => {
    const f = await attachWith({});
    f.emitTranscript({ speaker: "model", text: "Hello.", isFinal: false });
    f.emitTranscript({ speaker: "caller", text: "Hi, this is Caitlyn.", isFinal: false });
    f.emitTranscript({ speaker: "model", text: "I'd like to book.", isFinal: false });
    f.finishTurn();
    expect(f.handle.transcript.map((e) => e.text)).toEqual([
      "Hello.",
      "Hi, this is Caitlyn.",
      "I'd like to book."
    ]);
  });

  it("drops the empty markers the provider synthesises", async () => {
    // They are not reliable turn boundaries — the provider only emits them when
    // it did not already see a final — and as entries they are pure noise.
    const f = await attachWith({});
    f.emitTranscript({ speaker: "model", text: "", isFinal: true });
    f.emitTranscript({ speaker: "model", text: "Hello.", isFinal: false });
    f.finishTurn();
    expect(f.handle.transcript).toEqual([{ speaker: "model", text: "Hello.", isFinal: true }]);
  });

  it("leaves a turn cut off by the end of the call marked unfinished", async () => {
    const f = await attachWith({});
    f.emitTranscript({ speaker: "model", text: "Thanks for your h", isFinal: false });
    expect(f.handle.transcript).toEqual([
      { speaker: "model", text: "Thanks for your h", isFinal: false }
    ]);
  });
});

/**
 * `onCallEvent` was `() => {}`. Every lifecycle event the telephony layer
 * synthesises — `admitted` and `removed` among them, both added with tests of
 * their own on the provider side — reached a function that dropped it, so the
 * carrier's whole lifecycle channel existed with no consumer at all.
 */
describe("carrier lifecycle events", () => {
  it("routes an admitted event into the session rather than dropping it", async () => {
    const diagnostics: string[] = [];
    const f = fakes();
    const session = new CallSession({
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
      onDiagnostic: (m) => diagnostics.push(m)
    });
    await session.attach("CA1", new FakeSocket());
    f.emitCallEvent({ type: "admitted" });
    expect(diagnostics).toContain("carrier lifecycle: admitted");
  });

  it("records answeredBy from a lifecycle event delivered by the media layer", async () => {
    const f = fakes();
    const session = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: f.realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    await session.attach("CA1", new FakeSocket());
    f.emitCallEvent({ type: "answered", answeredBy: "machine" });
    expect(session.answeredBy).toBe("machine");
  });

  // Twilio emits `removed` on EVERY socket close, normal hangups included,
  // because it cannot tell a host removal from a hangup. Saying so is the
  // whole point: an EndReason fed from this would label every completed call
  // "removed", which is why no such EndReason exists.
  it("reports an unattributable removal as what it is, and ends nothing", async () => {
    const diagnostics: string[] = [];
    const f = fakes();
    const session = new CallSession({
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
      onDiagnostic: (m) => diagnostics.push(m)
    });
    const handle = await session.attach("CA1", new FakeSocket());
    f.emitCallEvent({ type: "removed", by: "unknown" });
    expect(diagnostics.some((d) => d.includes("cannot tell a host removal from a hangup"))).toBe(
      true
    );
    expect(handle.endedBy).toBeUndefined();
  });
});

describe("CallSession.meetingBrief", () => {
  it("reads execution.meeting.brief through unchanged", () => {
    const f = fakes();
    const meetingBrief = {
      title: "Roadmap Sync",
      topic: "Q4 scope.",
      role: "product lead",
      track: ["engineering"]
    };
    const session = new CallSession({
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
      execution: {
        meeting: {
          consent: { phrase: "go ahead and take notes", timeoutSeconds: 180, onTimeout: "hangUp" },
          brief: meetingBrief
        }
      }
    });
    expect(session.meetingBrief).toEqual(meetingBrief);
  });

  it("is undefined for a declared meeting whose caller supplied no brief", () => {
    const f = fakes();
    const session = new CallSession({
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
      execution: {
        meeting: {
          consent: { phrase: "go ahead and take notes", timeoutSeconds: 180, onTimeout: "hangUp" }
        }
      }
    });
    expect(session.meetingBrief).toBeUndefined();
  });

  it("is undefined for an ordinary (non-meeting) call — indistinguishable from 'meeting, no brief'", () => {
    const f = fakes();
    const session = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: f.realtime,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    expect(session.meetingBrief).toBeUndefined();
  });
});

// A live call's goodbye was said twice and nothing on disk said when each
// tool call, model turn and caller final landed. These lines are the timeline:
// content-free (names, result kinds, offsets) so they are safe to keep.
describe("CallSession timing diagnostics", () => {
  const closure: CallExecution = {
    closure: { requireOutcomeBeforeEnd: true },
    outcome: { fields: [{ name: "x", description: "d" }] }
  };

  it("logs each routed tool call with its result kind and ms since start, never arguments", async () => {
    let t = 5_000;
    const lines: string[] = [];
    const f = await attachWith({
      execution: closure,
      now: () => t,
      onDiagnostic: (m) => lines.push(m)
    });
    t += 1_200;
    await f.fireToolCall({
      id: "c1",
      name: "record_outcome",
      args: { status: "completed", fields: { x: "hunter2" } }
    });
    t += 300;
    await f.fireToolCall({ id: "c2", name: "end_call", args: { reason: "done" } });
    const timing = lines.filter((l) => l.startsWith("tool "));
    expect(timing).toEqual([
      "tool record_outcome → recorded at +1200ms",
      "tool end_call → ok at +1500ms"
    ]);
    expect(lines.join("\n")).not.toContain("hunter2");
  });

  it("names a refusal by its kind, up to the first dash", async () => {
    let t = 0;
    const lines: string[] = [];
    const f = await attachWith({
      execution: closure,
      now: () => t,
      onDiagnostic: (m) => lines.push(m)
    });
    t += 40;
    await f.fireToolCall({ id: "c1", name: "end_call", args: {} });
    expect(lines).toContain("tool end_call → refused: record the outcome first at +40ms");
  });

  it("logs model turn completion and the caller's final transcript without their text", async () => {
    let t = 100;
    const lines: string[] = [];
    const f = await attachWith({ now: () => t, onDiagnostic: (m) => lines.push(m) });
    t += 700;
    f.emitCallerTranscript("my card is 4111");
    t += 900;
    f.finishTurn();
    expect(lines).toContain("caller final at +700ms");
    expect(lines).toContain("model turn complete at +1600ms");
    expect(lines.join("\n")).not.toContain("4111");
  });
});

/**
 * The ToolGate's "they have not confirmed" rule decides on two facts only
 * CallSession sees: the model producing AUDIO, and the far end speaking. Audio,
 * not the model's transcript — Gemini's output transcription can trail the
 * audio it describes, and the audio frames precede the tool call.
 *
 * Far-end speech is ANY non-empty far-end transcript, final or not. Gemini
 * 3.8's input transcription never sets `finished`: on the 2026-10-01 incident
 * call every caller entry was `isFinal: false` and no `caller final` line was
 * logged on either Gemini call that day. Keyed to `isFinal`, the gate would
 * have refused every completed record on Gemini.
 */
describe("CallSession feeds the confirmation gate", () => {
  const exec: CallExecution = {
    closure: { requireOutcomeBeforeEnd: true },
    outcome: { fields: [{ name: "x", description: "d" }] }
  };
  const notConfirmed: ToolResult =
    "refused: they have not confirmed what you just said — read the arrangement back exactly as they said it, wait for their yes, then record; do not end the call";
  const record = {
    id: "r",
    name: "record_outcome",
    args: { status: "completed", fields: { x: "v" } }
  };

  it("model audio after their last words refuses a completed record", async () => {
    const f = await attachWith({ execution: exec });
    f.emitTranscript({ speaker: "caller", text: "How about Monday at 9:26?", isFinal: true });
    f.emitModelAudio();
    await f.fireToolCall(record);
    expect(f.responses).toEqual([{ id: "r", result: notConfirmed }]);
    expect(f.session.gateSnapshot().outcome).toBeUndefined();
  });

  it("their words after the model's audio let it through — final or not (Gemini never marks finals)", async () => {
    const f = await attachWith({ execution: exec });
    f.emitModelAudio();
    f.emitTranscript({ speaker: "caller", text: "Yes, that works.", isFinal: false });
    await f.fireToolCall(record);
    expect(f.session.gateSnapshot().outcome?.status).toBe("completed");
  });

  it("an empty far-end transcript is not speech", async () => {
    const f = await attachWith({ execution: exec });
    f.emitModelAudio();
    f.emitTranscript({ speaker: "caller", text: "", isFinal: true });
    await f.fireToolCall(record);
    expect(f.responses).toEqual([{ id: "r", result: notConfirmed }]);
  });

  it("the model's transcript is not audio: text alone does not arm the gate", async () => {
    const f = await attachWith({ execution: exec });
    f.emitTranscript({ speaker: "caller", text: "Yes.", isFinal: true });
    f.emitTranscript({ speaker: "model", text: "Great.", isFinal: true });
    await f.fireToolCall(record);
    expect(f.session.gateSnapshot().outcome?.status).toBe("completed");
  });

  it("logs the refusal by kind on the timing line", async () => {
    let t = 0;
    const lines: string[] = [];
    const f = await attachWith({
      execution: exec,
      now: () => t,
      onDiagnostic: (m) => lines.push(m)
    });
    f.emitModelAudio();
    t += 700;
    await f.fireToolCall(record);
    expect(lines).toContain(
      "tool record_outcome → refused: they have not confirmed what you just said at +700ms"
    );
  });
});
