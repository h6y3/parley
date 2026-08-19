import { describe, expect, it } from "vitest";
import { runCallScenario, type ScenarioTraceEvent } from "../src/call-scenario-runner.js";
import type { CallScenario, ScenarioTurn } from "../src/call-scenario.js";

/** Fast timings. Every value here is a TIMEOUT — something that ends the run and
 * reports why — never a synchronization wait. That distinction is the point of
 * the whole module: the script advances on events, so shrinking these cannot
 * change which turns get delivered, only how long a stalled run takes to admit
 * it stalled. */
const FAST = { stallMs: 300, settleMs: 10, wallClockMs: 8_000 };

function scenario(
  script: ScenarioTurn[],
  execution?: Partial<CallScenario["envelope"]["execution"]>
): CallScenario {
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
        closure: { requireOutcomeBeforeEnd: true },
        limits: { maxDurationSeconds: 600 },
        ...execution
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

const speak = (text: string) => ({ serverContent: { outputTranscription: { text } } });
const complete = () => ({ serverContent: { turnComplete: true } });
const toolCall = (name: string, args: Record<string, unknown>) => ({
  toolCall: { functionCalls: [{ id: `c${name}`, name, args }] }
});

/** Fake Gemini Live. `respond` returns the messages the model emits in reply to
 * each text the runner sends; send 1 is always the opening trigger. */
function fakeLive(respond: (text: string, n: number) => unknown[]) {
  let onmessage: (m: unknown) => void = () => {};
  const sent: string[] = [];
  const session = {
    sendRealtimeInput: (input: { text: string }) => {
      sent.push(input.text);
      respond(input.text, sent.length).forEach((m, k) =>
        setTimeout(() => onmessage(m), 5 * (k + 1))
      );
    },
    sendToolResponse: () => {},
    close: () => {}
  };
  const factory = () =>
    ({
      live: {
        connect: async (p: { callbacks: { onmessage: (m: unknown) => void } }) => {
          onmessage = p.callbacks.onmessage;
          return session;
        }
      }
    }) as never;
  return { factory, sent };
}

async function run(s: CallScenario, factory: ReturnType<typeof fakeLive>["factory"]) {
  const trace: ScenarioTraceEvent[] = [];
  const result = await runCallScenario({
    apiKey: "fake",
    scenario: s,
    genAIFactory: factory,
    timings: FAST,
    trace: (e) => trace.push(e)
  });
  return { ...result, trace };
}

describe("the script advances on events, never on a timer", () => {
  it("sends no script turn at all to a model that never answers", async () => {
    // The old runner seeded its activity flag to true, so the first scripted
    // line went out on a 12s timer whether or not the model had said anything.
    const fake = fakeLive(() => []);
    const result = await run(
      scenario([{ label: "menu", text: "For service, press one." }]),
      fake.factory
    );
    expect(fake.sent).toHaveLength(1); // the opening trigger, and nothing else
    expect(result.endedBecause).toBe("stalled");
  });

  it("does not advance on speech alone — only on a completed turn", async () => {
    // A model mid-utterance has not finished. Advancing because a duration
    // elapsed is what let a scripted callee talk over it, and the transcript
    // then reads as though the model ignored what it was never allowed to hear.
    const fake = fakeLive((_t, n) => (n === 1 ? [speak("Hello, this is")] : []));
    const result = await run(
      scenario([{ label: "menu", text: "For service, press one." }]),
      fake.factory
    );
    expect(fake.sent).toHaveLength(1);
    expect(result.transcript).toBe("Hello, this is");
    expect(result.endedBecause).toBe("stalled");
  });

  it("advances as soon as the model completes its turn", async () => {
    const fake = fakeLive(() => [speak("ok"), complete()]);
    const s = scenario(
      [
        { label: "a", text: "one" },
        { label: "b", text: "two" }
      ],
      { closure: undefined }
    );
    const result = await run(s, fake.factory);
    expect(fake.sent.slice(1)).toEqual(["one", "two"]);
    expect(result.endedBecause).toBe("script-exhausted");
  });
});

describe("a held turn is released by the press, not by a poll", () => {
  const gated: ScenarioTurn[] = [
    { label: "menu", text: "For service, press one." },
    { label: "agent", text: "Service, this is Dave.", afterPress: "1" }
  ];

  it("delivers the gated turn when the model presses", async () => {
    const fake = fakeLive((_t, n) =>
      n === 2 ? [toolCall("press_digits", { digits: "1" })] : [speak("ok"), complete()]
    );
    const s = scenario(gated, { closure: undefined });
    const result = await run(s, fake.factory);
    expect(fake.sent.slice(1)).toEqual(["For service, press one.", "Service, this is Dave."]);
    expect(result.snapshot.dtmf?.pressed).toEqual(["1"]);
    expect(result.trace.some((e) => e.type === "turn-released")).toBe(true);
  });

  it("ends the run when the press never comes instead of polling to the wall clock", async () => {
    // Measured on a real cell: the model pressed the wrong digits, the gated
    // turn polled once a second, and the session burned its full 179s before
    // anyone learned the run was over after two turns.
    const fake = fakeLive((_t, n) =>
      n === 2
        ? [toolCall("press_digits", { digits: "9" }), speak("ok"), complete()]
        : [speak("ok"), complete()]
    );
    const started = Date.now();
    const result = await run(scenario(gated), fake.factory);
    expect(fake.sent.slice(1)).toEqual(["For service, press one."]);
    expect(result.endedBecause).toBe("stalled");
    expect(Date.now() - started).toBeLessThan(FAST.wallClockMs);
  });
});

describe("the run ends for a stated reason", () => {
  it("waits for the model to close when the envelope declares closure", async () => {
    // A model that says goodbye, then calls end_call, must not have the session
    // yanked out from under it between the two.
    const fake = fakeLive((_t, n) =>
      n === 2
        ? [speak("Thanks, goodbye."), complete(), toolCall("end_call", { reason: "done" })]
        : [speak("ok"), complete()]
    );
    const result = await run(scenario([{ label: "a", text: "one" }]), fake.factory);
    expect(result.endedBecause).toBe("model-ended");
    expect(result.toolCalls.map((c) => c.name)).toContain("end_call");
  });

  it("reports a declared closure that never arrived", async () => {
    const fake = fakeLive(() => [speak("ok"), complete()]);
    const result = await run(scenario([{ label: "a", text: "one" }]), fake.factory);
    expect(result.endedBecause).toBe("awaiting-closure");
  });

  it("reports script exhaustion when no closure is declared", async () => {
    const fake = fakeLive(() => [speak("ok"), complete()]);
    const result = await run(
      scenario([{ label: "a", text: "one" }], { closure: undefined }),
      fake.factory
    );
    expect(result.endedBecause).toBe("script-exhausted");
  });
});

describe("an empty turn is still a completed turn", () => {
  it("advances when the model completes a turn having said nothing", async () => {
    // Found by the first live pair run: three scenarios stalled having
    // delivered ZERO of eleven turns. Requiring speech behind a completion
    // conflates "the model had nothing to say" with "the model has not
    // finished" — and the first of those is a turn, so the callee should speak
    // next. The stale-completion race this guard was added for is real, but it
    // is narrower than the guard was.
    const fake = fakeLive((_t, n) => (n === 1 ? [complete()] : [speak("ok"), complete()]));
    const s = scenario(
      [
        { label: "a", text: "one" },
        { label: "b", text: "two" }
      ],
      { closure: undefined }
    );
    const result = await run(s, fake.factory);
    expect(fake.sent.slice(1)).toEqual(["one", "two"]);
    expect(result.endedBecause).toBe("script-exhausted");
  });

  it("still ignores a completion left in flight when a press released a turn", async () => {
    // The narrow case the guard exists for: the model speaks, presses, and the
    // press sends the gated line while its own turn is still open. The
    // completion that lands a moment later belongs to the turn that ended
    // BEFORE that line — advancing on it talks over the model.
    const fake = fakeLive((_t, n) =>
      n === 1
        ? [speak("Hello."), complete()]
        : n === 2
          ? [speak("Okay, pressing one."), toolCall("press_digits", { digits: "1" }), complete()]
          : []
    );
    const s = scenario(
      [
        { label: "menu", text: "For service, press one." },
        { label: "agent", text: "Service, this is Dave.", afterPress: "1" },
        { label: "third", text: "Anything else?" }
      ],
      { closure: undefined }
    );
    await run(s, fake.factory);
    expect(fake.sent.slice(1)).toEqual(["For service, press one.", "Service, this is Dave."]);
  });
});
