import { describe, expect, it, vi } from "vitest";
import {
  MULAW_8K,
  PCM_16K,
  PCM_24K,
  encodingEquals,
  formatEncoding,
  planOpening,
  type AudioFrame,
  type RealtimeConnectParams,
  type RealtimeSession,
  type RealtimeSessionCallbacks,
  type ToolCallRequest,
  type ToolResult
} from "@parley/core";
import { providerWireFakes, type ProviderWireFake } from "./helpers/provider-wire-fakes.js";

/** A string no vendor setup message would contain by accident, so counting
 * the messages that carry it counts where `systemInstruction` went. */
const INSTRUCTION = "CONFORMANCE-PERSONA: you are a test persona with exactly one purpose.";

function makeCallbacks() {
  return {
    onAudio: vi.fn<(frame: AudioFrame) => void>(),
    onInterrupted: vi.fn<() => void>(),
    onTranscript: vi.fn(),
    onToolCall: vi.fn<(call: ToolCallRequest) => void>(),
    onTurnComplete: vi.fn<() => void>(),
    onError: vi.fn(),
    onClose: vi.fn()
  } satisfies RealtimeSessionCallbacks;
}

function paramsFor(callbacks: RealtimeSessionCallbacks): RealtimeConnectParams {
  return {
    model: "test-model",
    systemInstruction: INSTRUCTION,
    responseModality: "audio",
    callbacks
  };
}

async function connected(fake: ProviderWireFake) {
  const callbacks = makeCallbacks();
  const pending = fake.provider.connect(paramsFor(callbacks));
  fake.wire.ready();
  const session: RealtimeSession = await pending;
  return { session, callbacks };
}

