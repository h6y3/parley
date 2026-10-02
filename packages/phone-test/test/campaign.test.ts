import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CAMPAIGN_FRIENDLY_NAME,
  campaignStatus,
  startCampaign,
  stopCampaign,
  type CampaignDeps
} from "../src/campaign.js";
import { NUMBER_MONTHLY_USD, appendSpend } from "../src/spend.js";
import type { OwnedNumber, TwilioNumbersClient } from "../src/twilio-numbers.js";

const NUMBER = "+15555550142";

/** A fake Twilio account: owned numbers by SID, with hooks to inject faults. */
class FakeTwilio implements TwilioNumbersClient {
  owned = new Map<string, OwnedNumber & { friendlyName: string }>();
  type: "Trial" | "Full" = "Full";
  calls: string[] = [];
  /** Buy succeeds server-side, then the response is "lost" and buyLocal throws. */
  throwAfterBuy = false;
  releaseFails = new Set<string>();
  private seq = 0;

  accountType() {
    this.calls.push("accountType");
    return Promise.resolve(this.type);
  }
  buyLocal(opts: { voiceUrl: string; statusCallback?: string; friendlyName: string }) {
    this.calls.push(`buy ${opts.friendlyName} ${opts.voiceUrl}`);
    this.seq += 1;
    const n = { sid: `PN${this.seq}`, phoneNumber: NUMBER, friendlyName: opts.friendlyName };
    this.owned.set(n.sid, n);
    if (this.throwAfterBuy) return Promise.reject(new Error("socket hang up"));
    return Promise.resolve({ sid: n.sid, phoneNumber: n.phoneNumber });
  }
  findByFriendlyName(name: string) {
    this.calls.push(`find ${name}`);
    return Promise.resolve(
      [...this.owned.values()]
        .filter((n) => n.friendlyName === name)
        .map(({ sid, phoneNumber }) => ({ sid, phoneNumber }))
    );
  }
  release(sid: string) {
    this.calls.push(`release ${sid}`);
    if (this.releaseFails.has(sid)) return Promise.reject(new Error("Twilio request failed: 500"));
    return Promise.resolve(
      this.owned.delete(sid) ? ("released" as const) : ("already-gone" as const)
    );
  }
}

let dir: string;
let twilio: FakeTwilio;
let simCalls: string[];
let now: Date;
let deps: CampaignDeps;
const ALLOWLIST = "# callable numbers\n+15555550100\n\n# trailing comment\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parley-campaign-"));
  twilio = new FakeTwilio();
  simCalls = [];
  now = new Date("2026-10-01T12:00:00Z");
  writeFileSync(join(dir, "callable.txt"), ALLOWLIST);
  deps = {
    statePath: join(dir, "cfg", "test-campaign.json"),
    spendPath: join(dir, "cfg", "test-spend.jsonl"),
    allowlistPath: join(dir, "callable.txt"),
    budgetUsd: 50,
    twilio,
    voiceUrl: "https://voice.example.com/sim/twilio/answer",
    startSim: () => {
      simCalls.push("start");
      return Promise.resolve();
    },
    stopSim: () => {
      simCalls.push("stop");
      return Promise.resolve();
    },
    now: () => now
  };
});

const readState = () => JSON.parse(readFileSync(deps.statePath, "utf8")) as Record<string, unknown>;
const allowlist = () => readFileSync(deps.allowlistPath, "utf8");

