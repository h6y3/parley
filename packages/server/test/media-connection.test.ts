import { describe, expect, it, vi } from "vitest";
import {
  type AudioCodec,
  type FrameConverter,
  type RealtimeProvider,
  type RealtimeSessionCallbacks,
  type TelephonyProvider,
  type WebSocketLike
} from "@parley/core";
import { CallSession, MULAW_8K } from "@parley/core";
import { createHostAllowlist, createNumberAllowlist } from "../src/allowlist.js";
import { PendingSessions } from "../src/pending-sessions.js";
import { handleMediaConnection, type CompletedCallRecord } from "../src/media-connection.js";
import { handleHttpRequest } from "../src/request-handler.js";

// Relabels without touching bytes: these tests verify wiring, not DSP.
const convert: FrameConverter = (f, to) => ({ encoding: to, data: f.data });
const canConvert = (): boolean => true;
const codec: AudioCodec = {
  dtmfTones: () => ({ encoding: MULAW_8K, data: Buffer.alloc(0) })
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
  const realtime: RealtimeProvider = {
    name: "fake",
    audio: { accepts: [MULAW_8K], emits: MULAW_8K },
    openingDelivery: "turn",
    continuesAfterToolResponse: false,
    connect: vi.fn()
  };
  const telephony: TelephonyProvider = {
    name: "fake",
    mediaEncoding: MULAW_8K,
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
    convert,
    canConvert,
    from: "+1",
    answerWebhookUrl: "https://h/a",
    model: "m"
  });
  (session as unknown as { attach: typeof attach }).attach = attach;
  return { session, attach, stop };
}

