import { describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { OPENING_TRIGGER } from "../src/render.js";
import type { Brief } from "../src/brief.js";
import type {
  AudioCodec,
  AudioFrame,
  MediaStreamHandle,
  RealtimeConnectParams,
  RealtimeProvider,
  RealtimeSession,
  TelephonyProvider,
  WebSocketLike
} from "../src/types.js";

const brief: Brief = {
  to: "+14155550123",
  persona: "You are Ada.",
  objective: "Confirm the booking.",
  facts: ["Party of four."]
};

const guardrails: readonly string[] = ["Rule one.", "Rule two."];

// Pass-through fake codec — this test verifies wiring, not DSP.
const fakeCodec: AudioCodec = {
  decodeInbound: (f: AudioFrame) => ({ encoding: "pcm16k", data: f.data }),
  encodeOutbound: (f: AudioFrame) => ({ encoding: "mulaw8k", data: f.data })
};

function fakes() {
  let realtimeCb!: RealtimeConnectParams["callbacks"];
  const sentAudio: AudioFrame[] = [];
  const openingTrigger = vi.fn();
  const session: RealtimeSession = {
    sendOpeningTrigger: openingTrigger,
    sendAudio: (f) => sentAudio.push(f),
    notifyActivityEnd: () => {},
    close: async () => {}
  };
  let connectParams!: RealtimeConnectParams;
  const realtime: RealtimeProvider = {
    name: "fake-realtime",
    connect: async (p) => {
      connectParams = p;
      realtimeCb = p.callbacks;
      return session;
    }
  };

  let onInbound!: (f: AudioFrame) => void;
  const sentOutbound: AudioFrame[] = [];
  const clearOutbound = vi.fn();
  const handle: MediaStreamHandle = {
    sendOutboundAudio: (f) => sentOutbound.push(f),
    clearOutboundBuffer: clearOutbound,
    close: () => {}
  };
  const telephony: TelephonyProvider = {
    name: "fake-telephony",
    originate: async () => ({ providerCallId: "call-1", status: "queued" }),
    buildAnswerResponse: () => ({ contentType: "text/xml", body: "<Response/>" }),
    verifyWebhookSignature: () => true,
    attachMediaStream: (p) => {
      onInbound = p.onInboundAudio;
      return handle;
    },
    sendDtmf: async () => {},
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
    emitInbound: (f: AudioFrame) => onInbound(f),
    emitModelAudio: (f: AudioFrame) => realtimeCb.onAudio(f),
    emitInterrupted: () => realtimeCb.onInterrupted(),
    emitTranscript: (e: Parameters<RealtimeConnectParams["callbacks"]["onTranscript"]>[0]) =>
      realtimeCb.onTranscript(e),
    getConnectParams: () => connectParams
  };
}

const fakeSocket: WebSocketLike = { send: () => {}, on: () => {}, close: () => {} };

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
    await cs.attach("call-1", fakeSocket);

    expect(f.getConnectParams().systemInstruction).toBe(
      "You are Ada.\n\nConfirm the booking. Party of four.\n\nRule one. Rule two."
    );
    expect(f.getConnectParams().responseModality).toBe("audio");
    expect(f.openingTrigger).toHaveBeenCalledWith(OPENING_TRIGGER);
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
    await cs.attach("call-1", fakeSocket);

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
    await expect(cs.attach("call-1", fakeSocket)).rejects.toThrow(/connect failed/);
    expect(mediaClose).toHaveBeenCalledTimes(1);
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
    await cs.attach("call-1", fakeSocket);

    f.emitInbound({ encoding: "mulaw8k", data: Buffer.from([1, 2, 3]) });
    expect(f.sentAudio).toHaveLength(1);
    expect(f.sentAudio[0].encoding).toBe("pcm16k");
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
    await cs.attach("call-1", fakeSocket);

    f.emitModelAudio({ encoding: "pcm24k", data: Buffer.from([9, 9]) });
    expect(f.sentOutbound).toHaveLength(1);
    expect(f.sentOutbound[0].encoding).toBe("mulaw8k");
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
    await cs.attach("call-1", fakeSocket);

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
    const handle = await cs.attach("call-1", fakeSocket);
    f.emitTranscript({ speaker: "model", text: "hello", isFinal: true });
    expect(handle.transcript).toEqual([{ speaker: "model", text: "hello", isFinal: true }]);
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
    const handle = await cs.attach("call-1", fakeSocket);

    await handle.stop("done");

    expect(mediaClose).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
});
