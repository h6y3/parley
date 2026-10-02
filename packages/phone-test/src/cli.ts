import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RealtimeProvider } from "@parley/core";
import {
  campaignStatus,
  startCampaign,
  stopCampaign,
  type CampaignDeps,
  type CampaignState
} from "./campaign.js";
import { splitStereo, type Timeline } from "./capture.js";
import { createGeminiJudge, DEFAULT_JUDGE_MODEL, judgePair, type JudgeClient } from "./judge.js";
import type { PairJudgement } from "./judge.js";
import { checkOutcome, type CompletedCallRecordLike } from "./outcome.js";
import { writeReport, type ReportCall } from "./report.js";
import { runCampaign, type CallErrorCode, type CallResult } from "./runner.js";
import {
  loadConfigs,
  loadScenario,
  withoutDiagnosticPersonas,
  type PhoneScenario,
  type TestConfig
} from "./scenario.js";
import { createSimServer, SIM_PORT } from "./sim-server.js";
import { appendSpend, type RealtimeProvider as ProviderKind } from "./spend.js";
import { analyzeTiming, loadThresholds, type Thresholds } from "./timing.js";
import { createTwilioNumbersClient, type TwilioNumbersClient } from "./twilio-numbers.js";

/** The sim's callee voice by provider. Each differs from Parley's own agent
 * voice on that provider (Gemini Aoede, Deepgram flux-kelsey-en), so a
 * listener — or the judge — can always tell the two ends apart. */
export const CALLEE_VOICES: Readonly<Record<ProviderKind, string>> = Object.freeze({
  gemini: "Puck",
  deepgram: "flux-kit-en"
});
/** The estimated cost of one judge request (two calls' four mono channels and
 * transcripts to a Gemini audio model), USD. A deliberately generous
 * constant: the request's real token count is not measured. Each pair is two
 * requests, one per order. */
export const JUDGE_REQUEST_USD = 0.02;
/** Default monthly cap, USD. */
export const DEFAULT_BUDGET_USD = 50;
/** Beside each other in the state directory (`~/.config/parley` by default). */
export const CAMPAIGN_STATE_FILE = "test-campaign.json";
export const SPEND_LOG_FILE = "test-spend.jsonl";
export const SIM_PID_FILE = "test-sim.pid";
export const SIM_LOG_FILE = "test-sim.log";
/** A campaign older than this is reported as overdue for `stop`. */
export const WATCHDOG_HOURS = 48;
const SIM_HEALTH_TIMEOUT_MS = 20_000;
const SIM_STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 250;
/** How `start` probes the public route to the sim: about a minute in all. */
export const PUBLIC_HEALTH_ATTEMPTS = 12;
export const PUBLIC_HEALTH_INTERVAL_MS = 5_000;
const E164 = /^\+[1-9]\d{1,14}$/;

/** Codes after which `runCampaign` has ended the whole run. */
const RUN_ENDING: ReadonlySet<CallErrorCode> = new Set([
  "budget-stop",
  "sim-unreachable",
  "dial-refused",
  "dial-failed",
  "sim-desync"
]);

const ENV_HINT = "run with: node --env-file ~/.config/parley/.env <parley> …";

export const PHONE_TEST_USAGE = [
  "  sim serve [--callee-provider gemini|deepgram] [--callee-voice <name>] [--port 3340] [--out <dir>]",
  "            [--caller <E.164>]",
  "  campaign start [--budget 50] [--state-dir <dir>]",
  "  campaign run --scenarios <file…> --configs <file> --calls-per-cell <n> [--judge] [--out <dir>]",
  "               [--include-diagnostic] [--state-dir <dir>]",
  "  campaign stop [--state-dir <dir>]",
  "  campaign status [--state-dir <dir>]",
  "  Secrets and settings come from the environment only; load them with",
  "  `node --env-file ~/.config/parley/.env …`. campaign run needs PARLEY_DAEMON_URL",
  "  (no default), PARLEY_CALL_TOKEN, PARLEY_PUBLIC_HOST, TWILIO_AUTH_TOKEN, the callee",
  "  provider's key (GEMINI_API_KEY / DEEPGRAM_API_KEY) and PARLEY_CALL_RECORDS (default:",
  "  the daemon's PARLEY_CALL_RECORDS_PATH); start/stop need TWILIO_ACCOUNT_SID,",
  "  TWILIO_AUTH_TOKEN and PARLEY_CALLABLE_NUMBERS_FILE; --judge needs GEMINI_API_KEY.",
  "  Output goes to --out, else $PARLEY_TEST_OUT_DIR/<campaign>, else ./parley-tests/<campaign>.",
  "  The sim answers only the daemon's caller number: --caller, else TWILIO_FROM_NUMBER",
  "  (start and run need TWILIO_FROM_NUMBER, which the sim they spawn inherits)."
].join("\n");