/** The record is now built AFTER the session is torn down, and teardown is
 * asynchronous — so a hook that used to be invoked on the socket-close tick is
 * invoked a few microtasks later. Deliberate: a record describing a call that
 * has not been hung up yet is the defect this ordering exists to fix. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
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

  /** `handle.stop()` reaches CallSession's own `endCall`, whose last two
   * teardown steps (`media.close()`, `session.close()`) are unguarded — the
   * latter reaches the realtime SDK on an ordinary call, so a rejection here
   * is reachable in production, not hypothetical. Before this fix, an
   * unguarded `await handle.stop(...)` let that rejection propagate out of
   * `evict()` entirely, skipping `onCallCompleted` — the call produced no
   * record at all, only a `console.error`. */
  it("still produces a record when stop() rejects during teardown", async () => {
    const pending = new PendingSessions();
    const stop = vi.fn(async () => {
      throw new Error("session.close boom");
    });
    const { session } = sessionWithAttachSpy(stop);
    pending.set("CA1", session);
    const socket = fakeSocket();
    const onCallCompleted = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await handleMediaConnection("CA1", socket, { pending, onCallCompleted });
    expect(ok).toBe(true);

    socket.triggerClose();
    await settle();

    expect(onCallCompleted).toHaveBeenCalledTimes(1);
    expect(onCallCompleted).toHaveBeenCalledWith(expect.objectContaining({ callId: "CA1" }));

    consoleError.mockRestore();
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
    await settle();

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
      expectedOutcomeFields: ["x"],
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
      onCallCompleted: (r) => {
        records.push(r);
      }
    });
    onClose();
    await settle();

    expect(records[0].endedBy).toBe("model");
    expect(records[0].answeredBy).toBe("human");
    expect(records[0].outcome?.status).toBe("completed");
    expect(records[0].dtmf).toEqual({ pressed: ["1"], refused: 0 });
    expect(records[0].expectedOutcomeFields).toEqual(["x"]);
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
      onCallCompleted: (r) => {
        records.push(r);
      }
    });
    onClose();
    await settle();

    expect(records[0].outcome).toBeUndefined();
    expect(records[0].answeredBy).toBeUndefined();
    expect(records[0].dtmf).toBeUndefined();
    // The fake session declares no `meetingBrief` getter at all — same as a
    // real CallSession for a non-meeting call, or a meeting whose caller
    // supplied no brief. Both read as undefined here, on purpose.
    expect(records[0].brief).toBeUndefined();
    // A socket closing with no recorded reason IS the far end hanging up.
    expect(records[0].endedBy).toBe("remote");
  });

  it("carries isMeeting, startedAt, consentReceipt, gaps, gapMs and coveredMs from the session", async () => {
    const records: CompletedCallRecord[] = [];
    const pending = new PendingSessions();
    const consentReceipt = {
      requestedAt: "T0",
      grantedAt: "T1",
      phrase: "go ahead",
      utterances: []
    };
    const gaps = [{ fromMs: 100, toMs: 200, reason: "transcriber_not_ready" }];
    const meetingBrief = {
      title: "Roadmap Sync",
      topic: "Q4 scope.",
      role: "product lead",
      track: ["engineering"]
    };
    const session = {
      attach: async () => ({ transcript: [], endedBy: "model" as const, stop: async () => {} }),
      answeredBy: undefined,
      isMeeting: true,
      consentReceipt,
      gaps,
      gapMs: 100,
      coveredMs: 4900,
      modelTurnsCompleted: 3,
      meetingBrief,
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
      onCallCompleted: (r) => {
        records.push(r);
      }
    });
    onClose();
    await settle();

    expect(records[0].isMeeting).toBe(true);
    expect(records[0].startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(records[0].consentReceipt).toEqual(consentReceipt);
    expect(records[0].gaps).toEqual(gaps);
    expect(records[0].gapMs).toBe(100);
    expect(records[0].coveredMs).toBe(4900);
    expect(records[0].modelTurnsCompleted).toBe(3);
    expect(records[0].brief).toEqual(meetingBrief);
  });

  it("carries modelTurnsCompleted as 0 when the agent never got a turn — the never_joined evidence", async () => {
    const records: CompletedCallRecord[] = [];
    const pending = new PendingSessions();
    const session = {
      attach: async () => ({ transcript: [], endedBy: "remote" as const, stop: async () => {} }),
      answeredBy: undefined,
      isMeeting: true,
      consentReceipt: undefined,
      gaps: [],
      gapMs: 0,
      coveredMs: 0,
      modelTurnsCompleted: 0,
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
      onCallCompleted: (r) => {
        records.push(r);
      }
    });
    onClose();
    await settle();

    expect(records[0].modelTurnsCompleted).toBe(0);
  });

  it("defaults isMeeting to false and omits consentReceipt for an ordinary (non-meeting) call", async () => {
    const records: CompletedCallRecord[] = [];
    const pending = new PendingSessions();
    const session = {
      attach: async () => ({ transcript: [], endedBy: "remote" as const, stop: async () => {} }),
      answeredBy: undefined,
      isMeeting: false,
      consentReceipt: undefined,
      gaps: [],
      gapMs: 0,
      coveredMs: 0,
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
      onCallCompleted: (r) => {
        records.push(r);
      }
    });
    onClose();
    await settle();

    expect(records[0].isMeeting).toBe(false);
    expect(records[0].consentReceipt).toBeUndefined();
    expect(records[0].gaps).toEqual([]);
  });
  it("stops the handle BEFORE building the record, and still completes the hook before returning", async () => {
    const pending = new PendingSessions();
    const order: string[] = [];
    const stop = vi.fn(async () => {
      order.push("stop");
    });
    const session = {
      attach: async () => ({ transcript: [], endedBy: "remote" as const, stop }),
      answeredBy: undefined,
      isMeeting: false,
      consentReceipt: undefined,
      gaps: [],
      gapMs: 0,
      coveredMs: 0,
      gateSnapshot: () => ({})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    pending.set("CA1", session);

    let resolveOnCallCompleted!: () => void;
    const onCallCompletedPromise = new Promise<void>((resolve) => {
      resolveOnCallCompleted = resolve;
    });

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
      onCallCompleted: () => {
        order.push("record");
        return onCallCompletedPromise;
      }
    });

    onClose();
    // The teardown runs first — the record must describe a finished call.
    expect(stop).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["stop", "record"]);

    resolveOnCallCompleted();
    await onCallCompletedPromise;
  });

  // The hook is still awaited before eviction finishes — spawning
  // PARLEY_POST_CALL_COMMAND must never race the files it is handed.
  it("does not finish evicting until an async onCallCompleted settles", async () => {
    const pending = new PendingSessions();
    const session = {
      attach: async () => ({ transcript: [], endedBy: "remote" as const, stop: async () => {} }),
      answeredBy: undefined,
      isMeeting: false,
      consentReceipt: undefined,
      gaps: [],
      gapMs: 0,
      coveredMs: 0,
      gateSnapshot: () => ({})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    pending.set("CA1", session);

    let settled = false;
    let release!: () => void;
    const hookPromise = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      settled = true;
    });

    let onClose!: () => void;
    const socket = {
      send: () => {},
      on: (e: string, l: () => void) => {
        if (e === "close") onClose = l;
      },
      close: () => {}
    };
    // Close BEFORE attach resolves, so the eviction runs on the awaited path
    // (`if (closed) await evict()`) rather than on the fire-and-forget one.
    const connection = handleMediaConnection("CA1", socket, {
      pending,
      onCallCompleted: () => hookPromise
    });
    onClose();
    let connectionDone = false;
    void connection.then(() => {
      connectionDone = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(connectionDone).toBe(false);
    expect(settled).toBe(false);

    release();
    await connection;
    expect(settled).toBe(true);
  });
});

