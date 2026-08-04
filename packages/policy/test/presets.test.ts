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
    const p = representedCall({ principalName: "Alex Rivera", authorizedCommitments: ["OK to 7pm."], pronunciation: ["Pronounce the last name Rivera as ree-VAIR-uh."] });
    expect(p.authority.authorizedCommitments).toEqual(["OK to 7pm."]);
    expect(p.pronunciation).toEqual(["Pronounce the last name Rivera as ree-VAIR-uh."]);
  });
});
