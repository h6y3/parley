import { describe, expect, it, vi } from "vitest";
import { CallSession, TRANSCRIPTION_CONNECT_TIMEOUT_MS } from "../src/call-session.js";
import { FakeSocket, makeMeetingFakes, makeMeetingParams } from "./helpers/call-session-harness.js";
import { MIXED_SOURCE, MULAW_8K, PCM_24K } from "../src/index.js";

/** The announcement, the request, and the go-ahead.
 *
 * `buildConsentReceipt` refuses to fabricate a receipt without all three, and
 * refuses BEFORE any state changes — so every handoff below has to seed them
 * first or it never reaches the plane work at all. */
function seedConsent(session: CallSession): void {
  session.noteTranscript({
    speaker: "model",
    text: "I'm an AI assistant sitting in for the host.",
    isFinal: true
  });
  session.noteTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
  session.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });
}

const frame = (): { encoding: typeof MULAW_8K; data: Buffer } => ({
  encoding: MULAW_8K,
  data: Buffer.alloc(160)
});

describe("the consent handoff", () => {
  // Closing the speaking plane is a socket close, and a socket close raises
  // `onClose` — whose handler hangs the carrier leg up. Asserting the speaking
  // plane is GONE was never enough: the call has to still be up, or a real
  // meeting drops the line at the exact instant consent is granted.
  it("closes the realtime session, keeps the CALL up, and leaves the speaking phase", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    const handle = await session.attach("CA1", new FakeSocket());
    seedConsent(session);
    await session.beginNotetaking();
    expect(params.stubs.realtimeSession.closed).toBe(true);
    expect(handle.endedBy).toBeUndefined();
    expect([...session.phases]).toEqual(["listening"]);
  });

  // The other half of the same guarantee, from the carrier's side: nothing on
  // the handoff path may ask the carrier to hang up.
  it("does not hang up the carrier when the speaking plane is retired", async () => {
    const hangups: string[] = [];
    const params = makeMeetingParams();
    const session = new CallSession({
      ...params,
      telephony: { ...params.telephony, hangup: async (id) => void hangups.push(id) }
    });
    await session.attach("CA1", new FakeSocket());
    seedConsent(session);
    await session.beginNotetaking();
    expect(hangups).toEqual([]);
  });

  // A realtime session that dies on its own — not because we retired it — must
  // still end the call. The flag closes one door, not both.
  it("still ends the call when the realtime session drops on its own", async () => {
    const params = makeMeetingFakes();
    const session = new CallSession(params.params);
    const handle = await session.attach("CA1", new FakeSocket());
    params.session.callbacks?.onClose("provider dropped us");
    await Promise.resolve();
    expect(handle.endedBy).toBe("error");
  });

  it("routes audio to the transcriber and NOT to the realtime session afterwards", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    seedConsent(session);
    await session.beginNotetaking();
    socket.pushInbound(frame(), MIXED_SOURCE);
    expect(params.stubs.transcriptionSession.received).toHaveLength(1);
    expect(params.stubs.realtimeSession.audioAfterClose).toBe(0);
  });

  it("passes through mulaw@8000 rather than converting it, and says so", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    seedConsent(session);
    await session.beginNotetaking();
    socket.pushInbound(frame(), MIXED_SOURCE);
    expect(session.audioBridgeStats.listening).toEqual({ conversions: 0, passThroughs: 1 });
  });

  it("records a gap for frames dropped while the transcriber is not ready", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    seedConsent(session);
    await session.beginNotetaking();
    params.stubs.transcriptionSession.ready = false;
    for (let i = 0; i < 100; i += 1) {
      socket.pushInbound(frame(), MIXED_SOURCE);
    }
    params.stubs.transcriptionSession.ready = true;
    socket.pushInbound(frame(), MIXED_SOURCE);
    expect(session.gaps).toHaveLength(1);
    expect(session.gaps[0]?.reason).toBe("transcriber_not_ready");
    expect(session.gaps[0]!.toMs).toBeGreaterThan(session.gaps[0]!.fromMs);
    // Audio coordinates, not arrival coordinates. A frame ARRIVES at the end
    // of the twenty milliseconds it carries, so a hole over the audio in
    // frames 1..100 runs [0, 2000) — not [20, 2020), which names twenty
    // milliseconds that were in fact covered and misses twenty that were not.
    expect(session.gaps[0]).toEqual({ fromMs: 0, toMs: 2000, reason: "transcriber_not_ready" });
    // The dropped frames are NOT counted as covered: one frame got through.
    expect(session.coveredMs).toBe(20);
    expect(session.gapMs).toBe(2000);
    // Not buffered and replayed — the hole is real and the record says so.
    expect(params.stubs.transcriptionSession.received).toHaveLength(1);
  });

  it("connects the transcriber with the elapsed meeting offset, not zero", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    await session.attach("CA1", new FakeSocket());
    seedConsent(session);
    params.stubs.clock.advance(90_000);
    await session.beginNotetaking();
    expect(params.stubs.transcriptionConnect.offsetMs).toBe(90_000);
  });

  it("refuses a second handoff", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    await session.attach("CA1", new FakeSocket());
    seedConsent(session);
    await session.beginNotetaking();
    await expect(session.beginNotetaking()).rejects.toThrow(/already/);
    // And refused it WITHOUT touching the plane it had already brought up.
    expect(params.stubs.transcriptionConnect.calls).toBe(1);
    expect(params.stubs.transcriptionSession.closes).toBe(0);
  });

  // Ordering, stated as a fact the stub can check rather than as a comment:
  // the listening plane is asked to come up while the speaking plane is still
  // open. The reverse leaves a window in which audio reaches neither, and the
  // first sentence after consent is exactly what a notetaker is there for.
  it("brings the transcriber up BEFORE the realtime session closes", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    await session.attach("CA1", new FakeSocket());
    seedConsent(session);
    await session.beginNotetaking();
    expect(params.stubs.transcriptionConnect.realtimeClosedAtConnect).toBe(false);
    expect(params.stubs.realtimeSession.closed).toBe(true);
  });

  // Consent is granted mid-turn: the model hears the go-ahead and keeps
  // talking while the transcriber is still connecting. Those words are
  // consented speech, and the buffer they used to land in has just been
  // emptied — if `notetaking` only flips after the connect resolves, they are
  // written nowhere and no test that only looks at the end state can see it.
  it("puts speech heard while the transcriber is connecting into the transcript, not the emptied buffer", async () => {
    const params = makeMeetingParams({ connect: "defer" });
    const session = new CallSession(params);
    const handle = await session.attach("CA1", new FakeSocket());
    seedConsent(session);

    const handoff = session.beginNotetaking();
    await Promise.resolve();
    session.noteTranscript({ speaker: "model", text: "Great, starting notes now.", isFinal: true });
    session.noteTranscript({ speaker: "caller", text: "so, the roadmap.", isFinal: true });
    params.stubs.releaseConnect();
    await handoff;

    expect(handle.transcript.map((e) => e.text)).toEqual([
      "Great, starting notes now.",
      "so, the roadmap."
    ]);
    expect(session.heardBeforeConsent).toEqual([]);
  });

  it("refuses a second handoff attempted while the first is still connecting", async () => {
    const params = makeMeetingParams({ connect: "defer" });
    const session = new CallSession(params);
    await session.attach("CA1", new FakeSocket());
    seedConsent(session);

    const first = session.beginNotetaking();
    await expect(session.beginNotetaking()).rejects.toThrow(/already/);
    params.stubs.releaseConnect();
    await first;
    expect(params.stubs.transcriptionConnect.calls).toBe(1);
  });
});