/**
 * The artifacts A2 reads are built from `CompletedCallRecord`, and two of the
 * things `endCall` does exist ONLY to make that record honest: it seals a gap
 * that is still open (`closeOpenGap` — "a hole in the record that the record
 * does not admit to") and it flushes the listening plane ("without it the last
 * utterance of a meeting is lost").
 *
 * On the NORMAL meeting ending — the bridge drops the leg — neither had run
 * when the record was built, because `evict()` invoked `onCallCompleted` first
 * and `handle.stop("remote")` after. A meeting delivered with a hole in it read
 * `gaps: [], gapMs: 0`, and its closing sentence was missing.
 *
 * These drive a REAL `CallSession` through a real handoff, because the defect
 * is entirely in the ORDER of two calls and a hand-built session double can be
 * ordered any way the test likes.
 */
describe("the record is built from a session that has been torn down", () => {
  const FRAME_MS = 20;

  function meetingRig() {
    const clock = { t: 1_700_000_000_000 };
    const now = (): number => clock.t;
    let transcriptionCallbacks: import("@parley/core").TranscriptionCallbacks | undefined;
    const listening = {
      ready: true,
      sendAudio: () => {},
      flush: async () => {
        // What a real transcriber's flush does: promote the pending partial,
        // which arrives as one last final transcript event.
        transcriptionCallbacks?.onTranscript({
          speaker: "participant",
          text: "and that is the whole scope, thanks everyone",
          startMs: 300_000,
          endMs: 303_000,
          isFinal: true
        });
      },
      close: async () => {}
    };
    const transcription = {
      provider: {
        name: "stub-transcription",
        ingress: { audio: true, channels: "mono" as const },
        accepts: [MULAW_8K],
        connect: async (p: import("@parley/core").TranscriptionConnectParams) => {
          transcriptionCallbacks = p.callbacks;
          return listening;
        }
      },
      convert: ((f: { data: Buffer }, to: unknown) => ({ encoding: to, data: f.data })) as never
    };

    const socket = fakeSocket() as ReturnType<typeof fakeSocket> & {
      pushInbound?: (frame: { encoding: typeof MULAW_8K; data: Buffer }) => void;
    };
    const telephony: TelephonyProvider = {
      name: "fake",
      mediaEncoding: MULAW_8K,
      originate: async () => ({ providerCallId: "CA1", status: "queued" }),
      buildAnswerResponse: () => ({ contentType: "text/xml", body: "" }),
      verifyWebhookSignature: () => true,
      attachMediaStream: (p) => {
        socket.pushInbound = (frame) => {
          clock.t += FRAME_MS;
          p.onInboundAudio(frame, { streamId: "mixed" });
        };
        return {
          sendOutboundAudio: () => {},
          clearOutboundBuffer: () => {},
          drainOutbound: async () => ({ confirmed: true, waitedMs: 0 }),
          close: () => {}
        };
      },
      hangup: async () => {}
    };
    const realtime: RealtimeProvider = {
      name: "fake",
      audio: { accepts: [MULAW_8K], emits: MULAW_8K },
      openingDelivery: "turn",
      continuesAfterToolResponse: false,
      connect: async () => ({
        sendOpeningTrigger: () => {},
        sendAudio: () => {},
        sendToolResponse: () => {},
        notifyActivityEnd: () => {},
        close: async () => {}
      })
    };
    const session = new CallSession({
      brief: { to: "+1", persona: "p", objective: "o", facts: [] },
      guardrails: [],
      telephony,
      realtime,
      codec,
      convert,
      canConvert,
      from: "+1",
      answerWebhookUrl: "https://h/a",
      model: "m",
      now,
      execution: {
        meeting: {
          consent: { phrase: "go ahead and take notes", timeoutSeconds: 180, onTimeout: "hangUp" }
        }
      },
      transcription
    });
    return { session, socket, listening, clock };
  }

  /** A SNAPSHOT taken inside the hook, not the record object read afterwards.
   * `transcript` and `gaps` are live references into `CallSession`, so a
   * record read after everything settled shows entries appended long after the
   * hook already wrote its files — which is exactly how this defect stayed
   * invisible. Production reads them inside the hook; so does this. */
  interface RecordSnapshot {
    transcript: string[];
    gaps: { reason: string }[];
    gapMs: number;
  }

  async function runToHangup(): Promise<RecordSnapshot> {
    const { session, socket, listening } = meetingRig();
    const pending = new PendingSessions();
    pending.set("CA1", session);
    const records: RecordSnapshot[] = [];
    await handleMediaConnection("CA1", socket, {
      pending,
      onCallCompleted: (r: CompletedCallRecord) => {
        records.push({
          transcript: r.transcript.map((e) => e.text),
          gaps: r.gaps.map((g) => ({ reason: g.reason })),
          gapMs: r.gapMs
        });
      }
    });

    session.noteTranscript({ speaker: "model", text: "I am here for the host.", isFinal: true });
    session.noteTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
    session.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });
    await session.beginNotetaking();

    socket.pushInbound?.({ encoding: MULAW_8K, data: Buffer.alloc(160) });
    // The transcriber drops out and never comes back: a hole that is still
    // OPEN when the bridge hangs up, which only `endCall` ever seals.
    listening.ready = false;
    for (let i = 0; i < 50; i += 1) {
      socket.pushInbound?.({ encoding: MULAW_8K, data: Buffer.alloc(160) });
    }

    socket.triggerClose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(records).toHaveLength(1);
    return records[0]!;
  }

  it("seals a gap that is still open, so the record does not read as a complete meeting", async () => {
    const record = await runToHangup();
    expect(record.gaps).toHaveLength(1);
    expect(record.gaps[0]?.reason).toBe("transcriber_not_ready");
    expect(record.gapMs).toBeGreaterThan(0);
  });

  it("carries the last utterance, which only the listening plane's flush produces", async () => {
    const record = await runToHangup();
    expect(record.transcript).toContain("and that is the whole scope, thanks everyone");
  });
});

