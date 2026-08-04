import { describe, expect, it } from "vitest";
import { parseCallPolicy, parseCallEnvelope, WIRE_VERSION } from "../src/schema.js";

const valid = {
  principalName: "Alex Rivera",
  identity: { style: "onBehalf", role: "personal assistant" },
  disclosure: { honestIfAsked: true, volunteer: false },
  scope: { lock: true },
  grounding: { antiInvention: false },
  deferral: { enabled: true },
  authority: {},
  callback: { number: "+15551234567" },
  voicemail: { onMachine: "leaveMessage" }
};

describe("parseCallPolicy", () => {
  it("accepts a well-formed policy", () => {
    expect(parseCallPolicy(valid).principalName).toBe("Alex Rivera");
  });
  it("rejects an unknown top-level field", () => {
    expect(() => parseCallPolicy({ ...valid, voicmail: { onMachine: "hangUp" } })).toThrow();
  });
  it("rejects an unknown nested field", () => {
    expect(() =>
      parseCallPolicy({ ...valid, disclosure: { honestIfAsked: true, volunteer: false, extra: 1 } })
    ).toThrow();
  });
  it("rejects a bad enum value", () => {
    expect(() =>
      parseCallPolicy({ ...valid, voicemail: { onMachine: "voicemailplease" } })
    ).toThrow();
  });
  it("rejects an onBehalf identity with no role", () => {
    expect(() => parseCallPolicy({ ...valid, identity: { style: "onBehalf" } })).toThrow();
  });
});

const brief = {
  to: "+15551234567",
  persona: "You are Ada.",
  objective: "Book a table.",
  facts: []
};

describe("parseCallEnvelope", () => {
  it("accepts the current wire version with a typed policy", () => {
    const env = parseCallEnvelope({ version: WIRE_VERSION, brief, policy: valid });
    expect(env.brief.to).toBe("+15551234567");
  });
  it("rejects an unsupported wire version", () => {
    expect(() =>
      parseCallEnvelope({
        version: 99,
        brief: { to: "+1", persona: "p", objective: "o", facts: [] },
        policy: valid
      })
    ).toThrow();
  });
  it("accepts raw guardrails in place of a typed policy", () => {
    const env = parseCallEnvelope({
      version: WIRE_VERSION,
      brief,
      guardrails: ["Stay on topic.", "Defer to Alex Rivera on money."]
    });
    expect("guardrails" in env && env.guardrails).toEqual([
      "Stay on topic.",
      "Defer to Alex Rivera on money."
    ]);
  });
  it("rejects an empty-string guardrail", () => {
    expect(() => parseCallEnvelope({ version: WIRE_VERSION, brief, guardrails: [""] })).toThrow();
  });
  it("rejects an envelope carrying both policy and guardrails", () => {
    expect(() =>
      parseCallEnvelope({ version: WIRE_VERSION, brief, policy: valid, guardrails: ["x"] })
    ).toThrow();
  });
  it("rejects an envelope carrying neither policy nor guardrails", () => {
    expect(() => parseCallEnvelope({ version: WIRE_VERSION, brief })).toThrow();
  });
  it("rejects an unknown top-level field alongside guardrails", () => {
    expect(() =>
      parseCallEnvelope({ version: WIRE_VERSION, brief, guardrails: ["x"], extra: "nope" })
    ).toThrow();
  });
});
