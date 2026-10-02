import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CampaignDeps, CampaignState } from "../src/campaign.js";
import {
  RECORD_WAIT_MS,
  RESULT_TIMEOUT_MS,
  WORST_CASE_MINUTES,
  agentTier,
  assertDialable,
  runCampaign,
  type CallResult
} from "../src/runner.js";
import {
  buildEnvelope,
  loadScenario,
  type PhoneScenario,
  type TestConfig
} from "../src/scenario.js";
import { appendSpend, callCostUsd } from "../src/spend.js";
import type { TwilioNumbersClient } from "../src/twilio-numbers.js";

const NUMBER = "+15555550142";
const DAEMON = "http://127.0.0.1:3333";
const SIM = "http://127.0.0.1:3340";
const TOKEN = "test-call-token";

const GEMINI: TestConfig = { name: "gemini-default", realtime: { provider: "gemini" } };
const SONNET: TestConfig = {
  name: "deepgram-sonnet",
  realtime: { provider: "deepgram", think: "claude-sonnet-4-6" }
};

const full = loadScenario(new URL("../scenarios/dental-reschedule.json", import.meta.url).pathname);
/** One persona, so scenario × persona × config is easy to count. */
const scenario: PhoneScenario = { ...full, personas: full.personas.slice(0, 1) };
const persona = scenario.personas[0]!;

/** How one dialled call behaves on the fake sim and daemon. */
interface CallScript {
  /** Result polls answered `pending` before `done`; Infinity = never done on its own. */
  pendingPolls?: number;
  /** Timeline length (last event), or undefined to write no timeline. */
  timelineMs?: number;
  /** Record appears this long after the call is done; Infinity = never. */
  recordAfterMs?: number;
  /** The sim had no persona queued: the call lands under persona-missing-<sid>. */
  personaMissing?: boolean;
  /** The record's line is half-written 1 s before it is complete. */
  partialFirst?: boolean;
  /** The sim reports no CallSid for the tag until after a hangup. */
  unanswered?: boolean;
  /** After a hangup, done arrives after this many more polls. */
  doneAfterHangupPolls?: number;
  /** The timeline is written with no numeric event times. */
  timelineNoTimes?: boolean;
}

interface LiveCall {
  /** The daemon's id: the outbound leg's CallSid, as POST /call returns it. */
  callId: string;
  /** The test number's inbound leg: its own CallSid, the one the sim sees. */
  simSid: string;
  tag: string;
  script: CallScript;
  polls: number;
  done: boolean;
  doneAtMs?: number;
  hungUp: boolean;
  hangupPolls: number;
  recorded: boolean;
  partial: boolean;
}

let dir: string;
/** Sleeps taken after the latest call reached done: one per records re-poll. */
let recordSleeps: number;
let deps: CampaignDeps;
let clockMs: number;
let log: string[];
let scripts: CallScript[];
let live: LiveCall[];
let queued: string[];
/** Tags the sim filed calls under when it answered with no persona queued. */
let unclaimed: string[];
let simDown: boolean;
let onExpect: (() => void) | undefined;

const STATE: CampaignState = {
  id: "c-test",
  status: "active",
  number: NUMBER,
  sid: "PN1",
  startedAt: "2026-10-01T12:00:00.000Z",
  budgetUsd: 50
};

const noTwilio = {} as TwilioNumbersClient;