/** Which realtime provider ran a call, and how soon its model first spoke, are
 * the two facts a provider A/B compares — so both are on the record itself,
 * provider-neutral, rather than reconstructed from logs afterwards. */
describe("the completed-call record names its realtime provider and first model audio", () => {
  function realtimeRig(name: string) {
    const captured: { callbacks?: RealtimeSessionCallbacks } = {};
    const provider: RealtimeProvider = {
      name,
      audio: { accepts: [MULAW_8K], emits: MULAW_8K },
      openingDelivery: "turn",
      continuesAfterToolResponse: false,
      connect: async (params) => {
        captured.callbacks = params.callbacks;
        return {
          sendOpeningTrigger: () => {},
          sendAudio: () => {},
          sendToolResponse: () => {},
          notifyActivityEnd: () => {},
          close: async () => {}
        };
      }
    };
    return { provider, captured };
  }

  function telephony(): TelephonyProvider {
    return {
      name: "fake",
      mediaEncoding: MULAW_8K,
      originate: async () => ({ providerCallId: "CA-AB-1", status: "queued" }),
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
  }

  async function completeCall(
    pending: PendingSessions,
    callId: string,
    during: () => void = () => {}
  ): Promise<CompletedCallRecord> {
    const socket = fakeSocket();
    const records: CompletedCallRecord[] = [];
    await handleMediaConnection(callId, socket, {
      pending,
      onCallCompleted: (r) => {
        records.push(r);
      }
    });
    during();
    socket.triggerClose();
    await settle();
    expect(records).toHaveLength(1);
    return records[0]!;
  }

  it("names the provider the envelope chose, and that provider's model (Deepgram's think model)", async () => {
    const gemini = realtimeRig("gemini");
    const deepgram = realtimeRig("deepgram");
    const pending = new PendingSessions();
    const token = "test-call-token";
    const res = await handleHttpRequest(
      {
        method: "POST",
        path: "/call",
        query: "",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        rawBody: JSON.stringify({
          version: 2,
          brief: { to: "+14155550002", persona: "p", objective: "o", facts: [] },
          guardrails: ["Be brief."],
          execution: { realtime: { provider: "deepgram" } }
        })
      },
      {
        telephony: telephony(),
        realtime: {
          providers: {
            gemini: { provider: gemini.provider, model: "gemini-3.8-live" },
            deepgram: { provider: deepgram.provider, model: "gpt-4o-mini" }
          },
          default: "gemini"
        },
        codec,
        convert,
        canConvert,
        from: "+14155550001",
        publicHost: "voice.example.com",
        numberAllowlist: createNumberAllowlist(["+14155550002"]),
        hostAllowlist: createHostAllowlist(["voice.example.com"]),
        pending,
        callToken: token,
        meetingArtifactsConfigured: true
      }
    );
    expect(res.status).toBe(202);

    const record = await completeCall(pending, "CA-AB-1");
    expect(record.realtime).toEqual({ provider: "deepgram", model: "gpt-4o-mini" });
    // And the call really ran there: the envelope's choice reached the wire.
    expect(deepgram.captured.callbacks).toBeDefined();
    expect(gemini.captured.callbacks).toBeUndefined();
  });

  function clockedSession() {
    const clock = { t: 1_000_000 };
    const rig = realtimeRig("gemini");
    const session = new CallSession({
      brief: { to: "+1", persona: "p", objective: "o", facts: [] },
      guardrails: [],
      telephony: telephony(),
      realtime: rig.provider,
      codec,
      convert,
      canConvert,
      from: "+1",
      answerWebhookUrl: "https://h/a",
      model: "gemini-3.8-live",
      now: () => clock.t
    });
    const pending = new PendingSessions();
    pending.set("CA1", session);
    return { clock, rig, pending };
  }

  it("records firstModelAudioMs as the offset of the model's FIRST audio frame from call start", async () => {
    const { clock, rig, pending } = clockedSession();
    const frame = { encoding: MULAW_8K, data: Buffer.alloc(160) };
    const record = await completeCall(pending, "CA1", () => {
      clock.t += 1234;
      rig.captured.callbacks!.onAudio(frame);
      clock.t += 500;
      rig.captured.callbacks!.onAudio(frame);
    });
    expect(record.firstModelAudioMs).toBe(1234);
    expect(record.realtime).toEqual({ provider: "gemini", model: "gemini-3.8-live" });
  });

  it("omits firstModelAudioMs when the model never spoke", async () => {
    const { clock, pending } = clockedSession();
    const record = await completeCall(pending, "CA1", () => {
      clock.t += 5000;
    });
    expect("firstModelAudioMs" in record).toBe(false);
  });

  it("carries an unexpected realtime close on the record, with endedBy error", async () => {
    const { rig, pending } = clockedSession();
    const record = await completeCall(pending, "CA1", () => {
      rig.captured.callbacks!.onClose("code=1011 reason=credits", {
        code: 1011,
        reason: "Your prepayment credits are depleted."
      });
    });
    expect(record.endedBy).toBe("error");
    expect(record.realtimeClose).toEqual({
      code: 1011,
      reason: "Your prepayment credits are depleted."
    });
  });

  it("omits realtimeClose on a normal hangup", async () => {
    const { clock, pending } = clockedSession();
    const record = await completeCall(pending, "CA1", () => {
      clock.t += 5000;
    });
    expect("realtimeClose" in record).toBe(false);
  });
});
