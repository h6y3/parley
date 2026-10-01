import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPENING_TRIGGER } from "@parley/core";
import { runCallScenario, type ScenarioTraceEvent } from "../src/call-scenario-runner.js";
import { callScenarioSchema } from "../src/call-scenario.js";
import { evaluateCallScenario } from "../src/call-scenario-evaluation.js";
import { geminiTransport } from "../src/transports/gemini-transport.js";
import { deepgramTransport } from "../src/transports/deepgram-transport.js";
import type { ScenarioTransport } from "../src/scenario-transport.js";
import { runScenarioCommand } from "../src/cli.js";

/** A real generated cell: an IVR, a gated agent line, a quote inside the
 * ceiling, a booking and a goodbye. */
const SCENARIO = callScenarioSchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../scenarios/generated/bounded-holdMidCall.json", import.meta.url)),
      "utf8"
    )
  )
);

/** What the model does, in vendor-neutral terms. Each adapter below renders
 * these as its own vendor's wire messages, so one scripted model drives both
 * transports and any difference between the two runs is the transport's. */
type Act = { say: string } | { complete: true } | { tool: string; args: Record<string, unknown> };

/** Silent through the ring, presses 1 on the menu, records the outcome and
 * hangs up on the goodbye, and otherwise answers briefly. */
function modelHears(line: string): Act[] {
  if (line.startsWith("The call has just connected")) return [];
  if (line.includes("press 1")) return [{ tool: "press_digits", args: { digits: "1" } }];
  if (line.includes("goodbye")) {
    return [
      {
        tool: "record_outcome",
        args: {
          status: "completed",
          fields: {
            agreedAmount: "160",
            appointmentStart: "2026-10-08T09:00",
            appointmentEnd: "2026-10-08T12:00",
            secondUnitIncluded: "no"
          }
        }
      }
    ];
  }
  return [{ say: "Okay, thank you." }, { complete: true }];
}

/** After a tool answer the model says nothing further of its own. Both
 * vendors close that turn with their own turn end: Gemini's `turnComplete`,
 * Deepgram's zero-audio `AgentAudioDone`. */
function modelResumesAfter(tool: string): Act[] {
  if (tool === "record_outcome") return [{ tool: "end_call", args: { reason: "done" } }];
  return [{ complete: true }];
}

type Model = { hears: (line: string) => Act[]; resumesAfter: (tool: string) => Act[] };
const SCRIPTED: Model = { hears: modelHears, resumesAfter: modelResumesAfter };

type Emit = (act: Act, id: string) => void;
const later = (acts: readonly Act[], emit: Emit): void => {
  acts.forEach((a, k) => setTimeout(() => emit(a, `c${Date.now()}${k}`), 3 * (k + 1)));
};

/** `dieOn`: the session closes underneath the run when the model is sent a
 * line containing this text — the vendor's own close, not one the runner
 * asked for. */
function geminiFake(dieOn?: string, wire?: unknown[]): ScenarioTransport {
  let onmessage: (m: unknown) => void = () => {};
  let onclose: (e: { code: number; reason: string }) => void = () => {};
  const emit: Emit = (a, id) => {
    if ("say" in a) onmessage({ serverContent: { outputTranscription: { text: a.say } } });
    else if ("complete" in a) onmessage({ serverContent: { turnComplete: true } });
    else onmessage({ toolCall: { functionCalls: [{ id, name: a.tool, args: a.args }] } });
  };
  const session = {
    sendRealtimeInput: (i: { text: string }) => {
      wire?.push({ via: "sendRealtimeInput", text: i.text });
      if (dieOn && i.text.includes(dieOn)) {
        setTimeout(() => onclose({ code: 1011, reason: "internal error" }), 3);
        return;
      }
      later(modelHears(i.text), emit);
    },
    sendToolResponse: (p: { functionResponses: { name: string }[] }) =>
      later(modelResumesAfter(p.functionResponses[0].name), emit),
    close: () => {}
  };
  return geminiTransport({
    apiKey: "fake",
    genAIFactory: () =>
      ({
        live: {
          connect: async (p: {
            config: unknown;
            callbacks: { onmessage: typeof onmessage; onclose: typeof onclose };
          }) => {
            wire?.push({ via: "connect", config: p.config });
            onmessage = p.callbacks.onmessage;
            onclose = p.callbacks.onclose;
            return session;
          }
        }
      }) as never
  });
}

