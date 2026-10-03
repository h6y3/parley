import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitStereo } from "../src/capture.js";
import type { PairJudgement } from "../src/judge.js";
import { REPORT_NO_JUDGE, writeReport, type ReportCall } from "../src/report.js";
import type { TestConfig } from "../src/scenario.js";
import type { TimingCode, TimingReport } from "../src/timing.js";

const gemini = (name: string): TestConfig => ({ name, realtime: { provider: "gemini" } });
const deepgram = (name: string): TestConfig =>
  ({ name, realtime: { provider: "deepgram", think: "gpt-4o-mini" } }) as TestConfig;

/** A real stereo 8 kHz WAV: L is the agent (0.5 s tones every other half
 * second, or silence), R a different, constant tone for the receptionist. */
function stereoWav(silentAgent: boolean, tag = "", seconds = 8): Buffer {
  let h0 = 0;
  for (const ch of tag) h0 = (h0 * 31 + ch.charCodeAt(0)) % 1000;
  const freq = 200 + h0; // a distinct agent tone per tag
  const frames = 8000 * seconds;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const on = Math.floor(i / 4000) % 2 === 0;
    const l = silentAgent || !on ? 0 : Math.round(8000 * Math.sin((i * 2 * Math.PI * freq) / 8000));
    const r = Math.round(6000 * Math.sin((i * 2 * Math.PI * 700) / 8000));
    data.writeInt16LE(l, i * 4);
    data.writeInt16LE(r, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function timing(gaps: number[], codes: TimingCode[] = [], bargeIn = false): TimingReport {
  const s = [...gaps].sort((a, b) => a - b);
  const pick = (p: number) => (s.length ? s[Math.ceil(p * s.length) - 1]! : 0);
  return {
    responseGapsMs: gaps,
    p50: pick(0.5),
    p90: pick(0.9),
    overlapsMs: [],
    bargeInStopsMs: bargeIn ? [400] : [],
    backchannelsMs: [],
    spokeBeforeCallee: codes.includes("spoke-before-callee"),
    talkedAfterGoodbyeMs: 0,
    deadAirMs: [],
    repromptCount: codes.includes("callee-reprompted") ? 1 : 0,
    codes
  };
}

interface MkOpts {
  gaps?: number[];
  timingCodes?: TimingCode[];
  outcome?: string[];
  errors?: ReportCall["errors"];
  placed?: boolean;
  noTiming?: boolean;
  diagnostic?: boolean;
  silentAgent?: boolean;
  bargeIn?: boolean;
}

/** One call in cell `cell` ("s1/p1"), with a WAV whose bytes name its tag. */
function mk(dir: string, config: string, cell: string, n: number, o: MkOpts = {}): ReportCall {
  const [scenarioId, persona] = cell.split("/") as [string, string];
  const tag = `${scenarioId}.${persona}.${config}.${n}`;
  const wavPath = join(dir, `${tag}.wav`);
  writeFileSync(wavPath, stereoWav(o.silentAgent ?? false, tag));
  const placed = o.placed ?? true;
  return {
    tag,
    scenarioId,
    persona,
    config,
    callId: placed ? `call-${tag}` : undefined,
    wavPath: placed ? wavPath : undefined,
    minutes: placed ? 1 : 0,
    usd: placed ? 0.1 : 0,
    errors: o.errors ?? [],
    outcomeCodes: o.outcome ?? [],
    timing: placed && !o.noTiming ? timing(o.gaps ?? [1000], o.timingCodes, o.bargeIn) : undefined,
    ...(o.diagnostic ? { diagnostic: true as const } : {})
  };
}

/** `wins` agreed pairs won by `winner` over `loser`, tagged with real calls. */
function pairs(
  winner: ReportCall[],
  loser: ReportCall[],
  wins: number,
  opts: { agreement?: boolean; tie?: boolean } = {}
): PairJudgement[] {
  const out: PairJudgement[] = [];
  for (let i = 0; i < wins; i++) {
    const w = winner[i % winner.length]!;
    const l = loser.find((c) => c.scenarioId === w.scenarioId && c.persona === w.persona)!;
    const agreement = opts.agreement ?? true;
    out.push({
      winner: opts.tie || !agreement ? "tie" : w.config,
      agreement,
      configs: [w.config, l.config],
      tags: [w.tag, l.tag],
      reasons: [],
      confidences: []
    });
  }
  return out;
}

const fresh = (name: string) => mkdtempSync(join(tmpdir(), `parley-report-${name}-`));
const read = (p: string) => readFileSync(p, "utf8");
const cells = ["s1/p1", "s1/p1", "s2/p1", "s2/p1"];
const fourOf = (dir: string, config: string, f: (i: number) => MkOpts = () => ({})) =>
  cells.map((cell, i) => mk(dir, config, cell, i + 1, f(i)));

describe("writeReport — tables", () => {
  it("writes per-config rows and per-code failure rates, excluding persona-violation", () => {
    const dir = fresh("table");
    const gem = [
      mk(dir, "gem", "s1/p1", 1, { gaps: [800] }),
      mk(dir, "gem", "s1/p1", 2, { gaps: [1200], outcome: ["outcome-status"] }),
      mk(dir, "gem", "s2/p1", 3, { gaps: [1000] }),
      mk(dir, "gem", "s2/p1", 4, { outcome: ["persona-violation"] })
    ];
    const dg = [
      mk(dir, "dg", "s1/p1", 1, { gaps: [900], timingCodes: ["talk-over"] }),
      mk(dir, "dg", "s1/p1", 2, { gaps: [1100], outcome: ["outcome-status"] }),
      mk(dir, "dg", "s2/p1", 3, { gaps: [1300], timingCodes: ["talk-over"] }),
      mk(dir, "dg", "s2/p1", 4, { placed: false, errors: ["budget-stop"] })
    ];
    const r = writeReport({
      campaignId: "c1",
      results: [...gem, ...dg],
      configs: [gemini("gem"), deepgram("dg")],
      outDir: dir,
      calibration: false
    });
    const md = read(r.reportPath);
    expect(r.reportPath).toBe(join(dir, "report.md"));
    expect(md).toContain("# Phone test campaign c1");
    expect(md).toContain(
      "| config | provider | calls | excluded | outcome failures | talk-over | spoke-before-callee | p50 gap | p90 gap | judge win (decided) | vs reference (decided) | USD |"
    );
    // gem: 3 counted (one persona-violation excluded), 1 outcome failure.
    expect(md).toContain(
      "| gem | gemini | 3 | 1 | 33% | 0% | 0% | 1000 ms | 1200 ms | — | — | $0.40 |"
    );
    // dg: 3 counted (one never placed), USD counts placed calls only.
    expect(md).toContain(
      "| dg | deepgram | 3 | 1 | 33% | 67% | 0% | 1100 ms | 1300 ms | — | — | $0.30 |"
    );
    expect(md).toContain("| config | outcome-status | talk-over |");
    expect(md).toContain("| gem | 33% | 0% |");
    expect(md).toContain("| dg | 33% | 67% |");
    // Excluded calls are listed by tag.
    expect(md).toContain("- s2.p1.gem.4 — persona-violation");
    expect(md).toContain("- s2.p1.dg.4 — not placed (budget-stop)");
    // The per-call list names every call.
    for (const c of [...gem, ...dg]) expect(md).toContain(`| ${c.tag} |`);
  });

  it("excludes harness errors from every rate, but counts a lone call-timeout (R17)", () => {
    const dir = fresh("harness");
    const gem = [
      mk(dir, "gem", "s1/p1", 1),
      mk(dir, "gem", "s1/p1", 2),
      mk(dir, "gem", "s2/p1", 3),
      // Harness failures, not the agent's: out of every rate, listed.
      mk(dir, "gem", "s2/p1", 4, { errors: ["record-missing"], timingCodes: ["talk-over"] }),
      mk(dir, "gem", "s2/p1", 5, { errors: ["persona-missing"] })
    ];
    const dg = [
      mk(dir, "dg", "s1/p1", 1),
      mk(dir, "dg", "s1/p1", 2),
      // The agent never ended the call: an outcome failure.
      mk(dir, "dg", "s2/p1", 3, { errors: ["call-timeout"] }),
      // A timeout the sim could not account for is the harness's.
      mk(dir, "dg", "s2/p1", 4, { errors: ["call-timeout", "sim-desync"] })
    ];
    const r = writeReport({
      campaignId: "c",
      results: [...gem, ...dg],
      configs: [gemini("gem"), deepgram("dg")],
      // dg's only win is over a harness-failed call; its loss stands.
      judge: { pairs: [...pairs([dg[3]!], [gem[3]!], 1), ...pairs([gem[0]!], [dg[0]!], 1)] },
      outDir: dir,
      calibration: false
    });
    const md = read(r.reportPath);
    expect(md).toMatch(/\| gem \| gemini \| 3 \| 2 \| 0% \| 0% \| 0% \|/);
    expect(md).toMatch(/\| dg \| deepgram \| 3 \| 1 \| 33% \| 0% \| 0% \|/);
    expect(md).toContain("| config | call-timeout |");
    expect(md).toContain("| dg | 33% |");
    expect(md).not.toMatch(/\| config \|[^\n]*record-missing/);
    expect(md).toContain("## Excluded (harness)");
    expect(md).toContain("- s2.p1.gem.4 — record-missing");
    expect(md).toContain("- s2.p1.gem.5 — persona-missing");
    expect(md).toContain("- s2.p1.dg.4 — call-timeout, sim-desync");
    expect(md).toContain("0% (1)");
  });

  it("excludes a callee-silent call as the harness's, even when it also timed out", () => {
    const dir = fresh("silent");
    const results = [
      mk(dir, "gem", "s1/p1", 1),
      // The simulated callee never spoke: the agent had no one to talk to.
      mk(dir, "gem", "s1/p1", 2, { errors: ["callee-silent"], outcome: ["outcome-missing"] }),
      mk(dir, "gem", "s1/p1", 3, { errors: ["call-timeout", "callee-silent"] })
    ];
    const md = read(
      writeReport({
        campaignId: "c",
        results,
        configs: [gemini("gem")],
        outDir: dir,
        calibration: false
      }).reportPath
    );
    expect(md).toMatch(/\| gem \| gemini \| 1 \| 2 \| 0% \|/);
    expect(md).not.toMatch(/\| config \|[^\n]*(outcome-missing|callee-silent|call-timeout)/);
    const harness = md.split("## Excluded (harness)")[1]!.split("##")[0]!;
    expect(harness).toContain("- s1.p1.gem.2 — callee-silent");
    expect(harness).toContain("- s1.p1.gem.3 — callee-silent");
  });

  it("notes that the judge is a Gemini model, with or without judge data", () => {
    const dir = fresh("note");
    const results = [mk(dir, "gem", "s1/p1", 1), mk(dir, "dg", "s1/p1", 1)];
    const opts = {
      campaignId: "c",
      results,
      configs: [gemini("gem"), deepgram("dg")],
      outDir: dir,
      calibration: false
    };
    expect(read(writeReport(opts).reportPath)).toMatch(/judge is a Gemini model/);
    const judged = writeReport({
      ...opts,
      judge: { pairs: pairs([results[1]!], [results[0]!], 1) }
    });
    expect(read(judged.reportPath)).toMatch(/judge is a Gemini model/);
  });
});

describe("writeReport — the pre-registered decision rule", () => {
  function campaign(dir: string) {
    const ref = fourOf(dir, "gem", () => ({ gaps: [1000] }));
    const ok = fourOf(dir, "dg-ok", () => ({ gaps: [1200] }));
    const slow = fourOf(dir, "dg-slow", () => ({ gaps: [1201] }));
    const fail = fourOf(dir, "dg-fail", (i) => ({ outcome: i === 0 ? ["outcome-status"] : [] }));
    const talk = fourOf(dir, "dg-talk", (i) => ({
      timingCodes: i === 0 ? (["talk-over"] as TimingCode[]) : []
    }));
    const early = fourOf(dir, "dg-early", (i) => ({
      timingCodes: i === 0 ? (["spoke-before-callee"] as TimingCode[]) : []
    }));
    const edge = fourOf(dir, "dg-edge");
    const weak = fourOf(dir, "dg-weak");
    const judge = [
      ...pairs(ok, ref, 3),
      ...pairs(ref, ok, 1),
      ...pairs(slow, ref, 2),
      ...pairs(fail, ref, 2),
      ...pairs(talk, ref, 2),
      ...pairs(early, ref, 2),
      // 3 of 5 decided is exactly 60%; disagreed and tied pairs leave the count.
      ...pairs(edge, ref, 3),
      ...pairs(ref, edge, 2),
      ...pairs(edge, ref, 2, { agreement: false }),
      ...pairs(edge, ref, 1, { tie: true }),
      // 1 of 2 vs the reference; wins over another Deepgram config do not count.
      ...pairs(weak, ref, 1),
      ...pairs(ref, weak, 1),
      ...pairs(weak, ok, 4)
    ];
    const configs = [
      gemini("gem"),
      ...["dg-ok", "dg-slow", "dg-fail", "dg-talk", "dg-early", "dg-edge", "dg-weak"].map(deepgram)
    ];
    return {
      results: [...ref, ...ok, ...slow, ...fail, ...talk, ...early, ...edge, ...weak],
      configs,
      judge: { pairs: judge }
    };
  }

  it("makes a finalist only of a config passing every check against Gemini", () => {
    const dir = fresh("rule");
    const r = writeReport({ campaignId: "c", ...campaign(dir), outDir: dir, calibration: false });
    expect(r.reference).toBe("gem");
    expect(r.finalists).toEqual(["dg-ok", "dg-edge"]);
    const md = read(r.reportPath);
    expect(md).toMatch(/dg-slow[^\n]*p50 gap/);
    expect(md).toMatch(/dg-fail[^\n]*outcome failures/);
    expect(md).toMatch(/dg-talk[^\n]*talk-over/);
    expect(md).toMatch(/dg-early[^\n]*spoke-before-callee/);
    expect(md).toMatch(/dg-weak[^\n]*judge/);
    // Win rates vs the reference carry their decided-pair counts.
    expect(md).toContain("75% (4)");
    expect(md).toContain("60% (5)");
    expect(md).toContain("50% (2)");
  });

  it("copies the top 2 finalists' best calls and the reference's best call", () => {
    const dir = fresh("copy");
    const out = join(dir, "out");
    const r = writeReport({ campaignId: "c", ...campaign(dir), outDir: out, calibration: false });
    expect(r.copied.map((p) => basename(p))).toEqual([
      "finalist-1-dg-ok.wav",
      "finalist-2-dg-edge.wav",
      "reference-gem.wav"
    ]);
    expect(readFileSync(r.copied[0]!).readUInt16LE(22)).toBe(2); // a named copy stays stereo
  });

  it("ranks finalists by judge rate, then fewer codes, then lower p90", () => {
    const dir = fresh("rank");
    const ref = fourOf(dir, "gem", () => ({ gaps: [1000, 1100] }));
    // All three win every pair; dg-x has a dead-air code; dg-z a higher p90.
    const x = fourOf(dir, "dg-x", (i) => ({
      gaps: [1000],
      timingCodes: i === 0 ? (["dead-air"] as TimingCode[]) : []
    }));
    const y = fourOf(dir, "dg-y", () => ({ gaps: [1000] }));
    const z = fourOf(dir, "dg-z", () => ({ gaps: [1000, 1100] }));
    const r = writeReport({
      campaignId: "c",
      results: [...ref, ...x, ...y, ...z],
      configs: [gemini("gem"), deepgram("dg-x"), deepgram("dg-y"), deepgram("dg-z")],
      judge: { pairs: [...pairs(x, ref, 2), ...pairs(y, ref, 2), ...pairs(z, ref, 2)] },
      outDir: dir,
      calibration: false
    });
    expect(r.finalists).toEqual(["dg-y", "dg-z", "dg-x"]);
    expect(r.copied.map((p) => basename(p))).toEqual([
      "finalist-1-dg-y.wav",
      "finalist-2-dg-z.wav",
      "reference-gem.wav"
    ]);
  });

  it("measures against the reference only on the scenario/persona cells both ran", () => {
    const dir = fresh("cells");
    // Gemini failed in a cell dg never ran; on the shared cell both are clean.
    const ref = [mk(dir, "gem", "s1/p1", 1), mk(dir, "gem", "s9/p1", 1, { outcome: ["x"] })];
    const dg = [mk(dir, "dg", "s1/p1", 1)];
    const dgRun = [mk(dir, "dg", "s1/p1", 2, { outcome: ["x"] }), ...dg];
    const r = writeReport({
      campaignId: "c",
      results: [...ref, ...dgRun],
      configs: [gemini("gem"), deepgram("dg")],
      judge: { pairs: pairs(dg, ref, 1) },
      outDir: dir,
      calibration: false
    });
    // dg fails 1 of 2 on s1/p1, Gemini 0 of 1 there: not a finalist, though
    // Gemini's overall rate (1 of 2) would have let it through.
    expect(r.finalists).toEqual([]);
  });

  it("picks a config's best call by fewest codes, then lowest p90", () => {
    const dir = fresh("best");
    const ref = [
      mk(dir, "gem", "s1/p1", 1, { outcome: ["outcome-status"], gaps: [500] }),
      mk(dir, "gem", "s1/p1", 2, { gaps: [1500] }),
      mk(dir, "gem", "s1/p1", 3, { gaps: [900] })
    ];
    const r = writeReport({
      campaignId: "c",
      results: ref,
      configs: [gemini("gem")],
      judge: { pairs: [] },
      outDir: dir,
      calibration: false
    });
    expect(r.copied[0]!).toContain("rank-1-gem");
    expect(readFileSync(r.copied[0]!).equals(readFileSync(ref[2]!.wavPath!))).toBe(true);
  });

  it("drops judge pairs that touch an excluded call", () => {
    const dir = fresh("drop");
    const ref = [mk(dir, "gem", "s1/p1", 1), mk(dir, "gem", "s2/p1", 2)];
    const dg = [
      mk(dir, "dg", "s1/p1", 1, { outcome: ["persona-violation"] }),
      mk(dir, "dg", "s2/p1", 2)
    ];
    const r = writeReport({
      campaignId: "c",
      results: [...ref, ...dg],
      configs: [gemini("gem"), deepgram("dg")],
      // dg's one judged win is over a persona-violation call; its loss stands.
      judge: { pairs: [...pairs([dg[0]!], ref, 1), ...pairs([ref[1]!], [dg[1]!], 1)] },
      outDir: dir,
      calibration: false
    });
    expect(r.finalists).toEqual([]);
    expect(read(r.reportPath)).toContain("0% (1)");
  });
});

describe("writeReport — a reprompted callee is an outcome failure", () => {
  it("does not make a finalist of a config whose only problem is reprompts", () => {
    const dir = fresh("reprompt");
    const ref = fourOf(dir, "gem");
    const dg = fourOf(dir, "dg", (i) => ({
      timingCodes: i === 0 ? (["callee-reprompted"] as TimingCode[]) : []
    }));
    const r = writeReport({
      campaignId: "c",
      results: [...ref, ...dg],
      configs: [gemini("gem"), deepgram("dg")],
      judge: { pairs: pairs(dg, ref, 4) },
      outDir: dir,
      calibration: false
    });
    expect(r.finalists).toEqual([]);
    const md = read(r.reportPath);
    expect(md).toMatch(/dg[^\n]*not a finalist[^\n]*outcome failures \(25% > 0%\)/);
    // It has a column in the per-code table, and the footnote says why.
    expect(md).toMatch(/## Failure rate per code[\s\S]*callee-reprompted/);
    expect(md).toMatch(/callee-reprompted/);
    expect(md).toMatch(/Outcome failures:[^\n]*callee-reprompted/);
  });
});

describe("writeReport — diagnostic calls", () => {
  it("never enter a rate or the decision rule, and are listed on their own", () => {
    const dir = fresh("diag");
    const ref = fourOf(dir, "gem");
    const dg = fourOf(dir, "dg");
    // The diagnostic cell is a disaster for dg and clean for the reference.
    const refDiag = [mk(dir, "gem", "s1/fast", 1, { diagnostic: true })];
    const dgDiag = [
      mk(dir, "dg", "s1/fast", 1, {
        diagnostic: true,
        outcome: ["outcome-status"],
        timingCodes: ["callee-reprompted", "talk-over"]
      })
    ];
    const r = writeReport({
      campaignId: "c",
      results: [...ref, ...dg, ...refDiag, ...dgDiag],
      configs: [gemini("gem"), deepgram("dg")],
      judge: { pairs: [...pairs(dg, ref, 4), ...pairs(dgDiag, refDiag, 1)] },
      outDir: dir,
      calibration: false
    });
    expect(r.finalists).toEqual(["dg"]);
    const md = read(r.reportPath);
    const configs = md.slice(md.indexOf("## Configs"), md.indexOf("## Failure rate per code"));
    expect(configs).toMatch(/\| dg \| deepgram \| 4 \| 0 \| 0% \|/);
    const perCode = md.slice(md.indexOf("## Failure rate per code"), md.indexOf("## Decision"));
    expect(perCode).toContain("No codes.");
    const diag = md.slice(md.indexOf("## Diagnostic"));
    expect(md).toContain("## Diagnostic");
    expect(diag).toContain(dgDiag[0]!.tag);
    expect(diag).toContain(refDiag[0]!.tag);
    expect(diag).toMatch(/callee-reprompted/);
    expect(md).toMatch(/2 diagnostic/);
  });
});

describe("writeReport — a missing capture fails closed", () => {
  it("excludes a placed call with no timing, so missing data cannot pass the rule", () => {
    const dir = fresh("capture");
    const ref = fourOf(dir, "gem", (i) => ({
      timingCodes: i === 0 ? (["talk-over"] as TimingCode[]) : []
    }));
    // With its two uncaptured calls counted as clean, dg's talk-over rate
    // would be 1 of 4 — equal to Gemini's. On captured calls it is 1 of 2.
    const dg = fourOf(dir, "dg", (i) => ({
      timingCodes: i === 0 ? (["talk-over"] as TimingCode[]) : [],
      noTiming: i === 1 || i === 3
    }));
    const r = writeReport({
      campaignId: "c",
      results: [...ref, ...dg],
      configs: [gemini("gem"), deepgram("dg")],
      judge: { pairs: pairs([dg[0]!, dg[2]!], ref, 2) },
      outDir: dir,
      calibration: false
    });
    expect(r.finalists).toEqual([]);
    const md = read(r.reportPath);
    expect(md).toMatch(/dg[^\n]*not a finalist[^\n]*talk-over/);
    expect(md).toContain("- s1.p1.dg.2 — capture-missing");
    expect(md).toContain("- s2.p1.dg.4 — capture-missing");
    expect(md).toMatch(/\| dg \| deepgram \| 2 \| 2 \|/);
  });
});

describe("writeReport — without judge data or a reference", () => {
  function timingOnly(dir: string) {
    return [
      ...fourOf(dir, "gem", () => ({ gaps: [1000, 1400] })),
      ...fourOf(dir, "dg-a", (i) => ({ outcome: i === 0 ? ["outcome-status"] : [] })),
      ...fourOf(dir, "dg-b", () => ({ gaps: [1000, 1200] })),
      ...fourOf(dir, "dg-c", (i) => ({ timingCodes: i < 2 ? (["dead-air"] as TimingCode[]) : [] }))
    ];
  }
  const configs = [gemini("gem"), deepgram("dg-a"), deepgram("dg-b"), deepgram("dg-c")];

  it("chooses no finalists and copies the top 3 by timing and outcome", () => {
    const dir = fresh("nojudge");
    const r = writeReport({
      campaignId: "c",
      results: timingOnly(dir),
      configs,
      outDir: dir,
      calibration: false
    });
    expect(r.finalists).toEqual([]);
    expect(read(r.reportPath)).toContain(REPORT_NO_JUDGE);
    expect(REPORT_NO_JUDGE).toBe("no judge data; ranked by timing/outcome only");
    // Codes per call: dg-b 0 (p90 1200), gem 0 (p90 1400), dg-a 0.25, dg-c 0.5.
    expect(r.copied.map((p) => basename(p))).toEqual([
      "rank-1-dg-b.wav",
      "rank-2-gem.wav",
      "rank-3-dg-a.wav"
    ]);
  });

  it("honours topN", () => {
    const dir = fresh("topn");
    const r = writeReport({
      campaignId: "c",
      results: timingOnly(dir),
      configs,
      outDir: dir,
      topN: 1,
      calibration: false
    });
    expect(r.copied.map((p) => basename(p))).toEqual(["rank-1-dg-b.wav"]);
  });

  it("says so and chooses no finalists when no config runs on Gemini", () => {
    const dir = fresh("noref");
    const results = [mk(dir, "dg-a", "s1/p1", 1), mk(dir, "dg-b", "s1/p1", 1)];
    const r = writeReport({
      campaignId: "c",
      results,
      configs: [deepgram("dg-a"), deepgram("dg-b")],
      judge: { pairs: pairs([results[0]!], [results[1]!], 1) },
      outDir: dir,
      calibration: false
    });
    expect(r.reference).toBeUndefined();
    expect(r.finalists).toEqual([]);
    expect(read(r.reportPath)).toMatch(/No reference config/);
  });
});

describe("writeReport — blind calibration pack", () => {
  /** A deterministic generator cycling through `values`. */
  const cycle = (values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length]!;
  };

  function judged(dir: string) {
    const ref = fourOf(dir, "gem");
    const a = fourOf(dir, "dg-a");
    const b = fourOf(dir, "dg-b");
    // Each config's best call (lowest p90, first tag): the one copied by name.
    const best = ["gem", "dg-a", "dg-b"].map((c) => mk(dir, c, "s1/p1", 0, { gaps: [500] }));
    return {
      results: [...best, ...ref, ...a, ...b],
      configs: [gemini("gem"), deepgram("dg-a"), deepgram("dg-b")],
      judge: {
        // Non-reference pairs first, so the reference quota has to reach past them.
        pairs: [
          ...pairs(a, b, 4),
          ...pairs(a, ref, 2),
          ...pairs(ref, b, 1),
          ...pairs(b, ref, 1, { agreement: false })
        ]
      }
    };
  }

  interface KeyEntry {
    A: string;
    B: string;
    aTag: string;
    bTag: string;
    judgeWinner: "A" | "B" | "tie" | null;
  }

  it("writes 6 blind pairs, at least 3 against the reference, with a key", () => {
    const dir = fresh("calib");
    const data = judged(dir);
    const r = writeReport({
      campaignId: "c",
      ...data,
      outDir: dir,
      rng: cycle([0.1, 0.7, 0.4, 0.9, 0.2])
    });
    const cal = join(dir, "calibration");
    expect(r.calibrationDir).toBe(cal);
    const files = readdirSync(cal).sort();
    const wavs = files.filter((f) => f.endsWith(".wav"));
    expect(wavs).toEqual(
      [1, 2, 3, 4, 5, 6].flatMap((n) => [`pair-${n}-A.wav`, `pair-${n}-B.wav`]).sort()
    );
    const key = JSON.parse(read(join(cal, ".key.json"))) as Record<string, KeyEntry>;
    expect(Object.keys(key).sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => `pair-${n}`).sort());
    const byTag = new Map(data.results.map((c) => [c.tag, c]));
    let withRef = 0;
    for (const [name, k] of Object.entries(key)) {
      const ca = byTag.get(k.aTag)!;
      const cb = byTag.get(k.bTag)!;
      expect(ca.config).toBe(k.A);
      expect(cb.config).toBe(k.B);
      expect(k.A).not.toBe(k.B);
      expect([ca.scenarioId, ca.persona]).toEqual([cb.scenarioId, cb.persona]);
      for (const [side, call] of [
        ["A", ca],
        ["B", cb]
      ] as const) {
        const got = readFileSync(join(cal, `${name}-${side}.wav`));
        const agent = splitStereo(readFileSync(call.wavPath!)).agent;
        expect(got.equals(agent)).toBe(true);
        // Distinct audio per call: no other call's agent channel matches.
        for (const other of data.results) {
          if (other.tag === call.tag || !other.wavPath) continue;
          expect(got.equals(splitStereo(readFileSync(other.wavPath)).agent)).toBe(false);
        }
        expect(got.readUInt16LE(22)).toBe(1); // mono
        expect(got.readUInt32LE(24)).toBe(8000);
      }
      if (k.A === "gem" || k.B === "gem") withRef++;
      // The judge's verdict, in this pair's letters.
      const p = data.judge.pairs.find((x) => x.tags.includes(k.aTag) && x.tags.includes(k.bTag))!;
      const expected = p.winner === "tie" ? "tie" : p.winner === k.A ? "A" : "B";
      expect(k.judgeWinner).toBe(expected);
    }
    expect(withRef).toBeGreaterThanOrEqual(3);
  });

  it("never names a config or a call in the README", () => {
    const dir = fresh("blind");
    writeReport({ campaignId: "c", ...judged(dir), outDir: dir, rng: cycle([0.3]) });
    const readme = read(join(dir, "calibration", "README.md"));
    for (const word of ["gem", "dg-", "gemini", "deepgram", "s1.", "s2."]) {
      expect(readme.toLowerCase()).not.toContain(word);
    }
    expect(readme).toMatch(/A, B or tie/);
    expect(readme).toMatch(/natural, competent human/);
    expect(readme).toMatch(/answers\.txt/);
    expect(readme).toMatch(/ONE voice: the assistant placing the call/);
    expect(readme).toMatch(/receptionist has been removed/i);
    expect(readme).toMatch(/Ignore line quality/);
    expect(read(join(dir, "calibration", "answers.txt"))).toBe(
      [1, 2, 3, 4, 5, 6].map((n) => `pair-${n}: `).join("\n") + "\n"
    );
  });

  it("randomises A/B with the injected generator", () => {
    const keyFor = (value: number) => {
      const dir = fresh(`ab${value}`);
      writeReport({ campaignId: "c", ...judged(dir), outDir: dir, rng: () => value });
      return JSON.parse(read(join(dir, "calibration", ".key.json"))) as Record<string, KeyEntry>;
    };
    const lo = Object.values(keyFor(0.1));
    const hi = Object.values(keyFor(0.9));
    // The same six pairs either way; only the letters flip.
    expect(lo).toHaveLength(6);
    for (const k of lo) {
      const h = hi.find((x) => x.aTag === k.bTag && x.bTag === k.aTag)!;
      expect(h).toBeDefined();
      expect([h.A, h.B]).toEqual([k.B, k.A]);
      if (k.judgeWinner === "A") expect(h.judgeWinner).toBe("B");
    }
  });

  it("builds unjudged pairs from the calls when there is no judge data", () => {
    const dir = fresh("calib-nojudge");
    const data = judged(dir);
    writeReport({
      campaignId: "c",
      results: data.results,
      configs: data.configs,
      outDir: dir,
      rng: cycle([0.5])
    });
    const key = JSON.parse(read(join(dir, "calibration", ".key.json"))) as Record<string, KeyEntry>;
    expect(Object.keys(key)).toHaveLength(6);
    expect(Object.values(key).every((k) => k.judgeWinner === null)).toBe(true);
  });

  it("never reuses a call copied by name, so no pair file matches a named copy", () => {
    for (const withJudge of [true, false]) {
      const dir = fresh(`calib-leak-${withJudge}`);
      const data = judged(dir);
      const r = writeReport({
        campaignId: "c",
        results: data.results,
        configs: data.configs,
        judge: withJudge ? data.judge : undefined,
        outDir: dir,
        rng: cycle([0.3])
      });
      expect(r.copied.length).toBeGreaterThan(0);
      const named = r.copied.map((p) => readFileSync(p));
      const namedAgents = named.map((b) => splitStereo(b).agent);
      const cal = join(dir, "calibration");
      const wavs = readdirSync(cal).filter((x) => x.endsWith(".wav"));
      expect(wavs).toHaveLength(12);
      for (const f of wavs) {
        const got = readFileSync(join(cal, f));
        for (const n of [...named, ...namedAgents]) expect(got.equals(n)).toBe(false);
      }
    }
  });

  it("skips a pair when either call's agent is silent", () => {
    const dir = fresh("calib-silent");
    const results = [
      mk(dir, "gem", "s1/p1", 1, { gaps: [500] }),
      mk(dir, "gem", "s1/p1", 2, { silentAgent: true }),
      mk(dir, "gem", "s1/p1", 3),
      mk(dir, "dg", "s1/p1", 1, { gaps: [500] }),
      mk(dir, "dg", "s1/p1", 2, { silentAgent: true }),
      mk(dir, "dg", "s1/p1", 3)
    ];
    writeReport({
      campaignId: "c",
      results,
      configs: [gemini("gem"), deepgram("dg")],
      outDir: dir,
      rng: cycle([0.3])
    });
    const key = JSON.parse(read(join(dir, "calibration", ".key.json"))) as Record<string, KeyEntry>;
    for (const k of Object.values(key)) {
      for (const t of [k.aTag, k.bTag]) {
        expect(t).not.toBe("s1.p1.gem.2");
        expect(t).not.toBe("s1.p1.dg.2");
      }
      expect([k.aTag, k.bTag].sort()).toEqual(["s1.p1.dg.3", "s1.p1.gem.3"]);
    }
    expect(Object.keys(key).length).toBeGreaterThan(0);
    // Only silent calls left for one side: no pack at all.
    const dir2 = fresh("calib-silent2");
    const r2 = writeReport({
      campaignId: "c",
      results: [
        mk(dir2, "gem", "s1/p1", 1, { gaps: [500] }),
        mk(dir2, "gem", "s1/p1", 2),
        mk(dir2, "dg", "s1/p1", 1, { gaps: [500] }),
        mk(dir2, "dg", "s1/p1", 2, { silentAgent: true })
      ],
      configs: [gemini("gem"), deepgram("dg")],
      outDir: dir2,
      rng: cycle([0.3])
    });
    expect(r2.calibrationDir).toBeUndefined();
  });

  it("excludes calls the callee cut off (barge-in or talk-over)", () => {
    for (const cut of ["bargeIn", "talkOver"] as const) {
      const dir = fresh(`calib-cut-${cut}`);
      const flag =
        cut === "bargeIn" ? { bargeIn: true } : { timingCodes: ["talk-over"] as TimingCode[] };
      const results = [
        mk(dir, "gem", "s1/p1", 1, { gaps: [500] }),
        mk(dir, "gem", "s1/p1", 2, flag),
        mk(dir, "gem", "s1/p1", 3),
        mk(dir, "dg", "s1/p1", 1, { gaps: [500] }),
        mk(dir, "dg", "s1/p1", 2, flag),
        mk(dir, "dg", "s1/p1", 3)
      ];
      writeReport({
        campaignId: "c",
        results,
        configs: [gemini("gem"), deepgram("dg")],
        outDir: dir,
        rng: cycle([0.3])
      });
      const key = JSON.parse(read(join(dir, "calibration", ".key.json"))) as Record<
        string,
        KeyEntry
      >;
      expect(Object.keys(key).length).toBeGreaterThan(0);
      for (const k of Object.values(key)) {
        expect([k.aTag, k.bTag].sort()).toEqual(["s1.p1.dg.3", "s1.p1.gem.3"]);
      }
    }
  });

  it("says so in the README and the report when fewer than 6 pairs remain", () => {
    const dir = fresh("calib-few");
    // One cell, two configs, two calls each: the best calls are copied by
    // name, leaving one pair.
    const results = [
      mk(dir, "gem", "s1/p1", 1, { gaps: [500] }),
      mk(dir, "gem", "s1/p1", 2),
      mk(dir, "dg", "s1/p1", 1, { gaps: [500] }),
      mk(dir, "dg", "s1/p1", 2)
    ];
    const r = writeReport({
      campaignId: "c",
      results,
      configs: [gemini("gem"), deepgram("dg")],
      outDir: dir,
      rng: cycle([0.3])
    });
    const cal = join(dir, "calibration");
    expect(readdirSync(cal).filter((x) => x.endsWith(".wav"))).toEqual([
      "pair-1-A.wav",
      "pair-1-B.wav"
    ]);
    expect(read(join(cal, "README.md"))).toMatch(/only 1 of 6 pairs/i);
    expect(read(r.reportPath)).toMatch(/only 1 of 6 pairs/i);
  });

  it("keeps an existing pack and its answers on a rerun, unless forced", () => {
    const dir = fresh("calib-keep");
    const data = judged(dir);
    writeReport({ campaignId: "c", ...data, outDir: dir, rng: cycle([0.1]) });
    const cal = join(dir, "calibration");
    const answers = join(cal, "answers.txt");
    const key = read(join(cal, ".key.json"));
    writeFileSync(answers, "pair-1: A\npair-2: tie\n");

    const again = writeReport({ campaignId: "c", ...data, outDir: dir, rng: cycle([0.9]) });
    expect(again.calibrationDir).toBe(cal);
    expect(read(answers)).toBe("pair-1: A\npair-2: tie\n");
    expect(read(join(cal, ".key.json"))).toBe(key);
    expect(read(again.reportPath)).toContain("calibration pack kept from a previous run");

    const forced = writeReport({
      campaignId: "c",
      ...data,
      outDir: dir,
      rng: cycle([0.9]),
      forceCalibration: true
    });
    expect(read(answers)).toMatch(/^pair-1: \n/);
    expect(read(join(cal, ".key.json"))).not.toBe(key);
    expect(read(forced.reportPath)).not.toContain("kept from a previous run");
  });

  it("can be turned off", () => {
    const dir = fresh("calib-off");
    const r = writeReport({ campaignId: "c", ...judged(dir), outDir: dir, calibration: false });
    expect(r.calibrationDir).toBeUndefined();
    expect(existsSync(join(dir, "calibration"))).toBe(false);
  });
});
