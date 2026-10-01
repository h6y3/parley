import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEETING_CONNECTED_CUE,
  MEETING_OPENING_TRIGGER,
  OPENING_TRIGGER,
  type OpeningDelivery
} from "@parley/core";
import { runCallScenario, type ScenarioTraceEvent } from "../src/call-scenario-runner.js";
import { evaluateCallScenario } from "../src/call-scenario-evaluation.js";
import type { CallScenario, ScenarioTurn } from "../src/call-scenario.js";
import type { ScenarioTransport } from "../src/scenario-transport.js";

const FAST = { stallMs: 300, settleMs: 10, wallClockMs: 8_000 };

function scenario(script: ScenarioTurn[]): CallScenario {
  return {
    id: "s1",
    description: "d",
    envelope: {
      version: 2,
      brief: { to: "+15555550142", persona: "p", objective: "o", facts: [], preferences: [] },
      policy: {
        principalName: "Jordan Rivera",
        identity: { style: "silent" },
        disclosure: { honestIfAsked: true, volunteer: false },
        scope: { lock: true },
        grounding: { antiInvention: false },
        deferral: { enabled: true },
        authority: {},
        ivr: { goal: "the service department" },
        voicemail: { onMachine: "hangUp" },
        wrapUp: { enabled: true }
      },
      execution: {
        ivr: { maxPresses: 4, allowedDigits: "0123456789*#", onUnrecognized: "zeroOut" },
        limits: { maxDurationSeconds: 600 }
      }
    },
    params: {
      menu: [{ option: "service", digit: "1" }],
      correctDigit: "1",
      quotedAmount: null,
      raisedTopic: null,
      adjacentIndex: null,
      offersAppointment: true,
      reachesSomeoneWhoCanAct: true
    },
    script
  };
}

type On = Parameters<ScenarioTransport["connect"]>[0]["on"];

/** A transport with no vendor behind it: `respond` scripts what the model
 * does in reply to each line sent (send 1 is the opening trigger). */
function fakeTransport(
  respond: (on: On, text: string, n: number) => void,
  openingDelivery: OpeningDelivery = "turn"
) {
  const sent: string[] = [];
  let on: On | undefined;
  let systemInstruction: string | undefined;
  const transport: ScenarioTransport = {
    completesAfterToolResponse: true,
    openingDelivery,
    async connect(p) {
      on = p.on;
      systemInstruction = p.systemInstruction;
    },
    sendCalleeText(text) {
      sent.push(text);
      const n = sent.length;
      setTimeout(() => on && respond(on, text, n), 5);
    },
    sendToolResponse() {},
    async close() {}
  };
  return {
    transport,
    sent,
    systemInstruction: (): string | undefined => systemInstruction
  };
}