// ---------------------------------------------------------------------------
// Arguments

export interface SimServeArgs {
  command: "serve";
  calleeProvider: ProviderKind;
  calleeVoice: string;
  port: number;
  outDir?: string;
  /** The daemon's caller number; else `TWILIO_FROM_NUMBER`. */
  caller?: string;
}

export type CampaignArgs =
  | { command: "start"; budgetUsd: number; stateDir?: string }
  | {
      command: "run";
      scenarios: string[];
      configs: string;
      callsPerCell: number;
      judge: boolean;
      /** Run diagnostic personas too; a decision run leaves them out. */
      includeDiagnostic: boolean;
      outDir?: string;
      stateDir?: string;
    }
  | { command: "stop"; stateDir?: string }
  | { command: "status"; stateDir?: string };

type FlagKind = "value" | "list" | "bool";

/** Strict: an unknown flag, a positional argument, a repeated flag or a flag
 * missing its value throws, naming it. A typo must never run a billed
 * campaign on a default. */
function parseFlags(
  what: string,
  rest: readonly string[],
  spec: Record<string, FlagKind>
): Map<string, string[] | true> {
  const out = new Map<string, string[] | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const kind = spec[arg];
    if (!arg.startsWith("--")) throw new Error(`${what}: unexpected argument "${arg}"`);
    if (kind === undefined) throw new Error(`${what}: unknown flag "${arg}"`);
    if (out.has(arg)) throw new Error(`${what}: ${arg} given twice`);
    if (kind === "bool") {
      out.set(arg, true);
      continue;
    }
    const values: string[] = [];
    while (i + 1 < rest.length && !rest[i + 1]!.startsWith("--")) {
      values.push(rest[++i]!);
      if (kind === "value") break;
    }
    if (values.length === 0) throw new Error(`${what}: ${arg} needs a value`);
    out.set(arg, values);
  }
  return out;
}

const one = (flags: Map<string, string[] | true>, name: string): string | undefined => {
  const v = flags.get(name);
  return Array.isArray(v) ? v[0] : undefined;
};

