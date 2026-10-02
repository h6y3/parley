import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseParleyArgs } from "../src/args.js";
import { main } from "../src/cli.js";

const PHONE_TEST = join(import.meta.dirname, "..", "..", "phone-test");
const SCENARIO = join(PHONE_TEST, "scenarios", "dental-reschedule.json");
const CONFIGS = join(PHONE_TEST, "configs", "default.json");

describe("parley sim args", () => {
  it("defaults the callee to Gemini's Puck on port 3340", () => {
    expect(parseParleyArgs(["sim", "serve"]).sim).toEqual({
      command: "serve",
      calleeProvider: "gemini",
      calleeVoice: "Puck",
      port: 3340
    });
  });
  it("gives a Deepgram callee flux-kit-en, never the agent's flux-kelsey-en", () => {
    expect(parseParleyArgs(["sim", "serve", "--callee-provider", "deepgram"]).sim).toMatchObject({
      calleeProvider: "deepgram",
      calleeVoice: "flux-kit-en"
    });
  });
  it("takes a voice, a port and an out dir", () => {
    const a = parseParleyArgs([
      "sim",
      "serve",
      "--callee-voice",
      "Charon",
      "--port",
      "4000",
      "--out",
      "caps"
    ]);
    expect(a.sim).toMatchObject({ calleeVoice: "Charon", port: 4000, outDir: "caps" });
  });
  it("takes the daemon's caller number, and refuses one that is not E.164", () => {
    expect(parseParleyArgs(["sim", "serve", "--caller", "+15555550142"]).sim).toMatchObject({
      caller: "+15555550142"
    });
    expect(() => parseParleyArgs(["sim", "serve", "--caller", "5555550142"])).toThrow(
      /--caller must be an E\.164 number/
    );
  });
  it("names an unknown flag", () => {
    expect(() => parseParleyArgs(["sim", "serve", "--calee-provider", "gemini"])).toThrow(
      /unknown flag "--calee-provider"/
    );
  });
  it("refuses an unknown provider and an unknown subcommand", () => {
    expect(() => parseParleyArgs(["sim", "serve", "--callee-provider", "openai"])).toThrow(
      /--callee-provider must be "gemini" or "deepgram"/
    );
    expect(() => parseParleyArgs(["sim", "start"])).toThrow(/unknown command "start"/);
  });
});

describe("parley campaign args", () => {
  it("parses run with several scenarios", () => {
    const a = parseParleyArgs([
      "campaign",
      "run",
      "--scenarios",
      "a.json",
      "b.json",
      "--configs",
      "c.json",
      "--calls-per-cell",
      "3",
      "--judge",
      "--out",
      "o"
    ]);
    expect(a.command).toBe("campaign");
    expect(a.campaign).toEqual({
      command: "run",
      scenarios: ["a.json", "b.json"],
      configs: "c.json",
      callsPerCell: 3,
      judge: true,
      includeDiagnostic: false,
      outDir: "o"
    });
  });
  it("keeps diagnostic personas out of a run unless --include-diagnostic is given", () => {
    const base = ["campaign", "run", "--scenarios", "a.json", "--configs", "c.json"];
    const run = (...more: string[]) =>
      parseParleyArgs([...base, "--calls-per-cell", "1", ...more]).campaign;
    expect(run()).toMatchObject({ includeDiagnostic: false });
    expect(run("--include-diagnostic")).toMatchObject({ includeDiagnostic: true });
  });
  it("defaults start's budget to 50", () => {
    expect(parseParleyArgs(["campaign", "start"]).campaign).toEqual({
      command: "start",
      budgetUsd: 50
    });
    expect(parseParleyArgs(["campaign", "start", "--budget", "20"]).campaign).toMatchObject({
      budgetUsd: 20
    });
  });
  it("parses stop and status", () => {
    expect(parseParleyArgs(["campaign", "stop"]).campaign).toEqual({ command: "stop" });
    expect(parseParleyArgs(["campaign", "status", "--state-dir", "s"]).campaign).toEqual({
      command: "status",
      stateDir: "s"
    });
  });
  it("names unknown flags, per subcommand", () => {
    expect(() => parseParleyArgs(["campaign", "run", "--bogus"])).toThrow(/unknown flag "--bogus"/);
    expect(() => parseParleyArgs(["campaign", "start", "--judge"])).toThrow(
      /unknown flag "--judge"/
    );
    expect(() => parseParleyArgs(["campaign", "stop", "--budget", "5"])).toThrow(
      /unknown flag "--budget"/
    );
  });
  it("names missing required flags and bad values", () => {
    expect(() => parseParleyArgs(["campaign", "run", "--configs", "c.json"])).toThrow(
      /missing --scenarios, --calls-per-cell/
    );
    expect(() =>
      parseParleyArgs([
        "campaign",
        "run",
        "--scenarios",
        "a.json",
        "--configs",
        "c.json",
        "--calls-per-cell",
        "0"
      ])
    ).toThrow(/--calls-per-cell must be a positive integer/);
    expect(() => parseParleyArgs(["campaign", "start", "--budget", "lots"])).toThrow(
      /--budget must be a positive number/
    );
    expect(() => parseParleyArgs(["campaign", "run", "--configs"])).toThrow(
      /--configs needs a value/
    );
    expect(() => parseParleyArgs(["campaign", "start", "stray"])).toThrow(
      /unexpected argument "stray"/
    );
    expect(() => parseParleyArgs(["campaign", "launch"])).toThrow(/unknown command "launch"/);
  });
});

