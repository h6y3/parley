import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_JUDGE_MODEL, type PairJudgement } from "./judge.js";
import type { CallResult } from "./runner.js";
import type { TestConfig } from "./scenario.js";
import type { TimingReport } from "./timing.js";

/** One call as the report reads it: the runner's result, its timing analysis
 * (absent when the capture could not be analysed) and its outcome codes. */
export type ReportCall = CallResult & { timing?: TimingReport; outcomeCodes: string[] };

export interface WriteReportOptions {
  campaignId: string;
  results: ReportCall[];
  /** The campaign's configs; the one on `realtime.provider: "gemini"` is the
   * reference every Deepgram config is measured against. */
  configs: TestConfig[];
  /** The judge's pair verdicts. Absent or empty means no judge data. */
  judge?: { pairs: PairJudgement[]; model?: string };
  outDir: string;
  /** How many configs' best calls to copy when finalists cannot be chosen. */
  topN?: number;
  /** Write the blind calibration pack (default true). */
  calibration?: boolean;
  /** A [0, 1) generator for the calibration pack's order and A/B sides. */
  rng?: () => number;
  /** Rewrite an existing calibration pack. Off by default: a rerun keeps the
   * pack, its key and the listener's answers. */
  forceCalibration?: boolean;
}

export interface ReportResult {
  reportPath: string;
  /** Every WAV copied into `outDir`, in rank order. */
  copied: string[];
  /** Finalists under the decision rule, best first. */
  finalists: string[];
  reference?: string;
  calibrationDir?: string;
}

export const REPORT_NO_JUDGE = "no judge data; ranked by timing/outcome only";
/** The outcome code that makes a call invalid data: the callee broke its
 * persona. */
const PERSONA_VIOLATION = "persona-violation";
/** The one runner error that is the agent's failure: it never ended the call,
 * though the sim accounted for it (an unaccounted timeout adds `sim-desync`). */
const AGENT_ERROR = "call-timeout";
/** The timing code that counts as an outcome failure: the callee had to say
 * "Hello?" again because the agent did not answer it. */
const REPROMPTED = "callee-reprompted";
const GAP_MARGIN_MS = 200;
const JUDGE_MIN_RATE = 0.6;
const FINALISTS_COPIED = 2;
const CALIBRATION_PAIRS = 6;
const CALIBRATION_MIN_REFERENCE = 3;

const isPlaced = (c: ReportCall): boolean => c.callId !== undefined;
type Exclusion = { kind: "harness" | "persona"; reason: string };
/** Why a call is out of every rate, if it is. Harness failures (the call was
 * never placed, any runner error but a lone `call-timeout`, or no timing
 * analysis — `capture-missing`) are not the agent's; a persona violation is
 * the callee's. A missing capture fails closed: counted, it would read as a
 * clean call with no talk-over. */
const exclusion = (c: ReportCall): Exclusion | undefined => {
  if (!isPlaced(c)) {
    const why = c.errors.length ? ` (${c.errors.join(", ")})` : "";
    return { kind: "harness", reason: `not placed${why}` };
  }
  if (c.errors.some((e) => e !== AGENT_ERROR)) {
    return { kind: "harness", reason: c.errors.join(", ") };
  }
  if (c.outcomeCodes.includes(PERSONA_VIOLATION)) {
    return { kind: "persona", reason: PERSONA_VIOLATION };
  }
  if (c.timing === undefined) return { kind: "harness", reason: "capture-missing" };
  return undefined;
};
/** Every code on a call: runner errors, outcome codes and timing codes. */
const codesOf = (c: ReportCall): string[] => [
  ...new Set([...c.errors, ...c.outcomeCodes, ...(c.timing?.codes ?? [])])
];
const cellOf = (c: { scenarioId: string; persona: string }) => `${c.scenarioId}\u0000${c.persona}`;

function nearestRank(sortedAsc: number[], p: number): number | undefined {
  if (sortedAsc.length === 0) return undefined;
  return sortedAsc[Math.max(0, Math.ceil(p * sortedAsc.length) - 1)];
}

interface Stats {
  calls: number;
  /** Calls with any outcome code, a lone `call-timeout` (the agent never ended
   * the call), or `callee-reprompted` (the agent left the callee's hello
   * unanswered). */
  outcomeFailureRate: number;
  talkOverRate: number;
  spokeBeforeRate: number;
  /** Nearest-rank percentiles over every response gap of every call. */
  p50?: number;
  p90?: number;
  codesPerCall: number;
  codeRates: Map<string, number>;
}

