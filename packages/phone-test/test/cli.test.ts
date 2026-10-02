import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { muLawEncode } from "@parley/audio";
import { CaptureRecorder } from "../src/capture.js";
import {
  CALLEE_VOICES,
  CAMPAIGN_STATE_FILE,
  JUDGE_REQUEST_USD,
  SIM_PID_FILE,
  calleeFor,
  defaultOutDir,
  detachedSim,
  groupByProvider,
  judgePairs,
  runCampaignCli,
  scoreCall,
  type SimProcess
} from "../src/cli.js";
import type { JudgeClient } from "../src/judge.js";
import type { CallResult } from "../src/runner.js";
import { loadScenario, type TestConfig } from "../src/scenario.js";
import { loadThresholds } from "../src/timing.js";

const PKG = join(import.meta.dirname, "..");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

const call = (over: Partial<CallResult>): CallResult => ({
  tag: "t",
  scenarioId: "s",
  persona: "p",
  config: "c",
  minutes: 0,
  usd: 0,
  errors: [],
  ...over
});

describe("config groups and callees", () => {
  it("groups configs by agent provider in first-appearance order", () => {
    const configs: TestConfig[] = [
      { name: "d1", realtime: { provider: "deepgram" } },
      { name: "g", realtime: { provider: "gemini" } },
      { name: "d2", realtime: { provider: "deepgram", think: "gpt-4o-mini" } }
    ];
    expect(groupByProvider(configs).map(([p, g]) => [p, g.map((c) => c.name)])).toEqual([
      ["deepgram", ["d1", "d2"]],
      ["gemini", ["g"]]
    ]);
    expect(calleeFor("gemini")).toBe("deepgram");
    expect(calleeFor("deepgram")).toBe("gemini");
  });
  it("never gives the callee the agent's default voice", () => {
    expect(CALLEE_VOICES).toEqual({ gemini: "Puck", deepgram: "flux-kit-en" });
  });
});

describe("judgePairs", () => {
  it("pairs the k-th call of a config with the k-th reference call of the same cell", () => {
    const r = [
      call({ tag: "g1", config: "ref", wavPath: "a" }),
      call({ tag: "g2", config: "ref", wavPath: "a" }),
      call({ tag: "d1", config: "dg", wavPath: "a" }),
      call({ tag: "d2", config: "dg", wavPath: "a" }),
      call({ tag: "d3", config: "dg", wavPath: "a" }), // no third reference call
      call({ tag: "h1", config: "dg2", wavPath: "a" }),
      call({ tag: "x1", config: "dg", persona: "other", wavPath: "a" }), // no reference
      call({ tag: "n1", config: "dg3" }) // no audio
    ];
    expect(judgePairs(r, "ref").map(([a, b]) => [a.tag, b.tag])).toEqual([
      ["d1", "g1"],
      ["d2", "g2"],
      ["h1", "g1"]
    ]);
  });
});

describe("judgePairs and diagnostic calls", () => {
  it("never pairs a diagnostic call: it is not judged and costs nothing", () => {
    const r = [
      call({ tag: "g1", config: "ref", persona: "fast", wavPath: "a", diagnostic: true }),
      call({ tag: "d1", config: "dg", persona: "fast", wavPath: "a", diagnostic: true }),
      call({ tag: "g2", config: "ref", wavPath: "a" }),
      call({ tag: "d2", config: "dg", wavPath: "a" })
    ];
    expect(judgePairs(r, "ref").map(([a, b]) => [a.tag, b.tag])).toEqual([["d2", "g2"]]);
  });
});

