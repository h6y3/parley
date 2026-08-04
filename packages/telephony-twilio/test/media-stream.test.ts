import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioFrame, CallLifecycleEvent, WebSocketLike } from "@parley/core";
import { attachTwilioMediaStream, outboundFramesDue } from "../src/media-stream.js";

/** A fake WebSocketLike that lets a test push inbound messages and capture
 * what the handle sends back. */
function makeFakeSocket() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {
    message: [],
    close: [],
    error: []
  };
  const sent: string[] = [];
  const socket: WebSocketLike = {
    send: (d) => {
      sent.push(typeof d === "string" ? d : d.toString("utf8"));
    },
    on: (event, listener) => {
      listeners[event].push(listener);
    },
    close: vi.fn()
  };
  const emit = (event: "message" | "close" | "error", data: unknown) =>
    listeners[event].forEach((l) => l(data));
  return { socket, sent, emit, closeSpy: socket.close as ReturnType<typeof vi.fn> };
}

const START = JSON.stringify({
  event: "start",
  start: {
    streamSid: "MZ123",
    callSid: "CA123",
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }
  },
  streamSid: "MZ123"
});

const decodePayload = (raw: string) => Buffer.from(JSON.parse(raw).media.payload, "base64");

// The outbound pacer is a 20 ms setInterval. Fake timers make its cadence
// deterministic: nothing is sent until a tick, so inbound/lifecycle tests that
// never advance the clock see no stray silence frames, and outbound tests drive
// exactly the ticks they assert on.
describe("attachTwilioMediaStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("decodes inbound media into a mulaw8k AudioFrame", () => {
    const { socket, emit } = makeFakeSocket();
    const frames: AudioFrame[] = [];
    attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: (f) => frames.push(f),
      onCallEvent: () => {}
    });
    emit("message", START);
    const payload = Buffer.from([0xff, 0x7f, 0x00]).toString("base64");
    emit(
      "message",
      JSON.stringify({ event: "media", media: { track: "inbound", payload }, streamSid: "MZ123" })
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].encoding).toBe("mulaw8k");
    expect([...frames[0].data]).toEqual([0xff, 0x7f, 0x00]);
  });

  it("paces a short outbound buffer into one 160-byte μ-law frame with the captured streamSid", () => {
    const { socket, sent, emit } = makeFakeSocket();
    const handle = attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: () => {},
      onCallEvent: () => {}
    });
    emit("message", START);
    handle.sendOutboundAudio({ encoding: "mulaw8k", data: Buffer.from([0x01, 0x02]) });
    vi.advanceTimersByTime(20); // one pacer tick
    const msg = JSON.parse(sent[0]);
    expect(msg.event).toBe("media");
    expect(msg.streamSid).toBe("MZ123");
    const payload = decodePayload(sent[0]);
    expect(payload.length).toBe(160); // exactly 20 ms of 8 kHz μ-law
    expect([...payload.subarray(0, 2)]).toEqual([0x01, 0x02]); // real audio...
    expect(payload[2]).toBe(0xff); // ...then μ-law silence padding
  });

  it("drains a large outbound buffer across successive pacer ticks in 160-byte frames", () => {
    const { socket, sent, emit } = makeFakeSocket();
    const handle = attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: () => {},
      onCallEvent: () => {}
    });
    emit("message", START);
    handle.sendOutboundAudio({ encoding: "mulaw8k", data: Buffer.alloc(400, 0x10) }); // 2 full frames + an 80-byte tail
    vi.advanceTimersByTime(20);
    expect(decodePayload(sent[0]).length).toBe(160);
    vi.advanceTimersByTime(20);
    expect(decodePayload(sent[1]).length).toBe(160);
    vi.advanceTimersByTime(20);
    const tail = decodePayload(sent[2]);
    expect(tail.length).toBe(160);
    expect([...tail.subarray(0, 80)].every((b) => b === 0x10)).toBe(true); // remaining real audio
    expect(tail[80]).toBe(0xff); // padded to a full frame with silence
  });

  it("sends μ-law silence as keep-alive while idle", () => {
    const { socket, sent, emit } = makeFakeSocket();
    attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: () => {},
      onCallEvent: () => {}
    });
    emit("message", START);
    vi.advanceTimersByTime(20);
    const payload = decodePayload(sent[0]);
    expect(payload.length).toBe(160);
    expect([...payload].every((b) => b === 0xff)).toBe(true);
  });

  it("clearOutboundBuffer flushes the queue and emits a Twilio clear (barge-in)", () => {
    const { socket, sent, emit } = makeFakeSocket();
    const handle = attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: () => {},
      onCallEvent: () => {}
    });
    emit("message", START);
    handle.sendOutboundAudio({ encoding: "mulaw8k", data: Buffer.alloc(320, 0x10) });
    handle.clearOutboundBuffer();
    expect(JSON.parse(sent[0])).toEqual({ event: "clear", streamSid: "MZ123" });
    // The queued audio was dropped: the next tick yields silence, not 0x10 audio.
    vi.advanceTimersByTime(20);
    expect([...decodePayload(sent[1])].every((b) => b === 0xff)).toBe(true);
  });

  it("does not send outbound audio before the stream starts (no streamSid yet)", () => {
    const { socket, sent } = makeFakeSocket();
    const handle = attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: () => {},
      onCallEvent: () => {}
    });
    handle.sendOutboundAudio({ encoding: "mulaw8k", data: Buffer.from([0x01]) });
    vi.advanceTimersByTime(60); // several ticks — pacer stays quiet until streamSid is known
    expect(sent).toHaveLength(0);
  });

  it("captures streamSid from a media frame when the start frame was missed (fallback)", () => {
    const { socket, sent, emit } = makeFakeSocket();
    const handle = attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: () => {},
      onCallEvent: () => {}
    });
    // No START — only a media frame arrives; its streamSid must still enable outbound.
    emit(
      "message",
      JSON.stringify({ event: "media", media: { payload: "AA==" }, streamSid: "MZ999" })
    );
    handle.sendOutboundAudio({ encoding: "mulaw8k", data: Buffer.from([0x01, 0x02]) });
    vi.advanceTimersByTime(20);
    expect(JSON.parse(sent[0]).streamSid).toBe("MZ999");
  });

  it("drops outbound audio that would exceed the runaway-backlog cap", () => {
    const { socket, sent, emit } = makeFakeSocket();
    const handle = attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: () => {},
      onCallEvent: () => {}
    });
    emit("message", START);
    // A single frame larger than the ~60s cap is dropped, not buffered.
    handle.sendOutboundAudio({ encoding: "mulaw8k", data: Buffer.alloc(60 * 8000 + 1, 0x10) });
    vi.advanceTimersByTime(20);
    expect([...decodePayload(sent[0])].every((b) => b === 0xff)).toBe(true); // silence — the frame was dropped
  });

  it("rejects a non-mulaw8k outbound frame (encoding contract)", () => {
    const { socket, emit } = makeFakeSocket();
    const handle = attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: () => {},
      onCallEvent: () => {}
    });
    emit("message", START);
    expect(() =>
      handle.sendOutboundAudio({ encoding: "pcm16k", data: Buffer.from([0x01]) })
    ).toThrow(/mulaw8k/);
  });

  it("maps start→answered and stop→completed lifecycle events", () => {
    const { socket, emit } = makeFakeSocket();
    const events: CallLifecycleEvent[] = [];
    attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: () => {},
      onCallEvent: (e) => events.push(e)
    });
    emit("message", START);
    emit(
      "message",
      JSON.stringify({
        event: "media",
        media: { payload: "AA==", timestamp: "2000" },
        streamSid: "MZ123"
      })
    );
    emit("message", JSON.stringify({ event: "stop", streamSid: "MZ123" }));
    expect(events[0]).toEqual({ type: "answered" });
    expect(events[1]).toEqual({ type: "completed", durationSeconds: 2 });
  });

  it("ignores malformed JSON frames without throwing", () => {
    const { socket, emit } = makeFakeSocket();
    const frames: AudioFrame[] = [];
    attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: (f) => frames.push(f),
      onCallEvent: () => {}
    });
    expect(() => emit("message", "{not json")).not.toThrow();
    expect(frames).toHaveLength(0);
  });

  it("catches up when the pacer clock jumps (delayed/coalesced OS timer)", () => {
    // Drive Date.now() independently of the fake interval so a SINGLE tick can
    // observe a large elapsed time (a delayed/coalesced timer), which fake
    // timers alone can't simulate (advancing fires each 20ms tick separately).
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const { socket, sent, emit } = makeFakeSocket();
      const handle = attachTwilioMediaStream({
        callId: "CA123",
        socket,
        onInboundAudio: () => {},
        onCallEvent: () => {}
      });
      emit("message", START);
      handle.sendOutboundAudio({ encoding: "mulaw8k", data: Buffer.alloc(800, 0x10) }); // 5 frames' worth
      // First tick establishes the epoch (elapsed 0) and sends frame #1.
      vi.advanceTimersByTime(20);
      expect(sent).toHaveLength(1);
      // Now 60ms of real time has passed but only ONE more tick fires: it must
      // send the 3-frame backlog (frames #2,#3,#4), not just one.
      clock = 1_000_060;
      vi.advanceTimersByTime(20);
      expect(sent).toHaveLength(4);
      expect([...decodePayload(sent[3]).subarray(0, 10)].every((b) => b === 0x10)).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("stops the pacer on close", () => {
    const { socket, sent, emit, closeSpy } = makeFakeSocket();
    const handle = attachTwilioMediaStream({
      callId: "CA123",
      socket,
      onInboundAudio: () => {},
      onCallEvent: () => {}
    });
    emit("message", START);
    handle.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    const before = sent.length;
    vi.advanceTimersByTime(100); // no more frames after close
    expect(sent.length).toBe(before);
  });
});

