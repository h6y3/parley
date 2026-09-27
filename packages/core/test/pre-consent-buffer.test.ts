import { describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { FakeSocket, makeMeetingFakes, makeMeetingParams } from "./helpers/call-session-harness.js";

describe("pre-consent buffer", () => {
  it("keeps caller speech in memory and out of the call transcript", async () => {
    const session = new CallSession(makeMeetingParams());
    const handle = await session.attach("CA1", new FakeSocket());
    session.noteTranscript({ speaker: "caller", text: "so about the roadmap", isFinal: true });
    expect(handle.transcript).toHaveLength(0);
    expect(session.heardBeforeConsent).toEqual(["so about the roadmap"]);
  });

  it("bounds the buffer rather than growing it for the length of a waiting room", async () => {
    const session = new CallSession(makeMeetingParams());
    await session.attach("CA1", new FakeSocket());
    for (let i = 0; i < 600; i += 1) {
      session.noteTranscript({ speaker: "caller", text: `line ${i}`, isFinal: true });
    }
    expect(session.heardBeforeConsent.length).toBeLessThanOrEqual(500);
    // The most recent survive: the go-ahead is the newest thing said.
    expect(session.heardBeforeConsent.at(-1)).toBe("line 599");
  });

  it("builds a receipt of exactly the announcement, the request and the go-ahead", async () => {
    const session = new CallSession(makeMeetingParams());
    await session.attach("CA1", new FakeSocket());
    session.noteTranscript({ speaker: "caller", text: "hold music noise", isFinal: true });
    session.noteTranscript({
      speaker: "model",
      text: "I'm an AI assistant for Jordan.",
      isFinal: true
    });
    session.noteTranscript({
      speaker: "model",
      text: "Any objection to my taking notes?",
      isFinal: true
    });
    session.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });
    await session.beginNotetaking();
    const receipt = session.consentReceipt;
    expect(receipt?.utterances.map((u) => u.text)).toEqual([
      "I'm an AI assistant for Jordan.",
      "Any objection to my taking notes?",
      "go ahead and take notes"
    ]);
    expect(receipt?.phrase).toBe("go ahead and take notes");
  });

  it("discards the whole buffer and writes no receipt when consent times out", async () => {
    vi.useFakeTimers();
    const session = new CallSession(makeMeetingParams());
    const handle = await session.attach("CA1", new FakeSocket());
    session.noteTranscript({ speaker: "caller", text: "private hallway chat", isFinal: true });
    await vi.advanceTimersByTimeAsync(181_000);
    expect(handle.endedBy).toBe("consentTimeout");
    expect(session.consentReceipt).toBeUndefined();
    expect(session.heardBeforeConsent).toEqual([]);
    expect(handle.transcript).toHaveLength(0);
    vi.useRealTimers();
  });
});

// `makeMeetingParams()` is built on `stubRealtime()`, whose `connect()`
// discards the callbacks object — nothing built from it can drive the REAL
// `onTranscript` callback, only the public `noteTranscript` shortcut. The
// four tests above all use that shortcut, which means the guards on the
// coalesced MODEL-fragment path in `onTranscript` itself — the code a real
// call actually runs — were exercised by nothing. `makeMeetingFakes()`
// closes that gap.
describe("pre-consent buffer — the coalesced model-fragment path", () => {
  it("keeps model speech out of the transcript before consent, mid-turn and after close, and still coalesces it correctly into the buffer", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession(f.params);
    const handle = await cs.attach("CA1", new FakeSocket());

    f.emitTranscript({ speaker: "model", text: "I'm an AI assistant", isFinal: false });
    expect(handle.transcript).toHaveLength(0); // mid-turn

    f.emitTranscript({ speaker: "model", text: " for Jordan.", isFinal: true });
    expect(handle.transcript).toHaveLength(0); // after close

    // The coalesced whole utterance still has to land in the buffer, or the
    // receipt loses the announcement entirely.
    cs.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });
    await cs.beginNotetaking();
    expect(cs.consentReceipt?.utterances.map((u) => u.text)).toContain(
      "I'm an AI assistant for Jordan."
    );
  });
});

