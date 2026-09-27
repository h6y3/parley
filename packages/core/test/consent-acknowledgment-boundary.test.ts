import { describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { FakeSocket, makeMeetingFakes } from "./helpers/call-session-harness.js";

/**
 * The gate ruled out the go-ahead it had already matched.
 *
 * On a live meeting call the room said "go ahead" — a phrase on the gate's own
 * accepted list — the model acknowledged aloud that it was going quiet to take
 * notes, and then took none. The record said `status: "consent_refused"`,
 * `coveredMs: 0`, `consentReceipt: null`, and the one line on disk read
 * `begin_notetaking refused: the go-ahead phrase has not been spoken —
 * heard=2 eligible=1 requested=true`. The room was told notes were being
 * taken and none were, which in a design whose premise is a promise made
 * aloud is worse than never speaking at all.
 *
 * Nothing was wrong with the words or with `findConsentMatch`. The BOUNDARY
 * moved. `findConsentMatch` skips any utterance older than `requestedAt`, and
 * `requestedAt` was `lastModelUtteranceAt()` — the model's most recent
 * utterance, recomputed at tool-call time. `meetingConsentRequest`
 * (@parley/policy) requires the model to acknowledge the go-ahead and call
 * `begin_notetaking` in the SAME turn, so the acknowledgment is itself a later
 * model utterance and lands in the buffer first:
 *
 *   t1  model        announces, asks whether it may take notes
 *   t2  participant  "go ahead"
 *   t3  model        "I'll go quiet now"   <- lastModelUtteranceAt() becomes t3
 *   t3  model        calls begin_notetaking, judged against requestedAt = t3
 *
 * At t3 the go-ahead at t2 is `< requestedAt` and is skipped: the gate refused
 * a phrase it would have accepted one instant earlier. The two turns the rail
 * binds together are exactly what made the boundary outrun the answer.
 *
 * Every test here drives the REAL tool-call path through `CallSession`, and
 * every one advances the clock between utterances — a same-millisecond
 * recording is a tie, which `findConsentMatch` admits deliberately, and a tie
 * cannot reproduce an ordering defect.
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

const T0 = Date.parse("2026-08-21T17:00:00.000Z");
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
const tick = (seconds: number): void => {
  vi.setSystemTime(new Date(T0 + seconds * 1000));
};

/** The live call's own sequence up to the instant before the tool call: the
 * agent announces and asks, the room answers, the agent acknowledges — and
 * that acknowledgment closes into the pre-consent buffer as a model utterance
 * NEWER than the go-ahead, which is the whole defect. */
async function driveUpToTheAcknowledgment(): Promise<{
  f: ReturnType<typeof makeMeetingFakes>;
  cs: CallSession;
}> {
  const f = makeMeetingFakes();
  const cs = new CallSession({ ...f.params, execution: shortPhraseExecution() });
  await cs.attach("CA1", new FakeSocket());

  tick(1);
  f.emitTranscript({
    speaker: "model",
    text: "I'm an AI assistant on the line for Jordan Rivera.",
    isFinal: true
  });
  f.emitTurnComplete();

  tick(5);
  f.emitTranscript({ speaker: "model", text: "Is it all right if I take notes?", isFinal: true });
  f.emitTurnComplete();

  tick(10);
  cs.noteTranscript({ speaker: "participant", text: "go ahead", isFinal: true });

  // The acknowledgment the rail requires, in the same turn as the call that
  // follows it — so no `emitTurnComplete` here.
  tick(12);
  f.emitTranscript({ speaker: "model", text: "Thanks — I'll go quiet now.", isFinal: true });

  return { f, cs };
}

describe("the live failure: the model's acknowledgment moved the boundary past the go-ahead", () => {
  it("authorizes begin_notetaking anyway — the consent the room actually gave is the consent the gate honours", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const { f, cs } = await driveUpToTheAcknowledgment();

      tick(12);
      await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

      expect(f.toolResponses).toEqual([{ id: "t1", result: "ok" }]);
      expect([...cs.phases]).toEqual(["listening"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attributes the go-ahead in the receipt: the request that was answered, the answer, and the words of both", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const { f, cs } = await driveUpToTheAcknowledgment();

      tick(12);
      await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

      const receipt = cs.consentReceipt;
      expect(receipt?.matchedPhrase).toBe("go ahead");
      expect(receipt?.phrase).toBe("go ahead");
      // The REQUEST, at t=5 — not the acknowledgment at t=12. A receipt dated
      // from the acknowledgment would claim consent was granted before it was
      // requested, which `meetingRecordSchema` (@parley/cli) states as an
      // invariant of its own: "at or after requestedAt".
      expect(receipt?.requestedAt).toBe(at(5));
      expect(receipt?.grantedAt).toBe(at(10));
      expect(receipt!.grantedAt >= receipt!.requestedAt).toBe(true);
      expect(receipt?.utterances.map((u) => u.text)).toEqual([
        "I'm an AI assistant on the line for Jordan Rivera.",
        "Is it all right if I take notes?",
        "go ahead"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The four properties the fix had to leave standing. Firing the handoff EARLY
 * is the dangerous direction — after it there is no speaking plane left to
 * correct or apologise with — so a fix that made consent easier to satisfy in
 * general would be worse than the defect it closed.
 */
describe("what the anchored boundary must NOT have loosened", () => {
  it("the model still cannot authorize itself, even saying the phrase after its own request", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const f = makeMeetingFakes();
      const cs = new CallSession({ ...f.params, execution: shortPhraseExecution() });
      await cs.attach("CA1", new FakeSocket());

      tick(5);
      f.emitTranscript({
        speaker: "model",
        text: "Is it all right if I take notes?",
        isFinal: true
      });
      f.emitTurnComplete();

      // The model says the accepted phrase itself. Nobody else says anything.
      tick(10);
      f.emitTranscript({ speaker: "model", text: "go ahead", isFinal: true });

      tick(11);
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

  it("still refuses a go-ahead spoken before the agent ever asked — the anchor is never set by an utterance that answered nothing", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const f = makeMeetingFakes();
      const cs = new CallSession({ ...f.params, execution: shortPhraseExecution() });
      await cs.attach("CA1", new FakeSocket());

      // Said to someone else in the room, before the agent has spoken at all.
      tick(2);
      cs.noteTranscript({ speaker: "participant", text: "go ahead", isFinal: true });

      tick(30);
      f.emitTranscript({
        speaker: "model",
        text: "Is it all right if I take notes?",
        isFinal: true
      });
      f.emitTurnComplete();

      tick(31);
      await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

      expect(f.toolResponses).toEqual([
        { id: "t1", result: "refused: the go-ahead phrase has not been spoken" }
      ]);
      expect(cs.consentReceipt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a negation after the go-ahead still withdraws it — the anchor pins the boundary, never the verdict", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const { f, cs } = await driveUpToTheAcknowledgment();

      // "Actually, no" — after the go-ahead AND after the acknowledgment that
      // moved the boundary. A latch that stored the MATCH rather than the
      // boundary would replay the earlier grant here.
      tick(14);
      cs.noteTranscript({ speaker: "participant", text: "actually, no", isFinal: true });

      tick(15);
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

  it("and the same room correcting itself forward is authorized again — a withdrawal is not permanent either", async () => {
    vi.useFakeTimers();
    try {
      tick(0);
      const { f, cs } = await driveUpToTheAcknowledgment();

      tick(14);
      cs.noteTranscript({ speaker: "participant", text: "actually, no", isFinal: true });

      tick(16);
      f.emitTranscript({ speaker: "model", text: "Understood — I won't.", isFinal: true });
      f.emitTurnComplete();

      tick(18);
      cs.noteTranscript({ speaker: "participant", text: "sorry, go ahead", isFinal: true });

      tick(19);
      await f.emitToolCall({ id: "t1", name: "begin_notetaking", args: {} });

      expect(f.toolResponses).toEqual([{ id: "t1", result: "ok" }]);
      expect(cs.consentReceipt?.grantedAt).toBe(at(18));
    } finally {
      vi.useRealTimers();
    }
  });
});
