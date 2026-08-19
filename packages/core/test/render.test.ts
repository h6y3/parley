import { describe, expect, it } from "vitest";
import { OPENING_TRIGGER, renderSystemInstruction } from "../src/render.js";

describe("renderSystemInstruction", () => {
  it("orders persona, objective+facts, guardrails and joins with blank lines", () => {
    const out = renderSystemInstruction({
      persona: "  You are Ada.  ",
      objective: "  Confirm the 7pm booking.  ",
      facts: ["Party of four.", "Friday."],
      guardrails: ["Rule one.", "Rule two."]
    });
    expect(out).toBe(
      "You are Ada.\n\nConfirm the 7pm booking. Party of four. Friday.\n\nRule one. Rule two."
    );
  });

  it("omits the guardrails section entirely when there are none", () => {
    const out = renderSystemInstruction({
      persona: "P",
      objective: "O",
      facts: [],
      guardrails: []
    });
    expect(out).toBe("P\n\nO");
  });

  it("omits the objective/facts section when both are empty", () => {
    const out = renderSystemInstruction({
      persona: "P",
      objective: "",
      facts: [],
      guardrails: ["G."]
    });
    expect(out).toBe("P\n\nG.");
  });
});

/**
 * The trigger tells the model to wait before speaking. Told only that, a live
 * call had it narrate the wait — the transcript carries "(waiting for someone
 * or something to speak first)" and "(I'm waiting silently for any menu or
 * person to continue.)" in the MODEL channel, meaning a person who had just
 * picked up the phone heard them.
 *
 * On a voice call every instruction is about audible behaviour, so one that
 * describes a state has to say what that state sounds like.
 */
describe("OPENING_TRIGGER", () => {
  it("says waiting means silence, not announcing the wait", () => {
    expect(OPENING_TRIGGER).toMatch(/Waiting means silence/);
    expect(OPENING_TRIGGER).toMatch(/do not announce that you are waiting/);
    expect(OPENING_TRIGGER).toMatch(/do not narrate your own state/);
  });

  it("gives the reason it matters here specifically", () => {
    expect(OPENING_TRIGGER).toMatch(/heard aloud by whoever picks up/);
  });

  it("still says what to do once something is heard", () => {
    expect(OPENING_TRIGGER).toMatch(/greet a person and say why you are calling/);
  });
});
