import { describe, expect, it, vi } from "vitest";
import {
  OPENING_TRIGGER,
  defaultTimeZone,
  renderSystemInstruction,
  type Brief
} from "@parley/core";
import { composePolicy, representedCall } from "@parley/policy";
import { buildPayloadPreview, formatPayloadPreview } from "../src/payload-preview.js";

const policy = representedCall({ principalName: "Alex Rivera" });

const brief: Brief = {
  to: "+14155550123",
  persona: "You are Ada, an assistant calling on behalf of Alex Rivera.",
  objective: "Schedule a plumbing appointment for a leaking kitchen faucet.",
  facts: ["Alex Rivera is available Tuesday or Wednesday afternoon."]
};

describe("buildPayloadPreview", () => {
  it("renders systemInstruction from renderSystemInstruction + composePolicy and drops the recipient field", () => {
    const today = { now: new Date("2026-09-30T19:00:00Z"), timeZone: "America/Los_Angeles" };
    const preview = buildPayloadPreview(brief, policy, undefined, today);
    expect(preview).toEqual({
      systemInstruction: renderSystemInstruction({
        persona: brief.persona,
        objective: brief.objective,
        facts: brief.facts,
        guardrails: composePolicy(policy),
        today
      }),
      openingTrigger: OPENING_TRIGGER
    });
    expect(preview.systemInstruction).toContain("personal assistant");
    expect(preview).not.toHaveProperty("recipient");
    expect(preview).not.toHaveProperty("meetingBrief");
  });

  it("shows the date sentence for the current date by default", () => {
    // The default reads the clock, so the clock is pinned — a test that read
    // the real one could straddle midnight between its two reads.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-30T19:00:00Z"));
      const preview = buildPayloadPreview(brief, policy);
      const iso = new Intl.DateTimeFormat("en-CA", {
        dateStyle: "short",
        timeZone: defaultTimeZone()
      }).format(new Date("2026-09-30T19:00:00Z"));
      expect(preview.systemInstruction).toContain(`Today is`);
      expect(preview.systemInstruction).toContain(`${iso} (${defaultTimeZone()})`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries a supplied meetingBrief on the returned preview WITHOUT changing systemInstruction", () => {
    const meetingBrief = {
      title: "Roadmap Sync",
      topic: "Q4 scope.",
      role: "product lead",
      track: ["engineering"]
    };
    const plain = buildPayloadPreview(brief, policy);
    const withBrief = buildPayloadPreview(brief, policy, meetingBrief);

    expect(withBrief.meetingBrief).toEqual(meetingBrief);
    // The whole point: a meeting brief is for the downstream readout, never
    // for the model — passing it must not alter one character of the call
    // payload composed from Brief + CallPolicy.
    expect(withBrief.systemInstruction).toBe(plain.systemInstruction);
    expect(withBrief.openingTrigger).toBe(plain.openingTrigger);
  });
});

describe("formatPayloadPreview", () => {
  it("renders a human-readable preview including systemInstruction and trigger, with no recipient line", () => {
    const preview = buildPayloadPreview(brief, policy);
    const formatted = formatPayloadPreview(preview);
    expect(formatted).toContain(preview.systemInstruction);
    expect(formatted).toContain(`openingTrigger: "${OPENING_TRIGGER}"`);
    expect(formatted).not.toContain("recipient:");
    expect(formatted).not.toContain("meetingBrief");
  });

  it("shows the meeting brief's fields when the preview carries one, marked audit-only", () => {
    const meetingBrief = {
      title: "Roadmap Sync",
      topic: "Q4 scope.",
      role: "product lead",
      track: ["engineering"]
    };
    const preview = buildPayloadPreview(brief, policy, meetingBrief);
    const formatted = formatPayloadPreview(preview);
    expect(formatted).toContain("meetingBrief (audit-only — never sent to the model):");
    expect(formatted).toContain("title: Roadmap Sync");
    expect(formatted).toContain("topic: Q4 scope.");
    expect(formatted).toContain("role: product lead");
    expect(formatted).toContain("track: engineering");
  });

  it("shows only the fields actually supplied — partial brief, partial output", () => {
    const preview = buildPayloadPreview(brief, policy, { title: "Roadmap Sync" });
    const formatted = formatPayloadPreview(preview);
    expect(formatted).toContain("title: Roadmap Sync");
    expect(formatted).not.toContain("topic:");
    expect(formatted).not.toContain("role:");
    expect(formatted).not.toContain("track:");
  });
});
