import { describe, expect, it } from "vitest";
import { selectPageIndex } from "../scripts/capture-meet-dom.js";

const MEETING = "https://meet.google.com/abc-defg-hij";
const SIGNIN = "https://accounts.google.com/signin/v2/identifier";
const BLANK = "about:blank";

describe("selectPageIndex", () => {
  it("selects the only open page without needing a substring", () => {
    expect(selectPageIndex([MEETING])).toEqual({ ok: true, index: 0 });
  });

  it("fails when no page is open at all", () => {
    const result = selectPageIndex([]);
    expect(result.ok).toBe(false);
    expect(result).not.toBe(null);
    if (!result.ok) {
      expect(result.reason).toMatch(/no open page/);
    }
  });

  it("fails, listing every open URL, when more than one page is open and no substring is given", () => {
    // This is the exact shape of the 2026-08-22 incident: a leftover
    // sign-in tab alongside the real meeting tab, and nothing to say which
    // one is meant.
    const result = selectPageIndex([SIGNIN, MEETING]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(SIGNIN);
      expect(result.reason).toContain(MEETING);
    }
  });

  it("selects the one page whose URL contains the given substring", () => {
    expect(selectPageIndex([SIGNIN, MEETING], "abc-defg-hij")).toEqual({ ok: true, index: 1 });
  });

  it("fails when the substring matches zero open pages", () => {
    const result = selectPageIndex([SIGNIN, BLANK], "abc-defg-hij");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("abc-defg-hij");
      expect(result.reason).toContain(SIGNIN);
      expect(result.reason).toContain(BLANK);
    }
  });

  it("fails when the substring matches more than one open page", () => {
    const result = selectPageIndex(
      ["https://meet.google.com/abc-defg-hij", "https://meet.google.com/abc-defg-hij#confirm"],
      "abc-defg-hij"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/2 open pages/);
    }
  });

  it("still requires disambiguation with a substring that matches nothing among many pages", () => {
    const result = selectPageIndex([SIGNIN, BLANK, MEETING], "zzz-not-present");
    expect(result.ok).toBe(false);
  });
});