function stats(calls: ReportCall[]): Stats {
  const n = calls.length;
  const rate = (pred: (c: ReportCall) => boolean) => (n === 0 ? 0 : calls.filter(pred).length / n);
  const gaps = calls.flatMap((c) => c.timing?.responseGapsMs ?? []).sort((a, b) => a - b);
  const codeCounts = new Map<string, number>();
  let total = 0;
  for (const c of calls) {
    for (const code of codesOf(c)) {
      codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
      total++;
    }
  }
  return {
    calls: n,
    outcomeFailureRate: rate(
      (c) =>
        c.outcomeCodes.length > 0 ||
        c.errors.includes(AGENT_ERROR) ||
        c.timing?.codes.includes(REPROMPTED) === true
    ),
    talkOverRate: rate((c) => c.timing?.codes.includes("talk-over") === true),
    spokeBeforeRate: rate((c) => c.timing?.codes.includes("spoke-before-callee") === true),
    p50: nearestRank(gaps, 0.5),
    p90: nearestRank(gaps, 0.9),
    codesPerCall: n === 0 ? 0 : total / n,
    codeRates: new Map([...codeCounts].map(([k, v]) => [k, v / n]))
  };
}

interface WinRate {
  wins: number;
  decided: number;
}

/** Wins over order-agreed decided pairs, optionally only against `opponent`. */
function winRate(pairs: PairJudgement[], config: string, opponent?: string): WinRate {
  let wins = 0;
  let decided = 0;
  for (const p of pairs) {
    if (!p.configs.includes(config)) continue;
    if (opponent !== undefined && !p.configs.includes(opponent)) continue;
    if (!p.agreement || p.winner === "tie") continue;
    decided++;
    if (p.winner === config) wins++;
  }
  return { wins, decided };
}

const pct = (r: number) => `${Math.round(r * 100)}%`;
const ms = (v: number | undefined) => (v === undefined ? "—" : `${Math.round(v)} ms`);
const usd = (v: number) => `$${v.toFixed(2)}`;
const fmtWin = (w: WinRate) =>
  w.decided === 0 ? "—" : `${pct(w.wins / w.decided)} (${w.decided})`;
const byP90 = (a?: number, b?: number) => (a ?? Infinity) - (b ?? Infinity);
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

/** A config's best call: a counted call with audio, fewest codes, then lowest
 * p90, then tag. */
function bestCall(calls: ReportCall[]): ReportCall | undefined {
  return calls
    .filter((c) => c.wavPath)
    .sort(
      (a, b) =>
        codesOf(a).length - codesOf(b).length ||
        byP90(a.timing?.p90, b.timing?.p90) ||
        a.tag.localeCompare(b.tag)
    )[0];
}

interface Verdict {
  config: string;
  finalist: boolean;
  failures: string[];
  vsReference: WinRate;
}

/** The pre-registered rule: a Deepgram config is a finalist only if, on the
 * scenario/persona cells it shares with the reference, it fails outcomes no
 * more often, answers within reference p50 + 200 ms, talks over and speaks
 * first no more often, and the judge prefers it in ≥ 60% of the order-agreed
 * pairs against the reference. */
function decide(
  config: string,
  reference: string,
  counted: Map<string, ReportCall[]>,
  pairs: PairJudgement[]
): Verdict {
  const own = counted.get(config) ?? [];
  const ref = counted.get(reference) ?? [];
  const shared = new Set(own.map(cellOf).filter((cell) => ref.some((c) => cellOf(c) === cell)));
  const vsReference = winRate(pairs, config, reference);
  if (shared.size === 0) {
    return {
      config,
      finalist: false,
      failures: ["no scenario/persona shared with the reference"],
      vsReference
    };
  }
  const s = stats(own.filter((c) => shared.has(cellOf(c))));
  const r = stats(ref.filter((c) => shared.has(cellOf(c))));
  const failures: string[] = [];
  if (s.outcomeFailureRate > r.outcomeFailureRate) {
    failures.push(`outcome failures (${pct(s.outcomeFailureRate)} > ${pct(r.outcomeFailureRate)})`);
  }
  if (s.p50 === undefined || r.p50 === undefined) {
    failures.push("p50 gap (no response gaps to compare)");
  } else if (s.p50 > r.p50 + GAP_MARGIN_MS) {
    failures.push(`p50 gap (${ms(s.p50)} > ${ms(r.p50)} + ${GAP_MARGIN_MS} ms)`);
  }
  if (s.talkOverRate > r.talkOverRate) {
    failures.push(`talk-over (${pct(s.talkOverRate)} > ${pct(r.talkOverRate)})`);
  }
  if (s.spokeBeforeRate > r.spokeBeforeRate) {
    failures.push(`spoke-before-callee (${pct(s.spokeBeforeRate)} > ${pct(r.spokeBeforeRate)})`);
  }
  if (vsReference.decided === 0) {
    failures.push("judge (no decided pair against the reference)");
  } else if (vsReference.wins / vsReference.decided < JUDGE_MIN_RATE) {
    failures.push(`judge (${fmtWin(vsReference)} < ${pct(JUDGE_MIN_RATE)})`);
  }
  return { config, finalist: failures.length === 0, failures, vsReference };
}

