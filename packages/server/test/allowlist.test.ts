import { describe, expect, it } from "vitest";
import { createHostAllowlist, createNumberAllowlist } from "../src/allowlist.js";

describe("createNumberAllowlist", () => {
  it("permits a listed number (normalized)", () => {
    const al = createNumberAllowlist(["+14155550002"]);
    expect(al.permits("(415) 555-0002")).toBe(true);
  });
  it("denies an unlisted number (fail closed)", () => {
    const al = createNumberAllowlist(["+14155550002"]);
    expect(al.permits("+19998887777")).toBe(false);
  });
  it("empty allowlist denies everything (fail closed)", () => {
    expect(createNumberAllowlist([]).permits("+14155550002")).toBe(false);
  });
});

describe("createHostAllowlist", () => {
  it("permits a listed host and denies others", () => {
    const al = createHostAllowlist(["voice.example.com"]);
    expect(al.permits("voice.example.com")).toBe(true);
    expect(al.permits("attacker.example.com")).toBe(false);
  });
});