describe("judgePairs indexing", () => {
  it("indexes over every call of the cell, then skips a pair missing audio on either side", () => {
    const r = [
      call({ tag: "g1", config: "ref" }), // reference call 1 has no audio
      call({ tag: "g2", config: "ref", wavPath: "a" }),
      call({ tag: "d1", config: "dg", wavPath: "a" }),
      call({ tag: "d2", config: "dg", wavPath: "a" }),
      call({ tag: "e1", config: "dg2", wavPath: "a" }),
      call({ tag: "e2", config: "dg2" }) // candidate call 2 has no audio
    ];
    // d1 pairs with g1 (no audio: skipped), never shifted onto g2.
    expect(judgePairs(r, "ref").map(([a, b]) => [a.tag, b.tag])).toEqual([["d2", "g2"]]);
  });

  it("leaves out a persona-violation call; its rerun takes its index", () => {
    const r = [
      call({ tag: "g1", config: "ref", wavPath: "a", excludedReason: "persona-violation" }),
      call({ tag: "g1r", config: "ref", wavPath: "a", rerunOf: "g1" }),
      call({ tag: "g2", config: "ref", wavPath: "a" }),
      call({ tag: "d1", config: "dg", wavPath: "a" }),
      call({ tag: "d2", config: "dg", wavPath: "a", excludedReason: "persona-violation" }),
      call({ tag: "d2r", config: "dg", wavPath: "a", rerunOf: "d2" })
    ];
    expect(judgePairs(r, "ref").map(([a, b]) => [a.tag, b.tag])).toEqual([
      ["d1", "g1r"],
      ["d2r", "g2"]
    ]);
  });
});

describe("campaign run reruns a persona violation", () => {
  it("scores each call as it lands and reruns the cell whose callee broke character", async () => {
    const f = runFixture({ calleeLine: (n) => (n === 1 ? "I'm an AI assistant." : undefined) });
    f.args.judge = false;
    f.args.callsPerCell = 1;
    await runCampaignCli(f.args, f.deps);
    const results = JSON.parse(readFileSync(join(f.outDir, "results.json"), "utf8")) as {
      tag: string;
      config: string;
      excludedReason?: string;
      rerunOf?: string;
      outcomeCodes: string[];
    }[];
    // gemini: violated, then rerun; deepgram: one clean call.
    expect(results.map((r) => r.config)).toEqual([
      "gemini-default",
      "gemini-default",
      "deepgram-4omini"
    ]);
    expect(results[0]).toMatchObject({ excludedReason: "persona-violation" });
    expect(results[0]!.outcomeCodes).toContain("persona-violation");
    expect(results[1]!.rerunOf).toBe(results[0]!.tag);
    expect(f.dialled).toHaveLength(3);
  });
});

describe("defaultOutDir", () => {
  it("is ./parley-tests/<id> by default, whatever folders exist in home", () => {
    const home = tmp("home-");
    const cwd = tmp("cwd-");
    mkdirSync(join(home, "shared"));
    expect(defaultOutDir("c-1", {}, home, cwd)).toBe(join(cwd, "parley-tests", "c-1"));
  });
  it("is $PARLEY_TEST_OUT_DIR/<id> when set (relative to cwd, ~ expanded)", () => {
    const home = tmp("home-");
    const cwd = tmp("cwd-");
    const env = (v: string) => ({ PARLEY_TEST_OUT_DIR: v });
    expect(defaultOutDir("c-1", env("/srv/tests"), home, cwd)).toBe(join("/srv/tests", "c-1"));
    expect(defaultOutDir("c-1", env("out"), home, cwd)).toBe(join(cwd, "out", "c-1"));
    expect(defaultOutDir("c-1", env("~/runs"), home, cwd)).toBe(join(home, "runs", "c-1"));
  });
});

describe("scoreCall", () => {
  const thresholds = loadThresholds(join(PKG, "configs", "thresholds.json"));
  const expectOk = { status: "completed" as const, fields: { when: ["monday"] } };

  it("checks the outcome without a capture, and leaves timing out", () => {
    const s = scoreCall(
      call({
        record: { endedBy: "model", outcome: { status: "completed", fields: { when: "Monday" } } }
      }),
      expectOk,
      thresholds
    );
    expect(s.timing).toBeUndefined();
    expect(s.outcomeCodes).toEqual([]);
  });
  it("gives no outcome codes when there is no record to check", () => {
    expect(scoreCall(call({}), expectOk, thresholds).outcomeCodes).toEqual([]);
    expect(scoreCall(call({ record: { x: 1 } }), expectOk, thresholds).outcomeCodes).toEqual([]);
  });
  it("leaves timing out when the capture does not read", () => {
    const dir = tmp("score-");
    writeFileSync(join(dir, "a.wav"), "not a wav");
    writeFileSync(join(dir, "a.timeline.json"), "{");
    const s = scoreCall(
      call({ wavPath: join(dir, "a.wav"), timelinePath: join(dir, "a.timeline.json") }),
      expectOk,
      thresholds
    );
    expect(s.timing).toBeUndefined();
  });
});

