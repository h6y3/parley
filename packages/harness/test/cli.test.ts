import { describe, expect, it, vi } from "vitest";
import {
  loadBrief,
  parseCliArgs,
  runPreviewCommand,
  runReliabilityCommand,
  runScenariosCommand,
  runTextPreviewCommand
} from "../src/cli.js";
import type { runTextPreview } from "../src/text-preview-runner.js";

const briefJson = JSON.stringify({
  to: "+14085559999",
  persona: "You are Ada, an assistant calling on behalf of Alex Rivera.",
  objective: "Schedule a plumbing appointment.",
  facts: ["Alex Rivera is available Tuesday afternoon."]
});

function fakeReadFile(files: Record<string, string>) {
  return (path: string) => {
    if (!(path in files)) throw new Error(`fakeReadFile: no fixture for ${path}`);
    return files[path];
  };
}

describe("parseCliArgs", () => {
  it("parses a preview command with --brief", () => {
    expect(parseCliArgs(["preview", "--brief", "brief.json"])).toEqual({
      command: "preview",
      briefPath: "brief.json"
    });
  });

  it("parses a scenarios command", () => {
    expect(parseCliArgs(["scenarios"])).toEqual({ command: "scenarios" });
  });

  it("falls back to help for an unrecognized command", () => {
    expect(parseCliArgs([])).toEqual({ command: "help" });
    expect(parseCliArgs(["bogus"])).toEqual({ command: "help" });
  });

  it("throws when preview is missing required flags", () => {
    expect(() => parseCliArgs(["preview"])).toThrow("preview requires --brief <path>");
  });

  it("parses a run-text-preview command with --brief", () => {
    expect(parseCliArgs(["run-text-preview", "--brief", "brief.json"])).toEqual({
      command: "run-text-preview",
      briefPath: "brief.json"
    });
  });

  it("throws when run-text-preview is missing required flags", () => {
    expect(() => parseCliArgs(["run-text-preview"])).toThrow(
      "run-text-preview requires --brief <path>"
    );
  });
});

describe("loadBrief", () => {
  const readFile = fakeReadFile({ "brief.json": briefJson });

  it("parses a Brief from JSON", () => {
    expect(loadBrief("brief.json", readFile).objective).toBe("Schedule a plumbing appointment.");
  });
});

describe("runPreviewCommand", () => {
  it("renders a full payload preview from the harness's fixed represented-mode policy", () => {
    const readFile = fakeReadFile({ "brief.json": briefJson });
    const output = runPreviewCommand({ command: "preview", briefPath: "brief.json" }, readFile);
    expect(output).toContain("personal assistant");
    expect(output).toContain("openingTrigger:");
    expect(output).not.toContain("recipient:");
  });
});

describe("runScenariosCommand", () => {
  it("lists every derail scenario id and description", () => {
    const output = runScenariosCommand();
    expect(output).toContain("topic-change:");
    expect(output).toContain("silence:");
  });
});

describe("runTextPreviewCommand", () => {
  it("builds the payload preview and drives runTextPreview with every non-empty scenario line", async () => {
    const readFile = fakeReadFile({ "brief.json": briefJson });
    const fakeRunTextPreview = vi.fn<typeof runTextPreview>(async () => ({
      turns: [
        {
          label: "opening",
          userText: undefined,
          responseText: "Hi there, I'm an AI assistant calling on behalf of Alex Rivera."
        }
      ],
      fullText: "Hi there, I'm an AI assistant calling on behalf of Alex Rivera."
    }));

    const output = await runTextPreviewCommand(
      { briefPath: "brief.json", apiKey: "fake" },
      { readFile, runTextPreview: fakeRunTextPreview }
    );

    expect(fakeRunTextPreview).toHaveBeenCalledOnce();
    const callArgs = fakeRunTextPreview.mock.calls[0][0];
    expect(callArgs.apiKey).toBe("fake");
    expect(callArgs.userTurns).not.toContain("");
    expect(callArgs.userTurns.length).toBe(7);
    expect(output).toContain("[opening]");
    expect(output).toContain("Hi there, I'm an AI assistant calling on behalf of Alex Rivera.");
  });
});

describe("parseCliArgs reliability", () => {
  it("parses reliability with defaults", () => {
    const args = parseCliArgs(["reliability", "--brief", "b.json", "--scenario", "hostile"]);
    expect(args).toEqual({
      command: "reliability",
      briefPath: "b.json",
      scenarioId: "hostile",
      runs: 20
    });
  });

  it("throws without --scenario", () => {
    expect(() => parseCliArgs(["reliability", "--brief", "b.json"])).toThrow(/scenario/);
  });
});

describe("runReliabilityCommand", () => {
  it("formats the report from an injected runner without touching the network", async () => {
    const out = await runReliabilityCommand(
      { briefPath: "b.json", scenarioId: "hostile", runs: 5, apiKey: "fake" },
      {
        readFile: (p: string) =>
          p === "b.json"
            ? JSON.stringify({ to: "+14155550123", persona: "p", objective: "o", facts: [] })
            : "",
        makeProvider: () =>
          ({ name: "fake" }) as unknown as import("@parley/core").RealtimeProvider,
        runScenarioReliability: async () => ({
          scenarioId: "hostile",
          runsRequested: 5,
          runsCompleted: 5,
          longestCleanStreak: 5,
          passed: true,
          failures: []
        })
      }
    );
    expect(out).toContain("PASSED: true");
    expect(out).toContain("scenario: hostile");
  });
});

describe("scenario commands", () => {
  it("parses the scenario command", () => {
    expect(parseCliArgs(["scenario", "--file", "s.json", "--runs", "1"])).toEqual({
      command: "scenario",
      scenarioPath: "s.json",
      runs: 1,
      concurrency: 1
    });
  });

  it("parses an --only filter", () => {
    expect(
      parseCliArgs(["scenario", "--file", "d", "--runs", "2", "--only", "bounded-holdMidCall"])
    ).toEqual({
      command: "scenario",
      scenarioPath: "d",
      runs: 2,
      only: "bounded-holdMidCall",
      concurrency: 1
    });
  });

  // No default on --runs, deliberately: each run is a billed Gemini Live
  // session, and a default is how a quick check becomes twenty of them.
  it("refuses a scenario run with no explicit --runs", () => {
    expect(() => parseCliArgs(["scenario", "--file", "s.json"])).toThrow(/--runs/);
  });

  it("refuses a non-positive --runs", () => {
    expect(() => parseCliArgs(["scenario", "--file", "s.json", "--runs", "0"])).toThrow(/positive/);
  });

  it("refuses a scenario command with no --file", () => {
    expect(() => parseCliArgs(["scenario", "--runs", "1"])).toThrow(/--file/);
  });

  it("parses the generate-scenarios command", () => {
    expect(parseCliArgs(["generate-scenarios", "--seed", "s.json", "--out", "d"])).toEqual({
      command: "generate-scenarios",
      seedPath: "s.json",
      outDir: "d"
    });
  });

  it("refuses generate-scenarios without both --seed and --out", () => {
    expect(() => parseCliArgs(["generate-scenarios", "--seed", "s.json"])).toThrow(/--out/);
  });
});
