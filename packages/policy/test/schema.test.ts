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

const execBrief = { to: "+15555550142", persona: "p", objective: "o", facts: [] };
const execPolicy = {
  principalName: "Alex Rivera",
  identity: { style: "silent" as const },
  disclosure: { honestIfAsked: true, volunteer: false },
  scope: { lock: true },
  grounding: { antiInvention: false },
  deferral: { enabled: true },
  authority: {}
};

describe("execution plane", () => {
  it("accepts a v2 envelope with a full execution block", () => {
    const env = parseCallEnvelope({
      version: 2,
      brief: execBrief,
      policy: { ...execPolicy, ivr: { goal: "the service department" } },
      execution: {
        ivr: { maxPresses: 6, allowedDigits: "0123456789*#", onUnrecognized: "zeroOut" },
        closure: { requireOutcomeBeforeEnd: true },
        outcome: {
          fields: [{ name: "appointmentStart", description: "ISO start of the booked window" }]
        },
        limits: { maxDurationSeconds: 600, maxSilenceSeconds: 45 },
        turnDetection: { silenceMs: 1500 },
        detection: { mode: "enable" }
      }
    });
    expect(env.execution?.ivr?.maxPresses).toBe(6);
  });

  it("still accepts a v1 envelope with no execution block", () => {
    expect(() =>
      parseCallEnvelope({ version: 1, brief: execBrief, policy: execPolicy })
    ).not.toThrow();
  });

  it("rejects a v1 envelope carrying an execution block", () => {
    expect(() =>
      parseCallEnvelope({
        version: 1,
        brief: execBrief,
        policy: execPolicy,
        execution: { limits: { maxDurationSeconds: 600 } }
      })
    ).toThrow();
  });

  it("rejects policy.ivr without execution.ivr", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: { ...execPolicy, ivr: { goal: "service" } }
      })
    ).toThrow();
  });

  it("rejects execution.ivr without policy.ivr", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { ivr: { maxPresses: 6, allowedDigits: "0123456789", onUnrecognized: "hangUp" } }
      })
    ).toThrow();
  });

  it("rejects a non-keypad character in allowedDigits", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: { ...execPolicy, ivr: { goal: "service" } },
        execution: { ivr: { maxPresses: 6, allowedDigits: "12a", onUnrecognized: "hangUp" } }
      })
    ).toThrow();
  });

  it("rejects duplicate outcome field names", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: {
          outcome: {
            fields: [
              { name: "x", description: "a" },
              { name: "x", description: "b" }
            ]
          }
        }
      })
    ).toThrow();
  });

  it("accepts an empty execution block as equivalent to absent", () => {
    expect(() =>
      parseCallEnvelope({ version: 2, brief: execBrief, policy: execPolicy, execution: {} })
    ).not.toThrow();
  });

  it("accepts execution alongside raw guardrails (no policy object)", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        guardrails: ["Be brief."],
        execution: { limits: { maxDurationSeconds: 300 } }
      })
    ).not.toThrow();
  });
});

/**
 * The gap the matrix found was structural, not a model failure: a caller could
 * declare spending authority in the ADVISORY plane and an outcome record in the
 * BINDING one, and nothing tied them together. The prose asked the model to
 * respect a ceiling; the gate that writes the record had never heard of it.
 *
 * So the pairing is now a schema rule. You cannot declare a spend authority and
 * a place to record what you agreed without also binding the two — the same
 * shape as the policy.ivr/execution.ivr rule above, and for the same reason.
 */
describe("cross-plane rule: an advisory spend limit must be bound in the execution plane", () => {
  const envelope = (over: { spend?: unknown; execution?: unknown } = {}): unknown => ({
    version: 2,
    brief: { to: "+15555550142", persona: "p", objective: "o", facts: [] },
    policy: {
      principalName: "Jordan Rivera",
      identity: { style: "silent" },
      disclosure: { honestIfAsked: true, volunteer: false },
      scope: { lock: true },
      grounding: { antiInvention: false },
      deferral: { enabled: true },
      authority:
        "spend" in over
          ? over.spend === undefined
            ? {}
            : { spend: over.spend }
          : { spend: { limit: 250, currency: "USD", basis: "for this visit" } }
    },
    execution:
      "execution" in over
        ? over.execution
        : {
            outcome: { fields: [{ name: "agreedAmount", description: "total agreed" }] },
            spendCeiling: { field: "agreedAmount", limit: 250 }
          }
  });

  it("accepts a matched pair", () => {
    expect(() => parseCallEnvelope(envelope())).not.toThrow();
  });

  it("rejects an advisory ceiling with an outcome record and no binding ceiling", () => {
    expect(() =>
      parseCallEnvelope(
        envelope({
          execution: { outcome: { fields: [{ name: "agreedAmount", description: "t" }] } }
        })
      )
    ).toThrow(/spendCeiling/);
  });

  it("rejects a binding ceiling that names an undeclared field", () => {
    expect(() =>
      parseCallEnvelope(
        envelope({
          execution: {
            outcome: { fields: [{ name: "appointmentStart", description: "t" }] },
            spendCeiling: { field: "agreedAmount", limit: 250 }
          }
        })
      )
    ).toThrow(/agreedAmount/);
  });

  it("rejects a binding ceiling that disagrees with the advisory one", () => {
    // A ceiling the model was told is 250 and the server enforces at 500 is
    // worse than no ceiling: it reads as protection and is not.
    expect(() =>
      parseCallEnvelope(
        envelope({
          execution: {
            outcome: { fields: [{ name: "agreedAmount", description: "t" }] },
            spendCeiling: { field: "agreedAmount", limit: 500 }
          }
        })
      )
    ).toThrow(/limit/);
  });

  it("rejects a binding ceiling with no advisory counterpart to have told the model about", () => {
    expect(() =>
      parseCallEnvelope(
        envelope({
          spend: undefined,
          execution: {
            outcome: { fields: [{ name: "agreedAmount", description: "t" }] },
            spendCeiling: { field: "agreedAmount", limit: 250 }
          }
        })
      )
    ).toThrow(/authority\.spend/);
  });

  it("requires nothing when there is no outcome record to bound", () => {
    expect(() =>
      parseCallEnvelope(envelope({ execution: { closure: { requireOutcomeBeforeEnd: true } } }))
    ).not.toThrow();
  });
});