// By the time `beginNotetaking()` runs, `routeToolCall` has already answered
// the model "ok". A connect that fails or never settles therefore leaves
// consent granted, the buffer emptied and no listening plane — and sitting on
// a live, billing call pretending to take notes is the one outcome that must
// not happen.
describe("the listening plane cannot be brought up", () => {
  it("ends the call as transcriptionLost when the provider refuses the connect", async () => {
    const diagnostics: string[] = [];
    const params = makeMeetingParams({ connect: "reject" });
    const session = new CallSession({ ...params, onDiagnostic: (m) => diagnostics.push(m) });
    const handle = await session.attach("CA1", new FakeSocket());
    seedConsent(session);

    await expect(session.beginNotetaking()).rejects.toThrow(/refused the connect/);

    expect(handle.endedBy).toBe("transcriptionLost");
    expect([...session.phases]).toEqual([]);
    // Consent WAS granted — the receipt records a promise made aloud to a
    // room, and it survives a call that then failed to keep it.
    expect(session.consentReceipt?.phrase).toBe("go ahead and take notes");
    expect(diagnostics.some((d) => d.includes("transcription connect failed"))).toBe(true);
  });

  it("bounds a connect that never settles rather than hanging on it forever", async () => {
    vi.useFakeTimers();
    try {
      const params = makeMeetingParams({ connect: "hang" });
      const session = new CallSession(params);
      const handle = await session.attach("CA1", new FakeSocket());
      seedConsent(session);

      const handoff = session.beginNotetaking();
      const settled = expect(handoff).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(TRANSCRIPTION_CONNECT_TIMEOUT_MS + 1);
      await settled;

      expect(handle.endedBy).toBe("transcriptionLost");
      expect([...session.phases]).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the call when the transcription session closes mid-meeting", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    const handle = await session.attach("CA1", new FakeSocket());
    seedConsent(session);
    await session.beginNotetaking();

    params.stubs.emitTranscriptionClose("socket closed");
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(handle.endedBy).toBe("transcriptionLost");
  });

  // A close code with no reason payload arrives here as `""`, not
  // `undefined` — `Buffer.toString()` on an empty buffer is still a string —
  // so `${reason}` alone printed "transcription closed: " with nothing after
  // the colon on the live call above.
  it("names an empty transcription-close reason instead of printing nothing", async () => {
    const diagnostics: string[] = [];
    const params = makeMeetingParams();
    const session = new CallSession({ ...params, onDiagnostic: (m) => diagnostics.push(m) });
    await session.attach("CA1", new FakeSocket());
    seedConsent(session);
    await session.beginNotetaking();

    params.stubs.emitTranscriptionClose("");
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(diagnostics).toContain("transcription closed: no reason given");
  });
});

describe("the listening plane's teardown", () => {
  it("flushes the transcriber before closing it, so the last utterance is promoted", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    const handle = await session.attach("CA1", new FakeSocket());
    seedConsent(session);
    await session.beginNotetaking();
    await handle.stop("remote");
    expect(params.stubs.transcriptionSession.teardown).toEqual(["flush", "close"]);
  });

  it("hangs up anyway when the flush throws", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    const handle = await session.attach("CA1", new FakeSocket());
    seedConsent(session);
    await session.beginNotetaking();
    params.stubs.transcriptionSession.flush = async () => {
      throw new Error("upstream is gone");
    };
    await handle.stop("remote");
    expect(params.stubs.transcriptionSession.closes).toBe(1);
    expect(handle.endedBy).toBe("remote");
  });

  it("closes a gap still open at hangup rather than forgetting it", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    const socket = new FakeSocket();
    const handle = await session.attach("CA1", socket);
    seedConsent(session);
    await session.beginNotetaking();
    params.stubs.transcriptionSession.ready = false;
    for (let i = 0; i < 50; i += 1) socket.pushInbound(frame(), MIXED_SOURCE);
    // The transcriber never came back. Without closing it here the hole is in
    // the record but not in `gaps`, and a readout over it reads complete.
    expect(session.gaps).toHaveLength(0);
    params.stubs.clock.advance(500);
    await handle.stop("remote");
    expect(session.gaps).toHaveLength(1);
    expect(session.gaps[0]?.reason).toBe("transcriber_not_ready");
    expect(session.gaps[0]?.fromMs).toBe(0);
    expect(session.gapMs).toBe(1500);
  });
});