type Handler = (...a: unknown[]) => void;

function deepgramFake(
  dieOn?: string,
  model: Model = SCRIPTED,
  refuseOn?: string,
  wire?: unknown[],
  /** Lines that got no reply, because they were injected while a tool
   * continuation was still pending. */
  swallowed?: string[]
): ScenarioTransport {
  const handlers: Record<string, Handler[]> = {};
  const fire = (event: string, ...args: unknown[]): void => {
    for (const h of handlers[event] ?? []) h(...args);
  };
  const agentSays = (m: Record<string, unknown>): void =>
    fire("message", Buffer.from(JSON.stringify(m)), false);
  /** Every turn ends with an `AgentAudioDone`, a silent one with zero audio
   * bytes — observed on every live probe. A turn that ends in a tool call
   * goes on in the continuation after the answer, which ends it instead. */
  const closeTurn = (acts: Act[]): Act[] =>
    acts.length > 0 && "tool" in acts[acts.length - 1]!
      ? acts
      : acts.some((a) => "complete" in a)
        ? acts
        : [...acts, { complete: true }];
  /** The continuation after a tool answer, while it has not yet run. A line
   * injected in that window is what the runner used to send after a press:
   * live, Deepgram cancelled the continuation and in 4 of 8 billed sessions
   * the line got no reply either, the turn closing with one zero-audio
   * `AgentAudioDone`. This fake reproduces that case. */
  let continuation: ReturnType<typeof setTimeout>[] = [];
  const schedule = (acts: readonly Act[]): ReturnType<typeof setTimeout>[] =>
    acts.map((a, k) => setTimeout(() => emit(a, `c${Date.now()}${k}`), 3 * (k + 1)));
  const emit: Emit = (a, id) => {
    if ("say" in a) {
      agentSays({ type: "ConversationText", role: "assistant", content: a.say });
      fire("message", Buffer.from([0xff]), true);
    } else if ("complete" in a) agentSays({ type: "AgentAudioDone" });
    else {
      agentSays({
        type: "FunctionCallRequest",
        functions: [{ id, name: a.tool, arguments: JSON.stringify(a.args), client_side: true }]
      });
    }
  };
  const socket = {
    on: (event: string, fn: Handler) => void (handlers[event] ??= []).push(fn),
    send: (data: string) => {
      const m = JSON.parse(data) as { type: string; content?: string; name?: string };
      wire?.push(m);
      if (m.type === "Settings") setTimeout(() => agentSays({ type: "SettingsApplied" }), 1);
      if (m.type === "InjectUserMessage" && dieOn && m.content?.includes(dieOn)) {
        setTimeout(() => fire("close", 1011, Buffer.from("internal error")), 3);
        return;
      }
      if (m.type === "InjectUserMessage" && refuseOn && m.content?.includes(refuseOn)) {
        setTimeout(() => agentSays({ type: "InjectionRefused", message: "agent is speaking" }), 3);
        return;
      }
      if (m.type === "InjectUserMessage") {
        agentSays({ type: "ConversationText", role: "user", content: m.content });
        if (continuation.length > 0) {
          continuation.forEach(clearTimeout);
          continuation = [];
          swallowed?.push(m.content ?? "");
          setTimeout(() => agentSays({ type: "AgentAudioDone" }), 3);
          return;
        }
        later(closeTurn(model.hears(m.content ?? "")), emit);
      }
      if (m.type === "FunctionCallResponse") {
        const timers = schedule(closeTurn(model.resumesAfter(m.name ?? "")));
        continuation = timers;
        // Pending only until its last act has gone out.
        setTimeout(
          () => {
            if (continuation === timers) continuation = [];
          },
          3 * timers.length + 1
        );
      }
    },
    close: () => fire("close", 1000, Buffer.from("done"))
  };
  return deepgramTransport({
    apiKey: "fake",
    think: { provider: "open_ai", model: "gpt-5.4-mini" },
    // Production's 300 ms quiet window, scaled to this fake's 3 ms act
    // spacing: the rule is the same, and nine turns at 300 ms real time
    // each pushed a two-scenario run past the test timeout.
    turnQuietMs: 2,
    wsFactory: () => {
      setTimeout(() => fire("open"), 1);
      return socket as never;
    }
  });
}

const TIMINGS = { stallMs: 500, settleMs: 5, wallClockMs: 8_000, firstLineDelayMs: 40 };

