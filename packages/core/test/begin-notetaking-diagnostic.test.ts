import { describe, expect, it } from "vitest";
import { routeToolCall, ToolGate, type ToolCarrier } from "../src/execution.js";

const T0 = "2026-08-20T18:00:00.000Z";
const AFTER = "2026-08-20T18:00:05.000Z";

const heard = (text: string, at: string): { text: string; at: string } => ({ text, at });

const meetingExecution = {
  meeting: {
    consent: {
      phrase: "go ahead and take notes",
      timeoutSeconds: 180,
      onTimeout: "hangUp" as const
    }
  }
};

function fakeCarrier(): ToolCarrier {
  return {
    sendDtmf: async () => {},
    endCall: async () => {},
    beginNotetaking: async () => {}
  };
}

/** `routeToolCall`'s `begin_notetaking` case answered the model on refusal
 * and told nobody else — call `CA0573ebc91a165c9c0230f8890915f87b`
 * (2026-08-20) looped on refusal for a minute with only
 * `modelTurnsCompleted: 7` left behind to explain why. `onDiagnostic` is the
 * same seam `CallSession` already reports the handoff and the drain
 * through. */
describe("routeToolCall — a refused begin_notetaking is no longer invisible", () => {
  it("emits a diagnostic naming the decision when begin_notetaking is refused", async () => {
    const diagnostics: string[] = [];
    const gate = new ToolGate(meetingExecution);
    let responded: string | undefined;

    await routeToolCall({
      call: { id: "t1", name: "begin_notetaking", args: {} },
      gate,
      carrier: fakeCarrier(),
      callId: "CA-TEST",
      respond: (result) => {
        responded = result;
      },
      heard: [heard("sure, whatever", AFTER)],
      requestedAt: T0,
      modelTurnsCompleted: 1,
      onDiagnostic: (m) => diagnostics.push(m)
    });

    expect(responded).toBe("refused: the go-ahead phrase has not been spoken");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("begin_notetaking");
    expect(diagnostics[0]).toContain("refused: the go-ahead phrase has not been spoken");
  });

  // The safety property Defect 3's brief demands: the diagnostic reaches
  // disk, so it must never carry the accepted phrase or the caller's own
  // words — those are exactly what an attacker reading that disk would want.
  it("the diagnostic contains neither an accepted phrase nor the caller's utterance text", async () => {
    const diagnostics: string[] = [];
    const gate = new ToolGate(meetingExecution);

    await routeToolCall({
      call: { id: "t1", name: "begin_notetaking", args: {} },
      gate,
      carrier: fakeCarrier(),
      callId: "CA-TEST",
      respond: () => {},
      heard: [heard("please dont take notes, I mean it", AFTER)],
      requestedAt: T0,
      modelTurnsCompleted: 1,
      onDiagnostic: (m) => diagnostics.push(m)
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).not.toContain("please dont take notes");
    expect(diagnostics[0]).not.toContain("go ahead and take notes");
  });

  // Part 1's actual gap: before this, an ACCEPTED begin_notetaking logged
  // nothing at all, so a model that never called the tool and a model whose
  // call succeeded were both silent on disk — indistinguishable from each
  // other and from the refusal case above. Two live calls in a row
  // (2026-08-20) ended `consent_refused` with `modelTurnsCompleted: 4` and no
  // explanation, because nothing here logged the ACCEPT path either — there
  // was nothing to compare the silence against.
  it("also emits a diagnostic when begin_notetaking is authorized, naming the tool and the outcome", async () => {
    const diagnostics: string[] = [];
    const gate = new ToolGate(meetingExecution);

    await routeToolCall({
      call: { id: "t1", name: "begin_notetaking", args: {} },
      gate,
      carrier: fakeCarrier(),
      callId: "CA-TEST",
      respond: () => {},
      heard: [heard("go ahead and take notes", AFTER)],
      requestedAt: T0,
      modelTurnsCompleted: 1,
      onDiagnostic: (m) => diagnostics.push(m)
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("begin_notetaking");
    expect(diagnostics[0]).toContain("ok");
  });

  // Same safety property as the refusal case, checked on the accept path:
  // this is written to disk, and the accepted phrase is exactly what an
  // attacker reading that disk would want.
  it("the accepted diagnostic contains neither the accepted phrase nor caller utterance text", async () => {
    const diagnostics: string[] = [];
    const gate = new ToolGate(meetingExecution);

    await routeToolCall({
      call: { id: "t1", name: "begin_notetaking", args: {} },
      gate,
      carrier: fakeCarrier(),
      callId: "CA-TEST",
      respond: () => {},
      heard: [heard("go ahead and take notes", AFTER)],
      requestedAt: T0,
      modelTurnsCompleted: 1,
      onDiagnostic: (m) => diagnostics.push(m)
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).not.toContain("go ahead and take notes");
  });
});

/** Part 1's other gap: `routeToolCall` only ever sees a call the model
 * actually MADE — a model that never calls at all leaves no trace there no
 * matter what this function logs. Every OTHER tool a call can route also
 * needs the same "named the tool and the outcome" property; begin_notetaking
 * already had a detailed refusal line, and this checks the three that never
 * had anything. */
describe("routeToolCall — every tool call is now named on the way out, not only begin_notetaking's refusal", () => {
  it("logs an accepted press_digits", async () => {
    const diagnostics: string[] = [];
    const gate = new ToolGate({
      ivr: { maxPresses: 10, allowedDigits: "0123456789", onUnrecognized: "hangUp" }
    });

    await routeToolCall({
      call: { id: "t1", name: "press_digits", args: { digits: "123" } },
      gate,
      carrier: fakeCarrier(),
      callId: "CA-TEST",
      respond: () => {},
      onDiagnostic: (m) => diagnostics.push(m)
    });

    expect(diagnostics).toEqual(["press_digits ok"]);
  });

  it("logs a refused record_outcome", async () => {
    const diagnostics: string[] = [];
    const gate = new ToolGate({});

    await routeToolCall({
      call: { id: "t1", name: "record_outcome", args: { status: "bogus", fields: {} } },
      gate,
      carrier: fakeCarrier(),
      callId: "CA-TEST",
      respond: () => {},
      onDiagnostic: (m) => diagnostics.push(m)
    });

    expect(diagnostics).toEqual(["record_outcome refused: invalid arguments"]);
  });

  it("logs an undeclared tool name rather than staying silent on it", async () => {
    const diagnostics: string[] = [];
    const gate = new ToolGate({});

    await routeToolCall({
      call: { id: "t1", name: "not_a_real_tool", args: {} },
      gate,
      carrier: fakeCarrier(),
      callId: "CA-TEST",
      respond: () => {},
      onDiagnostic: (m) => diagnostics.push(m)
    });

    expect(diagnostics).toEqual(["not_a_real_tool refused: tool not available"]);
  });
});