describe("the runner drives any transport", () => {
  it("sends the opening trigger, then each line on the model's completed turn", async () => {
    const fake = fakeTransport((on) => {
      on.modelText("ok");
      on.turnComplete();
    });
    const result = await runCallScenario({
      scenario: scenario([
        { label: "a", text: "one" },
        { label: "b", text: "two" }
      ]),
      transport: fake.transport,
      timings: FAST
    });
    expect(fake.sent).toEqual([OPENING_TRIGGER, "one", "two"]);
    expect(result.endedBecause).toBe("script-exhausted");
    expect(result.modelTurns).toEqual(["ok", "ok", "ok"]);
  });

  it("puts the same date sentence in the instruction a real call sends, before any opening suffix", async () => {
    const fake = fakeTransport((on) => on.turnComplete(), "prompt");
    await runCallScenario({
      scenario: scenario([{ label: "a", text: "one" }]),
      transport: fake.transport,
      timings: FAST,
      today: { now: new Date("2026-09-30T20:30:00Z"), timeZone: "Asia/Tokyo" }
    });
    const instruction = fake.systemInstruction()!;
    expect(instruction.split("Today is Thursday, 2026-10-01 (Asia/Tokyo).").length - 1).toBe(1);
    expect(instruction.indexOf("Today is")).toBeLessThan(instruction.indexOf(OPENING_TRIGGER));
  });

  it("ends a run whose session dies underneath it as transport-closed, and says why", async () => {
    // Not a stall: waiting out the stall timer would report a model that went
    // quiet. Not a rejection either: layers 2-3 read failure RATES, and one
    // flaky session must not abort the batch it is part of.
    const trace: ScenarioTraceEvent[] = [];
    const fake = fakeTransport((on, _t, n) => {
      if (n === 1) {
        on.modelText("Hello.");
        on.turnComplete();
      } else on.closed("socket went away");
    });
    const run = await runCallScenario({
      scenario: scenario([
        { label: "a", text: "one" },
        { label: "b", text: "two" }
      ]),
      transport: fake.transport,
      timings: FAST,
      trace: (e) => trace.push(e)
    });
    expect(run.endedBecause).toBe("transport-closed");
    expect(run.turnsDelivered).toBe(1);
    expect(trace).toContainEqual(
      expect.objectContaining({ type: "transport-closed", reason: "socket went away" })
    );
    const failures = evaluateCallScenario(
      scenario([
        { label: "a", text: "one" },
        { label: "b", text: "two" }
      ]),
      run
    ).failures;
    expect(failures.map((f) => f.code)).toContain("transport-closed");
    expect(failures.find((f) => f.code === "transport-closed")?.detail).toContain(
      "socket went away"
    );
  });

  it("rejects when the transport cannot connect", async () => {
    const transport: ScenarioTransport = {
      completesAfterToolResponse: true,
      openingDelivery: "turn",
      connect: async () => {
        throw new Error("refused settings");
      },
      sendCalleeText: () => {},
      sendToolResponse: () => {},
      close: async () => {}
    };
    await expect(
      runCallScenario({ scenario: scenario([]), transport, timings: FAST })
    ).rejects.toThrow("refused settings");
  });
});

/** The ring before pickup. The opening trigger tells the model to say nothing
 * until the other end has spoken, and Gemini 3.8 spoke during that silence in
 * one of three probe sessions — so the matrix has to be able to see it. */