describe("one generated scenario, end to end, through each transport", () => {
  it.each([
    ["gemini", geminiFake],
    ["deepgram", deepgramFake]
  ] as const)("%s: the same scripted model produces the same run", async (_name, make) => {
    const run = await runCallScenario({
      scenario: SCENARIO,
      transport: make(),
      timings: TIMINGS
    });
    expect(run.endedBecause).toBe("model-ended");
    expect(run.turnsDelivered).toBe(SCENARIO.script.length);
    expect(run.spokeBeforeCallee).toBe(false);
    // The scenario declares closure, so record_outcome and end_call answer with
    // the literals that say what happens next (2026-09-30); the press is "ok".
    expect(run.toolCalls.map((c) => `${c.name}:${c.result}`)).toEqual([
      "press_digits:ok",
      "record_outcome:recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call",
      "end_call:ok — say nothing more"
    ]);
    expect(run.snapshot.dtmf?.pressed).toEqual(["1"]);
    const verdict = evaluateCallScenario(SCENARIO, run);
    expect(verdict.failures).toEqual([]);
    expect(verdict.pass).toBe(true);
  });
});

/** Where the opening lands on each vendor's own wire. Deepgram's only text
 * input is a USER turn, heard as the callee: sent the trigger that way, billed
 * runs hung up during the ring or said "I'm listening and waiting" aloud. So
 * there it rides in the one Settings prompt, and on a two-party scenario
 * nothing is injected before the callee's first line. Gemini now does the same. */
describe("the opening on each vendor's wire, two-party", () => {
  const count = (s: string, needle: string): number => s.split(needle).length - 1;

  it("deepgram: the trigger is in the Settings prompt once, and no opening line is injected", async () => {
    const wire: { type?: string; content?: string }[] = [];
    await runCallScenario({
      scenario: SCENARIO,
      transport: deepgramFake(undefined, SCRIPTED, undefined, wire),
      timings: TIMINGS
    });
    const settings = wire.filter((m) => m.type === "Settings");
    expect(settings).toHaveLength(1);
    expect(count(JSON.stringify(settings[0]), OPENING_TRIGGER)).toBe(1);
    const injected = wire.filter((m) => m.type === "InjectUserMessage").map((m) => m.content);
    expect(injected[0]).toBe(SCENARIO.script[0]!.text);
    expect(injected).not.toContain(OPENING_TRIGGER);
    expect(count(JSON.stringify(wire), OPENING_TRIGGER)).toBe(1);
  });

  /** Gemini as Deepgram: a trigger sent as its own turn at connect was
   * answered into line hiss before the callee spoke (9/18 offline runs with
   * 3 s of noise before the hello; 0/72 with the opening in the prompt). So
   * the far end's first line — a person, a voicemail greeting, an IVR menu —
   * is the first realtime input the model ever gets. */
  it("gemini: the trigger is in the prompt once, and the callee's first line is the first input", async () => {
    const wire: { via: string; text?: string; config?: { systemInstruction?: string } }[] = [];
    await runCallScenario({
      scenario: SCENARIO,
      transport: geminiFake(undefined, wire),
      timings: TIMINGS
    });
    const connect = wire.find((m) => m.via === "connect");
    expect(connect?.config?.systemInstruction?.endsWith(`\n\n${OPENING_TRIGGER}`)).toBe(true);
    expect(count(JSON.stringify(wire), OPENING_TRIGGER)).toBe(1);
    const inputs = wire.filter((m) => m.via === "sendRealtimeInput").map((m) => m.text);
    expect(inputs[0]).toBe(SCENARIO.script[0]!.text);
    expect(inputs).not.toContain(OPENING_TRIGGER);
  });
});

