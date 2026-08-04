import { describe, expect, it } from "vitest";
import { OPENING_TRIGGER, renderSystemInstruction, type Brief } from "@parley/core";
import { composePolicy, representedCall } from "@parley/policy";
import { buildPayloadPreview, formatPayloadPreview } from "../src/payload-preview.js";

const policy = representedCall({ principalName: "Alex Rivera" });

const brief: Brief = {
  to: "+14085559999",
  persona: "You are Ada, an assistant calling on behalf of Alex Rivera.",
  objective: "Schedule a plumbing appointment for a leaking kitchen faucet.",
  facts: ["Alex Rivera is available Tuesday or Wednesday afternoon."]
};

describe("buildPayloadPreview", () => {
  it("renders systemInstruction from renderSystemInstruction + composePolicy and drops the recipient field", () => {
    const preview = buildPayloadPreview(brief, policy);
    expect(preview).toEqual({
      systemInstruction: renderSystemInstruction({
        persona: brief.persona,
        objective: brief.objective,
        facts: brief.facts,
        guardrails: composePolicy(policy)
      }),
      openingTrigger: OPENING_TRIGGER
    });
    expect(preview.systemInstruction).toContain("personal assistant");
    expect(preview).not.toHaveProperty("recipient");
  });
});

describe("formatPayloadPreview", () => {
  it("renders a human-readable preview including systemInstruction and trigger, with no recipient line", () => {
    const preview = buildPayloadPreview(brief, policy);
    const formatted = formatPayloadPreview(preview);
    expect(formatted).toContain(preview.systemInstruction);
    expect(formatted).toContain(`openingTrigger: "${OPENING_TRIGGER}"`);
    expect(formatted).not.toContain("recipient:");
  });
});
