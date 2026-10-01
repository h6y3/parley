import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultTimeZone,
  type Brief,
  type MeetingExecution,
  type RealtimeProvider,
  type TodayInput
} from "@parley/core";
import { representedCall, type CallMode } from "@parley/policy";
import { DEFAULT_GEMINI_MODEL, GeminiRealtimeProvider } from "@parley/realtime-gemini";
import { DEFAULT_DEEPGRAM_THINK, createDeepgramRealtimeProvider } from "@parley/realtime-deepgram";
import { buildPayloadPreview, formatPayloadPreview } from "./payload-preview.js";
import { runScenarioReliability } from "./reliability-runner.js";
import { writeRunRecord } from "./run-records.js";
import { DERAIL_SCENARIOS, MEETING_SCENARIOS } from "./scenarios.js";
import { runTextPreview } from "./text-preview-runner.js";
import { callScenarioSchema, type CallScenario } from "./call-scenario.js";
import {
  DEFAULT_SCENARIO_TIMINGS,
  runCallScenario,
  type ScenarioTraceEvent
} from "./call-scenario-runner.js";
import type { ScenarioTransport } from "./scenario-transport.js";
import { geminiTransport } from "./transports/gemini-transport.js";
import { deepgramTransport } from "./transports/deepgram-transport.js";
import { evaluateCallScenario } from "./call-scenario-evaluation.js";
import type { RelationOutcome } from "./metamorphic.js";
import {
  generateScenarios,
  matrixCells,
  authorPrompt,
  type AuthoredContent,
  type ScenarioAuthor
} from "./generate-scenarios.js";
import {
  raiseQuoteAboveCeiling,
  relateConsentGate,
  relateQuoteRaise,
  withoutConsentPhrase
} from "./metamorphic.js";
import type { ScenarioRun } from "./call-scenario-evaluation.js";

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
  relation?: MetamorphicRelationId;
  realtimeProvider?: RealtimeProviderKind;
  thinkModel?: string;
  /** Gemini's model id, when not the default. */
  geminiModel?: string;
  /** Directory `--transcript` writes one JSON file per run into. */
  transcriptDir?: string;
  firstLineDelayMs?: number;
  /** `--today`: the date the model is told, as `YYYY-MM-DD`. */
  today?: string;
}

/** The realtime providers `reliability`, `scenario` and `metamorphic` can
 * drive. The harness builds its own rather than importing @parley/cli or
 * @parley/server, which sit above it. */
export const REALTIME_PROVIDER_KINDS = ["gemini", "deepgram"] as const;
export type RealtimeProviderKind = (typeof REALTIME_PROVIDER_KINDS)[number];

/** The environment variable holding a provider's key. */
export function realtimeKeyVar(kind: RealtimeProviderKind): string {
  return kind === "deepgram" ? "DEEPGRAM_API_KEY" : "GEMINI_API_KEY";
}

/** A line for stderr when the environment holds both Google key variables on
 * a Gemini run, or undefined when it does not.
 *
 * The SDK's constructor reads the environment for a fallback key even when it
 * is handed one, and when both variables are set it warns "Using
 * GOOGLE_API_KEY" — then uses the explicit key anyway (pinned against the real
 * SDK in @parley/realtime-gemini's tests). The harness always passes
 * GEMINI_API_KEY explicitly, so the warning is false here, and a repro that
 * believed it chased the wrong cause of a stall. Names the variables, never
 * their values. */
export function geminiKeyConflictNote(
  kind: RealtimeProviderKind,
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  if (kind !== "gemini") return undefined;
  if (!env.GOOGLE_API_KEY?.trim() || !env.GEMINI_API_KEY?.trim()) return undefined;
  return (
    "note: GOOGLE_API_KEY is also set. The harness passes GEMINI_API_KEY to the SDK explicitly " +
    "and the SDK uses that one, so ignore its warning that it is using GOOGLE_API_KEY — the " +
    "harness uses GEMINI_API_KEY."
  );
}

/** Deepgram's `agent.think` for a model id: Anthropic ids go to the anthropic
 * provider, everything else to `open_ai`. */
export function thinkFor(model: string): { provider: string; model: string } {
  return { provider: model.startsWith("claude-") ? "anthropic" : "open_ai", model };
}

export interface BuiltHarnessProvider {
  provider: RealtimeProvider;
  /** The model reported in the run header: Gemini's model, or Deepgram's think model. */
  model: string;
}

