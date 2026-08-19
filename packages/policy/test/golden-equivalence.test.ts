import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderSystemInstruction } from "@parley/core";
import { composePolicy, principalCall, representedCall, transactionalCall } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "fixtures", "golden.json"), "utf8")) as Record<
  string,
  string
>;

const persona = "You are Ada, a calm, warm assistant.";
const objective = "Confirm a dinner reservation for four at 7pm on Friday.";
const facts = ["The reservation is under Alex Rivera.", "Party of four.", "7pm Friday."];

function render(policy: Parameters<typeof composePolicy>[0]): string {
  return renderSystemInstruction({ persona, objective, facts, guardrails: composePolicy(policy) });
}

/**
 * WHAT THIS PINS, AND WHAT IT USED TO PIN.
 *
 * The fixture was captured before @parley/policy was extracted from core, and
 * this block asserted the extraction reproduced the old systemInstruction
 * byte-for-byte. It did, and that claim has been verified for as long as it was
 * the question being asked.
 *
 * On 2026-08-19 it stopped being the question. A live call answered "where are
 * you guys based?" with a street address that appears nowhere in the brief, and
 * the fix widened DEFERRAL_CORE — a rail every one of these four policies
 * carries. Keeping the old fixture would have meant either never improving the
 * prompt, or updating the bytes while the test name still claimed equivalence
 * with a version it no longer matched. The second is worse: a green test
 * asserting something untrue.
 *
 * So the fixture is regenerated and the claim is narrowed to the one still
 * true: THE COMPOSED PROMPT DOES NOT CHANGE BY ACCIDENT. A failure here means
 * some edit moved the prose every call receives. That is allowed — but it is
 * never incidental, and the fixture is not updated without reading the diff and
 * writing down why.
 *
 * The procedure when it fires: render the four cases, diff each against the
 * fixture, and confirm the change is the one you meant and nothing else. Only
 * then regenerate. Both times it has fired so far the diff was a single rail —
 * DEFERRAL_CORE widening, then WRAP_UP_RULE — and each time one of the four
 * policies was correctly untouched, which is the signal that the change landed
 * where it was aimed rather than everywhere.
 */
describe("the composed prompt does not change by accident", () => {
  it("principal", () => {
    expect(render(principalCall({ principalName: "Alex Rivera" }))).toBe(golden.principal);
  });
  it("represented (full: callback + authority + pronunciation)", () => {
    const policy = representedCall({
      principalName: "Alex Rivera",
      callbackNumber: "+15551234567",
      authorizedCommitments: ["A table for four at 7pm on Friday is fine to confirm."],
      pronunciation: ["Pronounce the last name Rivera as ree-VAIR-uh."]
    });
    expect(render(policy)).toBe(golden.represented_full);
  });
  it("represented (minimal)", () => {
    expect(render(representedCall({ principalName: "Alex Rivera" }))).toBe(
      golden.represented_minimal
    );
  });
  it("transactional (full: callback)", () => {
    expect(
      render(
        transactionalCall({
          principalName: "Alex Rivera",
          recipientName: "Bella Vista",
          callbackNumber: "+15551234567"
        })
      )
    ).toBe(golden.transactional_full);
  });
});
