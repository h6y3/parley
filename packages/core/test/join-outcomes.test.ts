import { describe, expect, it } from "vitest";
import { JOIN_OUTCOMES } from "../src/meeting.js";

/** The list lives here, in the transport-agnostic core, because the two
 * packages that need it — the browser transport that produces the values and
 * the CLI's record schema that validates them — cannot import each other. The
 * assertions about WHAT the list contains therefore belong here too; the
 * transport's own suite asserts only that it re-exports this exact array
 * rather than keeping a copy. */
describe("join outcomes", () => {
  it("enumerates exactly the six outcomes the spec names", () => {
    expect([...JOIN_OUTCOMES]).toEqual([
      "admitted",
      "waiting_room_timeout",
      "denied",
      "not_started",
      "auth_required",
      "join_error"
    ]);
  });

  it("has no catch-all outcome", () => {
    // Outcomes are enumerated, never inferred. A generic "failed" would let a
    // caller stop distinguishing them, which is the defect that made a live
    // telephony failure undiagnosable.
    expect(JOIN_OUTCOMES).not.toContain("failed");
    expect(JOIN_OUTCOMES).not.toContain("error");
    expect(JOIN_OUTCOMES).not.toContain("unknown");
    expect(JOIN_OUTCOMES).not.toContain("other");
  });

  it("keeps a join that threw distinct from a join that timed out", () => {
    // The reason `join_error` was added rather than folded into
    // `waiting_room_timeout`. That one value meant three things at once — a
    // real lobby timeout, a successful join whose in-call anchors went
    // unrecognised, and a crash before any verdict existed — and a live
    // failure in any of the three could not be told from the other two.
    // Pinned as two distinct members rather than as prose, because the whole
    // point is that they are not the same value.
    expect(JOIN_OUTCOMES).toContain("join_error");
    expect(JOIN_OUTCOMES).toContain("waiting_room_timeout");
    expect(new Set(JOIN_OUTCOMES).size).toBe(JOIN_OUTCOMES.length);
  });
});
