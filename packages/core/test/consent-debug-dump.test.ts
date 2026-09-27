import { afterEach, describe, expect, it } from "vitest";
import {
  CONSENT_DEBUG_ENV_VAR,
  routeToolCall,
  ToolGate,
  type ToolCarrier
} from "../src/execution.js";

/**
 * The dump exists because the live failure left one line — `heard=2
 * eligible=1 requested=true` — and the cause was invisible in it. The
 * go-ahead was counted eligible against the boundary that line reported and
 * refused against a different one, so the numbers said "a qualifying
 * utterance was there" while the gate said "nothing qualified" and neither
 * was wrong. Diagnosing that took another live call.
 *
 * It is also the one thing in this file that writes what people said. On a
 * refused call the design persists none of it — `consentReceipt: null`, the
 * buffer dropped at hangup — so these tests pin the switch as hard as they
 * pin the output: OFF unless explicitly set, and never on by omission.
 */

const T0 = "2026-08-21T18:00:00.000Z";
const AFTER = "2026-08-21T18:00:05.000Z";
const LATER = "2026-08-21T18:00:09.000Z";
const BEFORE = "2026-08-21T17:59:00.000Z";

const heard = (
  text: string,
  at: string,
  speaker?: "participant"
): { text: string; at: string; speaker?: "participant" } => ({
  text,
  at,
  ...(speaker ? { speaker } : {})
});

const meetingExecution = {
  meeting: {
    consent: {
      phrase: "go ahead",
      additionalPhrases: ["sounds good"],
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

async function route(
  said: readonly { text: string; at: string; speaker?: "participant" }[],
  opts: { requestedAt?: string; modelTurnsCompleted?: number } = {}
): Promise<string[]> {
  const diagnostics: string[] = [];
  await routeToolCall({
    call: { id: "t1", name: "begin_notetaking", args: {} },
    gate: new ToolGate(meetingExecution),
    carrier: fakeCarrier(),
    callId: "CA-TEST",
    respond: () => {},
    heard: said,
    requestedAt: "requestedAt" in opts ? opts.requestedAt : T0,
    modelTurnsCompleted: opts.modelTurnsCompleted ?? 1,
    onDiagnostic: (m) => diagnostics.push(m)
  });
  return diagnostics;
}

afterEach(() => {
  delete process.env[CONSENT_DEBUG_ENV_VAR];
});

describe("the consent debug dump is off unless it is switched on", () => {
  it("emits nothing beyond the ordinary content-free line when the variable is unset", async () => {
    const diagnostics = await route([heard("please dont take notes", AFTER, "participant")]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).not.toContain(CONSENT_DEBUG_ENV_VAR);
    // The standing promise: no accepted phrase, no caller words, on the path
    // that runs in normal operation.
    expect(diagnostics[0]).not.toContain("please dont take notes");
    expect(diagnostics[0]).not.toContain("go ahead");
  });

  for (const off of ["", "0", "false"]) {
    it(`stays off for ${JSON.stringify(off)} — a value that reads as "no" must not enable it`, async () => {
      process.env[CONSENT_DEBUG_ENV_VAR] = off;
      const diagnostics = await route([heard("please dont take notes", AFTER, "participant")]);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).not.toContain("dump");
    });
  }
});

describe("switched on, it reports everything the gate decided from", () => {
  it("names the boundary, the phrase list, the turn count and the decision", async () => {
    process.env[CONSENT_DEBUG_ENV_VAR] = "1";
    const diagnostics = await route([heard("hmm, let me think", AFTER, "participant")]);
    const dump = diagnostics.find((d) => d.includes("dump"));
    expect(dump).toBeDefined();
    expect(dump).toContain(`boundary=${T0}`);
    expect(dump).toContain("turnsCompleted=1");
    expect(dump).toContain("decision=refused: the go-ahead phrase has not been spoken");
    expect(dump).toContain('phrases=["go ahead","sounds good"]');
  });

  it("reports each eligible utterance with its speaker, instant and words", async () => {
    process.env[CONSENT_DEBUG_ENV_VAR] = "1";
    const diagnostics = await route([heard("hmm, let me think", AFTER, "participant")]);
    const dump = diagnostics.find((d) => d.includes("dump"))!;
    expect(dump).toContain("speaker=participant");
    expect(dump).toContain(`at=${AFTER}`);
    expect(dump).toContain('text="hmm, let me think"');
  });

  it("names which check rejected each utterance: a negation reads match=false negation=true", async () => {
    process.env[CONSENT_DEBUG_ENV_VAR] = "1";
    const diagnostics = await route([
      heard("go ahead", AFTER, "participant"),
      heard("actually, no", LATER, "participant")
    ]);
    const dump = diagnostics.find((d) => d.includes("dump"))!;
    expect(dump).toContain(`at=${AFTER} match=true negation=false`);
    expect(dump).toContain(`at=${LATER} match=false negation=true`);
    // Which one decided the call is the walk's own rule — newest first, stop
    // on a negation — and the dump is what makes that readable.
    expect(dump).toContain("decision=refused: the go-ahead phrase has not been spoken");
  });

  it("shows an utterance dropped for arriving before the boundary as absent, with the counts to say so", async () => {
    process.env[CONSENT_DEBUG_ENV_VAR] = "1";
    const diagnostics = await route([heard("go ahead", BEFORE, "participant")]);
    const dump = diagnostics.find((d) => d.includes("dump"))!;
    expect(dump).toContain("heard=1 eligible=0");
    expect(dump).not.toContain(`at=${BEFORE}`);
  });

  it("distinguishes the two refusals it was added to tell apart", async () => {
    process.env[CONSENT_DEBUG_ENV_VAR] = "1";
    const notAsked = await route([heard("go ahead", AFTER, "participant")], {
      modelTurnsCompleted: 0
    });
    expect(notAsked.find((d) => d.includes("dump"))).toContain(
      "decision=refused: the agent has not asked for consent yet"
    );

    const noBoundary = await route([heard("go ahead", AFTER, "participant")], {
      requestedAt: undefined
    });
    const dump = noBoundary.find((d) => d.includes("dump"))!;
    expect(dump).toContain("boundary=none");
    expect(dump).toContain("decision=refused: the agent has not asked for consent yet");
  });

  it("dumps an ACCEPTED call too — a grant with nothing eligible behind it is the bug most worth seeing", async () => {
    process.env[CONSENT_DEBUG_ENV_VAR] = "1";
    const diagnostics = await route([heard("sure, go ahead", AFTER, "participant")]);
    const dump = diagnostics.find((d) => d.includes("dump"))!;
    expect(dump).toContain("decision=ok");
    expect(dump).toContain("match=true");
  });
});