describe("startCampaign / stopCampaign", () => {
  it("happy path: buys, records, allowlists, starts the sim; stop undoes all of it", async () => {
    const state = await startCampaign(deps);
    expect(state).toMatchObject({
      status: "active",
      number: NUMBER,
      sid: "PN1",
      startedAt: "2026-10-01T12:00:00.000Z",
      budgetUsd: 50
    });
    expect(typeof state.id).toBe("string");
    expect(readState()).toEqual(state);
    expect(statSync(deps.statePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "cfg")).mode & 0o777).toBe(0o700);
    expect(twilio.calls).toContain(`buy ${CAMPAIGN_FRIENDLY_NAME} ${deps.voiceUrl}`);
    expect(CAMPAIGN_FRIENDLY_NAME).toBe("parley-test-campaign");
    expect(allowlist()).toBe(ALLOWLIST + NUMBER + "\n");
    expect(simCalls).toEqual(["start"]);

    appendSpend(deps.spendPath, {
      at: now.toISOString(),
      campaign: state.id,
      callTag: "a",
      minutes: 2,
      usd: 0.5
    });
    appendSpend(deps.spendPath, {
      at: now.toISOString(),
      campaign: "other",
      callTag: "b",
      minutes: 2,
      usd: 9
    });

    const out = await stopCampaign(deps);
    expect(out.released).toEqual(["PN1"]);
    // The number's monthly fee, booked at start, plus the call.
    expect(out.spentUsd).toBeCloseTo(NUMBER_MONTHLY_USD + 0.5, 9);
    expect(twilio.owned.size).toBe(0);
    expect(allowlist()).toBe(ALLOWLIST);
    expect(simCalls).toEqual(["start", "stop"]);
    expect(existsSync(deps.statePath)).toBe(false);
  });

  it("books the number's monthly fee as soon as the number is bought", async () => {
    expect(NUMBER_MONTHLY_USD).toBe(1.15);
    const state = await startCampaign(deps);
    const lines = readFileSync(deps.spendPath, "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      {
        at: "2026-10-01T12:00:00.000Z",
        campaign: state.id,
        callTag: "number-fee",
        minutes: 0,
        usd: 1.15
      }
    ]);
    expect(statSync(deps.spendPath).mode & 0o777).toBe(0o600);
  });

  it("books the fee even when a later step rolls the campaign back", async () => {
    deps.startSim = () => Promise.reject(new Error("port in use"));
    await expect(startCampaign(deps)).rejects.toThrow("port in use");
    expect((await campaignStatus(deps)).monthSpendUsd).toBeCloseTo(NUMBER_MONTHLY_USD, 9);
  });

  it("refuses when the number's fee would pass the budget", async () => {
    appendSpend(deps.spendPath, {
      at: "2026-10-01T01:00:00Z",
      campaign: "x",
      callTag: "t",
      minutes: 10,
      usd: 49
    });
    await expect(startCampaign(deps)).rejects.toThrow(/budget/);
    expect(twilio.calls).toEqual([]);
  });

  it("refuses while a campaign exists, without touching Twilio", async () => {
    await startCampaign(deps);
    twilio.calls = [];
    await expect(startCampaign(deps)).rejects.toThrow(/already/);
    expect(twilio.calls).toEqual([]);
    expect(twilio.owned.size).toBe(1);
  });

  it("refuses when this month's spend has reached the budget", async () => {
    appendSpend(deps.spendPath, {
      at: "2026-10-01T01:00:00Z",
      campaign: "x",
      callTag: "t",
      minutes: 10,
      usd: 50
    });
    await expect(startCampaign(deps)).rejects.toThrow(/budget/);
    expect(twilio.calls).toEqual([]);
    expect(existsSync(deps.statePath)).toBe(false);
  });

  it("last month's spend does not count against the budget", async () => {
    appendSpend(deps.spendPath, {
      at: "2026-09-30T23:00:00Z",
      campaign: "x",
      callTag: "t",
      minutes: 10,
      usd: 500
    });
    await expect(startCampaign(deps)).resolves.toMatchObject({ status: "active" });
  });

  it("refuses on a Trial account, buying nothing and leaving no state", async () => {
    twilio.type = "Trial";
    await expect(startCampaign(deps)).rejects.toThrow(/Trial/);
    expect(twilio.owned.size).toBe(0);
    expect(existsSync(deps.statePath)).toBe(false);
    expect(allowlist()).toBe(ALLOWLIST);
  });

  it("a crash after pending: stop finds the number by friendlyName and releases it", async () => {
    // Simulate a process that died mid-buy: pending state on disk, number owned.
    await twilio.buyLocal({ voiceUrl: deps.voiceUrl, friendlyName: CAMPAIGN_FRIENDLY_NAME });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "cfg"), { recursive: true });
    writeFileSync(
      deps.statePath,
      JSON.stringify({ id: "c", status: "pending", startedAt: now.toISOString(), budgetUsd: 50 })
    );
    const out = await stopCampaign(deps);
    expect(out.released).toEqual(["PN1"]);
    expect(twilio.owned.size).toBe(0);
    expect(existsSync(deps.statePath)).toBe(false);
    expect(allowlist()).toBe(ALLOWLIST);
  });

  it("buyLocal throws after the purchase landed: start sweeps, releases, clears pending, rethrows", async () => {
    twilio.throwAfterBuy = true;
    await expect(startCampaign(deps)).rejects.toThrow("socket hang up");
    expect(twilio.calls).toContain(`find ${CAMPAIGN_FRIENDLY_NAME}`);
    expect(twilio.calls).toContain("release PN1");
    expect(twilio.owned.size).toBe(0);
    expect(existsSync(deps.statePath)).toBe(false);
    expect(simCalls).toEqual([]);
    expect(allowlist()).toBe(ALLOWLIST);
  });

  it("if that sweep itself fails, the pending state is kept so stop can retry", async () => {
    twilio.throwAfterBuy = true;
    twilio.releaseFails.add("PN1");
    await expect(startCampaign(deps)).rejects.toThrow(/stop/);
    expect(readState()).toMatchObject({ status: "pending" });
    twilio.releaseFails.clear();
    const out = await stopCampaign(deps);
    expect(out.released).toEqual(["PN1"]);
    expect(existsSync(deps.statePath)).toBe(false);
  });

  it("a startSim failure rolls the campaign back", async () => {
    deps.startSim = () => Promise.reject(new Error("port in use"));
    await expect(startCampaign(deps)).rejects.toThrow("port in use");
    expect(twilio.owned.size).toBe(0);
    expect(existsSync(deps.statePath)).toBe(false);
    expect(allowlist()).toBe(ALLOWLIST);
  });

  it("stop also sweeps by friendlyName, deduping against the stored SID", async () => {
    await startCampaign(deps);
    // A stray from an earlier, lost purchase.
    await twilio.buyLocal({ voiceUrl: deps.voiceUrl, friendlyName: CAMPAIGN_FRIENDLY_NAME });
    // Something unrelated on the account must be left alone.
    await twilio.buyLocal({ voiceUrl: deps.voiceUrl, friendlyName: "production" });
    twilio.calls = [];
    const out = await stopCampaign(deps);
    expect(out.released.sort()).toEqual(["PN1", "PN2"]);
    expect([...twilio.owned.keys()]).toEqual(["PN3"]);
    expect(twilio.calls.filter((c) => c === "release PN1")).toHaveLength(1);
  });

  it("stop twice: the second is a no-op", async () => {
    await startCampaign(deps);
    await stopCampaign(deps);
    twilio.calls = [];
    simCalls = [];
    const out = await stopCampaign(deps);
    expect(out).toEqual({ released: [], spentUsd: 0 });
    expect(twilio.calls.filter((c) => c.startsWith("release"))).toEqual([]);
    expect(simCalls).toEqual([]);
    expect(allowlist()).toBe(ALLOWLIST);
  });

  it("release 404 is treated as done", async () => {
    await startCampaign(deps);
    twilio.owned.clear(); // released out-of-band
    const out = await stopCampaign(deps);
    expect(out.released).toEqual([]);
    expect(existsSync(deps.statePath)).toBe(false);
    expect(allowlist()).toBe(ALLOWLIST);
  });

  it("a release failure keeps state and allowlist for a retry", async () => {
    await startCampaign(deps);
    twilio.releaseFails.add("PN1");
    await expect(stopCampaign(deps)).rejects.toThrow();
    expect(readState()).toMatchObject({ status: "active", sid: "PN1" });
    expect(allowlist()).toBe(ALLOWLIST + NUMBER + "\n");
    twilio.releaseFails.clear();
    expect((await stopCampaign(deps)).released).toEqual(["PN1"]);
  });

  it("a corrupt state file: stop still sweeps by FriendlyName first, then reports it", async () => {
    await startCampaign(deps);
    writeFileSync(deps.statePath, "{not json");
    twilio.calls = [];
    await expect(stopCampaign(deps)).rejects.toThrow(/unreadable.*released: \[PN1\]/s);
    expect(twilio.calls).toEqual([`find ${CAMPAIGN_FRIENDLY_NAME}`, "release PN1"]);
    expect(twilio.owned.size).toBe(0);
    // The file is kept for the operator to inspect.
    expect(readFileSync(deps.statePath, "utf8")).toBe("{not json");
  });

  it("records the release before editing the allowlist, so a failed edit never leaves it active", async () => {
    await startCampaign(deps);
    chmodSync(dir, 0o500); // the allowlist's directory: its atomic replace fails
    try {
      await expect(stopCampaign(deps)).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(twilio.owned.size).toBe(0);
    const s = readState();
    expect(s).toMatchObject({ status: "released", number: NUMBER });
    // No run can dial a released number.
    const { assertDialable } = await import("../src/runner.js");
    const { buildEnvelope, loadScenario } = await import("../src/scenario.js");
    const scenario = loadScenario(
      new URL("../scenarios/dental-reschedule.json", import.meta.url).pathname
    );
    const env = buildEnvelope(scenario, NUMBER, { name: "g", realtime: { provider: "gemini" } });
    const after = (await campaignStatus(deps)).state;
    expect(() => assertDialable(env, after)).toThrow(/dial-refused/);
    // A retry finishes the local cleanup.
    twilio.calls = [];
    const out = await stopCampaign(deps);
    expect(out.released).toEqual([]);
    expect(twilio.calls.filter((c) => c.startsWith("release"))).toEqual(["release PN1"]);
    expect(allowlist()).toBe(ALLOWLIST);
    expect(existsSync(deps.statePath)).toBe(false);
    expect(simCalls).toEqual(["start", "stop"]);
  });

  it("stopSim errors are ignored", async () => {
    deps.stopSim = () => Promise.reject(new Error("no such process"));
    await startCampaign(deps);
    await expect(stopCampaign(deps)).resolves.toMatchObject({ released: ["PN1"] });
    expect(existsSync(deps.statePath)).toBe(false);
  });
});

