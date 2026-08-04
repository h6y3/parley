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

describe("golden equivalence — new path reproduces old systemInstruction byte-for-byte", () => {
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