describe("a session that dies mid-script is a scored run, not an aborted batch", () => {
  it.each([
    ["gemini", geminiFake],
    ["deepgram", deepgramFake]
  ] as const)("%s: the run resolves transport-closed", async (_name, make) => {
    const run = await runCallScenario({
      scenario: SCENARIO,
      transport: make("diagnostic service call fee"),
      timings: TIMINGS
    });
    expect(run.endedBecause).toBe("transport-closed");
    expect(run.turnsDelivered).toBe(7);
    expect(evaluateCallScenario(SCENARIO, run).failures.map((f) => f.code)).toContain(
      "transport-closed"
    );
  });

  it.each([
    ["gemini", geminiFake],
    ["deepgram", deepgramFake]
  ] as const)("%s: the scenario command goes on to the next scenario", async (_name, make) => {
    const files: Record<string, string> = {
      "/s/a.json": JSON.stringify({ ...SCENARIO, id: "a" }),
      "/s/b.json": JSON.stringify({ ...SCENARIO, id: "b" })
    };
    let built = 0;
    const out = await runScenarioCommand(
      { scenarioPath: "/s", runs: 1, apiKey: "fake" },
      {
        readFile: (p) => files[p],
        readdir: () => ["a.json", "b.json"],
        // The first session dies mid-script; the second is healthy.
        makeTransport: () => make(built++ === 0 ? "diagnostic service call fee" : undefined),
        run: (p) => runCallScenario({ ...p, timings: TIMINGS })
      }
    );
    expect(out).toContain("FAIL a (run 1/1, ended: transport-closed)");
    expect(out).toContain("PASS b (run 1/1, ended: model-ended)");
    expect(out).toContain("1/2 runs passed across 2 scenario(s)");
    expect(out).toMatch(/transport-closed\s+1\/2/);
  });
});

describe("Deepgram turn shapes the runner must not assume are Gemini's", () => {
  it("a press-released line waits for the continuation, so Deepgram answers it", async () => {
    // Sent in the same tick as the press's answer, the released line landed on
    // a continuation still in flight. Live, Deepgram cancelled the
    // continuation (the press reads `CANCELLED` in the model's history) and in
    // 4 of 8 billed sessions the line got no reply, the turn closing with one
    // zero-audio AgentAudioDone the runner took for the reply. The model had
    // not answered "How can I help you today?" when the next line went out.
    // The line now waits for the continuation's own turn end.
    const script = [
      { label: "menu", text: "For service, press 1." },
      { label: "agent", text: "Service, this is Dave.", afterPress: "1" },
      { label: "more", text: "Anything else?" }
    ];
    const scenario = {
      ...SCENARIO,
      envelope: {
        ...SCENARIO.envelope,
        execution: { ...SCENARIO.envelope.execution, closure: undefined }
      },
      script
    };
    const heard: string[] = [];
    const model: Model = {
      hears: (line) => {
        heard.push(line);
        if (line.includes("press 1")) return [{ tool: "press_digits", args: { digits: "1" } }];
        if (line.startsWith("The call")) return [];
        return [{ say: "Okay." }, { complete: true }];
      },
      resumesAfter: () => []
    };
    const swallowed: string[] = [];
    const run = await runCallScenario({
      scenario,
      transport: deepgramFake(undefined, model, undefined, undefined, swallowed),
      timings: TIMINGS
    });
    // No line landed on a pending continuation.
    expect(swallowed).toEqual([]);
    // Every injected line is a callee line and reached the model: the opening
    // rides in the Settings prompt, so nothing precedes the script.
    expect(heard).toEqual(script.map((t) => t.text));
    expect(run.endedBecause).toBe("script-exhausted");
  });

  it("a successful end_call followed by silence ends model-ended, not awaiting-closure", async () => {
    // end_call answers before it hangs up, and when no further event follows
    // (this fake sends none) the hang-up is only ever seen by the watchdog.
    const run = await runCallScenario({
      scenario: SCENARIO,
      transport: deepgramFake(),
      timings: TIMINGS
    });
    expect(run.toolCalls.at(-1)).toMatchObject({
      name: "end_call",
      result: "ok — say nothing more"
    });
    expect(run.endedBecause).toBe("model-ended");
  });
});

describe("a line Deepgram refuses is never scored as heard", () => {
  it("ends the run transport-closed with the refusal in the trace", async () => {
    const trace: ScenarioTraceEvent[] = [];
    const run = await runCallScenario({
      scenario: SCENARIO,
      transport: deepgramFake(undefined, SCRIPTED, "diagnostic service call fee"),
      timings: TIMINGS,
      trace: (e) => trace.push(e)
    });
    expect(run.endedBecause).toBe("transport-closed");
    expect(run.closedReason).toBe("InjectionRefused: agent is speaking");
    expect(trace).toContainEqual(
      expect.objectContaining({
        type: "transport-closed",
        reason: "InjectionRefused: agent is speaking"
      })
    );
    expect(evaluateCallScenario(SCENARIO, run).failures.map((f) => f.code)).toContain(
      "transport-closed"
    );
  });
});
