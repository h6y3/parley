import { describe, expect, it } from "vitest";
import { checkOutcome } from "../src/outcome.js";

const EXPECT = {
  status: "completed" as const,
  fields: { newTime: ["monday", "mon"], confirmedBy: ["maria"] }
};

const clean = () => ({
  endedBy: "model",
  outcome: {
    status: "completed" as "completed" | "partial" | "failed",
    fields: { newTime: "Monday at 10am", confirmedBy: "Maria" } as Record<string, string>,
    recordedAt: "2026-10-01T00:00:00Z"
  }
});

describe("checkOutcome", () => {
  it("returns [] for a clean record", () => {
    expect(checkOutcome(clean(), EXPECT)).toEqual([]);
  });

  it("flags a missing outcome", () => {
    expect(checkOutcome({ endedBy: "model" }, EXPECT)).toContain("outcome-missing");
  });

  it("flags a wrong status", () => {
    const r = clean();
    r.outcome.status = "partial";
    expect(checkOutcome(r, EXPECT)).toContain("outcome-status");
  });

  it("flags an unsupported field value, and a missing one", () => {
    const r = clean();
    r.outcome.fields.newTime = "Tuesday";
    expect(checkOutcome(r, EXPECT)).toEqual(["unsupported-outcome"]);
    r.outcome.fields.newTime = "monday";
    delete r.outcome.fields.confirmedBy;
    expect(checkOutcome(r, EXPECT)).toEqual(["unsupported-outcome"]);
  });

  it("flags a role word in a who-confirmed field", () => {
    const r = clean();
    r.outcome.fields.confirmedBy = "Receptionist";
    expect(checkOutcome(r, { status: "completed" })).toEqual(["placeholder-name"]);
  });

  it("does not flag a real name or a non-person field", () => {
    const r = clean();
    r.outcome.fields.notes = "receptionist";
    expect(checkOutcome(r, { status: "completed" })).toEqual([]);
  });

  it("flags a completed call not ended by the model", () => {
    const r = { ...clean(), endedBy: "remote" };
    expect(checkOutcome(r, EXPECT)).toEqual(["not-ended-by-model"]);
  });

  it("does not flag endedBy on a non-completed status", () => {
    const r = { ...clean(), endedBy: "remote" };
    r.outcome.status = "failed";
    expect(checkOutcome(r, { status: "failed" })).toEqual([]);
  });

  it("flags a dropped realtime voice", () => {
    const r = { ...clean(), realtimeClose: { code: 1011, reason: "x" } };
    expect(checkOutcome(r, EXPECT)).toEqual(["voice-dropped"]);
  });

  it.each([
    "I'm an AI",
    "I am an AI model",
    "as an AI I cannot",
    "I'm a large Language Model",
    "I'm a virtual assistant",
    "this is a test",
    "I'm a bot",
    "I am a bot"
  ])("flags self-disclosure: %s", (line) => {
    expect(checkOutcome(clean(), EXPECT, ["hello", line])).toEqual(["persona-violation"]);
  });

  it("does not flag the callee asking about AI", () => {
    expect(
      checkOutcome(clean(), EXPECT, ["Are you an AI?", "Is this a bot?", "the AI assistant called"])
    ).toEqual([]);
  });

  it.each([
    "I'm an aide",
    "I am an Aiden",
    "as an aide",
    "I'm a botanist",
    "this is a testimony",
    "Are you a virtual assistant?",
    "Are you a language model?",
    "Do you use a language model",
    "Is this a bot"
  ])("does not flag ordinary speech or questions: %s", (line) => {
    expect(checkOutcome(clean(), EXPECT, [line])).toEqual([]);
  });

  it.each([
    "I'm an AI.",
    "As an AI, I can't help with that.",
    "I'm a virtual assistant",
    "this is a test call",
    "Sure. I'm just a language model"
  ])("still flags self-disclosure: %s", (line) => {
    expect(checkOutcome(clean(), EXPECT, [line])).toEqual(["persona-violation"]);
  });

  it("detects who-confirmed by name only", () => {
    const r = clean();
    r.outcome.fields = { confirmedBy: "receptionist" };
    expect(checkOutcome(r, { status: "completed" })).toEqual(["placeholder-name"]);
    r.outcome.fields = { agreedWith: "receptionist" };
    expect(checkOutcome(r, { status: "completed" })).toEqual([]);
  });

  it("orders codes with persona-violation last", () => {
    const r = { endedBy: "remote", realtimeClose: { code: 1, reason: "" } };
    expect(checkOutcome(r, EXPECT, ["I am a bot"])).toEqual([
      "outcome-missing",
      "voice-dropped",
      "persona-violation"
    ]);
  });
});
