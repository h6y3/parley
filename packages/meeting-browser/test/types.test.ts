import { describe, expect, it } from "vitest";
import { JOIN_OUTCOMES as CORE_JOIN_OUTCOMES } from "@parley/core";
import { DEFAULT_MAX_MEETING_SECONDS, JOIN_OUTCOMES } from "../src/types.js";

describe("join outcomes", () => {
  /** What this package must guarantee is that it keeps NO list of its own.
   * The members themselves are asserted in `@parley/core`'s own suite, which
   * is where the list is declared — repeating the literals here would
   * put a third copy of them in the repository, in the file whose job is to
   * prove there are not two.
   *
   * Reference identity, not deep equality: a copied array with the same
   * contents passes `toEqual` and is exactly the defect this asserts against. */
  it("re-exports core's array rather than keeping a copy of it", () => {
    expect(JOIN_OUTCOMES).toBe(CORE_JOIN_OUTCOMES);
  });

  it("ceilings a meeting at two hours by default", () => {
    expect(DEFAULT_MAX_MEETING_SECONDS).toBe(7200);
  });
});