function writeState(state: CampaignState): void {
  mkdirSync(join(dir, "cfg"), { recursive: true });
  writeFileSync(deps.statePath, JSON.stringify(state));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function tick(): void {
  for (const c of live) {
    if (!c.done || c.recorded) continue;
    const line = JSON.stringify({ callId: c.callId, status: "completed" }) + "\n";
    const due = (c.doneAtMs ?? 0) + (c.script.recordAfterMs ?? 0);
    const half = Math.floor(line.length / 2);
    if (clockMs >= due) {
      c.recorded = true;
      appendFileSync(join(dir, "calls.jsonl"), c.partial ? line.slice(half) : line);
    } else if (c.script.partialFirst && !c.partial && clockMs >= due - 1_000) {
      c.partial = true;
      appendFileSync(join(dir, "calls.jsonl"), line.slice(0, half));
    }
  }
}

function markDone(c: LiveCall): void {
  c.done = true;
  c.doneAtMs = clockMs;
  if (c.script.timelineMs !== undefined) {
    writeFileSync(
      join(dir, `${c.tag}.timeline.json`),
      JSON.stringify({
        startedAtMs: 0,
        sampleRate: 8000,
        channels: { agent: "L", callee: "R" },
        events: c.script.timelineNoTimes
          ? [{ event: "start" }, { atMs: "late", event: "callee-hangup" }]
          : [
              { atMs: 0, event: "start" },
              { atMs: c.script.timelineMs, event: "callee-hangup" }
            ],
        calleeText: []
      })
    );
  }
  tick();
}

function resultOf(c: LiveCall): unknown {
  if (!c.done) {
    // An unanswered call: the tag is still queued, so the sim knows no CallSid.
    return c.script.unanswered && !c.hungUp
      ? { state: "pending" }
      : { state: "pending", callSid: c.simSid };
  }
  const out: Record<string, unknown> = { state: "done", callSid: c.simSid };
  out.wavPath = join(dir, `${c.tag}.wav`);
  if (c.script.timelineMs !== undefined) out.timelinePath = join(dir, `${c.tag}.timeline.json`);
  return out;
}

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  log.push(`${method} ${url.replace(DAEMON, "daemon").replace(SIM, "sim")}`);
  if (url.startsWith(SIM) && simDown) throw new TypeError("fetch failed");

  if (method === "POST" && url === `${SIM}/control/expect`) {
    const body = JSON.parse(String(init?.body)) as { tag: string; persona: { name: string } };
    expect(body.persona.name).toBe(persona.name);
    queued.push(body.tag);
    onExpect?.();
    return json(200, { queued: queued.length });
  }
  if (method === "POST" && url === `${DAEMON}/call`) {
    expect((init?.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
    const env = JSON.parse(String(init?.body)) as { brief: { to: string } };
    expect(env.brief.to).toBe(NUMBER);
    const script = scripts.shift() ?? {};
    const callId = `CA${String(live.length + 1).padStart(32, "0")}`;
    // Twilio gives the inbound leg its own CallSid, never the outbound one.
    const simSid = `CAsim${String(live.length + 1).padStart(28, "0")}`;
    const ownTag = queued.shift()!;
    // A persona-missing call: the sim lost the queued tag (a restart between
    // expect and dial), so the tag reads unknown and the call is filed unclaimed.
    const tag = script.personaMissing ? `persona-missing-${simSid}` : ownTag;
    if (script.personaMissing) unclaimed.push(tag);
    live.push({
      callId,
      simSid,
      tag,
      script,
      polls: 0,
      done: false,
      hungUp: false,
      hangupPolls: 0,
      recorded: false,
      partial: false
    });
    return json(202, { callId });
  }
  if (method === "GET" && url === `${SIM}/control/unclaimed`) {
    return json(200, { tags: [...unclaimed] });
  }
  const r = /^.*\/control\/result\/(.+)$/.exec(url);
  if (method === "GET" && r && url.startsWith(SIM)) {
    const c = live.find((l) => l.tag === r[1]);
    if (!c) {
      // An expected tag that no call took yet reads as pending, like the sim.
      return queued.includes(r[1])
        ? json(200, { state: "pending" })
        : json(404, { error: "unknown tag" });
    }
    if (!c.done) {
      if (c.hungUp) {
        c.hangupPolls += 1;
        if (c.hangupPolls > (c.script.doneAfterHangupPolls ?? Infinity)) markDone(c);
      } else {
        c.polls += 1;
        if (c.polls > (c.script.pendingPolls ?? 0)) markDone(c);
      }
    }
    return json(200, resultOf(c));
  }
  const h = /^.*\/control\/hangup\/(.+)$/.exec(url);
  if (method === "POST" && h && url.startsWith(SIM)) {
    const c = live.find((l) => l.tag === h[1] && !l.done);
    if (!c) return json(404, { error: "no live call with that tag" });
    c.hungUp = true;
    return json(200, { ok: true });
  }
  return json(404, { error: "not found" });
}) as typeof fetch;

const fakeSleep = (ms: number): Promise<void> => {
  clockMs += ms;
  if (live.at(-1)?.done) recordSleeps += 1;
  tick();
  return Promise.resolve();
};

function run(over: Partial<Parameters<typeof runCampaign>[0]> = {}): Promise<CallResult[]> {
  return runCampaign({
    scenarios: [scenario],
    configs: [GEMINI],
    callsPerCell: 1,
    daemonUrl: DAEMON,
    callToken: TOKEN,
    simControlUrl: SIM,
    recordsPath: join(dir, "calls.jsonl"),
    deps,
    fetch: fakeFetch,
    sleep: fakeSleep,
    ...over
  });
}

const spendLines = () =>
  readFileSync(deps.spendPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parley-runner-"));
  clockMs = Date.parse("2026-10-01T12:00:00Z");
  log = [];
  scripts = [];
  live = [];
  queued = [];
  unclaimed = [];
  simDown = false;
  onExpect = undefined;
  recordSleeps = 0;
  deps = {
    statePath: join(dir, "cfg", "test-campaign.json"),
    spendPath: join(dir, "cfg", "test-spend.jsonl"),
    allowlistPath: join(dir, "callable.txt"),
    budgetUsd: 50,
    twilio: noTwilio,
    voiceUrl: "https://voice.example.com/sim/answer",
    startSim: () => {},
    stopSim: () => {},
    now: () => new Date(clockMs)
  };
  writeState(STATE);
});