// ---------------------------------------------------------------- run

/** A two-turn capture: callee speaks, the agent answers after `gapMs`. */
function writeCapture(
  dir: string,
  tag: string,
  gapMs: number,
  extraLine?: string
): { wav: string; timeline: string } {
  let t = 0;
  const rec = new CaptureRecorder(() => t);
  const tone = (ms: number) => muLawEncode(new Int16Array(8 * ms).fill(8000));
  const silence = (ms: number) => Buffer.alloc(8 * ms, 0xff);
  rec.agent(silence(300));
  rec.callee(tone(600));
  rec.calleeSaid("Bayside Dental, this is Sam.");
  if (extraLine) rec.calleeSaid(extraLine);
  t = 600;
  rec.agent(silence(gapMs));
  t = 600 + gapMs;
  rec.agent(tone(800));
  t = 600 + gapMs + 800;
  rec.callee(silence(2000));
  rec.agent(silence(2000));
  t += 2000;
  const { wav, timeline } = rec.finish();
  const paths = { wav: join(dir, `${tag}.wav`), timeline: join(dir, `${tag}.timeline.json`) };
  writeFileSync(paths.wav, wav);
  writeFileSync(paths.timeline, JSON.stringify(timeline));
  return paths;
}

/** An active campaign, one scenario with one persona, a Gemini and a Deepgram
 * config, and a fake daemon + sim control API that completes every call. */
