import { describe, expect, it } from "vitest";
import { loadBrief } from "../src/cli.js";

const bare = { to: "+15555550187", persona: "I am Ada.", objective: "Confirm.", facts: ["x"] };
const envelope = { version: 1, brief: bare, policy: {} };

describe("loadBrief", () => {
  it("returns a bare Brief as-is", () => {
    expect(loadBrief("p", () => JSON.stringify(bare))).toEqual(bare);
  });

  it("unwraps a full call envelope ({version, brief, policy}) to its Brief", () => {
    expect(loadBrief("p", () => JSON.stringify(envelope))).toEqual(bare);
  });
});
