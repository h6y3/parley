import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Brief, RealtimeProvider } from "@parley/core";
import { representedCall, type CallMode } from "@parley/policy";
import { DEFAULT_GEMINI_MODEL, GeminiRealtimeProvider } from "@parley/realtime-gemini";
import { buildPayloadPreview, formatPayloadPreview } from "./payload-preview.js";
import { runScenarioReliability } from "./reliability-runner.js";
import { DERAIL_SCENARIOS } from "./scenarios.js";
import { runTextPreview } from "./text-preview-runner.js";

/** The harness always previews/runs against one fixed represented-mode policy
 * — "calling on Alex Rivera's behalf" — since the harness's job is to exercise
 * call BEHAVIOR (derail scenarios, disclosure, marker leaks) against a
 * consistent guardrail set, not to exercise the policy envelope itself (that
 * is @parley/policy's own test surface, and @parley/server's request-time
 * concern for real calls). There is no more per-recipient RecipientRegistry
 * in the call path. */
const HARNESS_POLICY = representedCall({ principalName: "Alex Rivera" });
const HARNESS_MODE: CallMode = "represented";

export interface ParsedCliArgs {
  command: "preview" | "scenarios" | "run-text-preview" | "reliability" | "help";
  briefPath?: string;
  scenarioId?: string;
  runs?: number;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const [command, ...rest] = argv;
  if (command === "preview") {
    const briefPath = rest[rest.indexOf("--brief") + 1];
    if (!briefPath || rest.indexOf("--brief") === -1) {
      throw new Error("preview requires --brief <path>");
    }
    return { command: "preview", briefPath };
  }
  if (command === "run-text-preview") {
    const briefPath = rest[rest.indexOf("--brief") + 1];
    if (!briefPath || rest.indexOf("--brief") === -1) {
      throw new Error("run-text-preview requires --brief <path>");
    }
    return { command: "run-text-preview", briefPath };
  }
  if (command === "scenarios") {
    return { command: "scenarios" };
  }
  if (command === "reliability") {
    const briefPath = rest[rest.indexOf("--brief") + 1];
    const scenarioId = rest[rest.indexOf("--scenario") + 1];
    if (
      rest.indexOf("--brief") === -1 ||
      rest.indexOf("--scenario") === -1 ||
      !briefPath ||
      !scenarioId
    ) {
      throw new Error("reliability requires --brief <path> and --scenario <id>");
    }
    const runsIdx = rest.indexOf("--runs");
    const runs = runsIdx === -1 ? 20 : Number(rest[runsIdx + 1]);
    if (!Number.isInteger(runs) || runs < 1) {
      throw new Error("--runs must be a positive integer");
    }
    return { command: "reliability", briefPath, scenarioId, runs };
  }
  return { command: "help" };
}

type ReadFile = (path: string) => string;
const defaultReadFile: ReadFile = (path) => readFileSync(path, "utf8");

export function loadBrief(path: string, readFile: ReadFile = defaultReadFile): Brief {
  const parsed = JSON.parse(readFile(path)) as unknown;
  // Accept either a bare Brief or a full call envelope ({version, brief, policy}).
  if (
    parsed &&
    typeof parsed === "object" &&
    "brief" in parsed &&
    typeof (parsed as { brief: unknown }).brief === "object"
  ) {
    return (parsed as { brief: Brief }).brief;
  }
  return parsed as Brief;
}

export function runPreviewCommand(
  args: ParsedCliArgs & { command: "preview"; briefPath: string },
  readFile: ReadFile = defaultReadFile
): string {
  const brief = loadBrief(args.briefPath, readFile);
  return formatPayloadPreview(buildPayloadPreview(brief, HARNESS_POLICY));
}

export function runScenariosCommand(): string {
  return DERAIL_SCENARIOS.map((scenario) => `${scenario.id}: ${scenario.description}`).join("\n");
}