// Until now no production call site passed the gate its evidence, so it
// refused every time and the carrier stub threw. These two drive the REAL
// `onToolCall` path a live call runs.
describe("begin_notetaking, driven by the model", () => {
  it("performs the real handoff when the go-ahead is in the buffer", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession(f.params);
    await cs.attach("CA1", new FakeSocket());

    f.emitTranscript({
      speaker: "model",
      text: "I'm an AI assistant for the host.",
      isFinal: true
    });
    f.emitTurnComplete();
    f.emitTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
    f.emitTurnComplete();
    cs.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });

    await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

    expect(f.toolResponses).toEqual([{ id: "t1", result: "ok" }]);
    expect(f.stubs.transcriptionConnect.calls).toBe(1);
    expect(f.stubs.realtimeSession.closed).toBe(true);
    expect([...cs.phases]).toEqual(["listening"]);
    expect(cs.consentReceipt?.phrase).toBe("go ahead and take notes");
  });

  it("refuses, and leaves both planes exactly as they were, when nobody said the phrase", async () => {
    const diagnostics: string[] = [];
    const f = makeMeetingFakes();
    const cs = new CallSession({ ...f.params, onDiagnostic: (m) => diagnostics.push(m) });
    await cs.attach("CA1", new FakeSocket());

    f.emitTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
    f.emitTurnComplete();
    cs.noteTranscript({ speaker: "caller", text: "sure, whatever", isFinal: true });

    await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

    expect(f.toolResponses).toEqual([
      { id: "t1", result: "refused: the go-ahead phrase has not been spoken" }
    ]);
    expect(f.stubs.transcriptionConnect.calls).toBe(0);
    expect(f.stubs.realtimeSession.closed).toBe(false);
    expect([...cs.phases]).toEqual(["speaking"]);
    expect(cs.consentReceipt).toBeUndefined();
    // Defect 3 (`CA0573ebc91a165c9c0230f8890915f87b`, 2026-08-20): a refused
    // begin_notetaking used to answer the model and leave no other trace.
    // The diagnostic must name the decision and must NOT contain the
    // caller's own words — "sure, whatever" is exactly the utterance this
    // must not leak.
    expect(diagnostics.some((d) => d.includes("begin_notetaking"))).toBe(true);
    expect(
      diagnostics.some((d) => d.includes("refused: the go-ahead phrase has not been spoken"))
    ).toBe(true);
    expect(diagnostics.some((d) => d.includes("sure, whatever"))).toBe(false);
    expect(cs.heardBeforeConsent).toEqual(["sure, whatever"]);
  });

  it("reports rather than crashes when the handoff throws out of the void-style tool path", async () => {
    const diagnostics: string[] = [];
    const f = makeMeetingFakes({ connect: "reject" });
    const cs = new CallSession({ ...f.params, onDiagnostic: (m) => diagnostics.push(m) });
    const handle = await cs.attach("CA1", new FakeSocket());

    f.emitTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
    f.emitTurnComplete();
    cs.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });

    await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

    expect(handle.endedBy).toBe("transcriptionLost");
    expect(diagnostics.some((d) => d.includes('tool call "begin_notetaking" failed'))).toBe(true);
  });

  // Defect 4 (2026-08-20): two live calls in a row ended `consent_refused`
  // with `modelTurnsCompleted: 4` and nothing on disk to say why — the
  // operator confirmed by ear that the agent heard the go-ahead and said
  // "thank you", and simply never called `begin_notetaking`. Reproduced here
  // with no `emitToolCall` at all: the model hears the go-ahead, completes an
  // acknowledgment turn, and the tool is never invoked.
  it("signals once when consent is matched but the model finishes a turn without calling begin_notetaking", async () => {
    const diagnostics: string[] = [];
    // The timeline lines (`model turn complete at +…ms`, `caller final at
    // +…ms`) are not this signal; count only the signal's own diagnostics.
    const timeline = / at \+\d+ms$/;
    const f = makeMeetingFakes();
    const cs = new CallSession({
      ...f.params,
      onDiagnostic: (m) => {
        if (!timeline.test(m)) diagnostics.push(m);
      }
    });
    await cs.attach("CA1", new FakeSocket());

    f.emitTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
    f.emitTurnComplete();
    cs.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });

    // No `emitToolCall` — this is the exact silence that bit us.
    f.emitTranscript({ speaker: "model", text: "Thank you.", isFinal: true });
    f.emitTurnComplete();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("begin_notetaking");
    expect(diagnostics[0]).not.toContain("go ahead and take notes");
    expect(diagnostics[0]).not.toContain("Thank you");
    expect([...cs.phases]).toEqual(["speaking"]);

    // A second silent turn must not log a second line — "once, not per turn".
    f.emitTranscript({ speaker: "model", text: "Still here.", isFinal: true });
    f.emitTurnComplete();

    expect(diagnostics).toHaveLength(1);
  });

  it("stays silent on the signal above when the tool call succeeds in the same turn", async () => {
    const diagnostics: string[] = [];
    const f = makeMeetingFakes();
    const cs = new CallSession({ ...f.params, onDiagnostic: (m) => diagnostics.push(m) });
    await cs.attach("CA1", new FakeSocket());

    f.emitTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
    f.emitTurnComplete();
    cs.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });

    await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });
    f.emitTurnComplete();

    expect(diagnostics.some((d) => d.includes("consent already matched but not called"))).toBe(
      false
    );
    expect([...cs.phases]).toEqual(["listening"]);
  });
});