describe("agentTier", () => {
  it("is standard only for a Deepgram think model known to be Standard tier", () => {
    const dg = (think?: string): TestConfig => ({
      name: "x",
      realtime: think ? { provider: "deepgram", think } : { provider: "deepgram" }
    });
    for (const m of [
      "gpt-4o-mini",
      "gpt-4.1-mini",
      "gpt-5.4-mini",
      "claude-haiku-4-5",
      "gemini-3.5-flash"
    ]) {
      expect(agentTier(dg(m))).toBe("standard");
    }
    expect(agentTier(SONNET)).toBe("advanced");
    // No think: the daemon's own default, unknown to the harness. Conservative.
    expect(agentTier(dg())).toBe("advanced");
    expect(agentTier(dg("some-future-model"))).toBe("advanced");
    expect(agentTier(GEMINI)).toBe("standard");
  });
});

describe("assertDialable", () => {
  const env = buildEnvelope(scenario, NUMBER, GEMINI);
  it("passes when the envelope dials the active campaign's number", () => {
    expect(() => assertDialable(env, STATE)).not.toThrow();
  });
  it("throws dial-refused for any other number, or no active campaign", () => {
    const other = buildEnvelope(scenario, "+15555550199", GEMINI);
    expect(() => assertDialable(other, STATE)).toThrow(/dial-refused/);
    expect(() => assertDialable(env, undefined)).toThrow(/dial-refused/);
    expect(() => assertDialable(env, { ...STATE, status: "pending", number: undefined })).toThrow(
      /dial-refused/
    );
  });
});

