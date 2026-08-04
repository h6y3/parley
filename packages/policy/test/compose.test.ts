import { describe, expect, it } from "vitest";
import { composePolicy, CANARY_PHRASES } from "../src/compose.js";
import type { CallPolicy } from "../src/schema.js";

const base: CallPolicy = {
  principalName: "Alex Rivera",
  identity: { style: "onBehalf", role: "personal assistant" },
  disclosure: { honestIfAsked: true, volunteer: false },
  scope: { lock: true },
  grounding: { antiInvention: false },
  deferral: { enabled: true },
  authority: {}
};

describe("composePolicy", () => {
  it("emits scope, redirect, intro, honest, deferral, always-defer in order", () => {
    const g = composePolicy(base);
    expect(g[0]).toContain("this call has exactly one purpose"); // scope-lock
    expect(g[1]).toContain("gently return the conversation"); // redirect
    expect(g[2]).toContain("you are Alex Rivera's personal assistant"); // identity onBehalf
    expect(g[3]).toContain("answer honestly that you are Alex Rivera's AI assistant"); // honest-if-asked
    expect(g[4]).toContain("follow up with Alex Rivera"); // deferral
    expect(g[5]).toContain("money, fees, deposits"); // always-defer (baked default)
  });

  it("omits scope+redirect when scope is unlocked and emits self identity + grounding", () => {
    const g = composePolicy({
      ...base,
      identity: { style: "self" },
      disclosure: { honestIfAsked: false, volunteer: false },
      scope: { lock: false },
      grounding: { antiInvention: true },
      deferral: { enabled: false }
    });
    expect(g.some((s) => s.includes("this call has exactly one purpose"))).toBe(false);
    expect(g[0]).toContain("You are speaking directly with Alex Rivera");
    expect(g[1]).toContain("not limited to a single topic");
    expect(g[2]).toContain("answer only from what you actually know");
  });

  it("includes authority, callback, pronunciation, wrap-up, voicemail when present", () => {
    const g = composePolicy({
      ...base,
      authority: { authorizedCommitments: ["A table for four at 7pm is fine."] },
      callback: { number: "+15551234567" },
      pronunciation: ["Pronounce the last name Rivera as ree-VAIR-uh."],
      wrapUp: { enabled: true },
      voicemail: { onMachine: "leaveMessage" },
      extraGuardrails: ["Custom note."]
    }).join(" ");
    expect(g).toContain("nothing beyond it: A table for four at 7pm is fine.");
    expect(g).toContain("only this number: +15551234567");
    expect(g).toContain("Pronounce the last name Rivera as ree-VAIR-uh.");
    expect(g).toContain("confirm the single key outcome");
    expect(g).toContain("leave a short message");
    expect(g).toContain("Custom note.");
  });

  it("authority.alwaysDefer, when present, REPLACES the default category list rather than appending to it", () => {
    const g = composePolicy({
      ...base,
      authority: { alwaysDefer: ["legal waivers", "medical claims"] }
    });
    const defer = g.find((s) => s.startsWith("For anything involving"));
    expect(defer).toContain("For anything involving legal waivers, medical claims, do not commit");
    expect(defer).not.toContain("money, fees, deposits");
  });

  it("falls back to the default category list when authority.alwaysDefer is absent", () => {
    const g = composePolicy(base);
    const defer = g.find((s) => s.startsWith("For anything involving"));
    expect(defer).toContain(
      "money, fees, deposits, cancellation charges, contracts, or sensitive personal information"
    );
  });

  it("CANARY_PHRASES contains the fixed structural sentences", () => {
    expect(CANARY_PHRASES.length).toBeGreaterThanOrEqual(3);
  });
});