function runFixture(
  opts: { calleeLine?: (n: number) => string | undefined; withDiagnostic?: boolean } = {}
) {
  const stateDir = tmp("state-");
  const outDir = tmp("out-");
  const captures = tmp("caps-");
  const recordsPath = join(tmp("records-"), "calls.jsonl");
  const NUMBER = "+15555550123";
  writeFileSync(
    join(stateDir, CAMPAIGN_STATE_FILE),
    JSON.stringify({
      id: "c-test",
      status: "active",
      number: NUMBER,
      sid: "PN1",
      startedAt: new Date().toISOString(),
      budgetUsd: 50
    })
  );
  // One persona keeps the run small.
  const scenario = loadScenario(join(PKG, "scenarios", "dental-reschedule.json"));
  const scenarioPath = join(stateDir, "scenario.json");
  const personas = [scenario.personas[0]];
  if (opts.withDiagnostic) personas.push(scenario.personas.find((p) => p.diagnostic)!);
  writeFileSync(scenarioPath, JSON.stringify({ ...scenario, personas }));
  const configsPath = join(stateDir, "configs.json");
  writeFileSync(
    configsPath,
    JSON.stringify([
      { name: "gemini-default", realtime: { provider: "gemini" } },
      { name: "deepgram-4omini", realtime: { provider: "deepgram", think: "gpt-4o-mini" } }
    ])
  );

  const simStarts: { calleeProvider: string; outDir: string }[] = [];
  const sim: SimProcess = {
    start: async (s) => {
      simStarts.push(s);
    },
    stop: async () => {}
  };

  // The daemon and the sim's control API, in one fake fetch.
  let n = 0;
  const done = new Map<string, unknown>();
  const dialled: unknown[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith("/control/expect")) {
      const { tag } = JSON.parse(String(init?.body)) as { tag: string };
      const callId = `CA${++n}`;
      const cap = writeCapture(captures, tag, 400 + n * 100, opts.calleeLine?.(n));
      done.set(tag, {
        state: "done",
        // The sim sees the inbound leg: its own CallSid, never the daemon's.
        callSid: `CAsim${n}`,
        wavPath: cap.wav,
        timelinePath: cap.timeline
      });
      writeFileSync(
        recordsPath,
        JSON.stringify({
          callId,
          endedBy: "model",
          outcome: {
            status: "completed",
            fields: { newAppointment: "Monday at 10", confirmedBy: "Sam" }
          },
          transcript: [{ speaker: "model", text: "Hello", isFinal: true }]
        }) + "\n",
        { flag: "a" }
      );
      return ok({ queued: 1 });
    }
    if (url.endsWith("/call")) {
      dialled.push(JSON.parse(String(init?.body)));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer call-token");
      return ok({ callId: `CA${n}` });
    }
    if (url.endsWith("/control/unclaimed")) return ok({ tags: [] });
    const result = /\/control\/result\/(.+)$/.exec(url);
    if (result) {
      const r = done.get(result[1]!);
      return r ? ok(r) : new Response("{}", { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const compared: number[] = [];
  const judge: JudgeClient = {
    compare: async () => {
      compared.push(1);
      return { preferred: "A", confidence: 0.9, reason: "steadier pacing" };
    }
  };
  const lines: string[] = [];
  const args = {
    command: "run" as const,
    scenarios: [scenarioPath],
    configs: configsPath,
    callsPerCell: 2,
    judge: true,
    includeDiagnostic: false,
    outDir,
    stateDir
  };
  const deps = {
    env: {
      PARLEY_DAEMON_URL: "http://127.0.0.1:3334",
      PARLEY_CALL_TOKEN: "call-token",
      PARLEY_PUBLIC_HOST: "voice.example.com",
      TWILIO_AUTH_TOKEN: "auth",
      TWILIO_FROM_NUMBER: "+15555550142",
      GEMINI_API_KEY: "g",
      DEEPGRAM_API_KEY: "d",
      PARLEY_CALL_RECORDS: recordsPath
    },
    sim,
    fetch: fakeFetch,
    judge,
    log: (l: string) => lines.push(l),
    home: tmp("home-")
  };
  return { args, deps, outDir, NUMBER, simStarts, dialled, compared, lines };
}

describe("campaign run", () => {
  it("restarts the sim per config group, scores, judges and reports", async () => {
    const { args, deps, outDir, NUMBER, simStarts, dialled, compared, lines } = runFixture();
    await runCampaignCli(args, deps);

    // Gemini agents meet a Deepgram callee, then the sim swaps for Deepgram agents.
    expect(simStarts).toEqual([
      { calleeProvider: "deepgram", outDir: join(outDir, "captures") },
      { calleeProvider: "gemini", outDir: join(outDir, "captures") }
    ]);
    expect(dialled).toHaveLength(4);
    for (const env of dialled as { brief: { to: string } }[]) expect(env.brief.to).toBe(NUMBER);

    const results = JSON.parse(readFileSync(join(outDir, "results.json"), "utf8")) as {
      config: string;
      errors: string[];
      outcomeCodes: string[];
      timing?: { responseGapsMs: number[] };
    }[];
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.errors).toEqual([]);
      expect(r.outcomeCodes).toEqual([]);
      expect(r.timing?.responseGapsMs).toHaveLength(1);
    }
    // Two Deepgram calls, each judged against its reference call in both orders.
    expect(compared).toHaveLength(4);
    // Every judge request is booked to the spend log at its estimate.
    const spend = readFileSync(join(args.stateDir, "test-spend.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { callTag: string; usd: number; campaign: string });
    const judged = spend.filter((e) => e.callTag === "judge");
    expect(JUDGE_REQUEST_USD).toBeGreaterThan(0);
    expect(judged).toHaveLength(4);
    for (const e of judged) expect(e).toMatchObject({ campaign: "c-test", usd: JUDGE_REQUEST_USD });
    expect(existsSync(join(outDir, "report.md"))).toBe(true);
    expect(lines.some((l) => l.startsWith("report: "))).toBe(true);
  });

  it("skips diagnostic personas unless --include-diagnostic is given", async () => {
    const skip = runFixture({ withDiagnostic: true });
    await runCampaignCli({ ...skip.args, judge: false }, skip.deps);
    expect(skip.dialled).toHaveLength(4);
    expect(skip.lines.some((l) => /skipping diagnostic persona.*instant-hello/.test(l))).toBe(true);
    const results = JSON.parse(readFileSync(join(skip.outDir, "results.json"), "utf8")) as {
      persona: string;
    }[];
    expect(results.map((r) => r.persona)).not.toContain("instant-hello");

    const keep = runFixture({ withDiagnostic: true });
    await runCampaignCli({ ...keep.args, judge: false, includeDiagnostic: true }, keep.deps);
    expect(keep.dialled).toHaveLength(8);
    // Included, they are tagged diagnostic and kept out of the decision rates.
    const kept = JSON.parse(readFileSync(join(keep.outDir, "results.json"), "utf8")) as {
      persona: string;
      diagnostic?: boolean;
    }[];
    for (const r of kept) expect(r.diagnostic === true).toBe(r.persona === "instant-hello");
    expect(readFileSync(join(keep.outDir, "report.md"), "utf8")).toMatch(/## Diagnostic/);
  });

  it("keeps the completed calls when a later group fails", async () => {
    const f = runFixture();
    let starts = 0;
    f.deps.sim = {
      start: async () => {
        if (++starts === 2) throw new Error("sim did not become healthy");
      },
      stop: async () => {}
    };
    await expect(runCampaignCli(f.args, f.deps)).rejects.toThrow(/sim did not become healthy/);
    const results = JSON.parse(readFileSync(join(f.outDir, "results.json"), "utf8")) as {
      config: string;
    }[];
    expect(results.map((r) => r.config)).toEqual(["gemini-default", "gemini-default"]);
    expect(existsSync(join(f.outDir, "report.md"))).toBe(true);
  });

  it("refuses to run without an active campaign", async () => {
    await expect(
      runCampaignCli(
        {
          command: "run",
          scenarios: [join(PKG, "scenarios", "dental-reschedule.json")],
          configs: join(PKG, "configs", "default.json"),
          callsPerCell: 1,
          judge: false,
          includeDiagnostic: false,
          stateDir: tmp("state-")
        },
        {
          env: {
            PARLEY_DAEMON_URL: "http://127.0.0.1:3334",
            PARLEY_CALL_TOKEN: "t",
            PARLEY_PUBLIC_HOST: "voice.example.com",
            TWILIO_AUTH_TOKEN: "t",
            TWILIO_FROM_NUMBER: "+15555550142",
            GEMINI_API_KEY: "g",
            DEEPGRAM_API_KEY: "d",
            PARLEY_CALL_RECORDS: "/nonexistent/records.jsonl"
          },
          sim: { start: async () => {}, stop: async () => {} },
          log: () => {}
        }
      )
    ).rejects.toThrow(/no active test campaign/);
  });

  it("refuses --judge without exactly one gemini reference", async () => {
    const dir = tmp("cfg-");
    const configs = join(dir, "configs.json");
    writeFileSync(configs, JSON.stringify([{ name: "d", realtime: { provider: "deepgram" } }]));
    await expect(
      runCampaignCli(
        {
          command: "run",
          scenarios: [join(PKG, "scenarios", "dental-reschedule.json")],
          configs,
          callsPerCell: 1,
          judge: true,
          includeDiagnostic: false,
          stateDir: dir
        },
        {
          env: {
            PARLEY_DAEMON_URL: "http://127.0.0.1:3334",
            PARLEY_CALL_TOKEN: "t",
            PARLEY_PUBLIC_HOST: "voice.example.com",
            TWILIO_AUTH_TOKEN: "t",
            TWILIO_FROM_NUMBER: "+15555550142"
          },
          sim: { start: async () => {}, stop: async () => {} },
          log: () => {}
        }
      )
    ).rejects.toThrow(/exactly one gemini config/);
  });
});

/** A fetch that answers only the public sim health route, with `status`. */
function publicRoute(status: number, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url === "https://voice.example.com/sim/healthz") {
      return new Response(status === 200 ? '{"ok":true}' : "bad gateway", { status });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

describe("campaign start checks the public route", () => {
  it("rolls back (release, allowlist, sim) when https://<host>/sim/healthz never answers", async () => {
    const stateDir = tmp("state-");
    const allowlist = join(stateDir, "callable.txt");
    writeFileSync(allowlist, "+15555550100\n");
    const events: string[] = [];
    const seen: string[] = [];
    const sleeps: number[] = [];
    const deps = {
      env: {
        TWILIO_ACCOUNT_SID: "AC1",
        TWILIO_AUTH_TOKEN: "t",
        TWILIO_FROM_NUMBER: "+15555550142",
        PARLEY_PUBLIC_HOST: "voice.example.com",
        PARLEY_CALLABLE_NUMBERS_FILE: allowlist,
        GEMINI_API_KEY: "g"
      },
      sim: {
        start: async () => {
          events.push("sim-start");
        },
        stop: async () => {
          events.push("sim-stop");
        }
      },
      twilio: {
        accountType: async () => "Full" as const,
        buyLocal: async () => {
          events.push("buy");
          return { sid: "PN1", phoneNumber: "+15555550123" };
        },
        findByFriendlyName: async () => [],
        release: async (sid: string) => {
          events.push(`release ${sid}`);
          return "released" as const;
        }
      },
      fetch: publicRoute(502, seen),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      log: () => {},
      home: tmp("home-")
    };
    await expect(
      runCampaignCli({ command: "start", budgetUsd: 50, stateDir }, deps)
    ).rejects.toThrow(
      /https:\/\/voice\.example\.com\/sim\/healthz.*tunnel path rule \/sim\/ not routing\?/s
    );
    // Retried for about a minute before giving up.
    expect(seen.length).toBeGreaterThan(1);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(55_000);
    expect(events).toEqual(["buy", "sim-start", "release PN1", "sim-stop"]);
    expect(readFileSync(allowlist, "utf8")).toBe("+15555550100\n");
    expect(existsSync(join(stateDir, CAMPAIGN_STATE_FILE))).toBe(false);
  });

  it("passes once the public route answers, after a few misses", async () => {
    const stateDir = tmp("state-");
    let calls = 0;
    const flaky = (async () =>
      new Response("", { status: ++calls < 3 ? 502 : 200 })) as unknown as typeof fetch;
    await runCampaignCli(
      { command: "start", budgetUsd: 50, stateDir },
      {
        env: {
          TWILIO_ACCOUNT_SID: "AC1",
          TWILIO_AUTH_TOKEN: "t",
          TWILIO_FROM_NUMBER: "+15555550142",
          PARLEY_PUBLIC_HOST: "voice.example.com",
          PARLEY_CALLABLE_NUMBERS_FILE: join(stateDir, "callable.txt"),
          GEMINI_API_KEY: "g"
        },
        sim: { start: async () => {}, stop: async () => {} },
        twilio: {
          accountType: async () => "Full" as const,
          buyLocal: async () => ({ sid: "PN1", phoneNumber: "+15555550123" }),
          findByFriendlyName: async () => [],
          release: async () => "released" as const
        },
        fetch: flaky,
        sleep: async () => {},
        log: () => {},
        home: tmp("home-")
      }
    );
    expect(calls).toBe(3);
    expect(existsSync(join(stateDir, CAMPAIGN_STATE_FILE))).toBe(true);
  });
});

describe("campaign start and stop", () => {
  it("starts the sim with a Gemini callee and stops it with the campaign", async () => {
    const stateDir = tmp("state-");
    const allowlist = join(stateDir, "callable.txt");
    const events: string[] = [];
    const sim: SimProcess = {
      start: async (s) => {
        events.push(`start:${s.calleeProvider}`);
      },
      stop: async () => {
        events.push("stop");
      }
    };
    const twilio = {
      accountType: async () => "Full" as const,
      buyLocal: async () => ({ sid: "PN1", phoneNumber: "+15555550123" }),
      findByFriendlyName: async () => [],
      release: async () => "released" as const
    };
    const env = {
      TWILIO_ACCOUNT_SID: "AC1",
      TWILIO_AUTH_TOKEN: "t",
      TWILIO_FROM_NUMBER: "+15555550142",
      PARLEY_PUBLIC_HOST: "voice.example.com",
      PARLEY_CALLABLE_NUMBERS_FILE: allowlist,
      GEMINI_API_KEY: "g"
    };
    const lines: string[] = [];
    const deps = {
      env,
      sim,
      twilio,
      fetch: publicRoute(200),
      log: (l: string) => lines.push(l),
      home: tmp("home-")
    };
    await runCampaignCli({ command: "start", budgetUsd: 20, stateDir }, deps);
    expect(events).toEqual(["start:gemini"]);
    expect(readFileSync(allowlist, "utf8")).toBe("+15555550123\n");
    const state = JSON.parse(readFileSync(join(stateDir, CAMPAIGN_STATE_FILE), "utf8")) as {
      budgetUsd: number;
    };
    expect(state.budgetUsd).toBe(20);

    lines.length = 0;
    await runCampaignCli({ command: "status", stateDir }, deps);
    expect(lines[0]).toMatch(/^campaign: c-.* \(active, number \+15555550123\)$/);
    // The number's monthly fee is booked at start.
    expect(lines).toContain("month spend: $1.15 of $20.00");

    await runCampaignCli({ command: "stop", stateDir }, deps);
    expect(events.filter((e) => e === "stop").length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(allowlist, "utf8")).toBe("");
    expect(existsSync(join(stateDir, CAMPAIGN_STATE_FILE))).toBe(false);
  });
});

describe("campaign stop when Twilio fails", () => {
  it("still stops the sim, and still reports the failure", async () => {
    const stateDir = tmp("state-");
    const allowlist = join(stateDir, "callable.txt");
    let simStops = 0;
    const sim: SimProcess = {
      start: async () => {},
      stop: async () => {
        simStops++;
      }
    };
    const twilio = {
      accountType: async () => "Full" as const,
      buyLocal: async () => ({ sid: "PN1", phoneNumber: "+15555550123" }),
      findByFriendlyName: async () => [],
      release: async (): Promise<"released"> => {
        throw new Error("Twilio request failed: 500 /IncomingPhoneNumbers/PN1.json");
      }
    };
    const deps = {
      env: {
        TWILIO_ACCOUNT_SID: "AC1",
        TWILIO_AUTH_TOKEN: "t",
        TWILIO_FROM_NUMBER: "+15555550142",
        PARLEY_PUBLIC_HOST: "voice.example.com",
        PARLEY_CALLABLE_NUMBERS_FILE: allowlist,
        GEMINI_API_KEY: "g"
      },
      sim,
      twilio,
      fetch: publicRoute(200),
      log: () => {},
      home: tmp("home-")
    };
    await runCampaignCli({ command: "start", budgetUsd: 50, stateDir }, deps);
    await expect(runCampaignCli({ command: "stop", stateDir }, deps)).rejects.toThrow(
      /campaign stop incomplete/
    );
    expect(simStops).toBe(1);
    // The state is kept so a later stop retries the release.
    expect(existsSync(join(stateDir, CAMPAIGN_STATE_FILE))).toBe(true);
  });

  it("with a corrupt state file, still sweeps by FriendlyName, then reports the corruption", async () => {
    const stateDir = tmp("state-");
    writeFileSync(join(stateDir, CAMPAIGN_STATE_FILE), "{not json");
    const released: string[] = [];
    let simStops = 0;
    const deps = {
      env: {
        TWILIO_ACCOUNT_SID: "AC1",
        TWILIO_AUTH_TOKEN: "t",
        PARLEY_CALLABLE_NUMBERS_FILE: join(stateDir, "callable.txt")
      },
      sim: {
        start: async () => {},
        stop: async () => {
          simStops++;
        }
      },
      twilio: {
        accountType: async () => "Full" as const,
        buyLocal: async () => ({ sid: "PN1", phoneNumber: "+15555550123" }),
        findByFriendlyName: async () => [{ sid: "PN7", phoneNumber: "+15555550123" }],
        release: async (sid: string) => {
          released.push(sid);
          return "released" as const;
        }
      },
      log: () => {},
      home: tmp("home-")
    };
    await expect(runCampaignCli({ command: "stop", stateDir }, deps)).rejects.toThrow(/unreadable/);
    expect(released).toEqual(["PN7"]);
    expect(simStops).toBe(1);
  });

  it("reports the Twilio failure even when stopping the sim fails too", async () => {
    const stateDir = tmp("state-");
    const lines: string[] = [];
    const deps = {
      env: {
        TWILIO_ACCOUNT_SID: "AC1",
        TWILIO_AUTH_TOKEN: "t",
        PARLEY_CALLABLE_NUMBERS_FILE: join(stateDir, "callable.txt")
      },
      sim: {
        start: async () => {},
        stop: async () => {
          throw new Error("kill failed");
        }
      },
      twilio: {
        accountType: async () => "Full" as const,
        buyLocal: async () => ({ sid: "PN1", phoneNumber: "+15555550123" }),
        findByFriendlyName: async () => {
          throw new Error("Twilio request failed: 503 /IncomingPhoneNumbers.json");
        },
        release: async () => "released" as const
      },
      log: (l: string) => lines.push(l),
      home: tmp("home-")
    };
    await expect(runCampaignCli({ command: "stop", stateDir }, deps)).rejects.toThrow(
      /campaign stop incomplete/
    );
    expect(lines.some((l) => /sim: stop failed: kill failed/.test(l))).toBe(true);
  });
});

describe("detachedSim stop", () => {
  function setup(health: () => Promise<Response>) {
    const stateDir = tmp("state-");
    writeFileSync(join(stateDir, SIM_PID_FILE), JSON.stringify({ pid: 4242 }));
    const kills: [number, string][] = [];
    let dead = false;
    const lines: string[] = [];
    const sim = detachedSim({
      stateDir,
      parleyCommand: ["parley"],
      env: {},
      fetch: (async (input: string | URL | Request) => {
        expect(String(input)).toBe("http://127.0.0.1:3340/control/health");
        return health();
      }) as typeof fetch,
      processes: {
        kill: (pid, signal) => {
          kills.push([pid, signal]);
          dead = true;
        },
        alive: () => !dead
      },
      log: (l) => lines.push(l)
    });
    return { sim, stateDir, kills, lines };
  }

  it("kills the pid only when the sim on 3340 says it is that pid", async () => {
    const t = setup(async () => new Response(JSON.stringify({ ok: true, pid: 4242 })));
    await t.sim.stop();
    expect(t.kills).toEqual([[4242, "SIGTERM"]]);
    expect(existsSync(join(t.stateDir, SIM_PID_FILE))).toBe(false);
  });

  it("drops a stale pid file without killing when the sim is another pid", async () => {
    const t = setup(async () => new Response(JSON.stringify({ ok: true, pid: 9999 })));
    await t.sim.stop();
    expect(t.kills).toEqual([]);
    expect(existsSync(join(t.stateDir, SIM_PID_FILE))).toBe(false);
    expect(t.lines.some((l) => /stale/.test(l))).toBe(true);
  });

  it("drops a stale pid file without killing when no sim answers", async () => {
    const t = setup(async () => {
      throw new Error("ECONNREFUSED");
    });
    await t.sim.stop();
    expect(t.kills).toEqual([]);
    expect(existsSync(join(t.stateDir, SIM_PID_FILE))).toBe(false);
  });
});