describe("trigger silence: firstLineDelayMs and spoke-before-callee", () => {
  const RING = { stallMs: 30_000, settleMs: 10, wallClockMs: 60_000, firstLineDelayMs: 3_000 };
  const oneLine = (): CallScenario => scenario([{ label: "hello", text: "Hello?" }]);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags a model that speaks during the ring", async () => {
    vi.useFakeTimers();
    const fake = fakeTransport((on, _t, n) => {
      if (n === 1) on.modelText("Hi, I'm calling about");
      else on.turnComplete();
    });
    const running = runCallScenario({
      scenario: oneLine(),
      transport: fake.transport,
      timings: RING
    });
    // Pickup lands on a turn the model left open, so the completion after it
    // is suppressed as the old turn's and the run ends on the stall timer.
    await vi.advanceTimersByTimeAsync(RING.firstLineDelayMs + RING.stallMs + 1_000);
    const run = await running;
    expect(fake.sent).toEqual([OPENING_TRIGGER, "Hello?"]);
    expect(run.spokeBeforeCallee).toBe(true);
    expect(evaluateCallScenario(oneLine(), run).failures.map((f) => f.code)).toContain(
      "spoke-before-callee"
    );
  });

  it("does not flag a model that stays silent, and picks up whatever the model does", async () => {
    // The first line goes out on the ring's clock. A silent model completes no
    // turn, so waiting on one — the rule for every later line — would stall
    // a run whose model did exactly what it was told.
    vi.useFakeTimers();
    const fake = fakeTransport((on, _t, n) => {
      if (n > 1) {
        on.modelText("Hi, this is Ava.");
        on.turnComplete();
      }
    });
    const running = runCallScenario({
      scenario: oneLine(),
      transport: fake.transport,
      timings: RING
    });
    await vi.advanceTimersByTimeAsync(RING.firstLineDelayMs - 1);
    expect(fake.sent).toEqual([OPENING_TRIGGER]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.sent).toEqual([OPENING_TRIGGER, "Hello?"]);
    const run = await running;
    expect(run.spokeBeforeCallee).toBe(false);
    expect(evaluateCallScenario(oneLine(), run).failures.map((f) => f.code)).not.toContain(
      "spoke-before-callee"
    );
  });

  it("never answers the ring early because the model finished a turn", async () => {
    // A completion during the ring is model state. The callee has not picked
    // up yet, and a line sent on it would be the script advancing on the model.
    vi.useFakeTimers();
    const fake = fakeTransport((on, _t, n) => {
      if (n === 1) on.turnComplete();
    });
    const running = runCallScenario({
      scenario: oneLine(),
      transport: fake.transport,
      timings: RING
    });
    await vi.advanceTimersByTimeAsync(RING.firstLineDelayMs - 1);
    expect(fake.sent).toEqual([OPENING_TRIGGER]);
    await vi.advanceTimersByTimeAsync(RING.stallMs + 1_000);
    await running;
    expect(fake.sent).toEqual([OPENING_TRIGGER, "Hello?"]);
  });

  it("changes nothing by default: no ring, no check", async () => {
    const fake = fakeTransport((on) => {
      on.modelText("ok");
      on.turnComplete();
    });
    const run = await runCallScenario({
      scenario: oneLine(),
      transport: fake.transport,
      timings: FAST
    });
    expect(fake.sent).toEqual([OPENING_TRIGGER, "Hello?"]);
    expect(run.spokeBeforeCallee).toBeUndefined();
  });

  it("refuses a ring as long as the stall window — it could only ever end 'stalled'", async () => {
    const fake = fakeTransport(() => {});
    await expect(
      runCallScenario({
        scenario: oneLine(),
        transport: fake.transport,
        timings: { ...FAST, firstLineDelayMs: FAST.stallMs }
      })
    ).rejects.toThrow(/firstLineDelayMs/);
  });
});

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** The runner plans the opening with `planOpening`, off the transport's
 * declared delivery — the same helper and the same inputs `CallSession` uses,
 * so a matrix run puts the opening where a real call on that vendor does. */
