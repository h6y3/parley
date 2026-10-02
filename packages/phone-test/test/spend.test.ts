import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  RATES_USD_PER_MIN,
  appendSpend,
  callCostUsd,
  campaignSpendUsd,
  monthSpendUsd
} from "../src/spend.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parley-spend-"));
});

const entry = (at: string, usd: number, campaign = "c1") => ({
  at,
  campaign,
  callTag: "t",
  minutes: 1,
  usd
});

describe("rates and call cost", () => {
  it("carries the spec rates verbatim", () => {
    expect(RATES_USD_PER_MIN).toEqual({
      twilioOutbound: 0.014,
      twilioInbound: 0.0085,
      mediaStreams: 0.0044,
      gemini: 0.023,
      deepgramStandard: 0.075,
      deepgramAdvanced: 0.163
    });
  });

  it("deepgram standard agent with a gemini callee", () => {
    expect(callCostUsd(3, "deepgram", "standard", "gemini")).toBeCloseTo(
      3 * (0.014 + 0.0085 + 0.0088 + 0.075 + 0.023),
      4
    );
  });

  it("uses the deepgram tier for the agent and gemini for both sides", () => {
    expect(callCostUsd(1, "deepgram", "advanced", "gemini")).toBeCloseTo(
      0.014 + 0.0085 + 0.0088 + 0.163 + 0.023,
      6
    );
    expect(callCostUsd(2, "gemini", "advanced", "gemini")).toBeCloseTo(
      2 * (0.014 + 0.0085 + 0.0088 + 0.023 + 0.023),
      6
    );
  });

  it("a deepgram callee is billed at the advanced tier: its think model is the daemon's, unknown here", () => {
    expect(callCostUsd(1, "gemini", "standard", "deepgram")).toBeCloseTo(
      0.014 + 0.0085 + 0.0088 + 0.023 + 0.163,
      6
    );
  });

  it("bills the Twilio legs per started minute and the realtime models per 0.1 minute", () => {
    const twilio = 0.014 + 0.0085 + 2 * 0.0044;
    expect(callCostUsd(1.1, "gemini", "standard", "gemini")).toBeCloseTo(
      2 * twilio + 1.1 * (0.023 + 0.023),
      9
    );
    expect(callCostUsd(0.1, "deepgram", "standard", "gemini")).toBeCloseTo(
      1 * twilio + 0.1 * (0.075 + 0.023),
      9
    );
    expect(callCostUsd(0, "gemini", "standard", "gemini")).toBe(0);
  });
});

describe("spend log", () => {
  it("a missing log reads as 0", () => {
    expect(monthSpendUsd(join(dir, "nope.jsonl"), new Date("2026-10-15T00:00:00Z"))).toBe(0);
  });

  it("appends JSONL, creating the file 600 and the directory 700", () => {
    const log = join(dir, "sub", "spend.jsonl");
    appendSpend(log, entry("2026-10-01T10:00:00Z", 0.5));
    appendSpend(log, entry("2026-10-02T10:00:00Z", 0.25));
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      entry("2026-10-01T10:00:00Z", 0.5),
      entry("2026-10-02T10:00:00Z", 0.25)
    ]);
    expect(monthSpendUsd(log, new Date("2026-10-20T00:00:00Z"))).toBeCloseTo(0.75, 9);
  });

  it("skips corrupt lines and excludes other months", () => {
    const log = join(dir, "spend.jsonl");
    writeFileSync(
      log,
      [
        JSON.stringify(entry("2026-09-30T23:59:59Z", 10)), // last month
        "{not json",
        JSON.stringify({ at: "2026-10-03T00:00:00Z", usd: "lots" }), // usd not a number
        JSON.stringify(entry("garbage-date", 7)),
        JSON.stringify(entry("2025-10-05T00:00:00Z", 3)), // same month, last year
        JSON.stringify(entry("2026-10-01T00:00:00Z", 1.5)),
        "",
        JSON.stringify(entry("2026-10-31T23:59:59Z", 0.5))
      ].join("\n") + "\n"
    );
    expect(monthSpendUsd(log, new Date("2026-10-15T12:00:00Z"))).toBeCloseTo(2, 9);
  });

  it("refuses to append a negative or non-finite entry, and skips one already in the log", () => {
    const log = join(dir, "spend.jsonl");
    expect(() => appendSpend(log, entry("2026-10-01T10:00:00Z", -1))).toThrow(/usd/);
    expect(() => appendSpend(log, entry("2026-10-01T10:00:00Z", Number.NaN))).toThrow(/usd/);
    writeFileSync(
      log,
      [entry("2026-10-01T10:00:00Z", -5), entry("2026-10-01T11:00:00Z", 2)]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n"
    );
    expect(monthSpendUsd(log, new Date("2026-10-15T00:00:00Z"))).toBeCloseTo(2, 9);
    expect(campaignSpendUsd(log, "c1")).toBeCloseTo(2, 9);
  });

  it("sums one campaign's spend", () => {
    const log = join(dir, "spend.jsonl");
    appendSpend(log, entry("2026-10-01T10:00:00Z", 0.5, "a"));
    appendSpend(log, entry("2026-10-01T11:00:00Z", 0.25, "b"));
    appendSpend(log, entry("2026-10-01T12:00:00Z", 0.125, "a"));
    expect(campaignSpendUsd(log, "a")).toBeCloseTo(0.625, 9);
    expect(campaignSpendUsd(join(dir, "none"), "a")).toBe(0);
  });
});
