import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MEETING_OPENING_TRIGGER, OPENING_TRIGGER } from "@parley/core";
import { runCallScenario, type ScenarioTraceEvent } from "../src/call-scenario-runner.js";
import { geminiTransport } from "../src/transports/gemini-transport.js";
import { callScenarioSchema } from "../src/call-scenario.js";
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

/** The Gemini transport with every opening sent as a line — the delivery
 * Gemini declared when these runner-mechanics tests were written, and the one
 * a meeting still uses. They count sends from the trigger; the shape of the
 * opening itself is pinned in "the opening trigger matches the shape of the
 * envelope" below, on the transport as declared. */
function triggerFirst(factory: ReturnType<typeof fakeLive>["factory"]) {
  return {
    ...geminiTransport({ apiKey: "fake", genAIFactory: factory }),
    openingDelivery: "turn" as const
  };
}

async function run(
  s: CallScenario,
  factory: ReturnType<typeof fakeLive>["factory"],
  opts: { asDeclared?: boolean } = {}
) {
  const trace: ScenarioTraceEvent[] = [];
  const result = await runCallScenario({
    scenario: s,
    transport: opts.asDeclared
      ? geminiTransport({ apiKey: "fake", genAIFactory: factory })
      : triggerFirst(factory),
    timings: FAST,
    trace: (e) => trace.push(e)
  });
  return { ...result, trace };
}