describe("outboundFramesDue (wall-clock pacing math)", () => {
  it("emits frame #1 at elapsed 0", () => {
    expect(outboundFramesDue(0, 0)).toEqual({ send: 1, resyncTo: null });
  });

  it("steady state: one frame per 20ms interval", () => {
    expect(outboundFramesDue(20, 1)).toEqual({ send: 1, resyncTo: null });
    expect(outboundFramesDue(40, 2)).toEqual({ send: 1, resyncTo: null });
  });

  it("sends nothing when the tick is early (not yet due)", () => {
    expect(outboundFramesDue(10, 1)).toEqual({ send: 0, resyncTo: null }); // <1 interval since frame #1
  });

  it("catches up the backlog when a tick was delayed", () => {
    // 60ms elapsed, only 1 frame sent → owe frames #2,#3,#4 = send 3.
    expect(outboundFramesDue(60, 1)).toEqual({ send: 3, resyncTo: null });
  });

  it("resyncs instead of bursting after an over-long suspend", () => {
    // 10s elapsed, 5 frames sent → ~500 frames behind (> MAX_CATCHUP 25):
    // send 1 and jump framesSent to due-1 so we don't dump the whole gap.
    const due = Math.floor(10_000 / 20) + 1; // 501
    expect(outboundFramesDue(10_000, 5)).toEqual({ send: 1, resyncTo: due - 1 });
  });

  it("sends exactly the catch-up ceiling at the boundary", () => {
    // 25 frames behind is still a catch-up (not a resync).
    expect(outboundFramesDue(20 * 25, 1)).toEqual({ send: 25, resyncTo: null });
  });

  it("resyncs one frame past the ceiling", () => {
    // 26 frames behind (one past MAX_CATCHUP) → resync, not a 26-frame burst.
    const elapsed = 20 * 26;
    const due = Math.floor(elapsed / 20) + 1; // 27
    expect(outboundFramesDue(elapsed, 1)).toEqual({ send: 1, resyncTo: due - 1 });
  });
});
