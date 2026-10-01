import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runScenarioCommand } from "../src/cli.js";
import type { ToolDeclaration } from "@parley/core";
import {
  DEFAULT_GEMINI_MODEL,
  GeminiRealtimeProvider,
  geminiFunctionDeclarations
} from "@parley/realtime-gemini";
import { geminiTransport } from "../src/transports/gemini-transport.js";
import { DEFAULT_SCENARIO_MODEL } from "../src/call-scenario-runner.js";

const TOOL: ToolDeclaration = {
  name: "press_digits",
  description: "press",
  parametersJsonSchema: { type: "object", properties: {} }
};

function fakeGenAI() {
  const connects: { model: string; config: Record<string, unknown> }[] = [];
  let callbacks: {
    onmessage: (m: unknown) => void;
    onerror: (e: unknown) => void;
    onclose: (e: unknown) => void;
  } = { onmessage: () => {}, onerror: () => {}, onclose: () => {} };
  const factory = () =>
    ({
      live: {
        connect: async (p: {
          model: string;
          config: Record<string, unknown>;
          callbacks: typeof callbacks;
        }) => {
          connects.push({ model: p.model, config: p.config });
          callbacks = p.callbacks;
          return {
            sendRealtimeInput: () => {},
            sendToolResponse: () => {},
            close: () => callbacks.onclose({ code: 1000, reason: "" })
          };
        }
      }
    }) as never;
  return { factory, connects, callbacks: () => callbacks };
}

const noop = {
  modelText: () => {},
  turnComplete: () => {},
  toolCall: () => {},
  closed: () => {}
};

describe("the Gemini scenario transport's opening delivery", () => {
  it("declares what the production provider declares, so the runner plans the same opening", () => {
    const production = new GeminiRealtimeProvider({ apiKey: "k" }).openingDelivery;
    expect(production).toEqual({ twoParty: "prompt", meeting: "turn" });
    expect(
      geminiTransport({ apiKey: "k", genAIFactory: fakeGenAI().factory }).openingDelivery
    ).toEqual(production);
  });
});

describe("the Gemini scenario transport declares tools the way production does", () => {
  it("defaults to production's model — layers 1–3 measure what a real call runs", async () => {
    expect(DEFAULT_SCENARIO_MODEL).toBe(DEFAULT_GEMINI_MODEL);
    const fake = fakeGenAI();
    await geminiTransport({ apiKey: "k", genAIFactory: fake.factory }).connect({
      systemInstruction: "s",
      tools: [],
      on: noop
    });
    expect(fake.connects[0].model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("marks every function BLOCKING and sends no thinking config", async () => {
    // gemini-3.8-live defaults function calls to NON-blocking; ToolGate needs
    // one call, one answer. A harness declaring tools differently from
    // production is measuring a different model.
    const fake = fakeGenAI();
    await geminiTransport({ apiKey: "k", genAIFactory: fake.factory }).connect({
      systemInstruction: "s",
      tools: [TOOL],
      on: noop
    });
    const config = fake.connects[0].config as {
      tools: { functionDeclarations: { behavior: string }[] }[];
    };
    expect(config.tools[0].functionDeclarations.map((f) => f.behavior)).toEqual(["BLOCKING"]);
    // Not a look-alike: the production provider's own mapping, verbatim.
    expect(config.tools[0].functionDeclarations).toEqual(geminiFunctionDeclarations([TOOL]));
    expect(JSON.stringify(config)).not.toMatch(/thinking/i);
  });

  it("reports a session that dies underneath the run, but not the close it was asked for", async () => {
    const fake = fakeGenAI();
    const closed: string[] = [];
    const transport = geminiTransport({ apiKey: "k", genAIFactory: fake.factory });
    await transport.connect({
      systemInstruction: "s",
      tools: [],
      on: { ...noop, closed: (r) => closed.push(r) }
    });
    fake.callbacks().onerror({ error: new Error("quota") });
    expect(closed).toEqual(["quota"]);
    await transport.close();
    expect(closed).toEqual(["quota"]);
  });
});

/** ToolGate refuses a completed record when the model has produced audio
 * since the callee last spoke. The run sends no audio, but the model's audio
 * still arrives, and the runner needs to know it did — the bytes themselves
 * are never passed on. */
describe("the Gemini scenario transport reports model audio", () => {
  it("raises modelAudio for each audio part, after the message's tool calls", async () => {
    const fake = fakeGenAI();
    const events: string[] = [];
    await geminiTransport({ apiKey: "k", genAIFactory: fake.factory }).connect({
      systemInstruction: "s",
      tools: [],
      on: {
        ...noop,
        modelAudio: () => events.push("audio"),
        toolCall: (c) => events.push(`tool:${c.name}`)
      }
    });
    fake.callbacks().onmessage({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }, { text: "x" }] } }
    });
    fake.callbacks().onmessage({ toolCall: { functionCalls: [{ id: "1", name: "end_call" }] } });
    fake.callbacks().onmessage({ serverContent: { modelTurn: { parts: [{ text: "thinking" }] } } });
    expect(events).toEqual(["audio", "tool:end_call"]);
  });
});

/** The SDK's `live.connect` awaits `setupComplete`, and a bad key, model or
 * tool schema surfaces as `onerror`/`onclose` DURING that wait — before
 * `connect` has returned. Reported as a mid-run close, every run of a batch
 * would be scored `transport-closed` against a session that never existed,
 * while `connect` itself never settled. */
describe("a Gemini session that fails during setup is a configuration error", () => {
  /** A `live.connect` that fires one callback during setup and then never
   * completes it — what the SDK does when setup is refused. */
  function failingSetup(fire: "onerror" | "onclose") {
    return () =>
      ({
        live: {
          connect: (p: {
            callbacks: { onerror: (e: unknown) => void; onclose: (e: unknown) => void };
          }) => {
            if (fire === "onerror") p.callbacks.onerror({ error: new Error("API key not valid") });
            else p.callbacks.onclose({ code: 1008, reason: "models/nope is not found" });
            return new Promise(() => {});
          }
        }
      }) as never;
  }

  it.each(["onerror", "onclose"] as const)(
    "%s during setup rejects connect and never reports a mid-run close",
    async (fire) => {
      const closed: string[] = [];
      const transport = geminiTransport({ apiKey: "bad", genAIFactory: failingSetup(fire) });
      await expect(
        transport.connect({
          systemInstruction: "s",
          tools: [],
          on: { ...noop, closed: (r) => closed.push(r) }
        })
      ).rejects.toThrow(fire === "onerror" ? /API key not valid/ : /models\/nope is not found/);
      expect(closed).toEqual([]);
    }
  );

  it("stops the scenario command instead of scoring every run", async () => {
    const generated = fileURLToPath(
      new URL("../scenarios/generated/bounded-holdMidCall.json", import.meta.url)
    );
    await expect(
      runScenarioCommand(
        { scenarioPath: generated, runs: 3, apiKey: "bad" },
        {
          makeTransport: () =>
            geminiTransport({ apiKey: "bad", genAIFactory: failingSetup("onclose") })
        }
      )
    ).rejects.toThrow(/models\/nope is not found/);
  });
});
