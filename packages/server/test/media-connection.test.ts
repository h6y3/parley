import { describe, expect, it, vi } from "vitest";
import {
  type AudioCodec,
  type RealtimeProvider,
  type TelephonyProvider,
  type WebSocketLike
} from "@parley/core";
import { CallSession } from "@parley/core";
import { PendingSessions } from "../src/pending-sessions.js";
import { handleMediaConnection, type CompletedCallRecord } from "../src/media-connection.js";

const codec: AudioCodec = {
  decodeInbound: (f) => f,
  encodeOutbound: (f) => f,
  dtmfTones: () => ({ encoding: "mulaw8k", data: Buffer.alloc(0) })
};

function fakeSocket(): WebSocketLike & { closed: boolean; triggerClose: () => void } {
  const closeListeners: Array<(...args: unknown[]) => void> = [];
  return {
    send: () => {},
    on(event, listener) {
      if (event === "close") closeListeners.push(listener);
    },
    close() {
      (this as { closed: boolean }).closed = true;
    },
    closed: false,
    triggerClose() {
      for (const listener of closeListeners) listener();
    }
  };
}

function sessionWithAttachSpy(stop = vi.fn(async () => {})) {
  const attach = vi.fn(async () => ({ transcript: [], stop }));
  const realtime: RealtimeProvider = { name: "fake", connect: vi.fn() };
  const telephony: TelephonyProvider = {
    name: "fake",
    originate: async () => ({ providerCallId: "CA1", status: "queued" }),
    buildAnswerResponse: () => ({ contentType: "text/xml", body: "" }),
    verifyWebhookSignature: () => true,
    attachMediaStream: () => ({
      sendOutboundAudio: () => {},
      clearOutboundBuffer: () => {},
      drainOutbound: async () => ({ confirmed: true, waitedMs: 0 }),
      close: () => {}
    }),
    hangup: async () => {}
  };
  const session = new CallSession({
    brief: { to: "+1", persona: "p", objective: "o", facts: [] },
    guardrails: [],
    telephony,
    realtime,
    codec,
    from: "+1",
    answerWebhookUrl: "https://h/a",
    model: "m"
  });
  (session as unknown as { attach: typeof attach }).attach = attach;
  return { session, attach, stop };
}

describe("handleMediaConnection", () => {
  it("attaches the matching pending session to the socket", async () => {
    const pending = new PendingSessions();
    const { session, attach } = sessionWithAttachSpy();
    pending.set("CA1", session);
    const socket = fakeSocket();
    const ok = await handleMediaConnection("CA1", socket, { pending });
    expect(ok).toBe(true);
    expect(attach).toHaveBeenCalledWith("CA1", socket);
  });

  it("closes the socket and returns false when no session matches", async () => {
    const pending = new PendingSessions();
    const socket = fakeSocket();
    const ok = await handleMediaConnection("CA-unknown", socket, { pending });
    expect(ok).toBe(false);
    expect(socket.closed).toBe(true);
  });

  it("stops the handle and evicts the pending session when the socket closes after attach", async () => {
    const pending = new PendingSessions();
    const stop = vi.fn(async () => {});
    const { session } = sessionWithAttachSpy(stop);
    pending.set("CA1", session);
    const socket = fakeSocket();

    const ok = await handleMediaConnection("CA1", socket, { pending });
    expect(ok).toBe(true);

    socket.triggerClose();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(pending.get("CA1")).toBeUndefined();
  });

  it("emits a completed-call record with the captured transcript when the socket closes", async () => {
    const pending = new PendingSessions();
    const transcript = [{ speaker: "caller" as const, text: "next week is packed", isFinal: true }];
    const { session } = sessionWithAttachSpy();
    (
      session as unknown as {
        attach: () => Promise<{ transcript: typeof transcript; stop: () => Promise<void> }>;
      }
    ).attach = async () => ({ transcript, stop: async () => {} });
    pending.set("CA1", session);
    const socket = fakeSocket();
    const onCallCompleted = vi.fn();

    const ok = await handleMediaConnection("CA1", socket, { pending, onCallCompleted });
    expect(ok).toBe(true);

    socket.triggerClose();

    expect(onCallCompleted).toHaveBeenCalledTimes(1);
    expect(onCallCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "CA1", transcript })
    );
  });

  it("evicts exactly once when the socket closes before attach resolves (lifecycle race)", async () => {
    const pending = new PendingSessions();
    const stop = vi.fn(async () => {});
    const { session } = sessionWithAttachSpy(stop);

    let resolveAttach!: (handle: { transcript: never[]; stop: typeof stop }) => void;
    const deferredAttach = new Promise<{ transcript: never[]; stop: typeof stop }>((resolve) => {
      resolveAttach = resolve;
    });
    (
      session as unknown as { attach: () => Promise<{ transcript: never[]; stop: typeof stop }> }
    ).attach = () => deferredAttach;

    pending.set("CA1", session);
    const socket = fakeSocket();

    const connectionPromise = handleMediaConnection("CA1", socket, { pending });

    // Socket closes while attach() is still in flight — the close listener
    // must already be registered, and eviction from `pending` must happen
    // immediately even though the handle (and thus stop()) isn't ready yet.
    socket.triggerClose();
    expect(stop).not.toHaveBeenCalled();
    expect(pending.get("CA1")).toBeUndefined();

    resolveAttach({ transcript: [], stop });
    const ok = await connectionPromise;

    expect(ok).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(pending.get("CA1")).toBeUndefined();
  });
});

describe("CompletedCallRecord contents", () => {
  it("carries endedBy, answeredBy, outcome and dtmf from the session", async () => {
    const records: CompletedCallRecord[] = [];
    const pending = new PendingSessions();
    const session = {
      attach: async () => ({
        transcript: [],
        endedBy: "model" as const,
        stop: async () => {}
      }),
      answeredBy: "human" as const,
      gateSnapshot: () => ({
        outcome: { status: "completed" as const, fields: { x: "v" }, recordedAt: "T" },
        dtmf: { pressed: ["1"], refused: 0 }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    pending.set("CA1", session);

    let onClose!: () => void;
    const socket = {
      send: () => {},
      on: (e: string, l: () => void) => {
        if (e === "close") onClose = l;
      },
      close: () => {}
    };
    await handleMediaConnection("CA1", socket, {
      pending,
      onCallCompleted: (r) => records.push(r)
    });
    onClose();

    expect(records[0].endedBy).toBe("model");
    expect(records[0].answeredBy).toBe("human");
    expect(records[0].outcome?.status).toBe("completed");
    expect(records[0].dtmf).toEqual({ pressed: ["1"], refused: 0 });
  });

  it("omits outcome, answeredBy and dtmf entirely when the session recorded none", async () => {
    const records: CompletedCallRecord[] = [];
    const pending = new PendingSessions();
    const session = {
      attach: async () => ({ transcript: [], endedBy: undefined, stop: async () => {} }),
      answeredBy: undefined,
      gateSnapshot: () => ({})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    pending.set("CA1", session);

    let onClose!: () => void;
    const socket = {
      send: () => {},
      on: (e: string, l: () => void) => {
        if (e === "close") onClose = l;
      },
      close: () => {}
    };
    await handleMediaConnection("CA1", socket, {
      pending,
      onCallCompleted: (r) => records.push(r)
    });
    onClose();

    expect(records[0].outcome).toBeUndefined();
    expect(records[0].answeredBy).toBeUndefined();
    expect(records[0].dtmf).toBeUndefined();
    // A socket closing with no recorded reason IS the far end hanging up.
    expect(records[0].endedBy).toBe("remote");
  });
});