describe("the script advances on events, never on a timer", () => {
  it("sends no reply line to a model that never answers", async () => {
    // The old runner seeded its activity flag to true, so scripted lines went
    // out on a 12s timer whether or not the model had said anything. The first
    // line is pickup, not a reply, and goes out on the ring (see "with no
    // ring" below); every line after it waits for the model.
    const fake = fakeLive(() => []);
    const result = await run(
      scenario([
        { label: "menu", text: "For service, press one." },
        { label: "again", text: "Please make a selection." }
      ]),
      fake.factory
    );
    expect(fake.sent).toEqual([OPENING_TRIGGER, "For service, press one."]);
    expect(result.endedBecause).toBe("stalled");
  });

  it("does not advance on speech alone — only on a completed turn", async () => {
    // A model mid-utterance has not finished. Advancing because a duration
    // elapsed is what let a scripted callee talk over it, and the transcript
    // then reads as though the model ignored what it was never allowed to hear.
    const fake = fakeLive((_t, n) => (n === 2 ? [speak("Hello, this is")] : []));
    const result = await run(
      scenario([
        { label: "menu", text: "For service, press one." },
        { label: "again", text: "Please make a selection." }
      ]),
      fake.factory
    );
    expect(fake.sent).toEqual([OPENING_TRIGGER, "For service, press one."]);
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

describe("with no ring, the phone is answered at once", () => {
  // `firstLineDelayMs: 0` used to mean "the first line waits on the model's
  // first completed turn". The opening trigger tells the model to say nothing,
  // and Gemini sends no `turnComplete` for a turn it never takes — so the
  // better the model obeyed, the more runs stalled before "Hello." went out:
  // 8 of 10 on one billed batch, every one scored `stalled` with an empty
  // transcript. Zero is a ring of zero, not a different rule.
  it("delivers the first line to a model that stays silent after the trigger", async () => {
    const fake = fakeLive(() => []);
    const result = await run(
      scenario([
        { label: "hello", text: "Hello." },
        { label: "next", text: "Anything else?" }
      ]),
      fake.factory
    );
    expect(fake.sent).toEqual([OPENING_TRIGGER, "Hello."]);
    expect(result.turnsDelivered).toBe(1);
    expect(result.endedBecause).toBe("stalled");
  });

  it("does not deliver the first line twice when the model also completes a turn", async () => {
    const fake = fakeLive(() => [speak("ok"), complete()]);
    const s = scenario(
      [
        { label: "a", text: "one" },
        { label: "b", text: "two" }
      ],
      { closure: undefined }
    );
    const result = await run(s, fake.factory);
    expect(fake.sent).toEqual([OPENING_TRIGGER, "one", "two"]);
    expect(result.endedBecause).toBe("script-exhausted");
  });
});

describe("a tool call is stamped with where in the script it landed", () => {
  // A record made on the callee's offer and one made after the callee agreed
  // look identical in `toolCalls` without this, and the evaluator cannot tell
  // a premature close from a correct one.
  it("records how many lines had gone out, and the trace carries the arguments", async () => {
    const fake = fakeLive((_t, n) =>
      n === 3
        ? [
            toolCall("record_outcome", {
              status: "completed",
              fields: { agreedAmount: "", appointmentStart: "Tuesday 10" }
            }),
            complete()
          ]
        : [complete()]
    );
    const s = scenario(
      [
        { label: "a", text: "one" },
        { label: "b", text: "two" },
        { label: "c", text: "three" }
      ],
      {
        closure: undefined,
        ivr: undefined,
        outcome: {
          fields: [
            { name: "agreedAmount", description: "a" },
            { name: "appointmentStart", description: "s" }
          ]
        }
      }
    );
    const result = await run(s, fake.factory);
    const rec = result.toolCalls.find((c) => c.name === "record_outcome");
    expect(rec?.turnsDelivered).toBe(2);
    const traced = result.trace.find((e) => e.type === "tool-call");
    expect(traced).toMatchObject({
      name: "record_outcome",
      args: { status: "completed", fields: { appointmentStart: "Tuesday 10" } }
    });
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

/** A stale completion must not deliver a line. Measured in the parity Step 0
 * probe: a completion armed the settle timer, a press then released the
 * gated line, and the settle — never cleared — fired 466 ms later and sent
 * the NEXT line with no model reply between the two. */
describe("a line delivered by a press cancels the pending settle", () => {
  it("never delivers line N+1 on the settle a completion armed before the press delivered N", async () => {
    const fake = fakeLive((_t, n) =>
      n === 1
        ? [complete()]
        : n === 2
          ? // Completes (arming the settle), then presses before it fires.
            [speak("Okay."), complete(), toolCall("press_digits", { digits: "1" })]
          : []
    );
    const s = scenario(
      [
        { label: "menu", text: "For service, press one." },
        { label: "agent", text: "Service, this is Dave.", afterPress: "1" },
        { label: "lookup", text: "Let me look that up." }
      ],
      { closure: undefined }
    );
    const result = await runCallScenario({
      scenario: s,
      transport: triggerFirst(fake.factory),
      // The settle outlasts the fake's 5 ms spacing, so the press lands while
      // the settle armed by the completion before it is still pending.
      timings: { ...FAST, settleMs: 40 }
    });
    expect(fake.sent.slice(1)).toEqual(["For service, press one.", "Service, this is Dave."]);
    expect(result.turnsDelivered).toBe(2);
  });
});

/** A gated line waits for ITS press. Generated and hand-written scripts gate
 * several lines on the same key, and a cumulative "has 1 ever been pressed"
 * stayed true for the rest of the call — so any tool call, `record_outcome`
 * included, released the next gated line, on Deepgram mid-utterance. */
describe("a gated turn opens only on a press made since it became current", () => {
  const press = (id: string, digits: string) => ({
    toolCall: { functionCalls: [{ id, name: "press_digits", args: { digits } }] }
  });
  const outcome = {
    toolCall: {
      functionCalls: [
        { id: "outcome", name: "record_outcome", args: { status: "partial", fields: {} } }
      ]
    }
  };
  const doublyGated: ScenarioTurn[] = [
    { label: "menu", text: "For service, press one." },
    { label: "agent", text: "Service, this is Dave.", afterPress: "1" },
    { label: "billing", text: "For billing questions, press one.", afterPress: "1" }
  ];

  it("record_outcome after an earlier press does not release the next gated line", async () => {
    const fake = fakeLive((_t, n) =>
      n === 1 ? [complete()] : n === 2 ? [press("p1", "1")] : n === 3 ? [outcome] : []
    );
    const result = await run(scenario(doublyGated, { closure: undefined }), fake.factory);
    expect(fake.sent.slice(1)).toEqual(["For service, press one.", "Service, this is Dave."]);
    expect(result.toolCalls.map((c) => c.name)).toEqual(["press_digits", "record_outcome"]);
    expect(result.endedBecause).toBe("stalled");
  });

  it("a completed turn does not release it on a press made before it became current", async () => {
    const fake = fakeLive((_t, n) =>
      n === 1
        ? [complete()]
        : n === 2
          ? [press("p1", "1")]
          : // The post-press continuation's completion, then a real reply.
            n === 3
            ? [complete(), speak("Hi Dave."), complete()]
            : []
    );
    const result = await run(scenario(doublyGated, { closure: undefined }), fake.factory);
    expect(fake.sent.slice(1)).toEqual(["For service, press one.", "Service, this is Dave."]);
    expect(result.trace.filter((e) => e.type === "turn-held").map((e) => e.label)).toEqual([
      "billing"
    ]);
  });

  it("a fresh press releases it", async () => {
    const fake = fakeLive((_t, n) =>
      n === 1 ? [complete()] : n === 2 ? [press("p1", "1")] : n === 3 ? [press("p2", "1")] : []
    );
    const result = await run(scenario(doublyGated, { closure: undefined }), fake.factory);
    expect(fake.sent.slice(1)).toEqual(doublyGated.map((t) => t.text));
    expect(result.snapshot.dtmf?.pressed).toEqual(["1", "1"]);
  });

  it("the reference seed plays through on the one press its menu asks for", async () => {
    // It gated every post-menu line on "1", which only ever worked because
    // the cumulative gate stayed open. Only the line the press reaches is
    // gated now.
    const seed = callScenarioSchema.parse(
      JSON.parse(
        readFileSync(
          fileURLToPath(new URL("../scenarios/reference-service-visit.json", import.meta.url)),
          "utf8"
        )
      )
    );
    const fake = fakeLive((_t, n) =>
      n === 2
        ? [press("p1", "1")]
        : n === 3
          ? [complete(), speak("Hi Sam."), complete()] // continuation, then reply
          : [speak("Okay."), complete()]
    );
    const result = await run(seed, fake.factory);
    expect(result.turnsDelivered).toBe(seed.script.length);
    expect(result.snapshot.dtmf?.pressed).toEqual(["1"]);
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

/**
 * `routeToolCall` defaults `heard` and `modelTurnsCompleted` to empty, and
 * with the defaults `ToolGate.authorizeNotetaking` refuses EVERY
 * `begin_notetaking` regardless of what the room said — the same defect that
 * refused every real call's handoff until `CallSession` started passing them.
 * A scenario scored against a gate that can only ever refuse measures nothing
 * about consent, which is what made the consent metamorphic pair pointless to
 * run.
 */
describe("the consent gate sees what the scripted room actually said", () => {
  const meeting = {
    meeting: {
      consent: {
        phrase: "go ahead and take notes",
        timeoutSeconds: 30,
        onTimeout: "hangUp" as const
      }
    }
  };

  it("ADMITS begin_notetaking after the phrase has been delivered and a model turn has completed", async () => {
    // Silent on the trigger, as it says; asks once the room is live; acts on
    // the answer.
    const { factory } = fakeLive((_text, n) =>
      n === 1
        ? []
        : n === 2
          ? [speak("Any objection to my taking notes?"), complete()]
          : [toolCall("begin_notetaking", {}), complete()]
    );
    const result = await run(
      scenario(
        [
          { label: "live", text: "Okay, everyone is here." },
          { label: "go-ahead", text: "Sure, go ahead and take notes." }
        ],
        meeting
      ),
      factory
    );
    expect(result.toolCalls.map((c) => c.result)).toContain("ok");
  });

  it("REFUSES it when the phrase was never spoken — the gate, not the script, decides", async () => {
    // Silent on the trigger, as it says; asks once the room is live; acts on
    // the answer.
    const { factory } = fakeLive((_text, n) =>
      n === 1
        ? []
        : n === 2
          ? [speak("Any objection to my taking notes?"), complete()]
          : [toolCall("begin_notetaking", {}), complete()]
    );
    const result = await run(
      scenario(
        [
          { label: "live", text: "Okay, everyone is here." },
          { label: "go-ahead", text: "Sure, that's fine with everyone." }
        ],
        meeting
      ),
      factory
    );
    expect(result.toolCalls.map((c) => c.result)).toEqual([
      "refused: the go-ahead phrase has not been spoken"
    ]);
  });
});

/** The runner bypasses `RealtimeProvider` and talks to the genai SDK directly
 * (see the module doc), so the trigger choice `CallSession.attach` makes is one
 * it has to make for itself. Left unmade, every meeting scenario — including
 * one written to check the fix — would be run on the two-party trigger, and
 * would reproduce the very silence that trigger caused on two live calls while
 * reporting it as the model's own behavior. */
describe("the opening trigger matches the shape of the envelope", () => {
  const meeting = {
    meeting: {
      consent: {
        phrase: "go ahead and take notes",
        timeoutSeconds: 30,
        onTimeout: "hangUp" as const
      }
    }
  };

  it("sends the meeting trigger when the envelope declares execution.meeting", async () => {
    const fake = fakeLive(() => []);
    await run(scenario([{ label: "room", text: "Let's get started." }], meeting), fake.factory, {
      asDeclared: true
    });
    expect(fake.sent[0]).toBe(MEETING_OPENING_TRIGGER);
  });

  /** On Gemini a two-party opening rides in the prompt, so what the far end
   * says first — here an IVR menu — is the model's first input, and the
   * model answers that rather than a trigger sent into a line nobody has
   * spoken on yet. */
  it("sends no trigger on an ordinary two-party call: the callee's first line is the first input", async () => {
    const fake = fakeLive(() => []);
    await run(scenario([{ label: "menu", text: "For service, press one." }]), fake.factory, {
      asDeclared: true
    });
    expect(fake.sent[0]).toBe("For service, press one.");
    expect(fake.sent).not.toContain(OPENING_TRIGGER);
  });

  it('still sends the generic trigger to a two-party call on a "turn" transport', async () => {
    const fake = fakeLive(() => []);
    await run(scenario([{ label: "menu", text: "For service, press one." }]), fake.factory);
    expect(fake.sent[0]).toBe(OPENING_TRIGGER);
  });
});

/** The runner's standing rule is that the script never advances on a timer, and
 * `ScenarioTurn.unpromptedAfterMs` is the one exception — for lines that are
 * not replies. A conference bridge's hold loop is the case: it plays on its own
 * clock and is waiting for nobody. */
describe("a line that is not a reply arrives on its own clock", () => {
  const meeting = {
    meeting: {
      consent: {
        phrase: "go ahead and take notes",
        timeoutSeconds: 30,
        onTimeout: "hangUp" as const
      }
    }
  };

  it("delivers an unprompted turn while the model has said nothing at all", async () => {
    // The failure this exists for: an agent that correctly stays silent in a
    // waiting room emits no `turnComplete`, so a script that only advances on
    // model events never reaches the room going live. Three of five live runs
    // ended `stalled` before the scenario had asked its question — and they did
    // so on the round where the waiting-room instruction finally worked, so the
    // measurement got worse exactly as the behaviour got better.
    const fake = fakeLive(() => []);
    const result = await run(
      scenario(
        [
          { label: "hold", text: "Please wait for the host.", unpromptedAfterMs: 5 },
          { label: "hold-again", text: "Still waiting for the host.", unpromptedAfterMs: 5 },
          { label: "live", text: "Okay, everyone is here.", unpromptedAfterMs: 5 }
        ],
        meeting
      ),
      fake.factory
    );
    expect(result.turnsDelivered).toBe(3);
    expect(fake.sent).toContain("Okay, everyone is here.");
  });

  it("sends each unprompted turn exactly once when model events land as well", async () => {
    // The timer is armed for one turn at a time and cleared on delivery by any
    // route. A stale one running on into the next turn would double-advance the
    // script and put the room's answer before its own question.
    const fake = fakeLive(() => [complete()]);
    const result = await run(
      scenario(
        [
          { label: "hold", text: "Please wait for the host.", unpromptedAfterMs: 40 },
          { label: "live", text: "Okay, everyone is here.", unpromptedAfterMs: 40 }
        ],
        meeting
      ),
      fake.factory
    );
    expect(result.turnsDelivered).toBe(2);
    expect(fake.sent.filter((t) => t === "Please wait for the host.")).toHaveLength(1);
    expect(fake.sent.filter((t) => t === "Okay, everyone is here.")).toHaveLength(1);
  });

  it("refuses a turn that is both gated on a press and unprompted", () => {
    expect(() =>
      callScenarioSchema.parse({
        ...scenario([{ label: "x", text: "y" }]),
        script: [{ label: "x", text: "y", afterPress: "1", unpromptedAfterMs: 10 }]
      })
    ).toThrow(/cannot be both gated on a press and delivered unprompted/);
  });
});