describe("parley campaign environment", () => {
  const stateDir = () => mkdtempSync(join(tmpdir(), "campaign-state-"));

  it("run names every missing variable and prints no value", async () => {
    const env = { TWILIO_AUTH_TOKEN: "secret-value-xyz" };
    const run = main(
      [
        "campaign",
        "run",
        "--scenarios",
        SCENARIO,
        "--configs",
        CONFIGS,
        "--calls-per-cell",
        "1",
        "--state-dir",
        stateDir()
      ],
      { env, phoneTest: { log: () => {} } }
    );
    await expect(run).rejects.toThrow(
      /PARLEY_DAEMON_URL, PARLEY_CALL_TOKEN, PARLEY_PUBLIC_HOST, TWILIO_FROM_NUMBER/
    );
    await expect(run).rejects.not.toThrow(/secret-value-xyz/);
    await expect(run).rejects.toThrow(/--env-file/);
  });

  it("run names the callee keys its config groups need", async () => {
    const env = {
      PARLEY_DAEMON_URL: "http://127.0.0.1:3334",
      PARLEY_CALL_TOKEN: "t",
      PARLEY_PUBLIC_HOST: "voice.example.com",
      TWILIO_AUTH_TOKEN: "t",
      TWILIO_FROM_NUMBER: "+15555550142"
    };
    const run = main(
      [
        "campaign",
        "run",
        "--scenarios",
        SCENARIO,
        "--configs",
        CONFIGS,
        "--calls-per-cell",
        "1",
        "--judge",
        "--state-dir",
        stateDir()
      ],
      { env, phoneTest: { log: () => {} } }
    );
    // Gemini agents get a Deepgram callee, Deepgram agents a Gemini one; the
    // judge needs Gemini too.
    await expect(run).rejects.toThrow(/DEEPGRAM_API_KEY, GEMINI_API_KEY/);
  });

  it("run requires the call-records path, defaulting to the daemon's", async () => {
    const env = {
      PARLEY_DAEMON_URL: "http://127.0.0.1:3334",
      PARLEY_CALL_TOKEN: "t",
      PARLEY_PUBLIC_HOST: "voice.example.com",
      TWILIO_AUTH_TOKEN: "t",
      TWILIO_FROM_NUMBER: "+15555550142",
      GEMINI_API_KEY: "k",
      DEEPGRAM_API_KEY: "k"
    };
    const argv = [
      "campaign",
      "run",
      "--scenarios",
      SCENARIO,
      "--configs",
      CONFIGS,
      "--calls-per-cell",
      "1",
      "--state-dir",
      stateDir()
    ];
    await expect(main(argv, { env, phoneTest: { log: () => {} } })).rejects.toThrow(
      /PARLEY_CALL_RECORDS/
    );
    // With the daemon's own variable set, it gets past the environment and
    // stops at the missing campaign.
    await expect(
      main(argv, {
        env: { ...env, PARLEY_CALL_RECORDS_PATH: join(stateDir(), "records.jsonl") },
        phoneTest: { log: () => {} }
      })
    ).rejects.toThrow(/no active test campaign/);
  });

  it("start and stop name what they need", async () => {
    await expect(
      main(["campaign", "start", "--state-dir", stateDir()], { env: {}, phoneTest: {} })
    ).rejects.toThrow(
      /TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, PARLEY_PUBLIC_HOST, PARLEY_CALLABLE_NUMBERS_FILE, GEMINI_API_KEY/
    );
    await expect(
      main(["campaign", "stop", "--state-dir", stateDir()], { env: {}, phoneTest: {} })
    ).rejects.toThrow(/TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PARLEY_CALLABLE_NUMBERS_FILE/);
  });

  it("sim serve names the callee's key", async () => {
    await expect(
      main(["sim", "serve", "--callee-provider", "deepgram"], {
        env: { PARLEY_PUBLIC_HOST: "voice.example.com", TWILIO_AUTH_TOKEN: "t" },
        phoneTest: {}
      })
    ).rejects.toThrow(/DEEPGRAM_API_KEY/);
  });

  it("sim serve needs the daemon's caller number, from --caller or TWILIO_FROM_NUMBER", async () => {
    const env = {
      PARLEY_PUBLIC_HOST: "voice.example.com",
      TWILIO_AUTH_TOKEN: "t",
      GEMINI_API_KEY: "k"
    };
    await expect(main(["sim", "serve"], { env, phoneTest: {} })).rejects.toThrow(
      /TWILIO_FROM_NUMBER/
    );
  });

  it("status needs nothing and reports an empty month", async () => {
    const lines: string[] = [];
    await main(["campaign", "status", "--state-dir", stateDir()], {
      env: {},
      phoneTest: { log: (l) => lines.push(l) }
    });
    expect(lines).toEqual(["campaign: none", "month spend: $0.00 of $50.00", "remaining: $50.00"]);
  });
});
