import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeProvider, TranscriptEvent } from "@parley/core";
import { DEFAULT_GEMINI_MODEL } from "@parley/realtime-gemini";
import {
  parseCliArgs,
  runMetamorphicCommand,
  runReliabilityCommand,
  runScenarioCommand
} from "../src/cli.js";
import type { ScenarioRun } from "../src/call-scenario-evaluation.js";
import type { ScenarioTransport } from "../src/scenario-transport.js";
import { runScenarioReliability } from "../src/reliability-runner.js";

/** A fake environment carrying a sentinel where a key would be. The files a
 * run writes must contain nothing from it. */
const SENTINEL = "sk-SENTINEL-do-not-write-0123456789";
const fakeEnv = { GEMINI_API_KEY: SENTINEL, DEEPGRAM_API_KEY: `${SENTINEL}-dg`, HOME: "/home/x" };

const GENERATED = fileURLToPath(
  new URL("../scenarios/generated/bounded-holdMidCall.json", import.meta.url)
);
const fakeTransport = { marker: "fake" } as unknown as ScenarioTransport;
const aRun = (): ScenarioRun => ({
  transcript: "Hello, this is Ava.",
  endedBecause: "script-exhausted",
  turnsDelivered: 1,
  toolCalls: [],
  snapshot: {}
});
const tmp = (): string => join(mkdtempSync(join(tmpdir(), "parley-tx-")), "nested", "out");
const readAll = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));

describe("--gemini-model and --transcript flags", () => {
  it("parses both on all three commands, and leaves them absent when not given", () => {
    const bases = [
      ["scenario", "--file", "d", "--runs", "1"],
      ["metamorphic", "--file", "d", "--runs", "1"],
      ["reliability", "--brief", "b", "--scenario", "hostile"]
    ];
    for (const base of bases) {
      const args = parseCliArgs([
        ...base,
        "--gemini-model",
        "gemini-3.1-flash-live-preview",
        "--transcript",
        "out"
      ]);
      expect(args.geminiModel).toBe("gemini-3.1-flash-live-preview");
      expect(args.transcriptDir).toBe("out");
      const bare = parseCliArgs(base);
      expect(bare).not.toHaveProperty("geminiModel");
      expect(bare).not.toHaveProperty("transcriptDir");
    }
  });

  it("refuses --gemini-model with deepgram, and either flag without a value", () => {
    for (const base of [
      ["scenario", "--file", "d", "--runs", "1"],
      ["reliability", "--brief", "b", "--scenario", "hostile"]
    ]) {
      expect(() =>
        parseCliArgs([...base, "--realtime-provider", "deepgram", "--gemini-model", "m"])
      ).toThrow(/gemini-model/);
      expect(() => parseCliArgs([...base, "--gemini-model"])).toThrow(/gemini-model/);
      expect(() => parseCliArgs([...base, "--transcript"])).toThrow(/transcript/);
    }
  });

  it("threads the gemini model into the transport and the provider: line", async () => {
    const makeTransport = vi.fn(() => fakeTransport);
    const out = await runScenarioCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k", geminiModel: "gemini-x" },
      { makeTransport, run: async () => aRun() }
    );
    expect(makeTransport).toHaveBeenCalledWith("gemini", "k", undefined, "gemini-x");
    expect(out.split("\n")[0]).toBe("provider: gemini/gemini-x");
    const dflt = await runScenarioCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k" },
      { makeTransport, run: async () => aRun() }
    );
    expect(dflt.split("\n")[0]).toBe(`provider: gemini/${DEFAULT_GEMINI_MODEL}`);
  });

  it("threads it into the reliability provider too", async () => {
    const makeProvider = vi.fn(() => ({
      provider: { name: "fake" } as unknown as RealtimeProvider,
      model: "gemini-x"
    }));
    await runReliabilityCommand(
      { briefPath: "b.json", scenarioId: "hostile", runs: 1, apiKey: "k", geminiModel: "gemini-x" },
      {
        readFile: () =>
          JSON.stringify({ to: "+14155550123", persona: "p", objective: "o", facts: [] }),
        makeProvider,
        runScenarioReliability: async () => ({
          scenarioId: "hostile",
          runsRequested: 1,
          runsCompleted: 1,
          longestCleanStreak: 1,
          passed: true,
          failures: [],
          failuresByCode: {}
        })
      }
    );
    expect(makeProvider).toHaveBeenCalledWith("gemini", "k", undefined, "gemini-x");
  });
});