// Everything between granting consent and the transcriber being live. The call
// can end inside it — the duration cap, the silence cap, the far end hanging
// up, or the realtime session's own onClose all fire on their own schedule —
// and the meeting keeps producing audio throughout it either way.
describe("the window while the transcriber is connecting", () => {
  it("abandons the handoff when the call ended mid-connect, and closes the session it was handed", async () => {
    const params = makeMeetingParams({ connect: "defer" });
    const session = new CallSession(params);
    const socket = new FakeSocket();
    const handle = await session.attach("CA1", socket);
    seedConsent(session);

    const handoff = session.beginNotetaking();
    await handle.stop("remote");
    params.stubs.releaseConnect();
    await handoff;

    // The vendor socket opened. Nothing else will ever close it, because
    // endCall found `transcriptionSession` still undefined and flushed and
    // closed nothing.
    expect(params.stubs.transcriptionSession.closes).toBe(1);
    // And the handoff did NOT resume onto a dead call: no terminal phase set
    // contradicting endedBy, no sink, no bridge.
    expect(handle.endedBy).toBe("remote");
    expect([...session.phases]).toEqual([]);
    expect(session.audioBridgeStats.listening).toEqual({ conversions: 0, passThroughs: 0 });
    socket.pushInbound(frame(), MIXED_SOURCE);
    expect(params.stubs.transcriptionSession.received).toHaveLength(0);
  });

  it("records the connect window itself as a gap, with real bounds", async () => {
    const params = makeMeetingParams({ connect: "defer" });
    const session = new CallSession(params);
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    seedConsent(session);

    const handoff = session.beginNotetaking();
    // Two seconds of consented meeting audio, arriving before there is
    // anything listening to it.
    for (let i = 0; i < 100; i += 1) socket.pushInbound(frame(), MIXED_SOURCE);
    params.stubs.releaseConnect();
    await handoff;

    expect(session.gaps).toEqual([{ fromMs: 0, toMs: 2000, reason: "transcriber_connecting" }]);
    expect(session.gapMs).toBe(2000);
    expect(session.coveredMs).toBe(0);
    expect(params.stubs.transcriptionSession.received).toHaveLength(0);
  });

  it("seals the connect gap at hangup when the call ends before the transcriber is live", async () => {
    const params = makeMeetingParams({ connect: "hang" });
    const session = new CallSession(params);
    const socket = new FakeSocket();
    const handle = await session.attach("CA1", socket);
    seedConsent(session);

    void session.beginNotetaking().catch(() => {
      /* the connect never settles; the call ends underneath it */
    });
    for (let i = 0; i < 50; i += 1) socket.pushInbound(frame(), MIXED_SOURCE);
    await handle.stop("remote");

    expect(session.gaps).toEqual([{ fromMs: 0, toMs: 1000, reason: "transcriber_connecting" }]);
  });

  it("does not invent a zero-length gap when the transcriber comes up instantly", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    seedConsent(session);
    await session.beginNotetaking();
    socket.pushInbound(frame(), MIXED_SOURCE);
    expect(session.gaps).toEqual([]);
    expect(session.coveredMs).toBe(20);
  });
});

