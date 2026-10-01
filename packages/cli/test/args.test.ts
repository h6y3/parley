import { describe, expect, it } from "vitest";
import { parseParleyArgs } from "../src/args.js";

describe("parseParleyArgs", () => {
  it("parses `call` with --to and --brief", () => {
    const a = parseParleyArgs(["call", "--to", "+14155550002", "--brief", "b.json"]);
    expect(a).toMatchObject({ command: "call", to: "+14155550002", briefPath: "b.json" });
  });
  it("parses `serve`", () => {
    expect(parseParleyArgs(["serve"]).command).toBe("serve");
  });
  it("defaults `serve` to the gemini realtime provider", () => {
    // A spike that silently becomes production is not a spike — this default
    // must never change without a deliberate edit here.
    expect(parseParleyArgs(["serve"]).realtimeProvider).toBe("gemini");
  });
  it("accepts `serve --realtime-provider deepgram` as the default provider", () => {
    expect(parseParleyArgs(["serve", "--realtime-provider", "deepgram"]).realtimeProvider).toBe(
      "deepgram"
    );
  });
  it("rejects an unrecognized --realtime-provider value", () => {
    expect(() => parseParleyArgs(["serve", "--realtime-provider", "bogus"])).toThrow(
      /--realtime-provider must be "gemini" or "deepgram"/
    );
  });
  it("captures the remainder after `harness` verbatim for delegation", () => {
    const a = parseParleyArgs(["harness", "reliability", "--scenario", "topic_change"]);
    expect(a.command).toBe("harness");
    expect(a.rest).toEqual(["reliability", "--scenario", "topic_change"]);
  });
  it("captures the remainder after `meeting` verbatim, the same way `harness` does", () => {
    // The meeting transport owns its own flags and its own usage text;
    // restating them here would give them two places to drift apart.
    const a = parseParleyArgs([
      "meeting",
      "join",
      "https://meet.example.test/abc-defg-hij",
      "--display-name",
      "Notetaker (recording)"
    ]);
    expect(a.command).toBe("meeting");
    expect(a.rest).toEqual([
      "join",
      "https://meet.example.test/abc-defg-hij",
      "--display-name",
      "Notetaker (recording)"
    ]);
  });
  it("parses `doctor`", () => {
    expect(parseParleyArgs(["doctor"]).command).toBe("doctor");
  });
  it("defaults to help", () => {
    expect(parseParleyArgs([]).command).toBe("help");
  });
});