interface CalibrationPair {
  first: ReportCall;
  second: ReportCall;
  judged?: PairJudgement;
}

/** Up to six pairs, at least three against the reference where possible:
 * judged pairs first (so a listener's answers can be scored against the judge), then
 * one unjudged pair per cell and config pair. A call copied by name is never
 * used: its bytes would give the pair away. Order and A/B sides come from
 * `rng`. */
function calibrationPairs(
  counted: ReportCall[],
  pairs: PairJudgement[],
  reference: string | undefined,
  named: Set<string>
): CalibrationPair[] {
  const byTag = new Map(
    counted.filter((c) => c.wavPath && !named.has(c.tag)).map((c) => [c.tag, c])
  );
  const seen = new Set<string>();
  const pool: CalibrationPair[] = [];
  const add = (a: ReportCall, b: ReportCall, judged?: PairJudgement) => {
    const id = [a.tag, b.tag].sort().join("\u0000");
    if (seen.has(id)) return;
    seen.add(id);
    pool.push({ first: a, second: b, judged });
  };
  for (const p of pairs) {
    const a = byTag.get(p.tags[0]);
    const b = byTag.get(p.tags[1]);
    if (a && b) add(a, b, p);
  }
  const firstPerCell = new Map<string, Map<string, ReportCall>>();
  for (const c of byTag.values()) {
    const m = firstPerCell.get(cellOf(c)) ?? new Map<string, ReportCall>();
    if (!m.has(c.config)) m.set(c.config, c);
    firstPerCell.set(cellOf(c), m);
  }
  for (const m of firstPerCell.values()) {
    const calls = [...m.values()];
    for (let i = 0; i < calls.length; i++) {
      for (let j = i + 1; j < calls.length; j++) add(calls[i]!, calls[j]!);
    }
  }
  const involvesRef = (p: CalibrationPair) =>
    p.first.config === reference || p.second.config === reference;
  const chosen = pool.filter(involvesRef).slice(0, CALIBRATION_MIN_REFERENCE);
  for (const p of pool) {
    if (chosen.length >= CALIBRATION_PAIRS) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  return chosen;
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const CALIBRATION_README = (n: number) =>
  [
    "# Blind listening pack",
    "",
    `There are ${n} pairs here. Each pair is the same phone call scenario, placed twice:`,
    "`pair-N-A.wav` and `pair-N-B.wav`. Each recording has two voices — the assistant",
    "placing the call, and the person who answered.",
    "",
    "For each pair, listen to both and decide which recording's **assistant** sounds",
    "more like a natural human on the phone: voice, pacing, wording and turn-taking.",
    "Ignore the other voice, and ignore line noise or muffled phone audio.",
    "",
    "Write A, B or tie after each pair's line in `answers.txt`, next to this file.",
    ...(n < CALIBRATION_PAIRS
      ? ["", `Only ${n} of ${CALIBRATION_PAIRS} pairs could be formed from this campaign.`]
      : []),
    ""
  ].join("\n");

function writeCalibration(
  dir: string,
  chosen: CalibrationPair[],
  rng: () => number
): Record<string, unknown> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const key: Record<string, unknown> = {};
  shuffle(chosen, rng).forEach((p, i) => {
    const name = `pair-${i + 1}`;
    const swap = rng() < 0.5;
    const a = swap ? p.second : p.first;
    const b = swap ? p.first : p.second;
    copyFileSync(a.wavPath!, join(dir, `${name}-A.wav`));
    copyFileSync(b.wavPath!, join(dir, `${name}-B.wav`));
    const w = p.judged?.winner;
    key[name] = {
      A: a.config,
      B: b.config,
      aTag: a.tag,
      bTag: b.tag,
      judgeWinner: w === undefined ? null : w === "tie" ? "tie" : w === a.config ? "A" : "B",
      judgeAgreement: p.judged ? p.judged.agreement : null
    };
  });
  writeFileSync(join(dir, ".key.json"), JSON.stringify(key, null, 2) + "\n");
  writeFileSync(join(dir, "README.md"), CALIBRATION_README(chosen.length));
  writeFileSync(
    join(dir, "answers.txt"),
    chosen.map((_, i) => `pair-${i + 1}: `).join("\n") + "\n"
  );
  return key;
}

/** Writes `report.md` for a campaign, copies the calls worth a listen, and
 * writes the blind calibration pack (an existing pack is kept unless
 * `forceCalibration`). Calls the harness failed (never placed, a runner error
 * other than a lone call-timeout, no capture) or whose callee broke its
 * persona are left out of every rate and listed. */
export function writeReport(opts: WriteReportOptions): ReportResult {
  const topN = opts.topN ?? 3;
  const rng = opts.rng ?? Math.random;
  mkdirSync(opts.outDir, { recursive: true });

  const configNames = [
    ...new Set([...opts.configs.map((c) => c.name), ...opts.results.map((r) => r.config)])
  ];
  const provider = (name: string) =>
    opts.configs.find((c) => c.name === name)?.realtime.provider ?? "?";
  // Diagnostic calls measure a risk, not a config: they stay out of every
  // rate, the judge and the decision rule, and are listed on their own.
  const diagnostic = opts.results.filter((c) => c.diagnostic === true);
  const decisive = opts.results.filter((c) => c.diagnostic !== true);
  const excluded = decisive.filter((c) => exclusion(c) !== undefined);
  const countedAll = decisive.filter((c) => exclusion(c) === undefined);
  const countedTags = new Set(countedAll.map((c) => c.tag));
  const counted = new Map(configNames.map((n) => [n, countedAll.filter((c) => c.config === n)]));

  const allPairs = opts.judge?.pairs ?? [];
  const pairs = allPairs.filter((p) => p.tags.every((t) => countedTags.has(t)));
  const droppedPairs = allPairs.length - pairs.length;
  const hasJudge = pairs.length > 0;

  const gemini = opts.configs.filter((c) => c.realtime.provider === "gemini");
  const reference = gemini.length === 1 ? gemini[0]!.name : undefined;
  const stat = new Map(configNames.map((n) => [n, stats(counted.get(n) ?? [])]));

  // Finalists.
  const verdicts =
    reference !== undefined && hasJudge
      ? opts.configs
          .filter((c) => c.realtime.provider === "deepgram")
          .map((c) => decide(c.name, reference, counted, pairs))
      : [];
  const rate = (w: WinRate) => (w.decided === 0 ? 0 : w.wins / w.decided);
  const finalists = verdicts
    .filter((v) => v.finalist)
    .sort(
      (a, b) =>
        rate(b.vsReference) - rate(a.vsReference) ||
        stat.get(a.config)!.codesPerCall - stat.get(b.config)!.codesPerCall ||
        byP90(stat.get(a.config)!.p90, stat.get(b.config)!.p90) ||
        a.config.localeCompare(b.config)
    )
    .map((v) => v.config);

  // Copies.
  const copied: string[] = [];
  const copiedTags = new Set<string>();
  const copy = (config: string, prefix: string) => {
    const best = bestCall(counted.get(config) ?? []);
    if (!best) return;
    const to = join(opts.outDir, `${prefix}-${safeName(config)}.wav`);
    copyFileSync(best.wavPath!, to);
    copied.push(to);
    copiedTags.add(best.tag);
  };
  const byTimingOutcome = configNames
    .filter((n) => (counted.get(n) ?? []).length > 0)
    .sort(
      (a, b) =>
        stat.get(a)!.codesPerCall - stat.get(b)!.codesPerCall ||
        byP90(stat.get(a)!.p90, stat.get(b)!.p90) ||
        a.localeCompare(b)
    );
  if (reference !== undefined && hasJudge) {
    finalists.slice(0, FINALISTS_COPIED).forEach((f, i) => copy(f, `finalist-${i + 1}`));
    copy(reference, "reference");
  } else {
    byTimingOutcome.slice(0, topN).forEach((n, i) => copy(n, `rank-${i + 1}`));
  }

  // Calibration pack.
  let calibrationDir: string | undefined;
  let calibration: CalibrationPair[] = [];
  let calibrationKept = false;
  if (opts.calibration !== false) {
    const dir = join(opts.outDir, "calibration");
    if (existsSync(dir) && opts.forceCalibration !== true) {
      // A rerun must not reshuffle the pack or lose the listener's answers.
      calibrationKept = true;
      calibrationDir = dir;
    } else {
      calibration = calibrationPairs(countedAll, pairs, reference, copiedTags);
      if (calibration.length > 0) {
        calibrationDir = dir;
        writeCalibration(dir, calibration, rng);
      }
    }
  }

  // report.md
  const L: string[] = [];
  const judgeModel = opts.judge?.model ?? DEFAULT_JUDGE_MODEL;
  L.push(`# Phone test campaign ${opts.campaignId}`, "");
  L.push(
    `Note: the judge is a Gemini model (${judgeModel}), and the reference config runs on ` +
      "Gemini too, so it may prefer the reference's voice. Read win rates with that in mind.",
    ""
  );
  L.push(
    `Calls: ${opts.results.length} placed or attempted, ${countedAll.length} counted, ` +
      `${excluded.length} excluded, ${diagnostic.length} diagnostic. Spend: ${usd(opts.results.reduce((s, c) => s + c.usd, 0))}.`,
    ""
  );

  L.push("## Configs", "");
  L.push(
    "| config | provider | calls | excluded | outcome failures | talk-over | spoke-before-callee | p50 gap | p90 gap | judge win (decided) | vs reference (decided) | USD |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const n of configNames) {
    const s = stat.get(n)!;
    const ex = excluded.filter((c) => c.config === n).length;
    const spent = opts.results.filter((c) => c.config === n).reduce((t, c) => t + c.usd, 0);
    const vsRef =
      reference !== undefined && n !== reference ? fmtWin(winRate(pairs, n, reference)) : "—";
    L.push(
      `| ${n} | ${provider(n)} | ${s.calls} | ${ex} | ${pct(s.outcomeFailureRate)} | ` +
        `${pct(s.talkOverRate)} | ${pct(s.spokeBeforeRate)} | ${ms(s.p50)} | ${ms(s.p90)} | ` +
        `${fmtWin(winRate(pairs, n))} | ${vsRef} | ${usd(spent)} |`
    );
  }
  L.push(
    "",
    "Outcome failures: calls with any outcome code, a call-timeout (the agent never ended the call), " +
      "or callee-reprompted (the callee had to say hello again because the agent did not answer it). Calls with any other runner error are the harness's and are excluded. Gaps pool every response " +
      "gap of a config's counted calls. Judge win rates count only order-agreed pairs that " +
      "named a winner; the decided-pair count is in brackets.",
    ""
  );

  L.push("## Failure rate per code", "");
  const codes = [...new Set(countedAll.flatMap(codesOf))].sort();
  if (codes.length === 0) {
    L.push("No codes.", "");
  } else {
    L.push(`| config | ${codes.join(" | ")} |`, `| --- |${" --- |".repeat(codes.length)}`);
    for (const n of configNames) {
      const s = stat.get(n)!;
      L.push(`| ${n} | ${codes.map((c) => pct(s.codeRates.get(c) ?? 0)).join(" | ")} |`);
    }
    L.push("");
  }

  L.push("## Decision rule", "");
  if (reference === undefined) {
    L.push(
      gemini.length === 0
        ? "No reference config (none runs on realtime.provider gemini): no finalists."
        : `No reference config (${gemini.length} run on gemini, the rule needs exactly one): no finalists.`
    );
  } else if (!hasJudge) {
    L.push(`Reference: ${reference}. Finalists cannot be chosen: ${REPORT_NO_JUDGE}.`);
  } else {
    L.push(
      `Reference: ${reference}. A Deepgram config is a finalist only if, on the cells it shares ` +
        `with the reference: outcome failures (callee-reprompted included) ≤ reference; p50 gap ≤ reference + ${GAP_MARGIN_MS} ms; ` +
        "talk-over and spoke-before-callee ≤ reference; the judge prefers it in ≥ " +
        `${pct(JUDGE_MIN_RATE)} of order-agreed pairs against the reference.`,
      ""
    );
    for (const v of verdicts) {
      L.push(
        v.finalist
          ? `- ${v.config}: finalist (judge vs reference ${fmtWin(v.vsReference)})`
          : `- ${v.config}: not a finalist — fails ${v.failures.join("; ")}`
      );
    }
    L.push("", `Finalists, best first: ${finalists.length ? finalists.join(", ") : "none"}.`);
  }
  if (droppedPairs > 0) {
    L.push("", `${droppedPairs} judge pair(s) dropped: they include an excluded call.`);
  }
  L.push("");
  if (reference === undefined || !hasJudge) {
    L.push(hasJudge ? "Copies ranked by timing/outcome only." : `${REPORT_NO_JUDGE}.`, "");
  }

  L.push("## Copied recordings", "");
  if (copied.length === 0) L.push("None.");
  for (const p of copied) L.push(`- ${p.slice(opts.outDir.length + 1)}`);
  L.push("");

  L.push("## Calibration", "");
  if (calibrationKept) {
    L.push(
      "calibration pack kept from a previous run (pass forceCalibration to rewrite it). " +
        "Answers go in calibration/answers.txt."
    );
  } else if (calibrationDir === undefined) {
    L.push(opts.calibration === false ? "Not written." : "No pair could be formed.");
  } else {
    const withRef = calibration.filter(
      (p) => p.first.config === reference || p.second.config === reference
    ).length;
    L.push(
      `${calibration.length} blind pair(s) in calibration/, ${withRef} against the reference. ` +
        "The key is calibration/.key.json; do not open it until the listener has rated the pairs in calibration/answers.txt. " +
        "If fewer than 4 of 6 of the listener's answers agree with the judge, rank by timing and outcome " +
        "only."
    );
    if (calibration.length < CALIBRATION_PAIRS) {
      L.push(
        "",
        `Only ${calibration.length} of ${CALIBRATION_PAIRS} pairs could be formed (calls copied by name are left out).`
      );
    }
    if (withRef < CALIBRATION_MIN_REFERENCE) {
      L.push(
        "",
        `Only ${withRef} pair(s) involve the reference (wanted ${CALIBRATION_MIN_REFERENCE}).`
      );
    }
  }
  L.push("");

  for (const [kind, title] of [
    ["persona", "Excluded (persona)"],
    ["harness", "Excluded (harness)"]
  ] as const) {
    const list = excluded.filter((c) => exclusion(c)!.kind === kind);
    L.push(`## ${title}`, "");
    if (list.length === 0) L.push("None.");
    for (const c of list) L.push(`- ${c.tag} — ${exclusion(c)!.reason}`);
    L.push("");
  }

  L.push("## Diagnostic", "");
  if (diagnostic.length === 0) {
    L.push("None.");
  } else {
    L.push(
      "Diagnostic personas measure a specific risk. These calls are in no rate, judge pair or " +
        "decision above.",
      "",
      "| tag | persona | config | codes | reprompts |",
      "| --- | --- | --- | --- | --- |"
    );
    for (const c of diagnostic) {
      const why = exclusion(c);
      const codesText = [...codesOf(c), ...(why ? [`excluded: ${why.reason}`] : [])];
      L.push(
        `| ${c.tag} | ${c.persona} | ${c.config} | ${codesText.join(", ") || "—"} | ` +
          `${c.timing?.repromptCount ?? "—"} |`
      );
    }
  }
  L.push("");

  L.push("## Calls", "");
  L.push(
    "| tag | scenario | persona | config | codes | p50 gap | p90 gap | minutes | USD |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const c of opts.results) {
    const codesText = codesOf(c).join(", ") || "—";
    L.push(
      `| ${c.tag} | ${c.scenarioId} | ${c.persona} | ${c.config} | ${codesText} | ` +
        `${ms(c.timing?.p50)} | ${ms(c.timing?.p90)} | ${c.minutes.toFixed(2)} | ${usd(c.usd)} |`
    );
  }
  L.push("");

  const reportPath = join(opts.outDir, "report.md");
  writeFileSync(reportPath, L.join("\n"));
  return { reportPath, copied, finalists, reference, calibrationDir };
}
