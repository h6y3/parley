import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import type { TranscriptionSession } from "../src/transcription.js";

describe("TranscriptionSession contract", () => {
  it("has exactly four members, checked by the COMPILER in both directions", () => {
    // A runtime array literal compared to itself proves nothing, and would not
    // fail in the direction that matters: someone ADDING an outbound method.
    // This is a type-level exhaustiveness check — it stops compiling if a
    // member is added OR removed, so `pnpm run typecheck` is the gate and this
    // assertion only documents that the check is wired.
    type Expected = "ready" | "sendAudio" | "flush" | "close";
    type Exhaustive = keyof TranscriptionSession extends Expected
      ? Expected extends keyof TranscriptionSession
        ? true
        : never
      : never;
    const wired: Exhaustive = true;
    expect(wired).toBe(true);
  });

  it("is exported from the package root", () => {
    expect(Object.keys(core)).toContain("TRANSCRIPTION_PLANE_HAS_NO_OUTBOUND");
  });
});
