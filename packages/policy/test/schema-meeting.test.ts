import { describe, expect, it } from "vitest";
import { callExecutionSchema } from "../src/schema.js";

const meeting = {
  consent: { phrase: "go ahead and take notes", timeoutSeconds: 180, onTimeout: "hangUp" as const }
};

describe("execution.meeting", () => {
  it("admits a four-hour ceiling when a meeting is declared", () => {
    const parsed = callExecutionSchema.safeParse({
      meeting,
      limits: { maxDurationSeconds: 14400 }
    });
    expect(parsed.success).toBe(true);
  });

  it("REFUSES a four-hour ceiling on an ordinary call", () => {
    const parsed = callExecutionSchema.safeParse({ limits: { maxDurationSeconds: 14400 } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toMatch(/1800/);
  });

  it("admits 40 presses for a meeting and refuses them for a call", () => {
    const ivr = { allowedDigits: "0123456789#*", onUnrecognized: "hangUp" as const };
    expect(
      callExecutionSchema.safeParse({ meeting, ivr: { ...ivr, maxPresses: 40 } }).success
    ).toBe(true);
    expect(callExecutionSchema.safeParse({ ivr: { ...ivr, maxPresses: 40 } }).success).toBe(false);
  });

  it("refuses a blank consent phrase — the gate would then match everything", () => {
    expect(
      callExecutionSchema.safeParse({
        meeting: { ...meeting, consent: { ...meeting.consent, phrase: "  " } }
      }).success
    ).toBe(false);
  });

  // The floor moved from four words to two: length was standing in for a
  // risk it did not actually guard (an accidental match), and a live call
  // found the cost — "go ahead" is the obvious human reply to a request, not
  // an accident. Ordering (`@parley/core`'s `findConsentMatch`) is what now
  // protects against a stray utterance, so a natural two-word reply is
  // allowed and only a single word is refused.
  it("refuses a single-word consent phrase", () => {
    expect(
      callExecutionSchema.safeParse({
        meeting: { ...meeting, consent: { ...meeting.consent, phrase: "sure" } }
      }).success
    ).toBe(false);
  });

  it("admits a two-word consent phrase", () => {
    expect(
      callExecutionSchema.safeParse({
        meeting: { ...meeting, consent: { ...meeting.consent, phrase: "go ahead" } }
      }).success
    ).toBe(true);
  });

  it("admits additionalPhrases alongside the primary phrase, each held to the same floor", () => {
    const parsed = callExecutionSchema.safeParse({
      meeting: {
        ...meeting,
        consent: { ...meeting.consent, additionalPhrases: ["sure thing", "sounds good"] }
      }
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a single-word entry inside additionalPhrases", () => {
    const parsed = callExecutionSchema.safeParse({
      meeting: {
        ...meeting,
        consent: { ...meeting.consent, additionalPhrases: ["sure thing", "yes"] }
      }
    });
    expect(parsed.success).toBe(false);
  });

  it("a single-phrase envelope with no additionalPhrases still parses exactly as before", () => {
    expect(callExecutionSchema.safeParse({ meeting }).success).toBe(true);
  });
});

describe("execution.meeting.brief", () => {
  it("admits all four fields", () => {
    const parsed = callExecutionSchema.safeParse({
      meeting: {
        ...meeting,
        brief: {
          title: "Roadmap Sync",
          topic: "Q4 scope review.",
          role: "product lead",
          track: ["engineering"]
        }
      }
    });
    expect(parsed.success).toBe(true);
  });

  it("a meeting with no brief at all still parses — the whole block is optional", () => {
    expect(callExecutionSchema.safeParse({ meeting }).success).toBe(true);
  });

  it("admits partial supply — a title with no topic/role/track", () => {
    const parsed = callExecutionSchema.safeParse({
      meeting: { ...meeting, brief: { title: "Roadmap Sync" } }
    });
    expect(parsed.success).toBe(true);
  });

  it("admits an empty brief object — every field inside is independently optional", () => {
    expect(callExecutionSchema.safeParse({ meeting: { ...meeting, brief: {} } }).success).toBe(
      true
    );
  });

  it("refuses an empty-string title — a caller with nothing to say should omit the field", () => {
    const parsed = callExecutionSchema.safeParse({
      meeting: { ...meeting, brief: { title: "" } }
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses an unknown key inside brief — .strict()", () => {
    const parsed = callExecutionSchema.safeParse({
      meeting: { ...meeting, brief: { title: "Roadmap Sync", summary: "not a real field" } }
    });
    expect(parsed.success).toBe(false);
  });

  // Guards against `brief` accidentally gaining a cross-plane pairing the way
  // `consent`'s `announce` almost did — it is pure metadata for a downstream
  // readout, so an ordinary (non-meeting) call must be entirely unaffected by
  // its existence.
  it("a non-meeting envelope parses exactly as before — brief lives only under meeting", () => {
    expect(callExecutionSchema.safeParse({}).success).toBe(true);
    expect(callExecutionSchema.safeParse({ limits: { maxDurationSeconds: 900 } }).success).toBe(
      true
    );
  });
});

// Call `CA0573ebc91a165c9c0230f8890915f87b` (2026-08-20): the declared phrase
// was "please do", and the room saying "please dont take notes" — a REFUSAL —
// still matched it, because "dont" starts with "do" and `findConsentMatch`
// (`@parley/core`) does plain substring matching. This is that hole closed at
// the same layer the two-word floor above already lives at.
describe("a phrase that collides with its own negation is refused", () => {
  it("refuses 'please do' — a substring of 'please dont'/'please don't'/'please do not'", () => {
    expect(
      callExecutionSchema.safeParse({
        meeting: { ...meeting, consent: { ...meeting.consent, phrase: "please do" } }
      }).success
    ).toBe(false);
  });

  it("refuses 'do proceed' — a substring of 'not do proceed'/'never do proceed'/'no do proceed'", () => {
    expect(
      callExecutionSchema.safeParse({
        meeting: { ...meeting, consent: { ...meeting.consent, phrase: "do proceed" } }
      }).success
    ).toBe(false);
  });

  it("refuses the same collision inside additionalPhrases, not just the primary phrase", () => {
    const parsed = callExecutionSchema.safeParse({
      meeting: {
        ...meeting,
        consent: { ...meeting.consent, additionalPhrases: ["sure thing", "please do"] }
      }
    });
    expect(parsed.success).toBe(false);
  });

  // The property that matters: a safe multi-word phrase — one that was never
  // built around "do" — is unaffected. "go ahead" is the exact phrase the
  // two-word floor above was lowered to keep admitting; this rule must not
  // re-break it.
  it("still admits safe multi-word phrases that have nothing to do with 'do'", () => {
    const safePhrases = ["go ahead", "go ahead and take notes", "sure thing", "sounds good to me"];
    const results = safePhrases.map(
      (phrase) =>
        callExecutionSchema.safeParse({
          meeting: { ...meeting, consent: { ...meeting.consent, phrase } }
        }).success
    );
    expect(results).toEqual(safePhrases.map(() => true));
  });

  // "do" in the middle of a phrase is not covered — see the doc on
  // `collidesWithOwnDoNegation` (`@parley/policy`'s `schema.ts`) for why no
  // version of this check could cover it without producing a different
  // phrase than the one actually configured. Documented here as the honest
  // boundary, not a gap this test is trying to hide.
  it("does not (and cannot) catch 'do' in the middle of a phrase", () => {
    expect(
      callExecutionSchema.safeParse({
        meeting: { ...meeting, consent: { ...meeting.consent, phrase: "please do that" } }
      }).success
    ).toBe(true);
  });
});

/** There is ONE purpose field, and it lives in the policy plane because the
 * announcement is speech. `execution.meeting.announce.purpose` was required
 * and validated here and read by nothing: setting it and leaving
 * `policy.meeting.purpose` unset made the room hear the default "take notes",
 * with no error. Two fields that can disagree about the same fact is the shape
 * the cross-plane pairing rule exists to prevent. */
describe("the announcement's purpose has exactly one home", () => {
  it("REJECTS execution.meeting.announce rather than accepting a second purpose nothing reads", () => {
    const parsed = callExecutionSchema.safeParse({
      meeting: { ...meeting, announce: { purpose: "take notes for the team" } }
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toMatch(/announce/);
  });
});
