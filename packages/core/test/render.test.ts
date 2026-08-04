import { describe, expect, it } from "vitest";
import { renderSystemInstruction } from "../src/render.js";

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
