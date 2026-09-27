import { describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { isConsentDenial } from "../src/execution.js";
import { FakeSocket, makeMeetingFakes } from "./helpers/call-session-harness.js";

/**
 * A refused meeting used to stay on the bridge, silent, until somebody else
 * hung up: the agent asked, was told no, and then simply remained. It now says
 * a short goodbye and leaves.
 *
 * The two distinctions this has to get right, and the reason it is not simply
 * "hang up when the gate refuses":
 *
 *  - A DENIAL is not "consent not yet given". Waiting for an answer is the
 *    ordinary state of every pre-consent meeting, and it must never end a
 *    call; the consent window's own timeout owns that, at the timeout the
 *    caller configured, and keeps its own `EndReason` so the record can tell
 *    "they said no" from "nobody replied".
 *  - Leaving is as irreversible as the handoff and fails closed the other
 *    way. The gate refuses consent on any negation near a phrase, so "oh no,
 *    sorry — go ahead" takes no notes; ending the call on that same sentence
 *    would be wrong, so a departure needs a refusal with no accepted phrase
 *    anywhere in it.
 *
 * The grace window is six seconds (`CONSENT_DEPARTURE_GRACE_MS`), so every
 * test here drives fake timers past it deliberately rather than waiting.
 */

const T0 = Date.parse("2026-08-21T19:00:00.000Z");
const tick = (seconds: number): void => {
  vi.setSystemTime(new Date(T0 + seconds * 1000));
};

const GRACE_MS = 6_000;

/** A meeting that has announced itself and asked, with the room silent so far. */
async function askedAndWaiting(): Promise<{
  f: ReturnType<typeof makeMeetingFakes>;
  cs: CallSession;
  handle: Awaited<ReturnType<CallSession["attach"]>>;
  diagnostics: string[];
}> {
  const f = makeMeetingFakes();
  const diagnostics: string[] = [];
  const cs = new CallSession({ ...f.params, onDiagnostic: (m) => diagnostics.push(m) });
  const handle = await cs.attach("CA1", new FakeSocket());

  tick(2);
  f.emitTranscript({
    speaker: "model",
    text: "I'm an AI assistant on the line for Jordan Rivera.",
    isFinal: true
  });
  f.emitTurnComplete();

  tick(6);
  f.emitTranscript({ speaker: "model", text: "Is it all right if I take notes?", isFinal: true });
  f.emitTurnComplete();

  return { f, cs, handle, diagnostics };
}

describe("a refused meeting leaves", () => {
  it("ends the call as consentDenied after the goodbye window, having said so on the way out", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const { cs, handle, diagnostics } = await askedAndWaiting();

      tick(10);
      cs.noteTranscript({ speaker: "participant", text: "no, please don't", isFinal: true });

      // Still on the line while the goodbye is said — hanging up on the
      // instant of the refusal is the rudeness the window exists to avoid.
      await vi.advanceTimersByTimeAsync(GRACE_MS - 500);
      expect(handle.endedBy).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(handle.endedBy).toBe("consentDenied");
      expect(cs.consentReceipt).toBeUndefined();
      expect(handle.transcript).toHaveLength(0);
      // Content-free, like every other diagnostic on this class.
      expect(diagnostics.some((d) => d.includes("consent refused by the room"))).toBe(true);
      expect(diagnostics.some((d) => d.includes("please don't"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps nothing the room said before the refusal — the promise the announcement made", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const { cs, handle } = await askedAndWaiting();

      tick(8);
      cs.noteTranscript({ speaker: "participant", text: "so about the roadmap", isFinal: true });
      tick(10);
      cs.noteTranscript({ speaker: "participant", text: "no thanks", isFinal: true });

      await vi.advanceTimersByTimeAsync(GRACE_MS + 500);
      expect(handle.endedBy).toBe("consentDenied");
      expect(cs.heardBeforeConsent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what must NOT end the call", () => {
  it("silence does not: a room that has not answered is waiting, and waiting is the consent window's business", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const { handle } = await askedAndWaiting();

      // Well past the departure window, nowhere near the 180s consent timeout.
      await vi.advanceTimersByTimeAsync(GRACE_MS * 5);
      expect(handle.endedBy).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unrelated remark does not, however long it goes on", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const { cs, handle } = await askedAndWaiting();

      tick(10);
      cs.noteTranscript({ speaker: "participant", text: "who just joined?", isFinal: true });
      tick(14);
      cs.noteTranscript({ speaker: "participant", text: "can you hear us?", isFinal: true });

      await vi.advanceTimersByTimeAsync(GRACE_MS * 3);
      expect(handle.endedBy).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refusal spoken BEFORE the agent asked does not — it answered nothing", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const f = makeMeetingFakes();
      const cs = new CallSession(f.params);
      const handle = await cs.attach("CA1", new FakeSocket());

      // Two people in the room, mid-conversation, before the agent speaks.
      tick(3);
      cs.noteTranscript({ speaker: "participant", text: "no, that won't work", isFinal: true });

      await vi.advanceTimersByTimeAsync(GRACE_MS * 3);
      expect(handle.endedBy).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a negation wrapped around an accepted phrase does not — the gate still refuses it, but it is not an unambiguous no", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const { f, cs, handle } = await askedAndWaiting();

      // Refuses consent (negation outside the phrase's span) but is not a
      // refusal of the request — the room is agreeing, awkwardly.
      tick(10);
      cs.noteTranscript({
        speaker: "participant",
        text: "oh no, sorry — go ahead and take notes",
        isFinal: true
      });

      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
      expect(handle.endedBy).toBeUndefined();

      // And the agent is still there to be told again, plainly.
      tick(20);
      cs.noteTranscript({ speaker: "participant", text: "go ahead and take notes", isFinal: true });
      await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });
      expect(f.toolResponses).toEqual([{ id: "t1", result: "ok" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a room that changes its mind inside the window keeps its meeting", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const { f, cs, handle } = await askedAndWaiting();

      tick(10);
      cs.noteTranscript({ speaker: "participant", text: "no, don't", isFinal: true });

      await vi.advanceTimersByTimeAsync(2_000);
      tick(12);
      cs.noteTranscript({
        speaker: "participant",
        text: "actually go ahead and take notes",
        isFinal: true
      });

      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
      expect(handle.endedBy).toBeUndefined();

      await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });
      expect(f.toolResponses).toEqual([{ id: "t1", result: "ok" }]);
      expect(cs.consentReceipt?.matchedPhrase).toBe("go ahead and take notes");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a consented meeting is never taken down by a refusal heard before the handoff", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const { f, cs, handle } = await askedAndWaiting();

      tick(10);
      cs.noteTranscript({ speaker: "participant", text: "no, don't", isFinal: true });
      tick(12);
      cs.noteTranscript({ speaker: "participant", text: "go ahead and take notes", isFinal: true });
      await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });
      expect([...cs.phases]).toEqual(["listening"]);

      await vi.advanceTimersByTimeAsync(GRACE_MS * 3);
      expect(handle.endedBy).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isConsentDenial — the words that end a meeting, and the ones that do not", () => {
  const phrases = ["go ahead and take notes", "no objection"];

  it("plain refusals are denials", () => {
    for (const text of ["no", "no thanks", "please don't", "I'd rather not", "absolutely not"]) {
      expect(isConsentDenial(text, phrases)).toBe(true);
    }
  });

  it("an utterance carrying an accepted phrase is never a denial, however it is wrapped", () => {
    expect(isConsentDenial("oh no, sorry — go ahead and take notes", phrases)).toBe(false);
    // "no objection" is itself a declared phrase: the negation is the phrase.
    expect(isConsentDenial("no objection here", phrases)).toBe(false);
  });

  it("a negation-shaped substring inside an ordinary word is not a negation", () => {
    expect(isConsentDenial("go ahead and take notes", phrases)).toBe(false);
    expect(isConsentDenial("I cannot see the screen", phrases)).toBe(false);
  });

  it("says nothing about an utterance with no negation in it at all", () => {
    expect(isConsentDenial("who just joined?", phrases)).toBe(false);
  });
});
