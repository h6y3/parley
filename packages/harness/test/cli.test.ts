import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultTimeZone, renderSystemInstruction, type TodayInput } from "@parley/core";
import { DEFAULT_GEMINI_MODEL } from "@parley/realtime-gemini";
import {
  loadBrief,
  METAMORPHIC_RELATIONS,
  parseCliArgs,
  pinnedToday,
  realtimeKeyVar,
  geminiKeyConflictNote,
  thinkFor,
  runPreviewCommand,
  runMetamorphicCommand,
  runReliabilityCommand,
  runScenarioCommand,
  runScenariosCommand,
  runTextPreviewCommand
} from "../src/cli.js";
import { MEETING_SCENARIOS } from "../src/scenarios.js";
import type { runTextPreview } from "../src/text-preview-runner.js";
import type { ScenarioRun } from "../src/call-scenario-evaluation.js";
import type { ScenarioTransport } from "../src/scenario-transport.js";

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
    // A two-party call opens in the prompt on both shipped providers.
    expect(output).toContain("openingTrigger: (none");
    expect(output).not.toContain("recipient:");
    expect(output).not.toContain("meetingBrief");
  });

  // An operator must be able to audit exactly what a call carries — the
  // meeting brief included — before dialling, without it appearing anywhere
  // in systemInstruction (see payload-preview.test.ts for that guarantee).
  it("shows execution.meeting.brief's fields when the envelope declares one", () => {
    const envelopeJson = JSON.stringify({
      version: 2,
      brief: JSON.parse(briefJson),
      policy: {},
      execution: {
        meeting: {
          consent: { phrase: "go ahead and take notes", timeoutSeconds: 120, onTimeout: "hangUp" },
          brief: {
            title: "Roadmap Sync",
            topic: "Q4 scope.",
            role: "product lead",
            track: ["engineering"]
          }
        }
      }
    });
    const readFile = fakeReadFile({ "envelope.json": envelopeJson });
    const output = runPreviewCommand({ command: "preview", briefPath: "envelope.json" }, readFile);
    expect(output).toContain("meetingBrief (audit-only — never sent to the model):");
    expect(output).toContain("title: Roadmap Sync");
    expect(output).toContain("track: engineering");
  });
});

describe("runScenariosCommand", () => {
  it("lists every derail scenario id and description", () => {
    const output = runScenariosCommand();
    expect(output).toContain("topic-change:");
    expect(output).toContain("silence:");
  });

  // MEETING_SCENARIOS had exactly one consumer — its own test. Absent from
  // this listing there was no way to discover a meeting derail's id, and
  // `harness reliability` takes an id.
  it("lists the meeting scenarios too, grouped so a meeting derail is not read as a two-party one", () => {
    const output = runScenariosCommand();
    for (const s of MEETING_SCENARIOS) expect(output).toContain(`${s.id}:`);
    expect(output).toContain("execution.meeting");
  });
});

