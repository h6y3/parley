import { describe, expect, it, vi } from "vitest";
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

describe("createNumberAllowlist with a file", () => {
  const reader = (text: string) => () => text;
  it("permits a number held only in the file", () => {
    const al = createNumberAllowlist([], { file: "/x", readFile: reader("+15555550142\n") });
    expect(al.permits("+15555550142")).toBe(true);
  });
  it("still permits static numbers and denies others", () => {
    const al = createNumberAllowlist(["+14155550002"], { file: "/x", readFile: reader("# c\n\n") });
    expect(al.permits("+14155550002")).toBe(true);
    expect(al.permits("+15555550142")).toBe(false);
  });
  it("re-reads the file on every call", () => {
    let text = "";
    const al = createNumberAllowlist([], { file: "/x", readFile: () => text });
    expect(al.permits("+15555550142")).toBe(false);
    text = "+15555550142";
    expect(al.permits("+15555550142")).toBe(true);
    text = "";
    expect(al.permits("+15555550142")).toBe(false);
  });
  it("a missing file yields static numbers only, never throws, warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const al = createNumberAllowlist(["+14155550002"], {
      file: "/missing",
      readFile: () => {
        throw new Error("ENOENT");
      }
    });
    expect(al.permits("+14155550002")).toBe(true);
    expect(al.permits("+15555550142")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
  it("ignores garbage lines and inline comments", () => {
    const al = createNumberAllowlist([], {
      file: "/x",
      readFile: reader("garbage\nnot a number\n+15555550142 # Jordan\n")
    });
    expect(al.permits("+15555550142")).toBe(true);
    expect(al.permits("garbage")).toBe(false);
    expect(al.permits("")).toBe(false);
  });
});

describe("createHostAllowlist", () => {
  it("permits a listed host and denies others", () => {
    const al = createHostAllowlist(["voice.example.com"]);
    expect(al.permits("voice.example.com")).toBe(true);
    expect(al.permits("attacker.example.com")).toBe(false);
  });
});
