import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Brief, RealtimeProvider } from "@parley/core";
import { representedCall, type CallMode } from "@parley/policy";
import { DEFAULT_GEMINI_MODEL, GeminiRealtimeProvider } from "@parley/realtime-gemini";
import { buildPayloadPreview, formatPayloadPreview } from "./payload-preview.js";
import { runScenarioReliability } from "./reliability-runner.js";
import { DERAIL_SCENARIOS } from "./scenarios.js";
import { runTextPreview } from "./text-preview-runner.js";
import { callScenarioSchema, type CallScenario } from "./call-scenario.js";
import { runCallScenario } from "./call-scenario-runner.js";
import { evaluateCallScenario } from "./call-scenario-evaluation.js";
import type { RelationOutcome } from "./metamorphic.js";
import {
  generateScenarios,
  matrixCells,
  authorPrompt,
  type AuthoredContent,
  type ScenarioAuthor
} from "./generate-scenarios.js";
import { raiseQuoteAboveCeiling, relateQuoteRaise } from "./metamorphic.js";

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
  command:
    | "preview"
    | "scenarios"
    | "run-text-preview"
    | "reliability"
    | "scenario"
    | "metamorphic"
    | "generate-scenarios"
    | "help";
  briefPath?: string;
  scenarioId?: string;
  runs?: number;
  scenarioPath?: string;
  concurrency?: number;
  seedPath?: string;
  outDir?: string;
  only?: string;
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
  if (command === "scenario") {
    const scenarioPath = rest[rest.indexOf("--file") + 1];
    if (rest.indexOf("--file") === -1 || !scenarioPath)
      throw new Error("scenario requires --file <path>");
    const runsIdx = rest.indexOf("--runs");
    // No default. Every run is a billed Gemini Live session, and a defaulted
    // count is how a "quick check" silently becomes twenty of them.
    if (runsIdx === -1)
      throw new Error("scenario requires --runs <n> (no default — each run is a billed call)");
    const runs = Number(rest[runsIdx + 1]);
    if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
    const onlyIdx = rest.indexOf("--only");
    const concIdx = rest.indexOf("--concurrency");
    // Default 1: sequential is what every recorded baseline was measured under,
    // and a run count that silently changes its own execution shape is not a
    // comparison.
    const concurrency = concIdx === -1 ? 1 : Number(rest[concIdx + 1]);
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error("--concurrency must be a positive integer");
    return {
      command: "scenario",
      scenarioPath,
      runs,
      concurrency,
      ...(onlyIdx === -1 ? {} : { only: rest[onlyIdx + 1] })
    };
  }
  if (command === "metamorphic") {
    const scenarioPath = rest[rest.indexOf("--file") + 1];
    if (rest.indexOf("--file") === -1 || !scenarioPath)
      throw new Error("metamorphic requires --file <path>");
    const runsIdx = rest.indexOf("--runs");
    // Same rule as `scenario`, and it bites harder here: one "run" is a PAIR,
    // so it is two billed Gemini Live sessions, not one.
    if (runsIdx === -1)
      throw new Error(
        "metamorphic requires --runs <n> (no default — each run is a PAIR of billed calls)"
      );
    const runs = Number(rest[runsIdx + 1]);
    if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
    const onlyIdx = rest.indexOf("--only");
    return {
      command: "metamorphic",
      scenarioPath,
      runs,
      ...(onlyIdx === -1 ? {} : { only: rest[onlyIdx + 1] })
    };
  }
  if (command === "generate-scenarios") {
    const seedPath = rest[rest.indexOf("--seed") + 1];
    const outDir = rest[rest.indexOf("--out") + 1];
    if (rest.indexOf("--seed") === -1 || !seedPath || rest.indexOf("--out") === -1 || !outDir) {
      throw new Error("generate-scenarios requires --seed <path> and --out <dir>");
    }
    return { command: "generate-scenarios", seedPath, outDir };
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

/** Entries of a directory, or null when the path is not one. */
export type ReadDir = (path: string) => string[] | null;
const defaultReadDir: ReadDir = (path) => (statSync(path).isDirectory() ? readdirSync(path) : null);

/** Load one scenario file, or every .json in a directory. */
export function loadScenarios(
  path: string,
  readFile: ReadFile = defaultReadFile,
  readdir: ReadDir = defaultReadDir
): CallScenario[] {
  const entries = readdir(path);
  const paths =
    entries === null
      ? [path]
      : entries
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => join(path, f));
  return paths.map((p) => callScenarioSchema.parse(JSON.parse(readFile(p))));
}