// Finding 2: whether the growing model entry had already been logged used to
// be re-derived from `preConsentActive()` at close time — a predicate that
// can change value between the entry opening and closing. Consent granted
// mid-turn (the model hears the go-ahead and keeps talking in the same turn
// it calls begin_notetaking) flipped that predicate between open and close,
// and the entry was dropped: written to neither the buffer, the receipt, nor
// the transcript.
describe("pre-consent buffer — consent granted mid-turn", () => {
  it("does not drop an open model turn when consent is granted before the turn closes", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession(f.params);
    const handle = await cs.attach("CA1", new FakeSocket());

    cs.noteTranscript({
      speaker: "model",
      text: "I'm an AI assistant for Jordan.",
      isFinal: true
    });
    cs.noteTranscript({
      speaker: "model",
      text: "Any objection to my taking notes?",
      isFinal: true
    });
    cs.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });

    // The tool-call turn is still generating trailing speech when the
    // handoff runs — the realistic sequence.
    f.emitTranscript({ speaker: "model", text: "Great, starting notes now.", isFinal: false });
    await cs.beginNotetaking();

    // The still-open turn closes AFTER the handoff.
    f.emitTurnComplete();

    expect(handle.transcript.map((e) => e.text)).toContain("Great, starting notes now.");
    // It is post-consent speech, not part of the promise the receipt makes —
    // it must not retroactively appear there.
    expect(cs.consentReceipt?.utterances.map((u) => u.text)).not.toContain(
      "Great, starting notes now."
    );
  });
});

// Finding 3: the receipt is the audit artifact for a promise made aloud to a
// room. `beginNotetaking()` is public and has no phrase check of its own
// upstream of `buildConsentReceipt` — it must refuse rather than fabricate a
// grantedAt/utterances that assert consent when none was heard.
describe("pre-consent buffer — the receipt cannot be built without evidence", () => {
  it("refuses when the buffer holds no go-ahead at all", async () => {
    const session = new CallSession(makeMeetingParams());
    await session.attach("CA1", new FakeSocket());
    session.noteTranscript({ speaker: "caller", text: "sure, sounds fine", isFinal: true });
    await expect(session.beginNotetaking()).rejects.toThrow();
    // A refusal must not half-execute the handoff: buffer intact, no receipt.
    expect(session.consentReceipt).toBeUndefined();
    expect(session.heardBeforeConsent).toEqual(["sure, sounds fine"]);
  });

  it("refuses when the buffer is empty", async () => {
    const session = new CallSession(makeMeetingParams());
    await session.attach("CA1", new FakeSocket());
    await expect(session.beginNotetaking()).rejects.toThrow();
    expect(session.consentReceipt).toBeUndefined();
  });

  // Residual from round 2 review: the first throw only closes the case where
  // no go-ahead was found. This is the other half — a go-ahead IS found, but
  // no model speech is in the buffer at all, so there was never an
  // announcement or a request behind it. Reachable because a model turn can
  // complete carrying no words (the provider's synthesised empty `isFinal`
  // marker) — `modelTurnsCompleted >= 1` does not guarantee the buffer holds
  // anything the model said.
  it("refuses when a go-ahead was heard but no model speech was ever recorded", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession(f.params);
    await cs.attach("CA1", new FakeSocket());

    // A model turn completes with no words.
    f.emitTranscript({ speaker: "model", text: "", isFinal: true });
    f.emitTurnComplete();

    cs.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });
    await expect(cs.beginNotetaking()).rejects.toThrow();
    expect(cs.consentReceipt).toBeUndefined();
  });
});

// Finding 5: `requestedAt` names the REQUEST, not the opening announcement —
// `modelSaid` is [announcement, request] in that chronological order, so the
// field must read the LAST of the two, not the first.
describe("pre-consent buffer — requestedAt dates the request, not the announcement", () => {
  it("uses the later model utterance's timestamp for requestedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const session = new CallSession(makeMeetingParams());
    await session.attach("CA1", new FakeSocket());

    session.noteTranscript({
      speaker: "model",
      text: "I'm an AI assistant for Jordan.",
      isFinal: true
    });
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    session.noteTranscript({
      speaker: "model",
      text: "Any objection to my taking notes?",
      isFinal: true
    });
    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    session.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });

    await session.beginNotetaking();
    expect(session.consentReceipt?.requestedAt).toBe("2026-01-01T00:00:05.000Z");
    expect(session.consentReceipt?.grantedAt).toBe("2026-01-01T00:00:10.000Z");
    vi.useRealTimers();
  });
});