/** Deepgram's `agent.think` for an optional `--think-model`. */
function deepgramThink(thinkModel?: string): { provider: string; model: string } {
  return thinkModel ? thinkFor(thinkModel) : DEFAULT_DEEPGRAM_THINK;
}

/** The model a run header names: Gemini's model, or Deepgram's think model. */
function harnessModel(
  kind: RealtimeProviderKind,
  thinkModel?: string,
  geminiModel?: string
): string {
  return kind === "deepgram"
    ? deepgramThink(thinkModel).model
    : (geminiModel ?? DEFAULT_GEMINI_MODEL);
}

function makeHarnessProvider(
  kind: RealtimeProviderKind,
  apiKey: string,
  thinkModel?: string,
  geminiModel?: string
): BuiltHarnessProvider {
  const model = harnessModel(kind, thinkModel, geminiModel);
  if (kind === "deepgram") {
    const think = deepgramThink(thinkModel);
    return { provider: createDeepgramRealtimeProvider({ apiKey, think }), model };
  }
  return { provider: new GeminiRealtimeProvider({ apiKey }), model };
}

/** A fresh scenario transport for one run, built from the same choices as
 * `makeHarnessProvider`. A transport is one session, so `scenario` and
 * `metamorphic` build one per run, never one per command. Building one opens
 * nothing; the session starts at `connect`. */
function makeScenarioTransport(
  kind: RealtimeProviderKind,
  apiKey: string,
  thinkModel?: string,
  geminiModel?: string
): ScenarioTransport {
  if (kind === "deepgram") return deepgramTransport({ apiKey, think: deepgramThink(thinkModel) });
  return geminiTransport({ apiKey, model: harnessModel(kind, thinkModel, geminiModel) });
}

/** `--realtime-provider`, `--think-model`, `--gemini-model` and `--transcript`,
 * identical on every command that takes them. Keys are present only when the flag was given, so a parse
 * without them is unchanged. */
function parseRealtimeFlags(rest: readonly string[]): {
  realtimeProvider?: RealtimeProviderKind;
  thinkModel?: string;
  geminiModel?: string;
  transcriptDir?: string;
} {
  const providerIdx = rest.indexOf("--realtime-provider");
  const realtimeProvider = (providerIdx === -1 ? "gemini" : rest[providerIdx + 1]) as string;
  if (!(REALTIME_PROVIDER_KINDS as readonly string[]).includes(realtimeProvider)) {
    throw new Error(
      `--realtime-provider must be one of ${REALTIME_PROVIDER_KINDS.join(", ")}, got ${realtimeProvider}`
    );
  }
  const thinkIdx = rest.indexOf("--think-model");
  const thinkModel = thinkIdx === -1 ? undefined : rest[thinkIdx + 1];
  if (thinkIdx !== -1 && !thinkModel) throw new Error("--think-model requires a model id");
  // A think model configures Deepgram's agent.think; Gemini has no such
  // stage, and silently ignoring the flag would report a run as something
  // it was not.
  if (thinkModel && realtimeProvider !== "deepgram") {
    throw new Error("--think-model applies only to --realtime-provider deepgram");
  }
  const geminiIdx = rest.indexOf("--gemini-model");
  const geminiModel = geminiIdx === -1 ? undefined : rest[geminiIdx + 1];
  if (geminiIdx !== -1 && !geminiModel) throw new Error("--gemini-model requires a model id");
  // The mirror of --think-model: a Gemini model id names nothing Deepgram runs.
  if (geminiModel && realtimeProvider !== "gemini") {
    throw new Error("--gemini-model applies only to --realtime-provider gemini");
  }
  const transcriptIdx = rest.indexOf("--transcript");
  const transcriptDir = transcriptIdx === -1 ? undefined : rest[transcriptIdx + 1];
  if (transcriptIdx !== -1 && !transcriptDir) throw new Error("--transcript requires a directory");
  return {
    ...(providerIdx === -1 ? {} : { realtimeProvider: realtimeProvider as RealtimeProviderKind }),
    ...(thinkModel ? { thinkModel } : {}),
    ...(geminiModel ? { geminiModel } : {}),
    ...(transcriptDir ? { transcriptDir } : {})
  };
}

/** `--first-line-delay-ms`: the ring before pickup
 * (`ScenarioTimings.firstLineDelayMs`). Present only when given, so a parse
 * without it is unchanged; 0 is the default and means no ring. */