export async function runScenarioCommand(
  args: { scenarioPath: string; runs: number; only?: string; apiKey: string; concurrency?: number },
  deps: {
    readFile?: ReadFile;
    readdir?: ReadDir;
    run?: typeof runCallScenario;
    onProgress?: (line: string) => void;
  } = {}
): Promise<string> {
  const doRun = deps.run ?? runCallScenario;
  const all = loadScenarios(args.scenarioPath, deps.readFile, deps.readdir);
  const selected = args.only ? all.filter((s) => s.id === args.only) : all;
  if (selected.length === 0)
    return `no scenarios matched${args.only ? ` --only ${args.only}` : ""}`;

  // Emit each verdict as it lands — twenty billed sessions is a half-hour run,
  // and one that prints nothing until it finishes is indistinguishable from a
  // wedged one. Same reason `generate-scenarios` writes incrementally.
  const collected: string[] = [];
  const lines = {
    push: (...ls: string[]) => {
      for (const l of ls) {
        collected.push(l);
        deps.onProgress?.(l);
      }
    }
  };
  let passes = 0;
  let total = 0;
  const byCode = new Map<string, number>();
  const byScenario = new Map<string, { pass: number; total: number }>();

  // Every (scenario, run) pair as one flat work list, so concurrency spreads
  // across scenarios rather than finishing one before starting the next.
  const jobs = selected.flatMap((scenario) =>
    Array.from({ length: args.runs }, (_, i) => ({ scenario, index: i }))
  );
  const concurrency = Math.min(args.concurrency ?? 1, jobs.length);

  const runOne = async (job: { scenario: CallScenario; index: number }): Promise<void> => {
    const { scenario, index } = job;
    const run = await doRun({ apiKey: args.apiKey, scenario });
    const verdict = evaluateCallScenario(scenario, run);
    // Tallying happens here, after the await, and each statement below is
    // synchronous — so concurrent workers interleave between jobs but never
    // inside one, and the counts cannot tear.
    total += 1;
    if (verdict.pass) passes += 1;
    const tally = byScenario.get(scenario.id) ?? { pass: 0, total: 0 };
    byScenario.set(scenario.id, {
      pass: tally.pass + (verdict.pass ? 1 : 0),
      total: tally.total + 1
    });
    // Count each code once per run: a run that fails an assertion twice is
    // still one run that failed it, and a rate over runs is the only figure
    // that can be compared between builds.
    for (const code of new Set(verdict.failures.map((f) => f.code))) {
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
    lines.push(
      `${verdict.pass ? "PASS" : "FAIL"} ${scenario.id} (run ${index + 1}/${args.runs}, ended: ${run.endedBecause})`
    );
    for (const f of verdict.failures) lines.push(`     ! ${f.detail}`);
    for (const w of verdict.warnings) lines.push(`     ~ ${w}`);
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      for (;;) {
        const job = jobs[next++];
        if (!job) return;
        await runOne(job);
      }
    })
  );

  lines.push(``, `${passes}/${total} runs passed across ${selected.length} scenario(s)`);

  if (byCode.size > 0) {
    lines.push(``, `failure rate by assertion, over ${total} run(s):`);
    for (const [code, n] of [...byCode].sort((a, b) => b[1] - a[1])) {
      lines.push(
        `  ${code.padEnd(18)} ${String(n).padStart(3)}/${total}  ${Math.round((n / total) * 100)}%`
      );
    }
  }

  // Only meaningful with repeats, and it is the figure that decides whether a
  // difference between two builds means anything: a scenario that passes some
  // runs and fails others is measuring variance, not behaviour. Two 20-cell
  // runs of the SAME build both scored 14/20 and shared only two failing cells.
  if (args.runs > 1) {
    const flaky = [...byScenario].filter(([, t]) => t.pass > 0 && t.pass < t.total);
    lines.push(
      ``,
      flaky.length === 0
        ? `no scenario changed verdict between runs`
        : `${flaky.length} scenario(s) changed verdict between runs — these measure variance, not behaviour:`
    );
    for (const [id, t] of flaky) lines.push(`  ${id} ${t.pass}/${t.total}`);
  }

  return collected.join("\n");
}