describe("--transcript files", () => {
  it("scenario: one JSON file per run, with transcript, trace, verdict and configuration", async () => {
    const dir = tmp();
    await runScenarioCommand(
      {
        scenarioPath: GENERATED,
        runs: 2,
        apiKey: SENTINEL,
        transcriptDir: dir,
        geminiModel: "g/x"
      },
      {
        makeTransport: () => fakeTransport,
        run: async ({ trace }) => {
          trace?.({ type: "turn-sent", label: "t1", atMs: 5 });
          return aRun();
        }
      }
    );
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    // The model id's slash is not a path separator.
    expect(files[0]).toMatch(/^scenario-[A-Za-z0-9._-]+-gemini-g_x-1\.json$/);
    expect(files[1]).toMatch(/-2\.json$/);
    const rec = JSON.parse(readFileSync(join(dir, files[0] as string), "utf8"));
    expect(Object.keys(rec).sort()).toEqual(
      [
        "command",
        "model",
        "provider",
        "runIndex",
        "scenarioId",
        "trace",
        "transcript",
        "verdict"
      ].sort()
    );
    expect(rec).toMatchObject({
      command: "scenario",
      provider: "gemini",
      model: "g/x",
      runIndex: 1
    });
    expect(rec.transcript).toBe("Hello, this is Ava.");
    expect(rec.trace).toEqual([{ type: "turn-sent", label: "t1", atMs: 5 }]);
    expect(typeof rec.verdict.pass).toBe("boolean");
    expect(Array.isArray(rec.verdict.failures)).toBe(true);
  });

  it("writes no file when the flag is absent", async () => {
    const trace = vi.fn();
    await runScenarioCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k" },
      { makeTransport: () => fakeTransport, run: async (p) => (trace(p.trace), aRun()) }
    );
    // No sink was requested, so none is handed to the runner.
    expect(trace).toHaveBeenCalledWith(undefined);
  });

  it("metamorphic: a file for each half of each pair, with the pair verdict", async () => {
    const dir = tmp();
    await runMetamorphicCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: SENTINEL, transcriptDir: dir },
      { makeTransport: () => fakeTransport, run: async () => aRun() }
    );
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.startsWith("metamorphic-"))).toBe(true);
    expect(files.some((f) => f.includes(".base-"))).toBe(true);
    expect(files.some((f) => f.includes(".variant-"))).toBe(true);
    const rec = JSON.parse(readFileSync(join(dir, files[0] as string), "utf8"));
    expect(rec.verdict).toHaveProperty("outcome");
  });

  it("reliability: a file per run holding the model transcript and typed codes", async () => {
    const dir = tmp();
    const caller: TranscriptEvent = { speaker: "caller", text: "Who won?", isFinal: true };
    const runAudioScript = vi.fn(async () => ({
      turns: [
        { label: "opening", transcript: [], modelAudioBytes: 0, lateModelTranscript: [] },
        { label: "topic-change", transcript: [caller], modelAudioBytes: 0, lateModelTranscript: [] }
      ],
      fullTranscript: [caller]
    }));
    const out = await runReliabilityCommand(
      {
        briefPath: "b.json",
        scenarioId: "topic-change",
        runs: 2,
        apiKey: SENTINEL,
        transcriptDir: dir
      },
      {
        readFile: () =>
          JSON.stringify({ to: "+14155550123", persona: "p", objective: "o", facts: [] }),
        makeProvider: () => ({
          provider: { name: "fake" } as unknown as RealtimeProvider,
          model: "gemini-x"
        }),
        runScenarioReliability: (params, deps) =>
          runScenarioReliability(params, { ...deps, runAudioScript, loadAudio: () => [] })
      }
    );
    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      "reliability-topic-change-gemini-gemini-x-1.json",
      "reliability-topic-change-gemini-gemini-x-2.json"
    ]);
    const rec = JSON.parse(readFileSync(join(dir, files[0] as string), "utf8"));
    expect(rec.transcript).toEqual([caller]);
    expect(rec.verdict.codes).toEqual(["no-reply"]);
    expect(rec.trace).toBeUndefined();
    // The report groups failures by typed code.
    expect(out).toContain("failures by code:");
    expect(out).toMatch(/no-reply\s+2\/2/);
  });

  it("never writes a value from the environment, even one a trace message carries", async () => {
    const dir = tmp();
    await runScenarioCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: fakeEnv.GEMINI_API_KEY, transcriptDir: dir },
      {
        makeTransport: () => fakeTransport,
        run: async ({ trace }) => {
          // A vendor diagnostic that echoed the connection URL would carry the key.
          trace?.({
            type: "transport-diagnostic",
            message: `connect wss://x?key=${fakeEnv.GEMINI_API_KEY}`,
            atMs: 1
          });
          return { ...aRun(), transcript: `leak ${fakeEnv.GEMINI_API_KEY}` };
        }
      }
    );
    for (const text of readAll(dir)) {
      for (const value of Object.values(fakeEnv)) expect(text).not.toContain(value);
    }
  });
});
