import { describe, expect, it } from "vitest";
import {
  SCOPE_STATEMENT,
  deferralRule,
  callbackRule,
  honestIfAsked,
  onBehalfIntro,
  selfIdentity,
  selfGrounding,
  alwaysDeferRule
} from "../src/constants.js";

describe("guardrail prose constants (verbatim from current core)", () => {
  it("SCOPE_STATEMENT matches current core wording", () => {
    expect(SCOPE_STATEMENT).toBe(
      "IMPORTANT: this call has exactly one purpose. You have no other purpose, no other " +
        "caller, and no other scenario available to you. Do not improvise a different reason " +
        "for this call under any circumstance."
    );
  });
  it("deferralRule ends with the anti-invention core", () => {
    expect(deferralRule("Alex Rivera")).toBe(
      "If you are asked something this brief does not cover, say plainly that you do not have " +
        "that information and will need to follow up with Alex Rivera. " +
        "Never guess, invent an answer, or draw on unrelated information to fill the gap."
    );
  });
  it("callbackRule pins the number for bookings", () => {
    expect(callbackRule("Alex Rivera", "+15551234567")).toContain(
      "give them this number and only this number: +15551234567"
    );
  });
  it("onBehalfIntro names the role", () => {
    expect(onBehalfIntro("Alex Rivera", "personal assistant")).toBe(
      "Open the call by saying you are Alex Rivera's personal assistant, calling on Alex Rivera's behalf, and " +
        "then state your purpose in one sentence. Speak warmly and professionally."
    );
  });
  it("selfIdentity + selfGrounding reproduce the principal framing halves", () => {
    expect(selfIdentity("Alex Rivera")).toContain("You are speaking directly with Alex Rivera");
    expect(selfGrounding()).toContain("Never guess, invent an answer");
  });
  it("honestIfAsked is the overridable disclosure floor", () => {
    expect(honestIfAsked("Alex Rivera")).toContain(
      "answer honestly that you are Alex Rivera's AI assistant"
    );
  });
  it("alwaysDeferRule defaults to the baked money/fees category list", () => {
    expect(alwaysDeferRule("Alex Rivera")).toBe(
      "For anything involving money, fees, deposits, cancellation charges, contracts, or " +
        "sensitive personal information, do not commit — say you will confirm with Alex Rivera " +
        "and call back."
    );
  });
  it("alwaysDeferRule substitutes a caller-supplied category list, keeping the surrounding sentence frame", () => {
    expect(alwaysDeferRule("Alex Rivera", "legal waivers, medical claims")).toBe(
      "For anything involving legal waivers, medical claims, do not commit — say you will " +
        "confirm with Alex Rivera and call back."
    );
  });
});
