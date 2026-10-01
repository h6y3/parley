import { describe, expect, it } from "vitest";
import { renderSystemInstruction } from "@parley/core";
import { composePolicy } from "../src/compose.js";
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
  it("accepts well-formed retry lineage and preserves it", () => {
    const env = parseCallEnvelope({
      version: WIRE_VERSION,
      brief: { ...brief, operation: { id: "order-AB123", attempt: 2, maxAttempts: 3 } },
      policy: valid
    });
    expect(env.brief.operation).toEqual({ id: "order-AB123", attempt: 2, maxAttempts: 3 });
  });
  it("rejects malformed or over-budget retry lineage", () => {
    expect(() =>
      parseCallEnvelope({
        version: WIRE_VERSION,
        brief: { ...brief, operation: { id: "bad id", attempt: 1, maxAttempts: 3 } },
        policy: valid
      })
    ).toThrow();
    expect(() =>
      parseCallEnvelope({
        version: WIRE_VERSION,
        brief: { ...brief, operation: { id: "order-AB123", attempt: 4, maxAttempts: 3 } },
        policy: valid
      })
    ).toThrow();
  });
  it("accepts brief.keyterms and preserves them", () => {
    const keyterms = Array.from({ length: 20 }, (_, i) => `term${i}`.padEnd(50, "x"));
    const env = parseCallEnvelope({
      version: WIRE_VERSION,
      brief: { ...brief, keyterms },
      policy: valid
    });
    expect(env.brief.keyterms).toEqual(keyterms);
  });
  it("rejects more than 20 keyterms", () => {
    const keyterms = Array.from({ length: 21 }, (_, i) => `term${i}`);
    expect(() =>
      parseCallEnvelope({ version: WIRE_VERSION, brief: { ...brief, keyterms }, policy: valid })
    ).toThrow();
  });
  it("rejects a keyterm over 50 characters or empty", () => {
    for (const bad of ["y".repeat(51), ""]) {
      expect(() =>
        parseCallEnvelope({
          version: WIRE_VERSION,
          brief: { ...brief, keyterms: [bad] },
          policy: valid
        })
      ).toThrow();
    }
  });
  it("keyterms never reach the rendered system instruction", () => {
    const render = (b: { persona: string; objective: string; facts: string[] }) =>
      renderSystemInstruction({ ...b, guardrails: composePolicy(parseCallPolicy(valid)) });
    const without = parseCallEnvelope({ version: WIRE_VERSION, brief, policy: valid });
    const withTerms = parseCallEnvelope({
      version: WIRE_VERSION,
      brief: { ...brief, keyterms: ["Nguyen"] },
      policy: valid
    });
    expect(render(withTerms.brief)).toBe(render(without.brief));
    expect(render(withTerms.brief)).not.toContain("Nguyen");
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

  /** Same shape as the policy.ivr/execution.ivr pairing above, and the same
   * reason: composePolicy composes the meeting rails (announce, ask for
   * objections, notetaker scope) off policy.meeting.announce alone — see
   * compose.ts's order:15 meeting rail. Declared apart, a room can be told an
   * AI will take notes while no execution.meeting tool exists to take any. */
  it("rejects policy.meeting.announce:true without execution.meeting", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: { ...execPolicy, meeting: { announce: true } }
      })
    ).toThrow();
  });

  it("rejects execution.meeting without policy.meeting.announce:true", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: {
          meeting: {
            consent: {
              phrase: "go ahead and take notes",
              timeoutSeconds: 180,
              onTimeout: "hangUp"
            }
          }
        }
      })
    ).toThrow();
  });

  it("accepts policy.meeting.announce:true PAIRED with execution.meeting", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: { ...execPolicy, meeting: { announce: true } },
        execution: {
          meeting: {
            consent: {
              phrase: "go ahead and take notes",
              timeoutSeconds: 180,
              onTimeout: "hangUp"
            }
          },
          limits: { maxDurationSeconds: 14400 }
        }
      })
    ).not.toThrow();
  });

  it("accepts policy.meeting.announce:false with no execution.meeting — announce:false composes no rail, so nothing to pair", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: { ...execPolicy, meeting: { announce: false } }
      })
    ).not.toThrow();
  });

  /** The five OPTIONAL policy fields meaningless for a meeting notetaker,
   * REJECTED outright rather than silently composing no rail for them — see
   * the `rejectedForMeeting` block in schema.ts, right after the
   * policy.meeting/execution.meeting pairing above. Each envelope below is
   * otherwise complete and correctly paired (a real execution.meeting with a
   * valid consent phrase), so the only thing under test is the meeting-field
   * rejection — not some other, unrelated validation failure. */
  describe("meeting envelopes reject fields meaningless for a notetaker", () => {
    const meetingExecution = {
      meeting: {
        consent: {
          phrase: "go ahead and take notes",
          timeoutSeconds: 180,
          onTimeout: "hangUp" as const
        }
      }
    };

    function parseWithMeetingField(extra: Record<string, unknown>): unknown {
      return parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: { ...execPolicy, meeting: { announce: true }, ...extra },
        execution: meetingExecution
      });
    }

    function messageFor(extra: Record<string, unknown>): string {
      try {
        parseWithMeetingField(extra);
        expect.unreachable("expected parseCallEnvelope to throw");
      } catch (error) {
        return String((error as Error).message);
      }
    }

    it("rejects authority.spend, naming the field and why", () => {
      const message = messageFor({
        authority: { spend: { limit: 250, currency: "USD", basis: "for this visit" } }
      });
      expect(message).toContain("policy.authority.spend");
      expect(message).toMatch(/meaningless for a meeting notetaker/);
    });

    it("rejects authority.authorizedCommitments, naming the field and why", () => {
      const message = messageFor({
        authority: { authorizedCommitments: ["Confirm the roadmap date."] }
      });
      expect(message).toContain("policy.authority.authorizedCommitments");
      expect(message).toMatch(/meaningless for a meeting notetaker/);
    });

    it("rejects callback, naming the field and why", () => {
      const message = messageFor({ callback: { number: "+15555550142" } });
      expect(message).toContain("policy.callback");
      expect(message).toMatch(/meaningless for a meeting notetaker/);
    });

    it("rejects wrapUp, naming the field and why", () => {
      const message = messageFor({ wrapUp: { enabled: true } });
      expect(message).toContain("policy.wrapUp");
      expect(message).toMatch(/meaningless for a meeting notetaker/);
    });

    it("rejects voicemail, naming the field and why", () => {
      const message = messageFor({ voicemail: { onMachine: "leaveMessage" } });
      expect(message).toContain("policy.voicemail");
      expect(message).toMatch(/meaningless for a meeting notetaker/);
    });

    it("accepts the same meeting envelope carrying none of the five fields", () => {
      expect(() => parseWithMeetingField({})).not.toThrow();
    });

    it("does NOT reject these same five fields on an ordinary (non-meeting) envelope", () => {
      expect(() =>
        parseCallEnvelope({
          version: 2,
          brief: execBrief,
          policy: {
            ...execPolicy,
            authority: { spend: { limit: 250, currency: "USD", basis: "for this visit" } },
            callback: { number: "+15555550142" },
            wrapUp: { enabled: true },
            voicemail: { onMachine: "leaveMessage" }
          }
        })
      ).not.toThrow();
    });
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
 * `execution.dial.sendDigits` is Twilio's `SendDigits`: carrier-played DTMF
 * fired at origination, before any media stream — or the model — exists. It
 * is unlike every other block in `execution` in one respect worth testing
 * for directly: it needs no `policy` pairing. `ivr` pairs with `policy.ivr`
 * and `meeting` pairs with `policy.meeting.announce` because both of those
 * tell the model, in prose, what it may do with a tool. There is nothing to
 * tell the model here — the carrier has already played the tones by the time
 * the model is on the line — so an envelope may declare `execution.dial`
 * with no matching `policy` field at all, alongside either a typed `policy`
 * or raw `guardrails[]`.
 */