describe.each(providerWireFakes())("realtime provider conformance: $name", (fake) => {
  const { provider, wire } = fake;

  it("sends systemInstruction in exactly one outbound message, and that message is first", async () => {
    const { session } = await connected(fake);
    session.sendOpeningTrigger("Begin the call naturally now.");
    session.sendAudio({ encoding: provider.audio.accepts[0]!, data: Buffer.from([1, 2, 3]) });

    const carrying = wire.sent().filter((m) => JSON.stringify(m).includes(INSTRUCTION));
    expect(carrying).toHaveLength(1);
    expect(wire.sent()[0]).toBe(carrying[0]);
  });

  it("never sends a mid-session re-instruction or a verbatim-speech message", async () => {
    const { session } = await connected(fake);
    session.sendOpeningTrigger("Begin the call naturally now.");
    session.sendToolResponse({ id: "t1", name: "record_outcome", args: {} }, "ok");
    for (const forbidden of [
      "InjectAgentMessage",
      "UpdatePrompt",
      "UpdateThink",
      "UpdateSpeak",
      "UpdateListen"
    ]) {
      expect(JSON.stringify(wire.sent())).not.toContain(forbidden);
    }
  });

  /** A provider's own guard on `sendOpeningTrigger` and the delivery it
   * declares must agree: every line `planOpening` would send it is accepted
   * and reaches the wire once, and nothing else is sent in its place. */
  it.each([false, true])(
    "accepts exactly the opening planOpening sends it (meeting=%s)",
    async (isMeeting) => {
      const declared = provider.openingDelivery;
      const shape =
        typeof declared === "string" ? declared : isMeeting ? declared.meeting : declared.twoParty;
      expect(["turn", "prompt"]).toContain(shape);
      const { session } = await connected(fake);
      const plan = planOpening(provider.openingDelivery, isMeeting);
      const before = wire.sent().length;
      if (plan.trigger !== undefined) session.sendOpeningTrigger(plan.trigger);
      expect(wire.sent().length).toBe(before + (plan.trigger === undefined ? 0 : 1));
      if (plan.trigger !== undefined) {
        expect(JSON.stringify(wire.sent().at(-1))).toContain(plan.trigger);
      }
    }
  );

  it("exposes exactly the narrow session surface", async () => {
    const { session } = await connected(fake);
    expect(Object.keys(session).sort()).toEqual(
      ["close", "notifyActivityEnd", "sendAudio", "sendOpeningTrigger", "sendToolResponse"].sort()
    );
  });

  it("delivers audio in the encoding it declares it emits", async () => {
    const { callbacks } = await connected(fake);
    wire.serverSays("audio", Buffer.from([9, 8, 7, 6]));
    expect(callbacks.onAudio).toHaveBeenCalledOnce();
    const frame = callbacks.onAudio.mock.calls[0]![0];
    expect(encodingEquals(frame.encoding, provider.audio.emits)).toBe(true);
    expect([...frame.data]).toEqual([9, 8, 7, 6]);
  });

  it("accepts exactly the encodings it declares and rejects every other", async () => {
    const { session } = await connected(fake);
    for (const encoding of [MULAW_8K, PCM_16K, PCM_24K]) {
      const before = wire.sent().length;
      const send = () => session.sendAudio({ encoding, data: Buffer.from([1, 2, 3, 4]) });
      if (provider.audio.accepts.some((a) => encodingEquals(a, encoding))) {
        expect(send, formatEncoding(encoding)).not.toThrow();
        expect(wire.sent().length, formatEncoding(encoding)).toBe(before + 1);
      } else {
        expect(send, formatEncoding(encoding)).toThrow();
        expect(wire.sent().length, formatEncoding(encoding)).toBe(before);
      }
    }
  });

  // Deepgram reports the turn complete only after `wire.turnSettleMs` of quiet
  // following its AgentAudioDone (DEEPGRAM_TURN_QUIET_MS), so this advances
  // fake time by that much — and, where it is non-zero, also asserts nothing
  // fired before it. Gemini's settle time is 0: unchanged.
  it("maps the vendor's end-of-turn signal to onTurnComplete", async () => {
    vi.useFakeTimers();
    try {
      const { callbacks } = await connected(fake);
      expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
      wire.serverSays("turnComplete");
      if (wire.turnSettleMs > 0) {
        await vi.advanceTimersByTimeAsync(wire.turnSettleMs - 1);
        expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(callbacks.onTurnComplete).toHaveBeenCalledOnce();
      expect(callbacks.onInterrupted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps the vendor's barge-in signal to onInterrupted", async () => {
    const { callbacks } = await connected(fake);
    wire.serverSays("interrupted");
    expect(callbacks.onInterrupted).toHaveBeenCalledOnce();
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
  });

  it("maps a tool request to onToolCall with parsed arguments", async () => {
    const { callbacks } = await connected(fake);
    wire.serverSays("toolCall", {
      id: "call-1",
      name: "record_outcome",
      args: { outcome: "booked", nested: { n: 2 } }
    });
    expect(callbacks.onToolCall).toHaveBeenCalledOnce();
    expect(callbacks.onToolCall).toHaveBeenCalledWith({
      id: "call-1",
      name: "record_outcome",
      args: { outcome: "booked", nested: { n: 2 } }
    });
  });

  it("answers a tool call with exactly the ToolResult string, addressed to that call", async () => {
    const { session } = await connected(fake);
    const call: ToolCallRequest = { id: "call-7", name: "press_digits", args: { digits: "1" } };
    const result: ToolResult = "refused: digit not permitted";
    session.sendToolResponse(call, result);
    expect(wire.toolResponses()).toEqual([{ id: "call-7", name: "press_digits", result }]);
    // The argument the model supplied never rides back to it.
    expect(JSON.stringify(wire.sent().slice(1))).not.toContain('"digits"');
  });

  it("rejects connect on a fatal error before the session is ready", async () => {
    const callbacks = makeCallbacks();
    const pending = provider.connect(paramsFor(callbacks));
    const settled = expect(pending).rejects.toThrow();
    wire.serverSays("fatalError");
    await settled;
  });
});
