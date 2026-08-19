import { describe, expect, it } from "vitest";
import { principalCall, representedCall, transactionalCall } from "../src/presets.js";

describe("presets", () => {
  it("principalCall is a self-call: unlocked, grounded, no deferral", () => {
    const p = principalCall({ principalName: "Alex Rivera" });
    expect(p.identity).toEqual({ style: "self" });
    expect(p.scope.lock).toBe(false);
    expect(p.grounding.antiInvention).toBe(true);
    expect(p.deferral.enabled).toBe(false);
    expect(p.disclosure).toEqual({ honestIfAsked: false, volunteer: false });
    expect(p.voicemail).toBeUndefined();
  });

  it("representedCall opens on-behalf, locks scope, leaves voicemail", () => {
    const p = representedCall({ principalName: "Alex Rivera", callbackNumber: "+15551234567" });
    expect(p.identity).toEqual({ style: "onBehalf", role: "personal assistant" });
    expect(p.scope.lock).toBe(true);
    expect(p.disclosure).toEqual({ honestIfAsked: true, volunteer: false });
    expect(p.grounding.antiInvention).toBe(false);
    expect(p.deferral.enabled).toBe(true);
    expect(p.callback).toEqual({ number: "+15551234567" });
    expect(p.voicemail).toEqual({ onMachine: "leaveMessage" });
    expect(p.wrapUp).toEqual({ enabled: true });
  });

  it("transactionalCall is silent and hangs up on voicemail", () => {
    const p = transactionalCall({ principalName: "Alex Rivera", recipientName: "Bella Vista" });
    expect(p.identity).toEqual({ style: "silent", recipientName: "Bella Vista" });
    expect(p.scope.lock).toBe(true);
    expect(p.voicemail).toEqual({ onMachine: "hangUp" });
  });

  it("passes through authorized commitments and pronunciation", () => {
    const p = representedCall({
      principalName: "Alex Rivera",
      authorizedCommitments: ["OK to 7pm."],
      pronunciation: ["Pronounce the last name Rivera as ree-VAIR-uh."]
    });
    expect(p.authority.authorizedCommitments).toEqual(["OK to 7pm."]);
    expect(p.pronunciation).toEqual(["Pronounce the last name Rivera as ree-VAIR-uh."]);
  });
});

import { navigableCall } from "../src/index.js";

describe("transactionalCall extensions", () => {
  it("threads the new fields through", () => {
    const p = transactionalCall({
      principalName: "Alex Rivera",
      adjacent: ["Also service the second unit."],
      ivrGoal: "the service department",
      menuHints: ["Press one for service."],
      spend: { limit: 250, currency: "USD", basis: "for this visit" },
      expectLookupPauses: true
    });
    expect(p.scope).toEqual({ lock: true, adjacent: ["Also service the second unit."] });
    expect(p.ivr).toEqual({
      goal: "the service department",
      menuHints: ["Press one for service."]
    });
    expect(p.authority.spend).toEqual({ limit: 250, currency: "USD", basis: "for this visit" });
    expect(p.patience).toEqual({ expectLookupPauses: true });
  });

  it("omits every new field when not asked for (golden-equivalence safety)", () => {
    const p = transactionalCall({ principalName: "Alex Rivera" });
    expect(p.scope).toEqual({ lock: true });
    expect(p.ivr).toBeUndefined();
    expect(p.patience).toBeUndefined();
    expect(p.authority.spend).toBeUndefined();
  });

  it("accepts an ivrGoal with no menuHints", () => {
    const p = transactionalCall({
      principalName: "Alex Rivera",
      ivrGoal: "the service department"
    });
    expect(p.ivr).toEqual({ goal: "the service department" });
  });
});

describe("navigableCall", () => {
  it("builds only the blocks it was given", () => {
    const e = navigableCall({
      maxPresses: 6,
      outcomeFields: [{ name: "appointmentStart", description: "ISO start" }]
    });
    expect(e.ivr).toEqual({
      maxPresses: 6,
      allowedDigits: "0123456789*#",
      onUnrecognized: "zeroOut"
    });
    expect(e.outcome?.fields).toHaveLength(1);
    expect(e.limits).toBeUndefined();
    expect(e.closure).toBeUndefined();
  });

  it("returns an empty execution when given nothing", () => {
    expect(navigableCall({})).toEqual({});
  });

  it("carries maxSilenceSeconds only alongside a duration cap", () => {
    expect(navigableCall({ maxSilenceSeconds: 30 }).limits).toBeUndefined();
    expect(navigableCall({ maxDurationSeconds: 600, maxSilenceSeconds: 30 }).limits).toEqual({
      maxDurationSeconds: 600,
      maxSilenceSeconds: 30
    });
  });
});