/**
 * Run metamorphic PAIRS: each scenario and a copy of it quoted above the spend
 * ceiling, judged on the property that must hold between the two runs.
 *
 * This is not the same test as running the `quoteAboveCeiling` cells. Those ask
 * whether the model got an absolute answer right, and that check is only ever
 * as good as the answer somebody wrote down. This asks whether CHANGING THE
 * PRICE changed the recorded outcome the way it has to — a question with no
 * authored answer in it at all, which is why it can catch a class of defect
 * nobody predicted.
 */
export async function runMetamorphicCommand(
  args: { scenarioPath: string; runs: number; only?: string; apiKey: string },
  deps: {
    readFile?: ReadFile;
    readdir?: ReadDir;
    run?: typeof runCallScenario;
    onProgress?: (line: string) => void;
  } = {}
): Promise<string> {
  const doRun = deps.run ?? runCallScenario;
  const all = loadScenarios(args.scenarioPath, deps.readFile, deps.readdir);
  const selected = args.only ? all.filter((s) => s.id === args.only) : all;
  if (selected.length === 0)
    return `no scenarios matched${args.only ? ` --only ${args.only}` : ""}`;

  // Emit each pair as it lands. Sixteen billed Gemini Live sessions is a
  // fifteen-minute run, and a fifteen-minute run that prints nothing until it
  // finishes is indistinguishable from a wedged one — the same reason
  // generate-scenarios writes incrementally.
  const collected: string[] = [];
  const lines = {
    push: (...ls: string[]) => {
      for (const l of ls) {
        collected.push(l);
        deps.onProgress?.(l);
      }
    }
  };
  const unpairable: string[] = [];
  const tally: Record<RelationOutcome, number> = { holds: 0, violated: 0, inconclusive: 0 };

  for (const scenario of selected) {
    const result = raiseQuoteAboveCeiling(scenario);
    if (result.kind === "unpairable") {
      unpairable.push(`  ${result.scenarioId}: ${result.reason}`);
      continue;
    }
    const { pair } = result;
    for (let i = 0; i < args.runs; i++) {
      const baseRun = await doRun({ apiKey: args.apiKey, scenario: pair.base });
      const variantRun = await doRun({ apiKey: args.apiKey, scenario: pair.variant });
      const verdict = relateQuoteRaise(pair, baseRun, variantRun);
      tally[verdict.outcome] += 1;
      lines.push(
        `${verdict.outcome.toUpperCase().padEnd(12)} ${pair.base.id} -> ${pair.raisedTo} ` +
          `(run ${i + 1}/${args.runs}; base ended ${baseRun.endedBecause}, variant ended ${variantRun.endedBecause})`
      );
      for (const v of verdict.violations) lines.push(`     ! ${v}`);
      for (const n of verdict.notes) lines.push(`     ~ ${n}`);
    }
  }

  if (unpairable.length > 0) {
    // Reported, never skipped in silence: an operator has to know which cells
    // the relation could not cover, or an empty violation list reads as proof.
    lines.push(``, `${unpairable.length} scenario(s) unpairable:`, ...unpairable);
  }
  lines.push(
    ``,
    `${tally.holds} held, ${tally.violated} violated, ${tally.inconclusive} inconclusive ` +
      `across ${tally.holds + tally.violated + tally.inconclusive} pair run(s)`
  );
  return collected.join("\n");
}