function parseFirstLineDelay(rest: readonly string[]): { firstLineDelayMs?: number } {
  const idx = rest.indexOf("--first-line-delay-ms");
  if (idx === -1) return {};
  const raw = rest[idx + 1];
  const ms = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(ms) || ms < 0) {
    throw new Error(`--first-line-delay-ms must be a non-negative integer, got ${raw}`);
  }
  return { firstLineDelayMs: ms };
}

/** The timings a run gets: the defaults, plus the ring when one was asked
 * for. Undefined when not, so the runner's own default applies unchanged. */
function scenarioTimings(firstLineDelayMs?: number): { timings?: typeof DEFAULT_SCENARIO_TIMINGS } {
  return firstLineDelayMs === undefined
    ? {}
    : { timings: { ...DEFAULT_SCENARIO_TIMINGS, firstLineDelayMs } };
}

/** `--today <YYYY-MM-DD>`: pin the date the model is told. Present only when
 * given, so a parse without it is unchanged and runs keep the wall clock.
 *
 * The model is told today's date so it can resolve "next Tuesday", which makes
 * any script naming a weekday depend on the day it is run: "this Wednesday"
 * is ambiguous on a Wednesday, and one cell failed 2/2 for that reason alone.
 * Pinned, a matrix scores the same prompt whenever it runs. */
function parseToday(rest: readonly string[]): { today?: string } {
  const idx = rest.indexOf("--today");
  if (idx === -1) return {};
  const raw = rest[idx + 1];
  if (raw === undefined || !isCalendarDate(raw)) {
    throw new Error(`--today must be a date as YYYY-MM-DD (e.g. 2026-10-05), got ${raw}`);
  }
  return { today: raw };
}

/** A real calendar date in `YYYY-MM-DD`: the shape, and a date that exists
 * (not 2026-02-30), checked by round-tripping through UTC. */