describe("allowlist editing", () => {
  it("is replaced atomically (temp file + rename), never rewritten in place, keeping its mode", async () => {
    // The daemon re-reads this file on every permits() call; an in-place
    // truncate-and-write could be observed empty and deny every number in it.
    chmodSync(deps.allowlistPath, 0o644);
    const ino0 = statSync(deps.allowlistPath).ino;
    await startCampaign(deps);
    const ino1 = statSync(deps.allowlistPath).ino;
    expect(ino1).not.toBe(ino0);
    expect(statSync(deps.allowlistPath).mode & 0o777).toBe(0o644);
    await stopCampaign(deps);
    expect(statSync(deps.allowlistPath).ino).not.toBe(ino1);
    expect(statSync(deps.allowlistPath).mode & 0o777).toBe(0o644);
    expect(allowlist()).toBe(ALLOWLIST);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("edits through a symlink, leaving the link in place", async () => {
    const real = join(dir, "real-callable.txt");
    writeFileSync(real, ALLOWLIST);
    deps.allowlistPath = join(dir, "link.txt");
    symlinkSync(real, deps.allowlistPath);
    await startCampaign(deps);
    expect(lstatSync(deps.allowlistPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(ALLOWLIST + NUMBER + "\n");
    await stopCampaign(deps);
    expect(lstatSync(deps.allowlistPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(ALLOWLIST);
  });

  it("restores a file without a trailing newline exactly", async () => {
    const original = "# list\r\n+15555550100\r\n+15555550101";
    writeFileSync(deps.allowlistPath, original);
    await startCampaign(deps);
    expect(allowlist()).toBe(original + "\n" + NUMBER);
    await stopCampaign(deps);
    expect(allowlist()).toBe(original);
  });

  it("restores an empty file exactly", async () => {
    writeFileSync(deps.allowlistPath, "");
    await startCampaign(deps);
    await stopCampaign(deps);
    expect(allowlist()).toBe("");
  });

  it("creates a missing allowlist file (mode 600)", async () => {
    deps.allowlistPath = join(dir, "cfg2", "callable.txt");
    await startCampaign(deps);
    expect(allowlist()).toBe(NUMBER + "\n");
    expect(statSync(deps.allowlistPath).mode & 0o777).toBe(0o600);
    await stopCampaign(deps);
    expect(allowlist()).toBe("");
  });

  it("an operator's own line for the same number survives stop", async () => {
    for (const original of [`# mine\n${NUMBER}\n`, `# mine\n${NUMBER}  # operator added this\n`]) {
      writeFileSync(deps.allowlistPath, original);
      await startCampaign(deps);
      await stopCampaign(deps);
      expect(allowlist()).toBe(original);
    }
  });
});

describe("campaignStatus", () => {
  it("with no campaign: spend and remaining budget only", async () => {
    appendSpend(deps.spendPath, {
      at: "2026-10-01T01:00:00Z",
      campaign: "x",
      callTag: "t",
      minutes: 1,
      usd: 12.5
    });
    expect(await campaignStatus(deps)).toEqual({ monthSpendUsd: 12.5, remainingUsd: 37.5 });
  });

  it("with an active campaign: state and age", async () => {
    const state = await startCampaign(deps);
    now = new Date("2026-10-02T18:00:00Z");
    const s = await campaignStatus(deps);
    expect(s.state).toEqual(state);
    expect(s.ageHours).toBeCloseTo(30, 9);
    expect(s.monthSpendUsd).toBeCloseTo(NUMBER_MONTHLY_USD, 9);
    expect(s.remainingUsd).toBeCloseTo(50 - NUMBER_MONTHLY_USD, 9);
  });

  it("remaining never goes negative", async () => {
    appendSpend(deps.spendPath, {
      at: "2026-10-01T01:00:00Z",
      campaign: "x",
      callTag: "t",
      minutes: 1,
      usd: 60
    });
    expect((await campaignStatus(deps)).remainingUsd).toBe(0);
  });
});