export async function runTextPreviewCommand(
  args: { briefPath: string; apiKey: string },
  deps: { readFile?: ReadFile; runTextPreview?: typeof runTextPreview } = {}
): Promise<string> {
  const readFile = deps.readFile ?? defaultReadFile;
  const doRunTextPreview = deps.runTextPreview ?? runTextPreview;

  const brief = loadBrief(args.briefPath, readFile);
  const preview = buildPayloadPreview(brief, HARNESS_POLICY);

  const result = await doRunTextPreview({
    apiKey: args.apiKey,
    systemInstruction: preview.systemInstruction,
    openingTrigger: preview.openingTrigger,
    userTurns: DERAIL_SCENARIOS.filter((scenario) => scenario.calleeLine).map(
      (scenario) => scenario.calleeLine
    )
  });

  return result.turns
    .map(
      (turn) =>
        `[${turn.label}]${turn.userText ? ` USER: ${turn.userText}\n` : " "}BOT: ${turn.responseText}`
    )
    .join("\n\n");
}

export async function runReliabilityCommand(
  args: { briefPath: string; scenarioId: string; runs: number; apiKey: string },
  deps: {
    readFile?: ReadFile;
    makeProvider?: (apiKey: string) => RealtimeProvider;
    runScenarioReliability?: typeof runScenarioReliability;
  } = {}
): Promise<string> {
  const readFile = deps.readFile ?? defaultReadFile;
  const makeProvider = deps.makeProvider ?? ((apiKey) => new GeminiRealtimeProvider({ apiKey }));
  const doRun = deps.runScenarioReliability ?? runScenarioReliability;

  const brief = loadBrief(args.briefPath, readFile);
  const preview = buildPayloadPreview(brief, HARNESS_POLICY);

  const report = await doRun({
    provider: makeProvider(args.apiKey),
    model: DEFAULT_GEMINI_MODEL,
    systemInstruction: preview.systemInstruction,
    openingTrigger: preview.openingTrigger,
    scenarioId: args.scenarioId,
    mode: HARNESS_MODE,
    runs: args.runs
  });

  return [
    `scenario: ${report.scenarioId}`,
    `runs: ${report.runsCompleted}/${report.runsRequested}`,
    `longest clean streak: ${report.longestCleanStreak}`,
    `PASSED: ${report.passed}`,
    `failures: ${report.failures.length}`
  ].join("\n");
}

function printHelp(): void {
  console.log(
    [
      "Usage:",
      "  parley-harness preview --brief <path>",
      "  parley-harness scenarios",
      "  parley-harness run-text-preview --brief <path>",
      "    Requires the GEMINI_API_KEY environment variable. Makes a LIVE",
      "    Gemini call to preview scripted-scenario turns as text — this is",
      "    not a reliability gate.",
      "  parley-harness reliability --brief <path> --scenario <id> [--runs <n>]",
      "    Requires the GEMINI_API_KEY environment variable. Makes LIVE Gemini",
      "    calls, repeatedly running one derail scenario end-to-end — this IS",
      "    the manual reliability gate (design spec §10.1)."
    ].join("\n")
  );
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseCliArgs(argv);
  if (args.command === "preview" && args.briefPath) {
    console.log(runPreviewCommand({ command: "preview", briefPath: args.briefPath }));
  } else if (args.command === "scenarios") {
    console.log(runScenariosCommand());
  } else if (args.command === "run-text-preview" && args.briefPath) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("run-text-preview requires the GEMINI_API_KEY environment variable to be set.");
      process.exitCode = 1;
      return;
    }
    console.log(await runTextPreviewCommand({ briefPath: args.briefPath, apiKey }, {}));
  } else if (args.command === "reliability" && args.briefPath && args.scenarioId && args.runs) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("reliability requires the GEMINI_API_KEY environment variable to be set.");
      process.exitCode = 1;
      return;
    }
    console.log(
      await runReliabilityCommand({
        briefPath: args.briefPath,
        scenarioId: args.scenarioId,
        runs: args.runs,
        apiKey
      })
    );
  } else {
    printHelp();
  }
}

// Run only when this file is executed directly (e.g. as the `parley-harness`
// bin or `node dist/cli.js ...`) — not when the harness test suite imports
// the named exports above, which must stay side-effect-free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