function isCalendarDate(raw: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The `TodayInput` for a pinned date: an instant on that calendar date in
 * `timeZone`. Only the zone changes from what a run sends by default — the
 * sentence still names the host zone, as a real call's does.
 *
 * Noon UTC is that date in every zone from UTC-12 to UTC+11; midnight UTC
 * covers UTC+0 to UTC+14. Between them they cover every zone in use, and the
 * zone's own reading of the instant is what decides, not arithmetic here. */
export function pinnedToday(date: string, timeZone: string = defaultTimeZone()): TodayInput {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const inZone = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  for (const hour of [12, 0]) {
    const now = new Date(Date.UTC(y, m - 1, d, hour));
    if (inZone.format(now) === date) return { now, timeZone };
  }
  throw new Error(`--today ${date} does not fall on a single day in ${timeZone}`);
}

/** The `today` a run gets: the pinned date when one was asked for, otherwise
 * absent, so the runner's own default (the wall clock) applies unchanged. */
function todayFor(today?: string): { today?: TodayInput } {
  return today === undefined ? {} : { today: pinnedToday(today) };
}

/** The report line naming a pinned date; none on the wall clock, so an
 * unpinned report is byte-identical to before the flag existed. */
function todayHeader(today?: string): string[] {
  return today === undefined ? [] : [`today: ${today} (pinned with --today)`];
}

/** The metamorphic relations this CLI can run.
 *
 * `consent-phrase-removed` had no way in at all: `withoutConsentPhrase` and
 * `relateConsentGate` existed, were tested, and were absent from `index.ts`,
 * and `runMetamorphicCommand` threw on any pair that was not the quote raise.
 * With the live meeting gate not yet run, this apparatus is what stands in for
 * it, and an apparatus that cannot be invoked stands in for nothing. */
export const METAMORPHIC_RELATIONS = [
  "quote-raised-above-ceiling",
  "consent-phrase-removed"
] as const;
export type MetamorphicRelationId = (typeof METAMORPHIC_RELATIONS)[number];

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
    // No default. Every run is a billed model session, and a defaulted
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
      ...(onlyIdx === -1 ? {} : { only: rest[onlyIdx + 1] }),
      ...parseRealtimeFlags(rest),
      ...parseFirstLineDelay(rest),
      ...parseToday(rest)
    };
  }
  if (command === "metamorphic") {
    const scenarioPath = rest[rest.indexOf("--file") + 1];
    if (rest.indexOf("--file") === -1 || !scenarioPath)
      throw new Error("metamorphic requires --file <path>");
    const runsIdx = rest.indexOf("--runs");
    // Same rule as `scenario`, and it bites harder here: one "run" is a PAIR,
    // so it is two billed model sessions, not one.
    if (runsIdx === -1)
      throw new Error(
        "metamorphic requires --runs <n> (no default — each run is a PAIR of billed calls)"
      );
    const runs = Number(rest[runsIdx + 1]);
    if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
    const onlyIdx = rest.indexOf("--only");
    const relationIdx = rest.indexOf("--relation");
    // Defaults to the quote raise, which is what this command did before there
    // was a second relation — a selector that silently changed what an existing
    // invocation runs would make every recorded result ambiguous.
    const relation = relationIdx === -1 ? METAMORPHIC_RELATIONS[0] : rest[relationIdx + 1];
    if (!METAMORPHIC_RELATIONS.includes(relation as MetamorphicRelationId)) {
      throw new Error(
        `--relation must be one of ${METAMORPHIC_RELATIONS.join(", ")}, got "${relation}"`
      );
    }
    return {
      command: "metamorphic",
      scenarioPath,
      runs,
      relation: relation as MetamorphicRelationId,
      ...(onlyIdx === -1 ? {} : { only: rest[onlyIdx + 1] }),
      ...parseRealtimeFlags(rest),
      ...parseFirstLineDelay(rest),
      ...parseToday(rest)
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
    return {
      command: "reliability",
      briefPath,
      scenarioId,
      runs,
      ...parseRealtimeFlags(rest),
      ...parseToday(rest)
    };
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

/** The counterpart read `loadBrief` deliberately does not do: pull
 * `execution.meeting.brief` out of a full call envelope, for `preview` to
 * show an operator. A bare Brief file (no `execution` at all) and a full
 * envelope whose meeting declared no brief are indistinguishable here on
 * purpose — both simply have nothing to show, same as everywhere else this
 * field passes through undefined rather than an invented placeholder. */
export function loadMeetingBrief(
  path: string,
  readFile: ReadFile = defaultReadFile
): MeetingExecution["brief"] {
  const parsed = JSON.parse(readFile(path)) as {
    execution?: { meeting?: { brief?: MeetingExecution["brief"] } };
  };
  return parsed?.execution?.meeting?.brief;
}

export function runPreviewCommand(
  args: ParsedCliArgs & { command: "preview"; briefPath: string },
  readFile: ReadFile = defaultReadFile
): string {
  const brief = loadBrief(args.briefPath, readFile);
  const meetingBrief = loadMeetingBrief(args.briefPath, readFile);
  return formatPayloadPreview(buildPayloadPreview(brief, HARNESS_POLICY, meetingBrief));
}

/** Every scenario the harness carries, LISTED — including the meeting set.
 *
 * `MEETING_SCENARIOS` had exactly one consumer, its own test: it was absent
 * from this listing and from `generate-fixtures`, so it could not be reached
 * through `harness reliability` (which resolves a scenario by id against the
 * fixtures) and the meeting derails could not be run at all. Grouped rather
 * than merged, because a meeting derail scored against a two-party call is
 * noise: they only apply to an envelope declaring `execution.meeting`. */
export function runScenariosCommand(): string {
  const list = (ss: typeof DERAIL_SCENARIOS): string =>
    ss.map((scenario) => `  ${scenario.id}: ${scenario.description}`).join("\n");
  return [
    "derail scenarios (any call):",
    list(DERAIL_SCENARIOS),
    "",
    "meeting scenarios (only an envelope declaring execution.meeting):",
    list(MEETING_SCENARIOS)
  ].join("\n");
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
  args: {
    briefPath: string;
    scenarioId: string;
    runs: number;
    apiKey: string;
    realtimeProvider?: RealtimeProviderKind;
    thinkModel?: string;
    geminiModel?: string;
    transcriptDir?: string;
    /** `--today`, as `YYYY-MM-DD`; absent means the wall clock. */
    today?: string;
  },
  deps: {
    readFile?: ReadFile;
    makeProvider?: typeof makeHarnessProvider;
    runScenarioReliability?: typeof runScenarioReliability;
  } = {}
): Promise<string> {
  const readFile = deps.readFile ?? defaultReadFile;
  const makeProvider = deps.makeProvider ?? makeHarnessProvider;
  const kind = args.realtimeProvider ?? "gemini";
  const doRun = deps.runScenarioReliability ?? runScenarioReliability;

  const brief = loadBrief(args.briefPath, readFile);
  const pinned = todayFor(args.today).today;
  const preview = pinned
    ? buildPayloadPreview(brief, HARNESS_POLICY, undefined, pinned)
    : buildPayloadPreview(brief, HARNESS_POLICY);

  const built = makeProvider(kind, args.apiKey, args.thinkModel, args.geminiModel);
  const transcriptDir = args.transcriptDir;
  const report = await doRun(
    {
      provider: built.provider,
      model: built.model,
      systemInstruction: preview.systemInstruction,
      scenarioId: args.scenarioId,
      mode: HARNESS_MODE,
      runs: args.runs
    },
    transcriptDir === undefined
      ? {}
      : {
          onRun: ({ runIndex, run, result }) =>
            writeRunRecord(
              transcriptDir,
              {
                command: "reliability",
                scenarioId: args.scenarioId,
                provider: kind,
                model: built.model,
                runIndex,
                transcript: run.fullTranscript,
                verdict: result
              },
              [args.apiKey]
            )
        }
  );
  const byCode = Object.entries(report.failuresByCode ?? {}).sort((a, b) => b[1] - a[1]);

  return [
    `provider: ${kind}/${built.model}`,
    ...todayHeader(args.today),
    `scenario: ${report.scenarioId}`,
    `runs: ${report.runsCompleted}/${report.runsRequested}`,
    `longest clean streak: ${report.longestCleanStreak}`,
    `PASSED: ${report.passed}`,
    `failures: ${report.failures.length}`,
    ...(byCode.length === 0
      ? []
      : [
          `failures by code:`,
          ...byCode.map(
            ([code, n]) => `  ${code.padEnd(12)} ${String(n).padStart(3)}/${report.runsCompleted}`
          )
        ])
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
  args: {
    scenarioPath: string;
    runs: number;
    only?: string;
    apiKey: string;
    concurrency?: number;
    realtimeProvider?: RealtimeProviderKind;
    thinkModel?: string;
    geminiModel?: string;
    transcriptDir?: string;
    firstLineDelayMs?: number;
    /** `--today`, as `YYYY-MM-DD`; absent means the wall clock. */
    today?: string;
  },
  deps: {
    readFile?: ReadFile;
    readdir?: ReadDir;
    run?: typeof runCallScenario;
    makeTransport?: typeof makeScenarioTransport;
    onProgress?: (line: string) => void;
  } = {}
): Promise<string> {
  const doRun = deps.run ?? runCallScenario;
  const kind = args.realtimeProvider ?? "gemini";
  const model = harnessModel(kind, args.thinkModel, args.geminiModel);
  /** A trace sink for one run, or none when `--transcript` was not given. */
  const traceSink = (): {
    events: ScenarioTraceEvent[];
    trace?: (e: ScenarioTraceEvent) => void;
  } => {
    if (args.transcriptDir === undefined) return { events: [] };
    const events: ScenarioTraceEvent[] = [];
    return { events, trace: (e) => events.push(e) };
  };
  const build = deps.makeTransport ?? makeScenarioTransport;
  const newTransport = (): ScenarioTransport =>
    build(kind, args.apiKey, args.thinkModel, args.geminiModel);
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
  // Every figure below is a measurement of one configuration, and two
  // reports only compare if each says which one it measured.
  lines.push(`provider: ${kind}/${model}`, ...todayHeader(args.today));
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
    const sink = traceSink();
    const run = await doRun({
      scenario,
      transport: newTransport(),
      ...scenarioTimings(args.firstLineDelayMs),
      ...todayFor(args.today),
      ...(sink.trace ? { trace: sink.trace } : {})
    });
    const verdict = evaluateCallScenario(scenario, run);
    if (args.transcriptDir !== undefined) {
      writeRunRecord(
        args.transcriptDir,
        {
          command: "scenario",
          scenarioId: scenario.id,
          provider: kind,
          model,
          runIndex: index + 1,
          transcript: run.transcript,
          trace: sink.events,
          verdict
        },
        [args.apiKey]
      );
    }
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
        `  ${code.padEnd(20)} ${String(n).padStart(3)}/${total}  ${Math.round((n / total) * 100)}%`
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

/** The witness `relateConsentGate` judges on, derived from a SCRIPTED run.
 *
 * That relation asks whether a transcript exists, and a scripted run writes no
 * files: `runCallScenario` drives a realtime model against a recording mock carrier
 * and produces a `ScenarioRun`, not a `MeetingRecord`. What it does carry is
 * the gate's own answer — and the gate is the only thing between a meeting and
 * a transcript, so "`begin_notetaking` was admitted" and "a transcript would
 * exist" are the same fact on this path. It runs the SAME `ToolGate` and
 * `routeToolCall` a real call runs, which is what makes the substitution legal
 * rather than convenient.
 *
 * The string is deliberately not path-shaped: nothing downstream should be
 * able to mistake a scripted witness for a file that exists. */
function consentWitness(run: ScenarioRun): { transcriptPath: string | null } {
  const admitted = run.toolCalls.some((c) => c.name === "begin_notetaking" && c.result === "ok");
  return {
    transcriptPath: admitted ? "<scripted run: the gate admitted begin_notetaking>" : null
  };
}

/**
 * Run metamorphic PAIRS: each scenario and a copy of it transformed in exactly
 * one way, judged on the property that must hold between the two runs.
 *
 * Two relations, chosen with `--relation`:
 *
 *  - `quote-raised-above-ceiling` — the same call quoted a price the model has
 *    no authority to accept.
 *  - `consent-phrase-removed` — the same meeting with the go-ahead phrase
 *    stripped from every turn that spoke it. A transcript must exist in
 *    exactly one of the two runs, which is checkable without anyone knowing
 *    what a good set of meeting notes looks like.
 *
 * This is not the same test as running the `quoteAboveCeiling` cells. Those ask
 * whether the model got an absolute answer right, and that check is only ever
 * as good as the answer somebody wrote down. This asks whether CHANGING THE
 * PRICE changed the recorded outcome the way it has to — a question with no
 * authored answer in it at all, which is why it can catch a class of defect
 * nobody predicted.
 */
export async function runMetamorphicCommand(
  args: {
    scenarioPath: string;
    runs: number;
    only?: string;
    apiKey: string;
    relation?: MetamorphicRelationId;
    realtimeProvider?: RealtimeProviderKind;
    thinkModel?: string;
    geminiModel?: string;
    transcriptDir?: string;
    firstLineDelayMs?: number;
    /** `--today`, as `YYYY-MM-DD`; absent means the wall clock. */
    today?: string;
  },
  deps: {
    readFile?: ReadFile;
    readdir?: ReadDir;
    run?: typeof runCallScenario;
    makeTransport?: typeof makeScenarioTransport;
    onProgress?: (line: string) => void;
  } = {}
): Promise<string> {
  const doRun = deps.run ?? runCallScenario;
  const kind = args.realtimeProvider ?? "gemini";
  const model = harnessModel(kind, args.thinkModel, args.geminiModel);
  /** A trace sink for one run, or none when `--transcript` was not given. */
  const traceSink = (): {
    events: ScenarioTraceEvent[];
    trace?: (e: ScenarioTraceEvent) => void;
  } => {
    if (args.transcriptDir === undefined) return { events: [] };
    const events: ScenarioTraceEvent[] = [];
    return { events, trace: (e) => events.push(e) };
  };
  const build = deps.makeTransport ?? makeScenarioTransport;
  const newTransport = (): ScenarioTransport =>
    build(kind, args.apiKey, args.thinkModel, args.geminiModel);
  const all = loadScenarios(args.scenarioPath, deps.readFile, deps.readdir);
  const selected = args.only ? all.filter((s) => s.id === args.only) : all;
  if (selected.length === 0)
    return `no scenarios matched${args.only ? ` --only ${args.only}` : ""}`;

  // Emit each pair as it lands. Sixteen billed model sessions is a
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
  lines.push(`provider: ${kind}/${model}`, ...todayHeader(args.today));
  const unpairable: string[] = [];
  const tally: Record<RelationOutcome, number> = { holds: 0, violated: 0, inconclusive: 0 };

  const relation = args.relation ?? METAMORPHIC_RELATIONS[0];
  const buildPair =
    relation === "consent-phrase-removed" ? withoutConsentPhrase : raiseQuoteAboveCeiling;

  for (const scenario of selected) {
    const result = buildPair(scenario);
    if (result.kind === "unpairable") {
      unpairable.push(`  ${result.scenarioId}: ${result.reason}`);
      continue;
    }
    const { pair } = result;
    // Each transform produces exactly one pair shape; narrow PairResult's
    // shared `pair` field back down before reading a shape-specific field.
    if (pair.relationId !== relation) {
      throw new Error(`expected the ${relation} pair, got ${pair.relationId}`);
    }
    for (let i = 0; i < args.runs; i++) {
      const baseSink = traceSink();
      const baseRun = await doRun({
        scenario: pair.base,
        transport: newTransport(),
        ...scenarioTimings(args.firstLineDelayMs),
        ...todayFor(args.today),
        ...(baseSink.trace ? { trace: baseSink.trace } : {})
      });
      const variantSink = traceSink();
      const variantRun = await doRun({
        scenario: pair.variant,
        transport: newTransport(),
        ...scenarioTimings(args.firstLineDelayMs),
        ...todayFor(args.today),
        ...(variantSink.trace ? { trace: variantSink.trace } : {})
      });
      const verdict =
        pair.relationId === "consent-phrase-removed"
          ? relateConsentGate(pair, consentWitness(baseRun), consentWitness(variantRun))
          : relateQuoteRaise(pair, baseRun, variantRun);
      tally[verdict.outcome] += 1;
      if (args.transcriptDir !== undefined) {
        // The verdict belongs to the pair, so both halves carry it; the role
        // is in the scenario id because a pair shares one run index.
        for (const [role, run, sink] of [
          ["base", baseRun, baseSink],
          ["variant", variantRun, variantSink]
        ] as const) {
          writeRunRecord(
            args.transcriptDir,
            {
              command: "metamorphic",
              scenarioId: `${pair.base.id}.${role}`,
              provider: kind,
              model,
              runIndex: i + 1,
              transcript: run.transcript,
              trace: sink.events,
              verdict
            },
            [args.apiKey]
          );
        }
      }
      const what =
        pair.relationId === "consent-phrase-removed"
          ? "consent phrase removed"
          : `-> ${pair.raisedTo}`;
      lines.push(
        `${verdict.outcome.toUpperCase().padEnd(12)} ${pair.base.id} ${what} ` +
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
      "    [--realtime-provider gemini|deepgram] [--think-model <id>]",
      "    [--gemini-model <id>] [--transcript <dir>] [--today <YYYY-MM-DD>]",
      "    Requires GEMINI_API_KEY (default) or DEEPGRAM_API_KEY (deepgram).",
      "    --think-model sets Deepgram's think model (claude-* uses anthropic,",
      "    anything else open_ai) and is an error with gemini. --gemini-model",
      "    picks Gemini's model (default: the shipped one) and is an error with",
      "    deepgram. --transcript <dir> writes one JSON file per run (model",
      "    transcript, trace where there is one, verdict); it never writes keys",
      "    or the environment. Makes LIVE",
      "    calls, repeatedly running one derail scenario end-to-end — this IS",
      "    the manual reliability gate (design spec §10.1).",
      "  parley-harness scenario --file <path|dir> --runs <n> [--only <id>] [--concurrency <n>]",
      "    [--realtime-provider gemini|deepgram] [--think-model <id>] [--first-line-delay-ms <n>]",
      "    [--gemini-model <id>] [--transcript <dir>] [--today <YYYY-MM-DD>]",
      "    Requires GEMINI_API_KEY (default) or DEEPGRAM_API_KEY (deepgram).",
      "    Runs multi-turn CallScenarios with a live tool channel and reports",
      "    pass/fail against each scenario's DERIVED expectations. --runs has",
      "    no default: every run is a billed model session. --concurrency",
      "    defaults to 1; raising it cuts wall-clock, which is what makes more",
      "    runs per cell practical, and does not change the per-run cost.",
      "    --first-line-delay-ms (default 0) is the ring before pickup: the first",
      "    callee line goes out that long after connect, and any model speech",
      "    before it scores spoke-before-callee. Must be under the 30 s stall.",
      "    --today pins the date the model is told (default: the wall clock, in",
      "    the host zone), so a script naming a weekday scores the same on any",
      "    day it is run. Also on reliability and metamorphic.",
      "  parley-harness metamorphic --file <path|dir> --runs <n> [--only <id>] " +
        "[--relation quote-raised-above-ceiling|consent-phrase-removed]",
      "    [--realtime-provider gemini|deepgram] [--think-model <id>] [--first-line-delay-ms <n>]",
      "    [--gemini-model <id>] [--transcript <dir>] [--today <YYYY-MM-DD>]",
      "    Requires GEMINI_API_KEY (default) or DEEPGRAM_API_KEY (deepgram).",
      "    Runs each scenario PAIRED with a copy transformed in one way, and",
      "    checks the property that must hold BETWEEN the two runs. One run is",
      "    TWO billed model sessions.",
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
    const keyVar = realtimeKeyVar(args.realtimeProvider ?? "gemini");
    const apiKey = process.env[keyVar];
    if (!apiKey) {
      console.error(`reliability requires the ${keyVar} environment variable to be set.`);
      process.exitCode = 1;
      return;
    }
    const keyNote = geminiKeyConflictNote(args.realtimeProvider ?? "gemini", process.env);
    if (keyNote) console.error(keyNote);
    console.log(
      await runReliabilityCommand({
        briefPath: args.briefPath,
        scenarioId: args.scenarioId,
        runs: args.runs,
        apiKey,
        ...(args.realtimeProvider ? { realtimeProvider: args.realtimeProvider } : {}),
        ...(args.thinkModel ? { thinkModel: args.thinkModel } : {}),
        ...(args.geminiModel ? { geminiModel: args.geminiModel } : {}),
        ...(args.transcriptDir ? { transcriptDir: args.transcriptDir } : {}),
        ...(args.today ? { today: args.today } : {})
      })
    );
  } else if (args.command === "scenario" && args.scenarioPath && args.runs) {
    const keyVar = realtimeKeyVar(args.realtimeProvider ?? "gemini");
    const apiKey = process.env[keyVar];
    if (!apiKey) {
      console.error(`scenario requires the ${keyVar} environment variable to be set.`);
      process.exitCode = 1;
      return;
    }
    const keyNote = geminiKeyConflictNote(args.realtimeProvider ?? "gemini", process.env);
    if (keyNote) console.error(keyNote);
    await runScenarioCommand(
      {
        scenarioPath: args.scenarioPath,
        runs: args.runs,
        // Parsed, validated, documented in `--help` — and, until now, dropped
        // on the floor here, so every invocation ran sequentially whatever it
        // asked for. The flag was not decorative: twenty billed sessions at up
        // to three minutes each is an hour of wall clock, and the difference
        // between measuring a prompt change in six minutes and in half an hour
        // is the difference between iterating on it and not.
        ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
        ...(args.only ? { only: args.only } : {}),
        ...(args.realtimeProvider ? { realtimeProvider: args.realtimeProvider } : {}),
        ...(args.thinkModel ? { thinkModel: args.thinkModel } : {}),
        ...(args.geminiModel ? { geminiModel: args.geminiModel } : {}),
        ...(args.transcriptDir ? { transcriptDir: args.transcriptDir } : {}),
        ...(args.firstLineDelayMs === undefined ? {} : { firstLineDelayMs: args.firstLineDelayMs }),
        ...(args.today ? { today: args.today } : {}),
        apiKey
      },
      { onProgress: (line) => console.log(line) }
    );
  } else if (args.command === "metamorphic" && args.scenarioPath && args.runs) {
    const keyVar = realtimeKeyVar(args.realtimeProvider ?? "gemini");
    const apiKey = process.env[keyVar];
    if (!apiKey) {
      console.error(`metamorphic requires the ${keyVar} environment variable to be set.`);
      process.exitCode = 1;
      return;
    }
    const keyNote = geminiKeyConflictNote(args.realtimeProvider ?? "gemini", process.env);
    if (keyNote) console.error(keyNote);
    await runMetamorphicCommand(
      {
        scenarioPath: args.scenarioPath,
        runs: args.runs,
        ...(args.only ? { only: args.only } : {}),
        ...(args.relation ? { relation: args.relation } : {}),
        ...(args.realtimeProvider ? { realtimeProvider: args.realtimeProvider } : {}),
        ...(args.thinkModel ? { thinkModel: args.thinkModel } : {}),
        ...(args.geminiModel ? { geminiModel: args.geminiModel } : {}),
        ...(args.transcriptDir ? { transcriptDir: args.transcriptDir } : {}),
        ...(args.firstLineDelayMs === undefined ? {} : { firstLineDelayMs: args.firstLineDelayMs }),
        ...(args.today ? { today: args.today } : {}),
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
