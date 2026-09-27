import { describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { FakeSocket, makeMeetingFakes, makeMeetingParams } from "./helpers/call-session-harness.js";

/**
 * A live call found a design defect in the consent gate: the declared phrase
 * was "go ahead and take notes", the principal answered "go ahead" — several
 * times — and a length-only substring match refused every one of them,
 * because "go ahead" is not a substring of a four-word phrase. The call ended
 * with no consent, no transcript, and a record saying `consent_refused`.
 *
 * The fix is ORDERING, not length: an utterance counts as consent only if it
 * arrived after the agent's request. These tests reproduce the reported
 * failure end-to-end through `CallSession`/`begin_notetaking` — the same
 * path a real call runs, not just the isolated `ToolGate` unit — and the
 * risk the ordering rule exists for (the same short phrase, said before
 * anything was asked, must not retroactively grant consent).
 */

const shortPhraseExecution = () =>
  ({
    meeting: {
      consent: {
        phrase: "go ahead",
        timeoutSeconds: 180,
        onTimeout: "hangUp" as const
      }
    }
  }) as const;

describe("the reported failure: a short natural reply, heard after the request, is authorized", () => {
  it("admits begin_notetaking when the model asks and the principal answers 'go ahead' — driven through the real tool-call path", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession({ ...f.params, execution: shortPhraseExecution() });
    await cs.attach("CA1", new FakeSocket());

    f.emitTranscript({
      speaker: "model",
      text: "I'm an AI assistant sitting in for the host.",
      isFinal: true
    });
    f.emitTurnComplete();
    f.emitTranscript({
      speaker: "model",
      text: "Does anyone object to me taking notes?",
      isFinal: true
    });
    f.emitTurnComplete();
    // The exact words from the incident: not the declared four-word phrase,
    // the ordinary human reply.
    cs.noteTranscript({ speaker: "participant", text: "go ahead", isFinal: true });

    await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

    expect(f.toolResponses).toEqual([{ id: "t1", result: "ok" }]);
    expect([...cs.phases]).toEqual(["listening"]);
    expect(cs.consentReceipt?.matchedPhrase).toBe("go ahead");
  });

  it("admits repeated short replies too — the incident had several, not one", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession({ ...f.params, execution: shortPhraseExecution() });
    await cs.attach("CA1", new FakeSocket());

    f.emitTranscript({ speaker: "model", text: "Any objection to notes?", isFinal: true });
    f.emitTurnComplete();
    cs.noteTranscript({ speaker: "participant", text: "go ahead", isFinal: true });
    cs.noteTranscript({ speaker: "participant", text: "go ahead", isFinal: true });
    cs.noteTranscript({ speaker: "participant", text: "yeah go ahead", isFinal: true });

    await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

    expect(f.toolResponses).toEqual([{ id: "t1", result: "ok" }]);
  });
});