export async function runGenerateScenariosCommand(
  args: { seedPath: string; outDir: string; apiKey: string },
  deps: {
    readFile?: ReadFile;
    author?: ScenarioAuthor;
    write?: (path: string, body: string) => void;
  } = {}
): Promise<string> {
  const readFile = deps.readFile ?? defaultReadFile;
  const write =
    deps.write ??
    ((path: string, body: string) => {
      mkdirSync(args.outDir, { recursive: true });
      writeFileSync(path, body, "utf8");
    });
  const seed = callScenarioSchema.parse(JSON.parse(readFile(args.seedPath)));
  const author = deps.author ?? makeGeminiAuthor(args.apiKey);

  const { scenarios, findings } = await generateScenarios({
    seed,
    cells: matrixCells(),
    author,
    // Write as we go. A paced 20-cell run takes minutes, and a run that is
    // interrupted should keep what it already produced.
    onScenario: (s) => write(join(args.outDir, `${s.id}.json`), JSON.stringify(s, null, 2) + "\n")
  });

  const lines = [`wrote ${scenarios.length} scenario(s) to ${args.outDir}`];
  if (findings.length > 0) {
    lines.push(``, `${findings.length} finding(s):`);
    for (const f of findings) lines.push(`  [${f.kind}] ${f.cellId}: ${f.detail}`);
    lines.push(``, `An inexpressible-cell finding is a question for the design, not a bug.`);
    lines.push(`See docs/scenario-authoring.md.`);
  }
  return lines.join("\n");
}

/** Pinned, not `gemini-flash-latest`: generated scenarios are committed as
 * fixtures, and a floating model id makes them silently unreproducible. */
export const DEFAULT_AUTHOR_MODEL = "gemini-3.7-flash";

/** Free-tier keys allow 5 generateContent calls per minute per model, and the
 * matrix is 20 cells — so an unpaced run exhausts quota a third of the way in
 * and the rest come back as findings that say nothing about the scenarios.
 * Measured against a real key, not guessed.
 *
 * The default is the safe one. A key with real quota should set
 * PARLEY_AUTHOR_MIN_INTERVAL_MS low (a few hundred ms): at 13s the pacing alone
 * costs over four minutes per run and buys nothing. Retry-with-backoff still
 * covers a 429 either way, so lowering this trades a possible retry for a much
 * shorter run rather than risking a failed one. */
const AUTHOR_MIN_INTERVAL_MS = (() => {
  const raw = Number(process.env.PARLEY_AUTHOR_MIN_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 13_000;
})();
const AUTHOR_MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Honour the server's own retryDelay when it supplies one — it knows the quota
 * window better than a fixed backoff does. */
function retryDelayMs(error: unknown, attempt: number): number {
  const text = error instanceof Error ? error.message : String(error);
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  if (match) return Math.ceil(Number(match[1]) * 1000) + 500;
  return Math.min(30_000, 2_000 * 2 ** attempt);
}

function isRetryable(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text.includes("429") ||
    text.includes("RESOURCE_EXHAUSTED") ||
    text.includes("503") ||
    text.includes("UNAVAILABLE")
  );
}

/** Ask Gemini for PROSE ONLY. Everything a verdict depends on was decided by
 * buildScenarioRequest before this is called — see docs/scenario-authoring.md. */