describe("execution.dial — carrier-side DTMF at origination", () => {
  it("accepts a well-formed sendDigits alongside a typed policy, with no pairing required", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { dial: { sendDigits: "1234567890#" } }
      })
    ).not.toThrow();
  });

  it("accepts sendDigits alongside raw guardrails (no policy object)", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        guardrails: ["Be brief."],
        execution: { dial: { sendDigits: "1234w5678" } }
      })
    ).not.toThrow();
  });

  it("accepts the full Twilio SendDigits alphabet: 0-9, *, #, w, W", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { dial: { sendDigits: "0123456789*#wW" } }
      })
    ).not.toThrow();
  });

  it("rejects an empty sendDigits", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { dial: { sendDigits: "" } }
      })
    ).toThrow();
  });

  it("rejects a character outside the SendDigits alphabet", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { dial: { sendDigits: "1234a5678" } }
      })
    ).toThrow();
  });

  it("rejects sendDigits over the length ceiling", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { dial: { sendDigits: "1".repeat(33) } }
      })
    ).toThrow();
  });

  it("accepts sendDigits at exactly the length ceiling", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { dial: { sendDigits: "1".repeat(32) } }
      })
    ).not.toThrow();
  });

  it("rejects an unknown field inside execution.dial", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { dial: { sendDigits: "123", extra: "nope" } }
      })
    ).toThrow();
  });

  it("does not echo the invalid value into the thrown error (sendDigits is a secret)", () => {
    // The digit string typically carries a bridge passcode. Zod's default
    // regex/length failure messages describe the RULE, not the value — this
    // asserts that stays true rather than trusting it silently.
    try {
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { dial: { sendDigits: "9999secretpasscode9999" } }
      });
      expect.unreachable("expected parseCallEnvelope to throw");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secretpasscode");
    }
  });
});

/**
 * `execution.realtime` chooses which of the daemon's realtime providers a call
 * runs on. It names a provider and never a model: per-provider configuration is
 * daemon-level, which keeps the surface a caller depends on small. Strict, so a
 * caller that tries to smuggle a model (or anything else) in finds out.
 */
describe("execution.realtime — per-call provider selection", () => {
  it.each(["gemini", "deepgram"])("accepts provider %s", (provider) => {
    const envelope = parseCallEnvelope({
      version: 2,
      brief: execBrief,
      policy: execPolicy,
      execution: { realtime: { provider } }
    });
    expect(envelope.execution?.realtime).toEqual({ provider });
  });

  it("rejects a provider it does not know", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { realtime: { provider: "openai" } }
      })
    ).toThrow();
  });

  it("rejects an unknown key inside execution.realtime (the envelope never picks a model)", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { realtime: { provider: "gemini", model: "gemini-3.8-live" } }
      })
    ).toThrow();
  });

  it("rejects an empty execution.realtime", () => {
    expect(() =>
      parseCallEnvelope({
        version: 2,
        brief: execBrief,
        policy: execPolicy,
        execution: { realtime: {} }
      })
    ).toThrow();
  });

  it("requires envelope version 2, like every execution field", () => {
    expect(() =>
      parseCallEnvelope({
        version: 1,
        brief: execBrief,
        policy: execPolicy,
        execution: { realtime: { provider: "deepgram" } }
      })
    ).toThrow();
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