describe("the risk the ordering rule exists for: a matching utterance said before the request", () => {
  it("refuses begin_notetaking when 'go ahead' was said before the agent ever asked", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const f = makeMeetingFakes();
      const cs = new CallSession({ ...f.params, execution: shortPhraseExecution() });
      await cs.attach("CA1", new FakeSocket());

      // Said to someone else in the room, well before the agent has spoken
      // at all.
      cs.noteTranscript({ speaker: "participant", text: "go ahead", isFinal: true });

      vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
      f.emitTranscript({ speaker: "model", text: "Any objection to notes?", isFinal: true });
      f.emitTurnComplete();

      await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

      expect(f.toolResponses).toEqual([
        { id: "t1", result: "refused: the go-ahead phrase has not been spoken" }
      ]);
      expect([...cs.phases]).toEqual(["speaking"]);
      expect(cs.consentReceipt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses buildConsentReceipt (the direct path) for the same reason, with real timestamps controlling order", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const session = new CallSession({
        ...makeMeetingParams(),
        execution: shortPhraseExecution()
      });
      await session.attach("CA1", new FakeSocket());

      // The go-ahead lands FIRST, well before the request.
      session.noteTranscript({ speaker: "caller", text: "go ahead", isFinal: true });

      vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
      session.noteTranscript({
        speaker: "model",
        text: "Any objection to my taking notes?",
        isFinal: true
      });

      await expect(session.beginNotetaking()).rejects.toThrow(
        /no go-ahead utterance in the pre-consent buffer/
      );
      expect(session.consentReceipt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits once the SAME words are repeated after the request, having refused them before it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const session = new CallSession({
        ...makeMeetingParams(),
        execution: shortPhraseExecution()
      });
      await session.attach("CA1", new FakeSocket());

      session.noteTranscript({ speaker: "caller", text: "go ahead", isFinal: true });

      vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
      session.noteTranscript({
        speaker: "model",
        text: "Any objection to my taking notes?",
        isFinal: true
      });

      vi.setSystemTime(new Date("2026-01-01T00:00:35.000Z"));
      session.noteTranscript({ speaker: "caller", text: "go ahead", isFinal: true });

      await session.beginNotetaking();
      expect(session.consentReceipt?.grantedAt).toBe("2026-01-01T00:00:35.000Z");
      expect(session.consentReceipt?.matchedPhrase).toBe("go ahead");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("multiple accepted phrases", () => {
  const multiPhraseExecution = () =>
    ({
      meeting: {
        consent: {
          phrase: "go ahead and take notes",
          additionalPhrases: ["sure thing", "sounds good to me"],
          timeoutSeconds: 180,
          onTimeout: "hangUp" as const
        }
      }
    }) as const;

  it("grants on the primary phrase, and the receipt names it as the match", async () => {
    const session = new CallSession({ ...makeMeetingParams(), execution: multiPhraseExecution() });
    await session.attach("CA1", new FakeSocket());
    session.noteTranscript({ speaker: "model", text: "Any objection to notes?", isFinal: true });
    session.noteTranscript({
      speaker: "caller",
      text: "go ahead and take notes",
      isFinal: true
    });
    await session.beginNotetaking();
    expect(session.consentReceipt?.matchedPhrase).toBe("go ahead and take notes");
  });

  it("grants on the first additional phrase, on its own, and the receipt names THAT phrase — not the primary one", async () => {
    const session = new CallSession({ ...makeMeetingParams(), execution: multiPhraseExecution() });
    await session.attach("CA1", new FakeSocket());
    session.noteTranscript({ speaker: "model", text: "Any objection to notes?", isFinal: true });
    session.noteTranscript({ speaker: "caller", text: "yeah, sure thing", isFinal: true });
    await session.beginNotetaking();
    expect(session.consentReceipt?.matchedPhrase).toBe("sure thing");
    // `phrase` still names the configured primary — the receipt records BOTH
    // what was configured and what actually happened.
    expect(session.consentReceipt?.phrase).toBe("go ahead and take notes");
  });

  it("grants on the second additional phrase, on its own", async () => {
    const session = new CallSession({ ...makeMeetingParams(), execution: multiPhraseExecution() });
    await session.attach("CA1", new FakeSocket());
    session.noteTranscript({ speaker: "model", text: "Any objection to notes?", isFinal: true });
    session.noteTranscript({
      speaker: "caller",
      text: "That sounds good to me.",
      isFinal: true
    });
    await session.beginNotetaking();
    expect(session.consentReceipt?.matchedPhrase).toBe("sounds good to me");
  });

  it("refuses when none of the accepted phrases were heard", async () => {
    const session = new CallSession({ ...makeMeetingParams(), execution: multiPhraseExecution() });
    await session.attach("CA1", new FakeSocket());
    session.noteTranscript({ speaker: "model", text: "Any objection to notes?", isFinal: true });
    session.noteTranscript({ speaker: "caller", text: "hmm, let me think", isFinal: true });
    await expect(session.beginNotetaking()).rejects.toThrow();
    expect(session.consentReceipt).toBeUndefined();
  });
});

describe("the receipt records which utterance actually granted consent", () => {
  it("names the matched phrase even for a plain single-phrase envelope (no additionalPhrases declared)", async () => {
    const session = new CallSession(makeMeetingParams());
    await session.attach("CA1", new FakeSocket());
    session.noteTranscript({ speaker: "model", text: "Any objection to notes?", isFinal: true });
    session.noteTranscript({
      speaker: "caller",
      text: "sure, go ahead and take notes",
      isFinal: true
    });
    await session.beginNotetaking();
    expect(session.consentReceipt?.matchedPhrase).toBe("go ahead and take notes");
    expect(session.consentReceipt?.phrase).toBe("go ahead and take notes");
  });
});

describe("a single-`phrase` envelope still behaves exactly as it does today", () => {
  it("every existing single-phrase scenario (unaffected by additionalPhrases or ordering) still works: request then go-ahead, no additionalPhrases", async () => {
    const session = new CallSession(makeMeetingParams());
    await session.attach("CA1", new FakeSocket());
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
    expect(receipt?.matchedPhrase).toBe("go ahead and take notes");
  });

  it("still refuses when the phrase is nowhere in the buffer at all, no additionalPhrases declared", async () => {
    const session = new CallSession(makeMeetingParams());
    await session.attach("CA1", new FakeSocket());
    session.noteTranscript({ speaker: "caller", text: "sure, sounds fine", isFinal: true });
    await expect(session.beginNotetaking()).rejects.toThrow();
    expect(session.consentReceipt).toBeUndefined();
  });
});