describe("metamorphic relation selection", () => {
  it("defaults to the quote raise, so an existing invocation keeps running what it ran", () => {
    expect(parseCliArgs(["metamorphic", "--file", "s.json", "--runs", "1"]).relation).toBe(
      "quote-raised-above-ceiling"
    );
  });

  it("accepts the consent relation", () => {
    expect(
      parseCliArgs([
        "metamorphic",
        "--file",
        "s.json",
        "--runs",
        "1",
        "--relation",
        "consent-phrase-removed"
      ]).relation
    ).toBe("consent-phrase-removed");
  });

  it("refuses a relation it cannot run rather than silently falling back", () => {
    expect(() =>
      parseCliArgs(["metamorphic", "--file", "s.json", "--runs", "1", "--relation", "bogus"])
    ).toThrow(/--relation must be one of/);
  });

  it("declares both relations", () => {
    expect([...METAMORPHIC_RELATIONS]).toEqual([
      "quote-raised-above-ceiling",
      "consent-phrase-removed"
    ]);
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

  it("parses --realtime-provider and --think-model", () => {
    const args = parseCliArgs([
      "reliability",
      "--brief",
      "b.json",
      "--scenario",
      "hostile",
      "--realtime-provider",
      "deepgram",
      "--think-model",
      "claude-haiku-4-5"
    ]);
    expect(args.realtimeProvider).toBe("deepgram");
    expect(args.thinkModel).toBe("claude-haiku-4-5");
  });

  it("refuses an unknown realtime provider", () => {
    expect(() =>
      parseCliArgs(["reliability", "--brief", "b", "--scenario", "s", "--realtime-provider", "x"])
    ).toThrow(/realtime-provider/);
  });

  it("refuses --think-model with gemini rather than ignoring it", () => {
    expect(() =>
      parseCliArgs(["reliability", "--brief", "b", "--scenario", "s", "--think-model", "m"])
    ).toThrow(/think-model/);
  });
});

describe("geminiKeyConflictNote", () => {
  // The SDK warns "Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using
  // GOOGLE_API_KEY." from its constructor whenever both are in the
  // environment — even when, as here, the key is passed explicitly and the
  // explicit one is what it uses. A repro read that warning as the cause of a
  // stall and spent a batch unsetting the variable; the stall was something
  // else. So the harness says which key it is using, in its own words.
  it("names both variables and says the explicit GEMINI_API_KEY is the one used", () => {
    const note = geminiKeyConflictNote("gemini", { GOOGLE_API_KEY: "g", GEMINI_API_KEY: "m" });
    expect(note).toMatch(/GOOGLE_API_KEY/);
    expect(note).toMatch(/uses GEMINI_API_KEY/);
    expect(note).toMatch(/ignore/i);
  });

  it("never echoes either value", () => {
    const note = geminiKeyConflictNote("gemini", {
      GOOGLE_API_KEY: "secret-google-value",
      GEMINI_API_KEY: "secret-gemini-value"
    });
    expect(note).not.toMatch(/secret-/);
  });

  it("is silent when there is no conflict, or the provider is not Gemini", () => {
    expect(geminiKeyConflictNote("gemini", { GEMINI_API_KEY: "m" })).toBeUndefined();
    expect(
      geminiKeyConflictNote("gemini", { GEMINI_API_KEY: "m", GOOGLE_API_KEY: " " })
    ).toBeUndefined();
    expect(
      geminiKeyConflictNote("deepgram", { GOOGLE_API_KEY: "g", GEMINI_API_KEY: "m" })
    ).toBeUndefined();
  });
});

describe("realtimeKeyVar / thinkFor", () => {
  it("names the env variable per provider", () => {
    expect(realtimeKeyVar("gemini")).toBe("GEMINI_API_KEY");
    expect(realtimeKeyVar("deepgram")).toBe("DEEPGRAM_API_KEY");
  });

  it("routes claude- ids to the anthropic think provider, others to open_ai", () => {
    expect(thinkFor("claude-haiku-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5"
    });
    expect(thinkFor("gpt-5.4")).toEqual({ provider: "open_ai", model: "gpt-5.4" });
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
        makeProvider: () => ({
          provider: { name: "fake" } as unknown as import("@parley/core").RealtimeProvider,
          model: "gemini-x"
        }),
        runScenarioReliability: async () => ({
          scenarioId: "hostile",
          runsRequested: 5,
          runsCompleted: 5,
          longestCleanStreak: 5,
          passed: true,
          failures: [],
          failuresByCode: {}
        })
      }
    );
    expect(out).toContain("PASSED: true");
    expect(out).toContain("scenario: hostile");
    expect(out).toContain("provider: gemini/gemini-x");
  });

  it("builds the chosen provider kind and think model through makeProvider", async () => {
    const makeProvider = vi.fn(() => ({
      provider: { name: "fake" } as unknown as import("@parley/core").RealtimeProvider,
      model: "gpt-5.4-mini"
    }));
    const out = await runReliabilityCommand(
      {
        briefPath: "b.json",
        scenarioId: "hostile",
        runs: 1,
        apiKey: "k",
        realtimeProvider: "deepgram",
        thinkModel: "gpt-5.4-mini"
      },
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
    expect(makeProvider).toHaveBeenCalledWith("deepgram", "k", "gpt-5.4-mini", undefined);
    expect(out).toContain("provider: deepgram/gpt-5.4-mini");
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

describe("--concurrency actually runs scenarios concurrently", () => {
  it("overlaps runs at the requested width", async () => {
    // There was no behavioural test for this at all, and `main` was quietly
    // dropping the flag on its way to `runScenarioCommand` — parsed,
    // range-checked, printed in --help, and then not forwarded, so
    // `--concurrency 5` ran five billed sessions one after another. A parse
    // assertion cannot see that: it stops one call short of the thing.
    const scenario = {
      id: "s",
      description: "d",
      envelope: {
        version: 2,
        brief: { to: "+15555550100", persona: "p", objective: "o", facts: [] },
        policy: {
          principalName: "Alex Rivera",
          identity: { style: "self" },
          disclosure: { honestIfAsked: false, volunteer: false },
          scope: { lock: false },
          grounding: { antiInvention: true },
          deferral: { enabled: false },
          authority: {}
        },
        execution: {}
      },
      params: {
        menu: [],
        correctDigit: null,
        quotedAmount: null,
        raisedTopic: null,
        adjacentIndex: null,
        offersAppointment: false,
        reachesSomeoneWhoCanAct: true
      },
      script: [{ label: "l", text: "hello" }]
    };

    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const runOne = async (): Promise<ScenarioRun> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return {
        transcript: "",
        endedBecause: "script-exhausted",
        turnsDelivered: 1,
        toolCalls: [],
        snapshot: {}
      };
    };

    const finished = runScenarioCommand(
      { scenarioPath: "x.json", runs: 4, concurrency: 3, apiKey: "unused" },
      {
        readFile: () => JSON.stringify(scenario),
        readdir: () => null,
        run: runOne
      }
    );
    // Let the three workers start, then drain everything.
    await new Promise((r) => setTimeout(r, 0));
    while (release.length > 0 || inFlight > 0) {
      release.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await finished;
    expect(peak).toBe(3);
  });
});

/** Layers 2 and 3 measure a CONFIGURATION, not a model family: the matrix and
 * the metamorphic pairs have to run against each provider, and each report has
 * to say which one it measured. */
describe("scenario and metamorphic run against any realtime provider", () => {
  const GENERATED = fileURLToPath(
    new URL("../scenarios/generated/bounded-holdMidCall.json", import.meta.url)
  );
  const aRun = (): ScenarioRun => ({
    transcript: "",
    endedBecause: "script-exhausted",
    turnsDelivered: 1,
    toolCalls: [],
    snapshot: {}
  });
  const fakeTransport = { marker: "fake" } as unknown as ScenarioTransport;

  it("parses --realtime-provider and --think-model on both commands", () => {
    for (const command of ["scenario", "metamorphic"]) {
      const args = parseCliArgs([
        command,
        "--file",
        "d",
        "--runs",
        "1",
        "--realtime-provider",
        "deepgram",
        "--think-model",
        "claude-haiku-4-5"
      ]);
      expect(args.realtimeProvider).toBe("deepgram");
      expect(args.thinkModel).toBe("claude-haiku-4-5");
    }
  });

  it("refuses an unknown provider, and a think model on gemini, on both commands", () => {
    for (const command of ["scenario", "metamorphic"]) {
      const base = [command, "--file", "d", "--runs", "1"];
      expect(() => parseCliArgs([...base, "--realtime-provider", "x"])).toThrow(
        /realtime-provider/
      );
      expect(() => parseCliArgs([...base, "--think-model", "m"])).toThrow(/think-model/);
    }
  });

  it("parses --first-line-delay-ms on both commands, and leaves it absent when not given", () => {
    for (const command of ["scenario", "metamorphic"]) {
      const base = [command, "--file", "d", "--runs", "1"];
      expect(parseCliArgs([...base, "--first-line-delay-ms", "3000"]).firstLineDelayMs).toBe(3000);
      expect(parseCliArgs([...base, "--first-line-delay-ms", "0"]).firstLineDelayMs).toBe(0);
      expect(parseCliArgs(base)).not.toHaveProperty("firstLineDelayMs");
    }
  });

  it("refuses a negative, fractional, missing or non-numeric --first-line-delay-ms", () => {
    for (const command of ["scenario", "metamorphic"]) {
      const base = [command, "--file", "d", "--runs", "1", "--first-line-delay-ms"];
      for (const bad of [["-1"], ["1.5"], ["soon"], [""], []]) {
        expect(() => parseCliArgs([...base, ...bad])).toThrow(/first-line-delay-ms/);
      }
    }
  });

  it("feeds --first-line-delay-ms into every run's timings", async () => {
    const seen: (number | undefined)[] = [];
    const run = async (p: { timings?: { firstLineDelayMs?: number } }) => {
      seen.push(p.timings?.firstLineDelayMs);
      return aRun();
    };
    await runScenarioCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k", firstLineDelayMs: 3000 },
      { makeTransport: () => fakeTransport, run }
    );
    await runMetamorphicCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k", firstLineDelayMs: 3000 },
      { makeTransport: () => fakeTransport, run }
    );
    expect(seen).toEqual([3000, 3000, 3000]);
    // Not given: the runner's own default timings, untouched.
    seen.length = 0;
    await runScenarioCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k" },
      { makeTransport: () => fakeTransport, run }
    );
    expect(seen).toEqual([undefined]);
  });

  /** The model is told today's date, and a script saying "this Wednesday" is
   * ambiguous on a Wednesday: the Task 20 cell failed 2/2 for that reason
   * alone on 2026-09-30. `--today` pins the date so a matrix is reproducible. */
  it("parses --today on scenario, metamorphic and reliability, and leaves it absent when not given", () => {
    const bases = [
      ["scenario", "--file", "d", "--runs", "1"],
      ["metamorphic", "--file", "d", "--runs", "1"],
      ["reliability", "--brief", "b.json", "--scenario", "hostile"]
    ];
    for (const base of bases) {
      expect(parseCliArgs([...base, "--today", "2026-10-05"]).today).toBe("2026-10-05");
      expect(parseCliArgs(base)).not.toHaveProperty("today");
    }
  });

  it("refuses a --today that is not a real YYYY-MM-DD date, naming the flag", () => {
    const bases = [
      ["scenario", "--file", "d", "--runs", "1"],
      ["metamorphic", "--file", "d", "--runs", "1"],
      ["reliability", "--brief", "b.json", "--scenario", "hostile"]
    ];
    for (const base of bases) {
      for (const bad of [
        ["2026-13-01"],
        ["2026-02-30"],
        ["10/05/2026"],
        ["2026-10-5"],
        ["tomorrow"],
        [""],
        []
      ]) {
        expect(() => parseCliArgs([...base, "--today", ...bad])).toThrow(
          /--today must be a date as YYYY-MM-DD/
        );
      }
    }
  });

  /** The date sentence as a prompt carries it — read through the public
   * renderer, since the sentence builder itself is core-internal. */
  const todaySentence = (today: TodayInput): string =>
    renderSystemInstruction({ persona: "", objective: "", facts: [], guardrails: [], today });

  it("pins the same calendar date in any zone, however far from UTC", () => {
    for (const timeZone of [
      "UTC",
      "America/Los_Angeles",
      "Asia/Kolkata",
      "Pacific/Kiritimati",
      "Pacific/Pago_Pago",
      "Etc/GMT+12"
    ]) {
      expect(todaySentence(pinnedToday("2026-10-05", timeZone))).toContain(
        `Today is Monday, 2026-10-05 (${timeZone})`
      );
    }
  });

  it("feeds --today into every scenario and metamorphic run as that date in the host zone", async () => {
    const seen: (TodayInput | undefined)[] = [];
    const run = async (p: { today?: TodayInput }) => {
      seen.push(p.today);
      return aRun();
    };
    await runScenarioCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k", today: "2026-10-05" },
      { makeTransport: () => fakeTransport, run }
    );
    await runMetamorphicCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k", today: "2026-10-05" },
      { makeTransport: () => fakeTransport, run }
    );
    expect(seen).toHaveLength(3);
    for (const today of seen) {
      expect(today?.timeZone).toBe(defaultTimeZone());
      expect(todaySentence(today!)).toContain(`Today is Monday, 2026-10-05 (${defaultTimeZone()})`);
    }
    // Not given: the runner's own default (the wall clock), untouched.
    seen.length = 0;
    await runScenarioCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k" },
      { makeTransport: () => fakeTransport, run }
    );
    expect(seen).toEqual([undefined]);
  });

  it("names a pinned date in the report header, and says nothing when it is the wall clock", async () => {
    const run = async () => aRun();
    const pinned = await runScenarioCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k", today: "2026-10-05" },
      { makeTransport: () => fakeTransport, run }
    );
    expect(pinned).toContain("today: 2026-10-05 (pinned with --today)");
    const pinnedPairs = await runMetamorphicCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k", today: "2026-10-05" },
      { makeTransport: () => fakeTransport, run }
    );
    expect(pinnedPairs).toContain("today: 2026-10-05 (pinned with --today)");
    const wall = await runScenarioCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k" },
      { makeTransport: () => fakeTransport, run }
    );
    expect(wall).not.toContain("today:");
  });

  it("puts a pinned --today into reliability's system instruction", async () => {
    const instructions: string[] = [];
    const deps = {
      readFile: () =>
        JSON.stringify({ to: "+14155550123", persona: "p", objective: "o", facts: [] }),
      makeProvider: () => ({
        provider: { name: "fake" } as unknown as import("@parley/core").RealtimeProvider,
        model: "gemini-x"
      }),
      runScenarioReliability: async (p: { systemInstruction: string }) => {
        instructions.push(p.systemInstruction);
        return {
          scenarioId: "hostile",
          runsRequested: 1,
          runsCompleted: 1,
          longestCleanStreak: 1,
          passed: true,
          failures: [],
          failuresByCode: {}
        };
      }
    };
    const out = await runReliabilityCommand(
      { briefPath: "b.json", scenarioId: "hostile", runs: 1, apiKey: "k", today: "2026-10-05" },
      deps as never
    );
    expect(instructions[0]).toContain(`Today is Monday, 2026-10-05 (${defaultTimeZone()})`);
    expect(out).toContain("today: 2026-10-05 (pinned with --today)");
  });

  it("scenario builds a fresh transport of the chosen kind for every run", async () => {
    const makeTransport = vi.fn(() => fakeTransport);
    const seen: ScenarioTransport[] = [];
    const out = await runScenarioCommand(
      {
        scenarioPath: GENERATED,
        runs: 2,
        apiKey: "k",
        realtimeProvider: "deepgram",
        thinkModel: "claude-haiku-4-5"
      },
      {
        makeTransport,
        run: async ({ transport }) => {
          seen.push(transport);
          return aRun();
        }
      }
    );
    expect(makeTransport).toHaveBeenCalledTimes(2);
    expect(makeTransport).toHaveBeenCalledWith("deepgram", "k", "claude-haiku-4-5", undefined);
    expect(seen).toEqual([fakeTransport, fakeTransport]);
    expect(out.split("\n")[0]).toBe("provider: deepgram/claude-haiku-4-5");
  });

  it("metamorphic builds one per half of every pair, and names the configuration", async () => {
    const makeTransport = vi.fn(() => fakeTransport);
    const out = await runMetamorphicCommand(
      { scenarioPath: GENERATED, runs: 1, apiKey: "k" },
      { makeTransport, run: async () => aRun() }
    );
    expect(makeTransport).toHaveBeenCalledTimes(2);
    expect(makeTransport).toHaveBeenCalledWith("gemini", "k", undefined, undefined);
    expect(out.split("\n")[0]).toBe(`provider: gemini/${DEFAULT_GEMINI_MODEL}`);
  });
});