// Finding 4: the receipt surviving a failed handoff is not a property of
// endCall on its own — it rests entirely on `notetaking` having been set
// before the connect was awaited. Asserted from the endCall side, in both
// directions, so moving that assignment cannot silently delete the consent
// record.
describe("what endCall keeps, and what it wipes", () => {
  it("keeps the receipt once consent has been granted, whatever ends the call", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    const handle = await session.attach("CA1", new FakeSocket());
    seedConsent(session);
    await session.beginNotetaking();
    await handle.stop("remote");
    expect(session.consentReceipt?.phrase).toBe("go ahead and take notes");
    expect(session.heardBeforeConsent).toEqual([]);
  });

  it("wipes the buffer and writes no receipt when the call ends before consent", async () => {
    const params = makeMeetingParams();
    const session = new CallSession(params);
    const handle = await session.attach("CA1", new FakeSocket());
    seedConsent(session);
    await handle.stop("remote");
    expect(session.consentReceipt).toBeUndefined();
    expect(session.heardBeforeConsent).toEqual([]);
  });
});

// Call CAa717b30c25f88b2d1b0966da77940a6b (2026-08-20) completed the full
// meeting cycle and the operator heard nothing back: "I said go ahead, the
// agent never acknowledged and stayed silent." The persisted record showed
// `modelTurnsCompleted: 2` — the turn that called `begin_notetaking` DID
// complete, so the model spoke; the audio was just still in flight when
// `beginNotetaking()`'s old `await speaking?.close()` cut the socket. This is
// the same defect `endCall`'s `reason === "model"` branch already fixed, on
// the same file, for the same reason (see its own comment there).
//
// `f.handle.drainOutbound` is overridden per test to a controllable promise —
// `makeMeetingFakes()`'s stock one resolves instantly, which cannot
// distinguish "drained before close" from "closed and happened to drain
// first": the whole point here is ORDER, not occurrence.
describe("the consent handoff waits for the turn's audio to land before it goes voiceless", () => {
  it("does not close the speaking plane until the in-flight turn finishes and drains", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession(f.params);
    await cs.attach("CA1", new FakeSocket());

    const drainCalls: number[] = [];
    let resolveDrain!: (r: { confirmed: boolean; waitedMs: number }) => void;
    f.handle.drainOutbound = async () => {
      drainCalls.push(1);
      return new Promise((resolve) => {
        resolveDrain = resolve;
      });
    };

    f.emitTranscript({
      speaker: "model",
      text: "I'm an AI assistant for the host.",
      isFinal: true
    });
    f.emitTurnComplete();
    f.emitTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
    f.emitTurnComplete();
    cs.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });

    // The go-ahead lands, the model calls begin_notetaking, and — as on the
    // live call above — keeps talking in the SAME turn: an unfinished
    // fragment, no onTurnComplete yet.
    f.emitTranscript({ speaker: "model", text: "Great, starting notes now", isFinal: false });
    await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

    // The turn is still open. Nothing may have drained or closed yet, or the
    // words above are exactly what gets cut off.
    expect(drainCalls).toEqual([]);
    expect(f.session.closed).toBe(false);

    f.emitTurnComplete();
    await new Promise((r) => setTimeout(r, 0));

    // The turn finished, so the drain has started — but it has not resolved,
    // so the socket must still be open. Closing here is the exact bug: the
    // carrier's own playout buffer still holds this turn's audio.
    expect(drainCalls).toEqual([1]);
    expect(f.session.closed).toBe(false);

    resolveDrain({ confirmed: true, waitedMs: 12 });
    await new Promise((r) => setTimeout(r, 0));

    expect(f.session.closed).toBe(true);
    expect([...cs.phases]).toEqual(["listening"]);
  });

  // Wire-observed (t20 dggpt-fix, transferToAnotherPerson): the tool call
  // comes FIRST and the acknowledgment is the turn that continues after the
  // answer. With no turn open when begin_notetaking landed, the handoff used
  // to drain an empty queue and retire the speaking plane over the whole
  // acknowledgment.
  it("on a continuing provider, waits for the acknowledgment spoken after the answer", async () => {
    vi.useFakeTimers();
    try {
      const f = makeMeetingFakes();
      const cs = new CallSession({
        ...f.params,
        realtime: { ...f.realtime, continuesAfterToolResponse: true }
      });
      await cs.attach("CA1", new FakeSocket());
      const order: string[] = [];
      f.handle.drainOutbound = async () => {
        order.push(`drain after ${f.sentOutbound.length} frames`);
        return { confirmed: true, waitedMs: 0 };
      };

      f.emitTranscript({
        speaker: "model",
        text: "I'm an AI assistant for the host.",
        isFinal: true
      });
      f.emitTurnComplete();
      f.emitTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
      f.emitTurnComplete();
      cs.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });

      // The call arrives with no turn open and no audio yet.
      await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });
      expect(f.toolResponses).toEqual([{ id: "t1", result: "ok" }]);
      await vi.advanceTimersByTimeAsync(300);
      expect(order).toEqual([]);
      expect(f.session.closed).toBe(false);

      // The acknowledgment: 3.8 s of audio, frames every 20ms.
      for (let t = 0; t < 3_800; t += 20) {
        f.emitModelAudio({ encoding: PCM_24K, data: Buffer.alloc(480) });
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(order).toEqual([]);
      expect(f.session.closed).toBe(false);

      f.emitTurnComplete();
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual([`drain after ${3_800 / 20} frames`]);
      expect(f.session.closed).toBe(true);
      expect([...cs.phases]).toEqual(["listening"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still retires and closes the speaking plane when the drain throws", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession(f.params);
    const handle = await cs.attach("CA1", new FakeSocket());
    f.handle.drainOutbound = async () => {
      throw new Error("carrier refused to report playout");
    };

    f.emitTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
    f.emitTurnComplete();
    cs.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });

    await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

    // Draining is best effort: a throw must not strand the handoff half done.
    expect(f.session.closed).toBe(true);
    // And `speakingPlaneRetired` must still have been set BEFORE this close —
    // if the throw skipped it, `onClose` treats this deliberate close as an
    // unasked-for drop and hangs up the carrier leg as an error. It must not.
    expect(handle.endedBy).toBeUndefined();
  });

  it("does not resume the handoff when the call settles mid-drain", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession(f.params);
    const handle = await cs.attach("CA1", new FakeSocket());

    let resolveDrain!: (r: { confirmed: boolean; waitedMs: number }) => void;
    f.handle.drainOutbound = async () =>
      new Promise((resolve) => {
        resolveDrain = resolve;
      });

    f.emitTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
    f.emitTurnComplete();
    cs.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });

    await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });
    // The turn was already complete, so the handoff is now stalled inside the
    // drain, exactly like the two tests above at their halfway point.

    // The far end hangs up while the drain is still pending.
    await handle.stop("remote");
    expect(handle.endedBy).toBe("remote");
    // endCall found `this.session` still assigned (the handoff had not yet
    // reached the line that clears it) and closed it directly.
    expect(f.session.closed).toBe(true);

    // Let the stalled drain resolve. A handoff that resumes here would flip
    // `speakingPlaneRetired` and re-close a session that is already gone, on
    // a call that is already over — the exact case the post-connect
    // `if (this.settled)` check exists to prevent, mirrored here for the
    // drain.
    resolveDrain({ confirmed: false, waitedMs: 5_000 });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(handle.endedBy).toBe("remote");
    expect([...cs.phases]).toEqual([]);
  });
});
