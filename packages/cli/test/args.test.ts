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
  it("captures the remainder after `harness` verbatim for delegation", () => {
    const a = parseParleyArgs(["harness", "reliability", "--scenario", "topic_change"]);
    expect(a.command).toBe("harness");
    expect(a.rest).toEqual(["reliability", "--scenario", "topic_change"]);
  });
  it("parses `doctor`", () => {
    expect(parseParleyArgs(["doctor"]).command).toBe("doctor");
  });
  it("defaults to help", () => {
    expect(parseParleyArgs([]).command).toBe("help");
  });
});