function makeGeminiAuthor(apiKey: string): ScenarioAuthor {
  let lastCallAt = 0;
  return async (request) => {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });

    const since = Date.now() - lastCallAt;
    if (lastCallAt !== 0 && since < AUTHOR_MIN_INTERVAL_MS)
      await sleep(AUTHOR_MIN_INTERVAL_MS - since);

    let lastError: unknown;
    for (let attempt = 0; attempt < AUTHOR_MAX_ATTEMPTS; attempt++) {
      try {
        lastCallAt = Date.now();
        return await authorOnce(ai, request);
      } catch (err) {
        lastError = err;
        if (!isRetryable(err) || attempt === AUTHOR_MAX_ATTEMPTS - 1) throw err;
        await sleep(retryDelayMs(err, attempt));
      }
    }
    throw lastError;
  };
}

async function authorOnce(
  ai: import("@google/genai").GoogleGenAI,
  request: Parameters<ScenarioAuthor>[0]
): Promise<AuthoredContent> {
  {
    const res = await ai.models.generateContent({
      model: DEFAULT_AUTHOR_MODEL,
      contents: authorPrompt(request),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
            objective: { type: "string" },
            briefFacts: { type: "array", items: { type: "string" } },
            briefPreferences: { type: "array", items: { type: "string" } },
            menuWording: { type: "array", items: { type: "string" } },
            script: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  text: { type: "string" },
                  afterPress: { type: "string" }
                },
                required: ["label", "text"]
              }
            }
          },
          required: ["objective", "briefFacts", "briefPreferences", "menuWording", "script"]
        }
      }
    });
    return JSON.parse(res.text ?? "{}") as AuthoredContent;
  }
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
      "    the manual reliability gate (design spec §10.1).",
      "  parley-harness scenario --file <path|dir> --runs <n> [--only <id>] [--concurrency <n>]",
      "    Requires the GEMINI_API_KEY environment variable. Runs multi-turn",
      "    CallScenarios with a live tool channel and reports pass/fail against",
      "    each scenario's DERIVED expectations. --runs has no default: every",
      "    run is a billed Gemini Live session. --concurrency defaults to 1;",
      "    raising it cuts wall-clock, which is what makes more runs per cell",
      "    practical, and does not change the per-run cost.",
      "  parley-harness metamorphic --file <path|dir> --runs <n> [--only <id>]",
      "    Requires the GEMINI_API_KEY environment variable. Runs each scenario",
      "    PAIRED with a copy quoted above the spend ceiling, and checks the",
      "    property that must hold BETWEEN the two runs. One run is TWO billed",
      "    Gemini Live sessions.",
      "  parley-harness generate-scenarios --seed <path> --out <dir>",
      "    Requires the GEMINI_API_KEY environment variable. Manufactures",
      "    adjacent scenarios across the cost/complication matrix. Offline",
      "    text generation — cheap. See docs/scenario-authoring.md."
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
  } else if (args.command === "scenario" && args.scenarioPath && args.runs) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("scenario requires the GEMINI_API_KEY environment variable to be set.");
      process.exitCode = 1;
      return;
    }
    await runScenarioCommand(
      {
        scenarioPath: args.scenarioPath,
        runs: args.runs,
        ...(args.only ? { only: args.only } : {}),
        apiKey
      },
      { onProgress: (line) => console.log(line) }
    );
  } else if (args.command === "metamorphic" && args.scenarioPath && args.runs) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("metamorphic requires the GEMINI_API_KEY environment variable to be set.");
      process.exitCode = 1;
      return;
    }
    await runMetamorphicCommand(
      {
        scenarioPath: args.scenarioPath,
        runs: args.runs,
        ...(args.only ? { only: args.only } : {}),
        apiKey
      },
      { onProgress: (line) => console.log(line) }
    );
  } else if (args.command === "generate-scenarios" && args.seedPath && args.outDir) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error(
        "generate-scenarios requires the GEMINI_API_KEY environment variable to be set."
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      await runGenerateScenariosCommand({ seedPath: args.seedPath, outDir: args.outDir, apiKey })
    );
  } else {
    printHelp();
  }
}