describe("runCampaign", () => {
  it("happy path: two calls, each expected, dialled, captured, recorded and booked", async () => {
    scripts = [
      { pendingPolls: 2, timelineMs: 90_000 },
      { pendingPolls: 0, timelineMs: 61_000 }
    ];
    const results = await run({ configs: [GEMINI, SONNET] });

    expect(results).toHaveLength(2);
    const [a, b] = results as [CallResult, CallResult];
    expect(a).toMatchObject({
      scenarioId: "dental-reschedule",
      persona: persona.name,
      config: "gemini-default",
      callId: live[0]!.callId,
      wavPath: join(dir, `${a.tag}.wav`),
      timelinePath: join(dir, `${a.tag}.timeline.json`),
      record: { callId: live[0]!.callId, status: "completed" },
      minutes: 1.5,
      errors: []
    });
    expect(a.usd).toBeCloseTo(callCostUsd(1.5, "gemini", "standard", "deepgram"), 9);
    expect(b).toMatchObject({ config: "deepgram-sonnet", minutes: 1.1, errors: [] });
    expect(b.usd).toBeCloseTo(callCostUsd(1.1, "deepgram", "advanced", "gemini"), 9);
    expect(a.tag).not.toBe(b.tag);
    for (const t of [a.tag, b.tag]) expect(t).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

    // Serial: the second call is expected only after the first is fully done.
    const order = log.filter((l) => /expect|daemon\/call/.test(l));
    expect(order).toEqual([
      "POST sim/control/expect",
      "POST daemon/call",
      "POST sim/control/expect",
      "POST daemon/call"
    ]);

    const spend = spendLines();
    expect(spend).toHaveLength(2);
    expect(spend[0]).toMatchObject({ campaign: "c-test", callTag: a.tag, minutes: 1.5 });
    expect(spend[0]!.usd).toBeCloseTo(a.usd, 9);
    expect(spend[1]).toMatchObject({ campaign: "c-test", callTag: b.tag, minutes: 1.1 });
  });

  it("correlates by tag alone: the sim's CallSid is the inbound leg's, not the daemon's callId", async () => {
    scripts = [{ pendingPolls: 1, timelineMs: 42_000 }];
    const before = clockMs;
    const [r] = await run();
    expect(live[0]!.simSid).not.toBe(live[0]!.callId);
    expect(r!.errors).toEqual([]);
    expect(r!.callId).toBe(live[0]!.callId);
    expect(r!.wavPath).toBe(join(dir, `${r!.tag}.wav`));
    expect(r!.minutes).toBe(0.7);
    // Done on the second poll, not after the 300 s ceiling.
    expect(clockMs - before).toBeLessThan(RESULT_TIMEOUT_MS);
    expect(log.some((l) => l.includes("/control/hangup/"))).toBe(false);
  });

  it("ignores an unclaimed call filed before this call was dialled", async () => {
    unclaimed.push("persona-missing-CAstale0001");
    scripts = [{ pendingPolls: 2, timelineMs: 30_000 }];
    const [r] = await run();
    expect(r!.errors).toEqual([]);
    expect(r!.wavPath).toBe(join(dir, `${r!.tag}.wav`));
  });

  it("without a timeline, books wall-clock minutes from dial to done, rounded up to 0.1", async () => {
    scripts = [{ pendingPolls: 31 }]; // 31 polls × 2 s = 62 s → 1.1 min
    const [r] = await run();
    expect(r!.timelinePath).toBeUndefined();
    expect(r!.minutes).toBe(1.1);
  });

  it("a timeline with no numeric times falls back to the wall clock", async () => {
    scripts = [{ pendingPolls: 31, timelineMs: 1, timelineNoTimes: true }]; // 62 s
    const [r] = await run();
    expect(r!.timelinePath).toBeDefined();
    expect(r!.minutes).toBe(1.1);
  });

  it("stops before the third call when month spend + a 5.5-minute worst case would pass the cap", async () => {
    scripts = [{ timelineMs: 90_000 }, { timelineMs: 90_000 }, { timelineMs: 90_000 }];
    const worst = callCostUsd(5.5, "gemini", "standard", "deepgram");
    const one = callCostUsd(1.5, "gemini", "standard", "deepgram");
    // Room for the worst case after one call, but not after two.
    deps.budgetUsd = one + worst + 0.01;
    appendSpend(deps.spendPath, {
      at: "2026-09-30T23:00:00.000Z", // last month: does not count
      campaign: "old",
      callTag: "old",
      minutes: 100,
      usd: 100
    });

    const results = await run({ callsPerCell: 5 });
    expect(results.map((r) => r.errors)).toEqual([[], [], ["budget-stop"]]);
    expect(results[2]).toMatchObject({ minutes: 0, usd: 0 });
    expect(results[2]!.callId).toBeUndefined();
    expect(log.filter((l) => l === "POST daemon/call")).toHaveLength(2);
    expect(log.filter((l) => l === "POST sim/control/expect")).toHaveLength(2);
  });

  it("picks up a call record on the third poll, tolerating its half-written line on the second", async () => {
    writeFileSync(join(dir, "calls.jsonl"), '{"callId":"CAother","status":"completed"}\n');
    // Poll 1: absent. Poll 2: the line is half-written. Poll 3: complete.
    scripts = [{ timelineMs: 30_000, recordAfterMs: 2_000, partialFirst: true }];
    const [r] = await run();
    expect(r!.errors).toEqual([]);
    expect(r!.record).toEqual({ callId: live[0]!.callId, status: "completed" });
    expect(recordSleeps).toBe(2); // three reads, two waits between them
  });

  it("a missing records file reads as no record yet, not a crash", async () => {
    scripts = [{ timelineMs: 30_000, recordAfterMs: 1_000 }];
    const [r] = await run();
    expect(r!.errors).toEqual([]);
    expect(r!.record).toMatchObject({ callId: live[0]!.callId });
  });

  it("records record-missing when no record appears within 30 s of done, and still books", async () => {
    scripts = [{ timelineMs: 30_000, recordAfterMs: Infinity }];
    const before = clockMs;
    const [r] = await run();
    expect(r!.errors).toEqual(["record-missing"]);
    expect(r!.record).toBeUndefined();
    expect(r!.minutes).toBe(0.5);
    expect(clockMs - before).toBeGreaterThanOrEqual(RECORD_WAIT_MS);
    expect(clockMs - before).toBeLessThan(RECORD_WAIT_MS + 5_000);
    expect(spendLines()).toHaveLength(1);
  });

  it("times out at 300 s: hangs up through the sim, records call-timeout, waits for done", async () => {
    scripts = [
      { pendingPolls: Infinity, doneAfterHangupPolls: 2, timelineMs: 300_000 },
      { timelineMs: 30_000 }
    ];
    const before = clockMs;
    const results = await run({ callsPerCell: 2 });
    const r = results[0];
    expect(r!.errors).toEqual(["call-timeout"]);
    expect(log).toContain(`POST sim/control/hangup/${r!.tag}`);
    expect(r!.timelinePath).toBeDefined();
    expect(r!.minutes).toBe(5);
    expect(clockMs - before).toBeGreaterThanOrEqual(RESULT_TIMEOUT_MS);
    // A clean hangup leaves the sim in step, so the run goes on.
    expect(results.map((x) => x.errors)).toEqual([["call-timeout"], []]);
    expect(spendLines()).toHaveLength(2);
  });

  it("ends the run (sim-desync) when no done arrives after the timeout hangup, still booking it", async () => {
    scripts = [{ pendingPolls: Infinity, doneAfterHangupPolls: Infinity }, {}];
    const results = await run({ callsPerCell: 2 });
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r!.errors).toEqual(["call-timeout", "sim-desync"]);
    expect(r!.wavPath).toBeUndefined();
    expect(r!.minutes).toBeGreaterThanOrEqual(5.5);
    expect(spendLines()).toHaveLength(1);
    expect(log.filter((l) => l === "POST sim/control/expect")).toHaveLength(1);
  });

  it("ends the run (sim-desync) when the sim never reported a CallSid for the tag by the timeout", async () => {
    // The persona may still sit in the sim's queue, where the next call would take it.
    scripts = [
      { unanswered: true, pendingPolls: Infinity, doneAfterHangupPolls: 1, timelineMs: 1_000 },
      {}
    ];
    const results = await run({ callsPerCell: 2 });
    expect(results).toHaveLength(1);
    expect(results[0]!.errors).toEqual(["call-timeout", "sim-desync"]);
    expect(spendLines()).toHaveLength(1);
    expect(log.filter((l) => l === "POST daemon/call")).toHaveLength(1);
  });

  it("on a network error dialling, hangs up the tag best-effort, books the worst case and ends", async () => {
    const base = fakeFetch;
    const failing = ((input: string | URL | Request, init?: RequestInit) =>
      String(input) === `${DAEMON}/call`
        ? Promise.reject(new TypeError("socket hang up"))
        : base(input, init)) as typeof fetch;
    const results = await run({ callsPerCell: 3, fetch: failing });
    expect(results.map((r) => r.errors)).toEqual([["dial-failed"]]);
    expect(log).toContain(`POST sim/control/hangup/${results[0]!.tag}`);
    expect(results[0]!.minutes).toBe(WORST_CASE_MINUTES);
    expect(WORST_CASE_MINUTES).toBe(5.5);
    expect(results[0]!.usd).toBeCloseTo(callCostUsd(5.5, "gemini", "standard", "deepgram"), 9);
    expect(spendLines()).toHaveLength(1);
  });

  it("propagates persona-missing when the sim answered the call without our persona", async () => {
    scripts = [{ personaMissing: true, pendingPolls: 1, timelineMs: 12_000 }];
    const [r] = await run();
    expect(r!.errors).toEqual(["persona-missing"]);
    expect(r!.wavPath).toBe(join(dir, `persona-missing-${live[0]!.simSid}.wav`));
    expect(r!.minutes).toBe(0.2);
  });

  it("reruns a persona-violation call once in the same cell, keeping both, the first excluded", async () => {
    scripts = [{ timelineMs: 30_000 }, { timelineMs: 30_000 }, { timelineMs: 30_000 }];
    const results = await run({
      callsPerCell: 2,
      isPersonaViolation: (r) => r.callId === live[0]!.callId
    });
    expect(results).toHaveLength(3);
    const [first, rerun, second] = results as [CallResult, CallResult, CallResult];
    expect(first.excludedReason).toBe("persona-violation");
    expect(rerun).toMatchObject({
      rerunOf: first.tag,
      persona: persona.name,
      config: "gemini-default"
    });
    expect(rerun.excludedReason).toBeUndefined();
    expect(rerun.tag).not.toBe(first.tag);
    expect(second.rerunOf).toBeUndefined();
    expect(spendLines()).toHaveLength(3);
  });

  it("reruns at most once: a rerun that violates again is kept and not rerun", async () => {
    scripts = [{ timelineMs: 30_000 }, { timelineMs: 30_000 }, { timelineMs: 30_000 }];
    const results = await run({ isPersonaViolation: () => true });
    expect(results).toHaveLength(2);
    expect(results[0]!.excludedReason).toBe("persona-violation");
    expect(results[1]!.rerunOf).toBe(results[0]!.tag);
    expect(log.filter((l) => l === "POST daemon/call")).toHaveLength(2);
  });

  it("a rerun is subject to the budget check", async () => {
    scripts = [{ timelineMs: 30_000 }, { timelineMs: 30_000 }];
    // Room for one worst case, but not for a second after the first call.
    deps.budgetUsd = callCostUsd(5.5, "gemini", "standard", "deepgram") + 0.01;
    const results = await run({ isPersonaViolation: () => true });
    expect(results.map((r) => r.errors)).toEqual([[], ["budget-stop"]]);
    expect(results[1]!.rerunOf).toBe(results[0]!.tag);
    expect(log.filter((l) => l === "POST daemon/call")).toHaveLength(1);
  });

  it("ends the run with sim-unreachable when the sim's control API cannot be reached", async () => {
    simDown = true;
    const results = await run({ callsPerCell: 3 });
    expect(results).toHaveLength(1);
    expect(results[0]!.errors).toEqual(["sim-unreachable"]);
    expect(log.some((l) => l.startsWith("POST daemon"))).toBe(false);
  });

  it("a 2xx with no callId: hangs up the tag, books the worst case and ends (dial-failed)", async () => {
    const base = fakeFetch;
    const noId = ((input: string | URL | Request, init?: RequestInit) =>
      String(input) === `${DAEMON}/call`
        ? Promise.resolve(json(202, { status: "queued" }))
        : base(input, init)) as typeof fetch;
    const results = await run({ callsPerCell: 3, fetch: noId });
    expect(results.map((r) => r.errors)).toEqual([["dial-failed"]]);
    expect(log).toContain(`POST sim/control/hangup/${results[0]!.tag}`);
    expect(results[0]!.minutes).toBe(WORST_CASE_MINUTES);
    expect(results[0]!.usd).toBeCloseTo(callCostUsd(5.5, "gemini", "standard", "deepgram"), 9);
    expect(spendLines()).toHaveLength(1);
  });

  it("ends the run with dial-failed when the daemon refuses the call", async () => {
    const base = fakeFetch;
    const failing = ((input: string | URL | Request, init?: RequestInit) =>
      String(input) === `${DAEMON}/call`
        ? Promise.resolve(json(422, { error: "nope" }))
        : base(input, init)) as typeof fetch;
    const results = await run({ callsPerCell: 3, fetch: failing });
    expect(results.map((r) => r.errors)).toEqual([["dial-failed"]]);
    expect(results[0]).toMatchObject({ minutes: 0, usd: 0 });
  });

  it("refuses to dial (dial-refused) with no active campaign", async () => {
    writeState({ ...STATE, status: "pending", number: undefined, sid: undefined });
    const results = await run({ callsPerCell: 2 });
    expect(results.map((r) => r.errors)).toEqual([["dial-refused"]]);
    expect(log).toEqual([]);
  });

  it("refuses to dial when the campaign's number changes between expect and dial", async () => {
    onExpect = () => writeState({ ...STATE, number: "+15555550199" });
    const results = await run({ callsPerCell: 2 });
    expect(results.map((r) => r.errors)).toEqual([["dial-refused"]]);
    expect(log.some((l) => l.startsWith("POST daemon"))).toBe(false);
  });
});