describe("opening delivery follows the transport's declaration", () => {
  const twoLines = (): CallScenario =>
    scenario([
      { label: "a", text: "one" },
      { label: "b", text: "two" }
    ]);
  const meetingScenario = (): CallScenario => {
    const base = scenario([{ label: "room", text: "Let's get started." }]);
    return {
      ...base,
      envelope: {
        ...base.envelope,
        execution: {
          meeting: {
            consent: {
              phrase: "go ahead and take notes",
              timeoutSeconds: 30,
              onTimeout: "hangUp" as const
            }
          }
        }
      }
    };
  };
  const answers = (on: On): void => {
    on.modelText("ok");
    on.turnComplete();
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('"turn": the trigger is sent as a line and the prompt does not carry it', async () => {
    const fake = fakeTransport(answers, "turn");
    await runCallScenario({ scenario: twoLines(), transport: fake.transport, timings: FAST });
    expect(fake.sent).toEqual([OPENING_TRIGGER, "one", "two"]);
    expect(fake.systemInstruction()).not.toContain(OPENING_TRIGGER);
  });

  it('"prompt", two-party: nothing is injected, and the prompt ends with the trigger once', async () => {
    const fake = fakeTransport(answers, "prompt");
    const run = await runCallScenario({
      scenario: twoLines(),
      transport: fake.transport,
      timings: FAST
    });
    // With nothing sent at connect the model has no turn to finish, so the
    // callee speaks first — which is what a real two-party call is.
    expect(fake.sent).toEqual(["one", "two"]);
    expect(run.endedBecause).toBe("script-exhausted");
    const instruction = fake.systemInstruction()!;
    expect(instruction.endsWith(`\n\n${OPENING_TRIGGER}`)).toBe(true);
    expect(occurrences(instruction, OPENING_TRIGGER)).toBe(1);
  });

  it('"prompt", two-party with a ring: nothing goes out until pickup', async () => {
    vi.useFakeTimers();
    const RING = { stallMs: 30_000, settleMs: 10, wallClockMs: 60_000, firstLineDelayMs: 3_000 };
    const fake = fakeTransport(answers, "prompt");
    const running = runCallScenario({
      scenario: scenario([{ label: "hello", text: "Hello?" }]),
      transport: fake.transport,
      timings: RING
    });
    await vi.advanceTimersByTimeAsync(RING.firstLineDelayMs - 1);
    expect(fake.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.sent).toEqual(["Hello?"]);
    const run = await running;
    expect(run.spokeBeforeCallee).toBe(false);
  });

  it('"prompt", meeting: sends exactly the connected cue, and the prompt ends with the meeting trigger', async () => {
    const fake = fakeTransport(answers, "prompt");
    await runCallScenario({
      scenario: meetingScenario(),
      transport: fake.transport,
      timings: FAST
    });
    expect(fake.sent[0]).toBe(MEETING_CONNECTED_CUE);
    expect(fake.sent).not.toContain(MEETING_OPENING_TRIGGER);
    const instruction = fake.systemInstruction()!;
    expect(instruction.endsWith(`\n\n${MEETING_OPENING_TRIGGER}`)).toBe(true);
    expect(occurrences(instruction, MEETING_OPENING_TRIGGER)).toBe(1);
  });
});

/** The runner drives `ToolGate` directly, not through CallSession, so it feeds
 * the gate the same two facts CallSession does: each callee line delivered is
 * the far end speaking, and each `modelAudio` is the model producing audio.
 * Without both, offline runs would never exercise the completed-record
 * confirmation rule a real call is held to. */
describe("the runner feeds ToolGate's confirmation rule", () => {
  const notConfirmed =
    "refused: they have not confirmed what you just said — read the arrangement back exactly as they said it, wait for their yes, then record; do not end the call — without mentioning this";
  const withOutcome = (): CallScenario => {
    const base = scenario([
      { label: "offer", text: "How about Monday at 9:26?" },
      { label: "confirm", text: "Yes, Monday at 9:26 works." }
    ]);
    return {
      ...base,
      envelope: {
        ...base.envelope,
        execution: {
          closure: { requireOutcomeBeforeEnd: true },
          outcome: { fields: [{ name: "newAppointment", description: "when" }] }
        }
      }
    };
  };
  const record = (on: On, id: string): void =>
    on.toolCall({
      id,
      name: "record_outcome",
      args: { status: "completed", fields: { newAppointment: "Monday 9:26" } }
    });

  it("refuses a completed record the model made after speaking over the offer", async () => {
    const fake = fakeTransport((on, _t, n) => {
      if (n === 2) {
        on.modelAudio?.();
        on.modelText("That works. Monday at 9:30. Goodbye.");
        record(on, "r1");
      }
      on.turnComplete();
    });
    const run = await runCallScenario({
      scenario: withOutcome(),
      transport: fake.transport,
      timings: FAST
    });
    expect(run.toolCalls.map((c) => c.result)).toEqual([notConfirmed]);
    // Kept, downgraded: arranged, not confirmed (review 0.4.1 I-A).
    expect(run.snapshot.outcome?.status).toBe("partial");
  });

  it("accepts it when their yes is the last thing said", async () => {
    const fake = fakeTransport((on, _t, n) => {
      // Spoke to every earlier line; answers the yes with the record alone.
      if (n === 3) record(on, "r1");
      else on.modelAudio?.();
      on.turnComplete();
    });
    const run = await runCallScenario({
      scenario: withOutcome(),
      transport: fake.transport,
      timings: FAST
    });
    expect(run.toolCalls.map((c) => c.result)).toEqual([
      "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call"
    ]);
  });
});