function positiveInt(what: string, name: string, raw: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${what}: ${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function providerKind(what: string, raw: string | undefined): ProviderKind {
  if (raw === undefined) return "gemini";
  if (raw === "gemini" || raw === "deepgram") return raw;
  throw new Error(`${what}: --callee-provider must be "gemini" or "deepgram", got "${raw}"`);
}

/** `parley sim <rest>`. */
export function parseSimArgs(rest: readonly string[]): SimServeArgs {
  const [sub, ...flags] = rest;
  if (sub !== "serve") throw new Error(`parley sim: unknown command "${sub ?? ""}"; try serve`);
  const what = "parley sim serve";
  const f = parseFlags(what, flags, {
    "--callee-provider": "value",
    "--callee-voice": "value",
    "--port": "value",
    "--out": "value",
    "--caller": "value"
  });
  const calleeProvider = providerKind(what, one(f, "--callee-provider"));
  const port = one(f, "--port");
  const out = one(f, "--out");
  const caller = one(f, "--caller");
  if (caller !== undefined && !E164.test(caller)) {
    throw new Error(`${what}: --caller must be an E.164 number (+ and digits), got "${caller}"`);
  }
  return {
    command: "serve",
    calleeProvider,
    calleeVoice: one(f, "--callee-voice") ?? CALLEE_VOICES[calleeProvider],
    port: port === undefined ? SIM_PORT : positiveInt(what, "--port", port),
    ...(out !== undefined ? { outDir: out } : {}),
    ...(caller !== undefined ? { caller } : {})
  };
}

/** `parley campaign <rest>`. */
export function parseCampaignArgs(rest: readonly string[]): CampaignArgs {
  const [sub, ...flags] = rest;
  const what = `parley campaign ${sub ?? ""}`.trim();
  const stateDir = (f: Map<string, string[] | true>) => {
    const d = one(f, "--state-dir");
    return d !== undefined ? { stateDir: d } : {};
  };
  switch (sub) {
    case "start": {
      const f = parseFlags(what, flags, { "--budget": "value", "--state-dir": "value" });
      const raw = one(f, "--budget");
      const budgetUsd = raw === undefined ? DEFAULT_BUDGET_USD : Number(raw);
      if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
        throw new Error(`${what}: --budget must be a positive number of USD, got "${raw}"`);
      }
      return { command: "start", budgetUsd, ...stateDir(f) };
    }
    case "run": {
      const f = parseFlags(what, flags, {
        "--scenarios": "list",
        "--configs": "value",
        "--calls-per-cell": "value",
        "--judge": "bool",
        "--include-diagnostic": "bool",
        "--out": "value",
        "--state-dir": "value"
      });
      const scenarios = f.get("--scenarios");
      const configs = one(f, "--configs");
      const perCell = one(f, "--calls-per-cell");
      const missing = [
        !Array.isArray(scenarios) ? "--scenarios" : "",
        configs === undefined ? "--configs" : "",
        perCell === undefined ? "--calls-per-cell" : ""
      ].filter(Boolean);
      if (missing.length > 0) throw new Error(`${what}: missing ${missing.join(", ")}`);
      const out = one(f, "--out");
      return {
        command: "run",
        scenarios: scenarios as string[],
        configs: configs!,
        callsPerCell: positiveInt(what, "--calls-per-cell", perCell!),
        judge: f.get("--judge") === true,
        includeDiagnostic: f.get("--include-diagnostic") === true,
        ...(out !== undefined ? { outDir: out } : {}),
        ...stateDir(f)
      };
    }
    case "stop":
    case "status": {
      const f = parseFlags(what, flags, { "--state-dir": "value" });
      return { command: sub, ...stateDir(f) };
    }
    default:
      throw new Error(`parley campaign: unknown command "${sub ?? ""}"; try start|run|stop|status`);
  }
}

// ---------------------------------------------------------------------------
// Environment

const KEY_VAR: Record<ProviderKind, string> = {
  gemini: "GEMINI_API_KEY",
  deepgram: "DEEPGRAM_API_KEY"
};

/** Throws naming every unset variable — never a value. */
export function requireEnvVars(
  what: string,
  env: NodeJS.ProcessEnv,
  names: readonly string[]
): Record<string, string> {
  const missing = names.filter((n) => !env[n]);
  if (missing.length > 0) {
    throw new Error(
      `${what}: missing environment variable(s): ${missing.join(", ")} (${ENV_HINT})`
    );
  }
  return Object.fromEntries(names.map((n) => [n, env[n]!]));
}

/** `PARLEY_CALL_RECORDS`, else the daemon's own `PARLEY_CALL_RECORDS_PATH`:
 * the runner reads records where the daemon writes them. */
export function callRecordsPath(what: string, env: NodeJS.ProcessEnv): string {
  const path = env.PARLEY_CALL_RECORDS || env.PARLEY_CALL_RECORDS_PATH;
  if (!path) {
    throw new Error(
      `${what}: missing environment variable(s): PARLEY_CALL_RECORDS ` +
        `(or the daemon's PARLEY_CALL_RECORDS_PATH) (${ENV_HINT})`
    );
  }
  return path;
}

/** The sim plays the callee on the provider not under test. */
export const calleeFor = (agent: ProviderKind): ProviderKind =>
  agent === "gemini" ? "deepgram" : "gemini";

/** Configs grouped by agent provider, in first-appearance order. */
export function groupByProvider(configs: readonly TestConfig[]): [ProviderKind, TestConfig[]][] {
  const groups = new Map<ProviderKind, TestConfig[]>();
  for (const c of configs) {
    const list = groups.get(c.realtime.provider) ?? [];
    list.push(c);
    groups.set(c.realtime.provider, list);
  }
  return [...groups];
}

// ---------------------------------------------------------------------------
// Paths

export const defaultStateDir = (home: string = homedir()): string =>
  join(home, ".config", "parley");

/** `$PARLEY_TEST_OUT_DIR/<id>/` when that is set (relative to `cwd`, a
 * leading `~/` meaning `home`), else `./parley-tests/<id>/`. */
export function defaultOutDir(
  campaignId: string,
  env: NodeJS.ProcessEnv,
  home: string,
  cwd: string
): string {
  const base = env.PARLEY_TEST_OUT_DIR;
  if (!base) return join(cwd, "parley-tests", campaignId);
  const expanded = base === "~" ? home : base.startsWith("~/") ? join(home, base.slice(2)) : base;
  return join(resolve(cwd, expanded), campaignId);
}

const thresholdsPath = (): string =>
  fileURLToPath(new URL("../configs/thresholds.json", import.meta.url));

// ---------------------------------------------------------------------------
// Scoring and judging

function isRecordLike(v: unknown): v is CompletedCallRecordLike {
  return (
    typeof v === "object" && v !== null && typeof (v as { endedBy?: unknown }).endedBy === "string"
  );
}

/** One call's timing analysis (when its capture exists and reads) and outcome
 * codes (when its record arrived). */
export function scoreCall(
  call: CallResult,
  expect: PhoneScenario["expect"],
  thresholds: Thresholds
): ReportCall {
  let timeline: Timeline | undefined;
  let timing: ReportCall["timing"];
  if (call.wavPath && call.timelinePath) {
    try {
      timeline = JSON.parse(readFileSync(call.timelinePath, "utf8")) as Timeline;
      timing = analyzeTiming(readFileSync(call.wavPath), timeline, thresholds);
    } catch {
      timing = undefined; // the report counts it as capture-missing
    }
  }
  const calleeText = Array.isArray(timeline?.calleeText) ? timeline.calleeText : undefined;
  const outcomeCodes = isRecordLike(call.record)
    ? checkOutcome(call.record, expect, calleeText)
    : [];
  return { ...call, ...(timing ? { timing } : {}), outcomeCodes };
}

/** The pairs the judge compares: every call of a non-reference config with the
 * reference call of the same scenario and persona at the same index, counted
 * over every call but a persona-violation one (its rerun takes its index); a
 * pair with no audio on either side is skipped. Returns
 * [candidate, reference] pairs. */
export function judgePairs(
  results: readonly CallResult[],
  reference: string
): [CallResult, CallResult][] {
  const key = (r: CallResult) => `${r.scenarioId}\u0000${r.persona}`;
  // Indexed over every call, audio or not: filtering first would shift the
  // k-th call onto another config's (k+1)-th whenever one call lost its audio.
  // A persona-violation call is invalid data, and its rerun takes its place.
  // A diagnostic call never enters the decision, so it is never judged (and
  // never billed for).
  const valid = results.filter((r) => r.excludedReason === undefined && r.diagnostic !== true);
  const refs = new Map<string, CallResult[]>();
  for (const r of valid.filter((r) => r.config === reference)) {
    refs.set(key(r), [...(refs.get(key(r)) ?? []), r]);
  }
  const seen = new Map<string, number>();
  const pairs: [CallResult, CallResult][] = [];
  for (const r of valid.filter((r) => r.config !== reference)) {
    const k = `${key(r)}\u0000${r.config}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    const ref = refs.get(key(r))?.[n];
    if (ref && r.wavPath && ref.wavPath) pairs.push([r, ref]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// The sim as a detached process

export interface SimProcess {
  /** Replace any running sim with one playing the callee on `calleeProvider`. */
  start(opts: { calleeProvider: ProviderKind; outDir: string }): Promise<void>;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The process calls `detachedSim` makes, injectable for tests. */
export interface ProcessApi {
  kill(pid: number, signal: NodeJS.Signals): void;
  alive(pid: number): boolean;
}

const realProcesses: ProcessApi = {
  kill: (pid, signal) => process.kill(pid, signal),
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }
};

/** Spawns `parley sim serve` detached, with its pid in `<stateDir>/test-sim.pid`
 * and its output appended to `<stateDir>/test-sim.log`. */
export function detachedSim(opts: {
  stateDir: string;
  parleyCommand: readonly string[];
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  processes?: ProcessApi;
  log?: (line: string) => void;
}): SimProcess {
  const doFetch = opts.fetch ?? fetch;
  const proc = opts.processes ?? realProcesses;
  const log = opts.log ?? console.log;
  const pidPath = join(opts.stateDir, SIM_PID_FILE);
  const logPath = join(opts.stateDir, SIM_LOG_FILE);
  const health = `http://127.0.0.1:${SIM_PORT}/sim/healthz`;
  const healthy = async (): Promise<boolean> => {
    try {
      return (await doFetch(health, { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
      return false;
    }
  };

  async function stop(): Promise<void> {
    if (!existsSync(pidPath)) return;
    let pid: number | undefined;
    try {
      pid = (JSON.parse(readFileSync(pidPath, "utf8")) as { pid?: unknown }).pid as number;
    } catch {
      pid = undefined;
    }
    // A pid file can outlive its sim, and the OS recycles pids: signal the pid
    // only when the sim on the port says it is that process.
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
      if ((await simPid()) === pid) {
        try {
          proc.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        const deadline = Date.now() + SIM_STOP_TIMEOUT_MS;
        while (proc.alive(pid) && Date.now() < deadline) await sleep(100);
        if (proc.alive(pid)) {
          try {
            proc.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      } else {
        log(
          `sim: pid file ${pidPath} is stale (no sim on port ${SIM_PORT} has pid ${pid}); removed`
        );
      }
    }
    rmSync(pidPath, { force: true });
  }

  /** The pid the sim on 127.0.0.1:3340 reports on its loopback-only route. */
  async function simPid(): Promise<number | undefined> {
    try {
      const res = await doFetch(`http://127.0.0.1:${SIM_PORT}/control/health`, {
        signal: AbortSignal.timeout(2_000)
      });
      if (!res.ok) return undefined;
      const { pid } = (await res.json()) as { pid?: unknown };
      return typeof pid === "number" ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  async function start(s: { calleeProvider: ProviderKind; outDir: string }): Promise<void> {
    await stop();
    // A healthy port with no sim of ours behind it is someone else's sim: a new
    // one would fail to bind, and its health check would read the old one.
    if (await healthy()) {
      throw new Error(
        `something is already serving on 127.0.0.1:${SIM_PORT}; stop it before starting the sim`
      );
    }
    mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
    const log = openSync(logPath, "a", 0o600);
    chmodSync(logPath, 0o600);
    const [cmd, ...pre] = opts.parleyCommand;
    if (!cmd) throw new Error("sim: no parley command to spawn");
    const child = spawn(
      cmd,
      [
        ...pre,
        "sim",
        "serve",
        "--callee-provider",
        s.calleeProvider,
        "--callee-voice",
        CALLEE_VOICES[s.calleeProvider],
        "--out",
        s.outDir
      ],
      { detached: true, stdio: ["ignore", log, log], env: opts.env }
    );
    closeSync(log);
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", () => {
      exited = true;
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`sim did not start; see ${logPath}`);
    writeFileSync(
      pidPath,
      JSON.stringify({ pid: child.pid, calleeProvider: s.calleeProvider, outDir: s.outDir }) + "\n",
      { mode: 0o600 }
    );
    const deadline = Date.now() + SIM_HEALTH_TIMEOUT_MS;
    while (!(await healthy())) {
      if (exited || Date.now() > deadline) {
        // Our own child, so no identity check: an unhealthy sim cannot vouch
        // for its pid, and this handle cannot name a recycled one.
        if (!exited) child.kill("SIGKILL");
        rmSync(pidPath, { force: true });
        throw new Error(`sim did not become healthy on ${health}; see ${logPath}`);
      }
      await sleep(POLL_MS);
    }
  }

  return { start, stop };
}

// ---------------------------------------------------------------------------
// Commands

export interface PhoneTestCliDeps {
  /** The only source of configuration and secrets. */
  env: NodeJS.ProcessEnv;
  /** argv that runs `parley` again (e.g. `[process.execPath, <cli.js>]`): how
   * the sim is spawned. */
  parleyCommand?: readonly string[];
  /** Builds the provider the sim's callee speaks through, from `env`'s key.
   * Owned by `@parley/cli`, which owns provider construction. */
  buildCallee?: (
    kind: ProviderKind,
    env: NodeJS.ProcessEnv
  ) => {
    provider: RealtimeProvider;
    model: string;
  };
  log?: (line: string) => void;
  home?: string;
  cwd?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  twilio?: TwilioNumbersClient;
  judge?: JudgeClient;
  sim?: SimProcess;
  /** Resolves when `sim serve` should shut down (default: SIGINT or SIGTERM). */
  shutdown?: () => Promise<void>;
  /** Waits between probes of the public route (default: a real timer). */
  sleep?: (ms: number) => Promise<void>;
}

/** Twilio must reach the sim through `https://<host>/sim/*`. Probe its health
 * route from outside until it answers, for about a minute; throws if it never
 * does, so `start` rolls back before any call is billed. */
export async function checkPublicRoute(
  host: string,
  doFetch: typeof fetch,
  wait: (ms: number) => Promise<void>
): Promise<void> {
  const url = `https://${host}/sim/healthz`;
  let last = "no answer";
  for (let i = 1; i <= PUBLIC_HEALTH_ATTEMPTS; i++) {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(PUBLIC_HEALTH_INTERVAL_MS) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (i < PUBLIC_HEALTH_ATTEMPTS) await wait(PUBLIC_HEALTH_INTERVAL_MS);
  }
  throw new Error(
    `the sim is up on loopback, but ${url} did not answer (${last}): ` +
      `tunnel path rule /sim/ not routing? It must forward /sim/* to 127.0.0.1:${SIM_PORT}`
  );
}

const noTwilio: TwilioNumbersClient = {
  accountType: () => Promise.reject(new Error("Twilio is not used by this command")),
  buyLocal: () => Promise.reject(new Error("Twilio is not used by this command")),
  findByFriendlyName: () => Promise.reject(new Error("Twilio is not used by this command")),
  release: () => Promise.reject(new Error("Twilio is not used by this command"))
};

function waitForSignal(): Promise<void> {
  return new Promise((done) => {
    process.once("SIGINT", () => done());
    process.once("SIGTERM", () => done());
  });
}

/** `parley sim serve`: the simulated callee, until SIGINT/SIGTERM. */
export async function runSimCli(args: SimServeArgs, deps: PhoneTestCliDeps): Promise<void> {
  const what = "parley sim serve";
  const env = requireEnvVars(what, deps.env, [
    "PARLEY_PUBLIC_HOST",
    "TWILIO_AUTH_TOKEN",
    ...(args.caller === undefined ? ["TWILIO_FROM_NUMBER"] : []),
    KEY_VAR[args.calleeProvider]
  ]);
  const callerNumber = args.caller ?? env.TWILIO_FROM_NUMBER!;
  if (!E164.test(callerNumber)) {
    throw new Error(`${what}: TWILIO_FROM_NUMBER must be an E.164 number (+ and digits)`);
  }
  if (!deps.buildCallee) throw new Error(`${what}: no callee provider factory`);
  const built = deps.buildCallee(args.calleeProvider, deps.env);
  const outDir = resolve(
    deps.cwd ?? process.cwd(),
    args.outDir ?? join("parley-tests", "captures")
  );
  const sim = createSimServer({
    port: args.port,
    publicHost: env.PARLEY_PUBLIC_HOST!,
    authToken: env.TWILIO_AUTH_TOKEN!,
    callerNumber,
    callee: { provider: built.provider, model: built.model, voice: args.calleeVoice },
    outDir
  });
  await sim.start();
  const log = deps.log ?? console.log;
  log(
    `parley sim listening on 127.0.0.1:${args.port} (callee: ${args.calleeProvider}, ` +
      `voice ${args.calleeVoice}); captures in ${outDir}`
  );
  await (deps.shutdown ?? waitForSignal)();
  await sim.stop();
}

interface Context {
  stateDir: string;
  statePath: string;
  spendPath: string;
  home: string;
  cwd: string;
  log: (line: string) => void;
  now: () => Date;
  sim: SimProcess;
}

function context(stateDir: string | undefined, deps: PhoneTestCliDeps): Context {
  const home = deps.home ?? homedir();
  const dir = resolve(deps.cwd ?? process.cwd(), stateDir ?? defaultStateDir(home));
  return {
    stateDir: dir,
    statePath: join(dir, CAMPAIGN_STATE_FILE),
    spendPath: join(dir, SPEND_LOG_FILE),
    home,
    cwd: deps.cwd ?? process.cwd(),
    log: deps.log ?? console.log,
    now: deps.now ?? (() => new Date()),
    sim:
      deps.sim ??
      detachedSim({
        stateDir: dir,
        parleyCommand: deps.parleyCommand ?? [],
        env: deps.env,
        log: deps.log ?? console.log,
        ...(deps.fetch ? { fetch: deps.fetch } : {})
      })
  };
}

const capturesDir = (outDir: string): string => join(outDir, "captures");

/** The budget a command other than `start` holds the campaign to: the one
 * `start` recorded, else the default. */
async function recordedBudget(ctx: Context): Promise<number> {
  try {
    const s = await campaignStatus({
      ...baseDeps(ctx, DEFAULT_BUDGET_USD),
      allowlistPath: "",
      twilio: noTwilio
    });
    return s.state?.budgetUsd ?? DEFAULT_BUDGET_USD;
  } catch {
    // An unreadable state file: `stop` must still sweep, and every other
    // command reports the file itself when it reads it.
    return DEFAULT_BUDGET_USD;
  }
}

function baseDeps(ctx: Context, budgetUsd: number): Omit<CampaignDeps, "allowlistPath" | "twilio"> {
  return {
    statePath: ctx.statePath,
    spendPath: ctx.spendPath,
    budgetUsd,
    // Only `start` buys a number; every other command never reads this.
    voiceUrl: "",
    startSim: () => {},
    stopSim: () => ctx.sim.stop(),
    now: ctx.now
  };
}

function describeState(state: CampaignState): string {
  return `${state.id} (${state.status}${state.number ? `, number ${state.number}` : ""})`;
}

/** `parley campaign <start|run|stop|status>`. */
export async function runCampaignCli(args: CampaignArgs, deps: PhoneTestCliDeps): Promise<void> {
  const what = `parley campaign ${args.command}`;
  const ctx = context(args.stateDir, deps);
  switch (args.command) {
    case "status": {
      const budget = await recordedBudget(ctx);
      const s = await campaignStatus({
        ...baseDeps(ctx, budget),
        allowlistPath: "",
        twilio: noTwilio
      });
      ctx.log(s.state ? `campaign: ${describeState(s.state)}` : "campaign: none");
      if (s.state && s.ageHours !== undefined) {
        const overdue =
          s.ageHours > WATCHDOG_HOURS ? ` — over the ${WATCHDOG_HOURS} h watchdog; run stop` : "";
        ctx.log(`age: ${s.ageHours.toFixed(1)} h${overdue}`);
      }
      ctx.log(`month spend: $${s.monthSpendUsd.toFixed(2)} of $${budget.toFixed(2)}`);
      ctx.log(`remaining: $${s.remainingUsd.toFixed(2)}`);
      return;
    }
    case "start": {
      const env = requireEnvVars(what, deps.env, [
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        // The sim answers only the daemon's caller number; it inherits this.
        "TWILIO_FROM_NUMBER",
        "PARLEY_PUBLIC_HOST",
        "PARLEY_CALLABLE_NUMBERS_FILE",
        // The sim starts with a Gemini callee; `run` swaps it per config group.
        KEY_VAR.gemini
      ]);
      const host = env.PARLEY_PUBLIC_HOST!;
      const state = await startCampaign({
        ...baseDeps(ctx, args.budgetUsd),
        allowlistPath: env.PARLEY_CALLABLE_NUMBERS_FILE!,
        twilio:
          deps.twilio ??
          createTwilioNumbersClient({
            accountSid: env.TWILIO_ACCOUNT_SID!,
            authToken: env.TWILIO_AUTH_TOKEN!,
            ...(deps.fetch ? { fetch: deps.fetch } : {})
          }),
        voiceUrl: `https://${host}/sim/answer`,
        statusCallback: `https://${host}/sim/status`,
        startSim: async () => {
          const id = (
            await campaignStatus({
              ...baseDeps(ctx, args.budgetUsd),
              allowlistPath: "",
              twilio: noTwilio
            })
          ).state?.id;
          if (!id) throw new Error("campaign state vanished while starting the sim");
          await ctx.sim.start({
            calleeProvider: "gemini",
            outDir: capturesDir(defaultOutDir(id, deps.env, ctx.home, ctx.cwd))
          });
          // A failure here rolls back like any other: release, allowlist, sim.
          await checkPublicRoute(host, deps.fetch ?? fetch, deps.sleep ?? sleep);
        }
      });
      ctx.log(`campaign started: ${describeState(state)}`);
      ctx.log(
        `sim on 127.0.0.1:${SIM_PORT}; https://${host}/sim/* must reach it from the public internet`
      );
      ctx.log(`budget: $${args.budgetUsd.toFixed(2)} a month`);
      return;
    }
    case "stop": {
      const env = requireEnvVars(what, deps.env, [
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "PARLEY_CALLABLE_NUMBERS_FILE"
      ]);
      const budget = await recordedBudget(ctx);
      let stopped: Awaited<ReturnType<typeof stopCampaign>>;
      try {
        stopped = await stopCampaign({
          ...baseDeps(ctx, budget),
          allowlistPath: env.PARLEY_CALLABLE_NUMBERS_FILE!,
          twilio:
            deps.twilio ??
            createTwilioNumbersClient({
              accountSid: env.TWILIO_ACCOUNT_SID!,
              authToken: env.TWILIO_AUTH_TOKEN!,
              ...(deps.fetch ? { fetch: deps.fetch } : {})
            })
        });
      } finally {
        // Whatever the state said, and whether or not Twilio answered, no sim
        // outlives a stop: a failed release must not leave 3340 bound. A sim
        // that will not stop is logged, never allowed to hide Twilio's error.
        try {
          await ctx.sim.stop();
        } catch (err) {
          ctx.log(`sim: stop failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const { released, spentUsd } = stopped;
      ctx.log(`campaign stopped; released ${released.length} number(s)`);
      ctx.log(`campaign spend: $${spentUsd.toFixed(2)}`);
      return;
    }
    case "run":
      await runCampaignCommand(args, deps, ctx);
      return;
  }
}

async function runCampaignCommand(
  args: Extract<CampaignArgs, { command: "run" }>,
  deps: PhoneTestCliDeps,
  ctx: Context
): Promise<void> {
  const what = "parley campaign run";
  // What every run needs is named before any file is read.
  const env = requireEnvVars(what, deps.env, [
    "PARLEY_DAEMON_URL",
    "PARLEY_CALL_TOKEN",
    // The sim, spawned from this process's environment, needs these three.
    "PARLEY_PUBLIC_HOST",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER"
  ]);
  const loaded = args.scenarios.map((p) => loadScenario(resolve(ctx.cwd, p)));
  const scenarios = withoutDiagnosticPersonas(loaded, args.includeDiagnostic);
  if (!args.includeDiagnostic) {
    for (const s of loaded) {
      for (const p of s.personas.filter((p) => p.diagnostic === true)) {
        ctx.log(`skipping diagnostic persona ${s.id}/${p.name} (--include-diagnostic runs it)`);
      }
    }
  }
  const configs = loadConfigs(resolve(ctx.cwd, args.configs));
  const thresholds = loadThresholds(thresholdsPath());
  const groups = groupByProvider(configs);

  const reference = configs.filter((c) => c.realtime.provider === "gemini");
  if (args.judge && reference.length !== 1) {
    throw new Error(
      `${what}: --judge needs exactly one gemini config as the reference, found ${reference.length}`
    );
  }
  // Each config group's callee runs on the other provider; the judge is Gemini.
  const keys = requireEnvVars(what, deps.env, [
    ...new Set([
      ...groups.map(([agent]) => KEY_VAR[calleeFor(agent)]),
      ...(args.judge ? [KEY_VAR.gemini] : [])
    ])
  ]);
  const recordsPath = callRecordsPath(what, deps.env);

  const budget = await recordedBudget(ctx);
  const campaignDeps: CampaignDeps = {
    ...baseDeps(ctx, budget),
    allowlistPath: "",
    twilio: noTwilio
  };
  const { state } = await campaignStatus(campaignDeps);
  if (!state || state.status !== "active") {
    throw new Error(`${what}: no active test campaign; run parley campaign start first`);
  }
  const outDir = args.outDir
    ? resolve(ctx.cwd, args.outDir)
    : defaultOutDir(state.id, deps.env, ctx.home, ctx.cwd);
  mkdirSync(outDir, { recursive: true });

  const results: CallResult[] = [];
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const score = (): ReportCall[] =>
    results.map((r) => scoreCall(r, byId.get(r.scenarioId)!.expect, thresholds));
  try {
    for (const [agent, group] of groups) {
      const callee = calleeFor(agent);
      ctx.log(`sim: callee on ${callee} (${CALLEE_VOICES[callee]}) for ${group.length} config(s)`);
      await ctx.sim.start({ calleeProvider: callee, outDir: capturesDir(outDir) });
      const got = await runCampaign({
        scenarios,
        configs: group,
        callsPerCell: args.callsPerCell,
        daemonUrl: env.PARLEY_DAEMON_URL!,
        callToken: env.PARLEY_CALL_TOKEN!,
        simControlUrl: `http://127.0.0.1:${SIM_PORT}`,
        recordsPath,
        deps: campaignDeps,
        // A callee that broke character makes the call invalid data: the
        // runner excludes it and reruns its cell once.
        isPersonaViolation: (r) =>
          scoreCall(r, byId.get(r.scenarioId)!.expect, thresholds).outcomeCodes.includes(
            "persona-violation"
          ),
        ...(deps.fetch ? { fetch: deps.fetch } : {})
      });
      results.push(...got);
      for (const r of got) {
        const errs = r.errors.length > 0 ? ` [${r.errors.join(", ")}]` : "";
        ctx.log(`  ${r.tag}: ${r.minutes} min, $${r.usd.toFixed(3)}${errs}`);
      }
      const ended = got.at(-1)?.errors.find((e) => RUN_ENDING.has(e));
      if (ended) {
        ctx.log(`run stopped: ${ended}`);
        break;
      }
    }
  } catch (err) {
    // The calls already placed were paid for: keep them before failing.
    try {
      const scored = score();
      writeFileSync(join(outDir, "results.json"), JSON.stringify(scored, null, 2) + "\n");
      const report = writeReport({ campaignId: state.id, results: scored, configs, outDir });
      ctx.log(`run failed after ${results.length} call(s); partial report: ${report.reportPath}`);
    } catch (saveErr) {
      ctx.log(
        `run failed, and its partial results could not be written: ` +
          `${saveErr instanceof Error ? saveErr.message : String(saveErr)}`
      );
    }
    throw err;
  }

  const scored = score();
  writeFileSync(join(outDir, "results.json"), JSON.stringify(scored, null, 2) + "\n");

  let judge: { pairs: PairJudgement[]; model: string } | undefined;
  if (args.judge) {
    const gemini = deps.judge ?? createGeminiJudge({ apiKey: keys[KEY_VAR.gemini]! });
    // Every request sent may be billed, answered or not: book each one.
    const client: JudgeClient = {
      compare: async (input) => {
        try {
          return await gemini.compare(input);
        } finally {
          appendSpend(ctx.spendPath, {
            at: ctx.now().toISOString(),
            campaign: state.id,
            callTag: "judge",
            minutes: 0,
            usd: JUDGE_REQUEST_USD
          });
        }
      }
    };
    const pairs: PairJudgement[] = [];
    for (const [candidate, ref] of judgePairs(results, reference[0]!.name)) {
      try {
        pairs.push(await judgePair(candidate, ref, client, splitStereo));
      } catch (err) {
        ctx.log(
          `judge: ${candidate.tag} vs ${ref.tag} skipped (${err instanceof Error ? err.message : "error"})`
        );
      }
    }
    judge = { pairs, model: DEFAULT_JUDGE_MODEL };
  }

  const report = writeReport({
    campaignId: state.id,
    results: scored,
    configs,
    ...(judge ? { judge } : {}),
    outDir
  });
  ctx.log(`report: ${report.reportPath}`);
  if (report.finalists.length > 0) ctx.log(`finalists: ${report.finalists.join(", ")}`);
  if (report.calibrationDir) ctx.log(`calibration pack: ${report.calibrationDir}`);
}
