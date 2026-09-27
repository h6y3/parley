import { describe, expect, it, vi } from "vitest";
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
  fakeCodec,
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
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    expect(f.getConnectParams().systemInstruction).toBe(
      "You are Ada.\n\nConfirm the booking. Party of four.\n\nRule one. Rule two."
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
}

async function attachWith(opts: ToolFakeOpts) {
  const sentDtmf: string[] = [];
  const order: string[] = [];
  const hangups: Array<{ callId: string; reason?: string }> = [];
  const responses: Array<{ id: string; result: ToolResult }> = [];
  let clearCount = 0;
  let mediaClosed = false;
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
    from: "+15555550142",
    answerWebhookUrl: "https://voice.example.com/twilio/answer",
    model: "test-model",
    ...(opts.execution ? { execution: opts.execution } : {}),
    ...(opts.now ? { now: opts.now } : {})
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
    expect(f.responses).toEqual([{ id: "c1", result: "ok" }]);
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
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model"
    });
    expect(session.meetingBrief).toBeUndefined();
  });
});
