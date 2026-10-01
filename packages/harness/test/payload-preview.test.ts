import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEETING_OPENING_TRIGGER,
  OPENING_TRIGGER,
  defaultTimeZone,
  renderSystemInstruction,
  type Brief
} from "@parley/core";
import { composePolicy, representedCall } from "@parley/policy";
import { harnessTimeZone } from "../src/time-zone.js";
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

describe("PARLEY_TIMEZONE", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("tells the model today in the zone the daemon would use", () => {
    // 2026-09-30 22:00 in Los Angeles is already 2026-10-01 in Tokyo.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T05:00:00Z"));
    vi.stubEnv("PARLEY_TIMEZONE", "Asia/Tokyo");
    expect(buildPayloadPreview(brief, policy).systemInstruction).toContain(
      "Today is Thursday, 2026-10-01 (Asia/Tokyo)"
    );
    vi.stubEnv("PARLEY_TIMEZONE", "America/Los_Angeles");
    expect(buildPayloadPreview(brief, policy).systemInstruction).toContain(
      "Today is Wednesday, 2026-09-30 (America/Los_Angeles)"
    );
  });

  it("falls back to the host zone when unset, and rejects an invalid name as the daemon does", () => {
    vi.stubEnv("PARLEY_TIMEZONE", "");
    expect(harnessTimeZone()).toBe(defaultTimeZone());
    vi.stubEnv("PARLEY_TIMEZONE", "Not/AZone");
    expect(() => harnessTimeZone()).toThrow("PARLEY_TIMEZONE");
  });
});

describe("buildPayloadPreview opening shape", () => {
  const today = { now: new Date("2026-09-30T19:00:00Z"), timeZone: "America/Los_Angeles" };
  const gemini = { twoParty: "prompt", meeting: "turn" } as const;

  it("puts a two-party prompt opening inside the systemInstruction and sends nothing at connect", () => {
    const plain = buildPayloadPreview(brief, policy, undefined, today);
    const preview = buildPayloadPreview(brief, policy, undefined, today, {
      openingDelivery: gemini
    });
    expect(preview.openingTrigger).toBeUndefined();
    expect(preview.systemInstruction).toBe(`${plain.systemInstruction}\n\n${OPENING_TRIGGER}`);
    expect(formatPayloadPreview(preview)).toContain("openingTrigger: (none");
  });

  it("keeps a Gemini meeting's opening as a separate turn", () => {
    const plain = buildPayloadPreview(brief, policy, undefined, today, { isMeeting: true });
    const preview = buildPayloadPreview(brief, policy, undefined, today, {
      openingDelivery: gemini,
      isMeeting: true
    });
    expect(preview.openingTrigger).toBe(MEETING_OPENING_TRIGGER);
    expect(preview.systemInstruction).toBe(plain.systemInstruction);
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
