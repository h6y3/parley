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

import { transactionalCall as _tc } from "../src/presets.js";
import type { CallPolicy as _CP } from "../src/schema.js";

const newRailBase = (): _CP => _tc({ principalName: "Alex Rivera" });

describe("new prose-plane rails", () => {
  it("emits the adjacency rail and swaps the scope statement", () => {
    const p: _CP = {
      ...newRailBase(),
      scope: { lock: true, adjacent: ["Also service the second unit."] }
    };
    const out = composePolicy(p).join(" ");
    expect(out).toContain("Also service the second unit.");
    expect(out).toContain("plus the small number of explicitly permitted extensions");
    expect(out).not.toContain("IMPORTANT: this call has exactly one purpose.");
  });

  it("emits the IVR rail and narrows the voicemail rail", () => {
    const p: _CP = { ...newRailBase(), ivr: { goal: "the service department" } };
    const out = composePolicy(p).join(" ");
    expect(out).toContain("do not assume a menu and do not act until you have heard one");
    expect(out).not.toContain("automated system you cannot complete the task with");
  });

  it("emits the preferences rail before the deferral rail", () => {
    const out = composePolicy(newRailBase(), ["Prefers morning appointments."]);
    const prefIdx = out.findIndex((r) => r.includes("standing preferences"));
    const deferIdx = out.findIndex((r) => r.includes("will need to follow up with"));
    expect(prefIdx).toBeGreaterThanOrEqual(0);
    expect(deferIdx).toBeGreaterThanOrEqual(0);
    expect(prefIdx).toBeLessThan(deferIdx);
  });

  it("emits the spend rail and narrows always-defer to exclude routine fees", () => {
    const b = newRailBase();
    const p: _CP = {
      ...b,
      authority: { ...b.authority, spend: { limit: 250, currency: "USD", basis: "for this visit" } }
    };
    const out = composePolicy(p).join(" ");
    expect(out).toContain("up to 250 USD in TOTAL for this visit");
    expect(out).toContain("For anything involving deposits, cancellation charges, contracts");
    expect(out).not.toContain("For anything involving money, fees, deposits");
  });

  it("a caller-supplied alwaysDefer list still wins over the spend narrowing", () => {
    const b = newRailBase();
    const p: _CP = {
      ...b,
      authority: {
        ...b.authority,
        alwaysDefer: ["Legal waivers."],
        spend: { limit: 250, currency: "USD", basis: "for this visit" }
      }
    };
    const out = composePolicy(p).join(" ");
    expect(out).toContain("For anything involving Legal waivers.");
    expect(out).toContain("up to 250 USD");
  });

  it("emits the patience rail", () => {
    const p: _CP = { ...newRailBase(), patience: { expectLookupPauses: true } };
    expect(composePolicy(p).join(" ")).toContain("Wait for them rather than filling the silence");
  });

  it("all new fields absent composes identically to today", () => {
    expect(composePolicy(newRailBase())).toEqual(composePolicy(newRailBase(), []));
  });
});
