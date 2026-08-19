import { z } from "zod";

/** Bumped for the execution plane. Both versions are accepted: a v1 envelope is
 * valid and simply gets no execution plane. */
export const WIRE_VERSION = 2;

const versionSchema = z.union([z.literal(1), z.literal(2)]);

export const callExecutionSchema = z
  .object({
    ivr: z
      .object({
        maxPresses: z.number().int().min(1).max(20),
        // Keypad characters only. A letter here would be silently unsendable.
        allowedDigits: z.string().regex(/^[0-9*#]+$/),
        onUnrecognized: z.enum(["zeroOut", "waitForHuman", "hangUp"])
      })
      .strict()
      .optional(),
    closure: z.object({ requireOutcomeBeforeEnd: z.boolean() }).strict().optional(),
    outcome: z
      .object({
        fields: z
          .array(z.object({ name: z.string().min(1), description: z.string().min(1) }).strict())
          .min(1)
          .refine((f) => new Set(f.map((x) => x.name)).size === f.length, {
            message: "outcome field names must be unique"
          })
      })
      .strict()
      .optional(),
    spendCeiling: z
      .object({ field: z.string().min(1), limit: z.number().positive() })
      .strict()
      .optional(),
    limits: z
      .object({
        maxDurationSeconds: z.number().int().min(30).max(1800),
        maxSilenceSeconds: z.number().int().min(5).max(300).optional()
      })
      .strict()
      .optional(),
    turnDetection: z
      .object({ silenceMs: z.number().int().min(200).max(5000) })
      .strict()
      .optional(),
    detection: z
      .object({ mode: z.enum(["enable", "detectMessageEnd"]) })
      .strict()
      .optional()
  })
  .strict();

const identitySchema = z.discriminatedUnion("style", [
  z.object({ style: z.literal("self") }).strict(),
  z.object({ style: z.literal("onBehalf"), role: z.string().min(1) }).strict(),
  z.object({ style: z.literal("silent"), recipientName: z.string().min(1).optional() }).strict()
]);

export const callPolicySchema = z
  .object({
    principalName: z.string().min(1),
    identity: identitySchema,
    disclosure: z.object({ honestIfAsked: z.boolean(), volunteer: z.boolean() }).strict(),
    scope: z
      .object({ lock: z.boolean(), adjacent: z.array(z.string().min(1)).optional() })
      .strict(),
    grounding: z.object({ antiInvention: z.boolean() }).strict(),
    deferral: z.object({ enabled: z.boolean() }).strict(),
    authority: z
      .object({
        authorizedCommitments: z.array(z.string().min(1)).optional(),
        alwaysDefer: z.array(z.string().min(1)).optional(),
        spend: z
          .object({
            limit: z.number().positive(),
            currency: z.string().length(3),
            basis: z.string().min(1)
          })
          .strict()
          .optional()
      })
      .strict(),
    callback: z
      .object({ number: z.string().min(1) })
      .strict()
      .optional(),
    wrapUp: z.object({ enabled: z.boolean() }).strict().optional(),
    voicemail: z
      .object({ onMachine: z.enum(["leaveMessage", "hangUp"]) })
      .strict()
      .optional(),
    patience: z.object({ expectLookupPauses: z.boolean() }).strict().optional(),
    ivr: z
      .object({ goal: z.string().min(1), menuHints: z.array(z.string().min(1)).optional() })
      .strict()
      .optional(),
    pronunciation: z.array(z.string().min(1)).optional(),
    extraGuardrails: z.array(z.string().min(1)).optional()
  })
  .strict();

export type CallPolicy = z.infer<typeof callPolicySchema>;
export type Identity = CallPolicy["identity"];

const briefSchema = z
  .object({
    to: z.string().min(1),
    persona: z.string().min(1),
    objective: z.string().min(1),
    facts: z.array(z.string()),
    preferences: z.array(z.string().min(1)).optional()
  })
  .strict();

/** `@parley/policy` is an OPTIONAL client helper: a caller may either send a
 * typed `policy` (the server composes it via `composePolicy`) or a
 * pre-composed `guardrails[]` (the server renders it as-is, no @parley/policy
 * dependency required client-side). Modeled as a union of two strict object
 * schemas — rather than one object with both fields optional plus a
 * `.refine()` — so "exactly one of policy/guardrails" and "no unknown keys"
 * both fall out of ordinary zod object validation on each branch, and the
 * inferred TS type is a genuine two-member union the server can narrow with
 * a plain `"policy" in envelope` check (each branch's type has one property
 * and lacks the other entirely, so `in` narrows cleanly). */
const callEnvelopeWithPolicySchema = z
  .object({
    version: versionSchema,
    brief: briefSchema,
    policy: callPolicySchema,
    execution: callExecutionSchema.optional()
  })
  .strict();

const callEnvelopeWithGuardrailsSchema = z
  .object({
    version: versionSchema,
    brief: briefSchema,
    guardrails: z.array(z.string().min(1)),
    execution: callExecutionSchema.optional()
  })
  .strict();

/** Cross-plane checks the two branch schemas cannot express on their own.
 *
 * Both rules here exist because a plane that describes a capability and a plane
 * that enforces it can be declared apart, and the gap between them is invisible
 * until something exploits it.
 *
 * The IVR pairing: `composePolicy` is pure over `CallPolicy` and narrows the
 * voicemail rail on `policy.ivr`. Without this check a caller could narrow that
 * rail — telling the model a menu may answer — while declaring no
 * `press_digits` tool, stranding it on a tree it has no way to navigate.
 *
 * The spend pairing: `policy.authority.spend` is prose, and prose is advisory.
 * A live matrix run had the model agree to 430 against a 250 ceiling and record
 * it as a completed call on three of four cells. Requiring
 * `execution.spendCeiling` alongside it means an envelope that grants spending
 * authority and declares somewhere to record the result cannot leave that
 * record unbounded — the gap closes by construction rather than by remembering. */
export const callEnvelopeSchema = z
  .union([callEnvelopeWithPolicySchema, callEnvelopeWithGuardrailsSchema])
  .superRefine((env, ctx) => {
    if (env.version === 1 && env.execution !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution"],
        message: "execution requires version 2"
      });
    }
    if ("policy" in env) {
      const policyIvr = env.policy.ivr !== undefined;
      const execIvr = env.execution?.ivr !== undefined;
      if (policyIvr !== execIvr) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["execution", "ivr"],
          message: "policy.ivr and execution.ivr must both be present or both absent"
        });
      }

      const spend = env.policy.authority.spend;
      const ceiling = env.execution?.spendCeiling;
      // Only when there is a record to bound. A call that may spend but records
      // nothing has nothing for a ceiling to act on.
      if (spend !== undefined && env.execution?.outcome !== undefined && ceiling === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["execution", "spendCeiling"],
          message:
            "policy.authority.spend grants spending authority and execution.outcome records the result, so " +
            "execution.spendCeiling must bind the two — an advisory-only ceiling is not enforced anywhere"
        });
      }
      if (ceiling !== undefined && spend === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["execution", "spendCeiling"],
          message:
            "execution.spendCeiling requires policy.authority.spend, or the model is never told the limit it is held to"
        });
      }
      if (ceiling !== undefined && spend !== undefined && ceiling.limit !== spend.limit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["execution", "spendCeiling", "limit"],
          message: "execution.spendCeiling.limit must equal policy.authority.spend.limit"
        });
      }
    }

    // Applies to both branches: a ceiling on a field nobody records is inert,
    // and reads as protection.
    const ceiling = env.execution?.spendCeiling;
    if (ceiling !== undefined) {
      const declared = env.execution?.outcome?.fields.map((f) => f.name) ?? [];
      if (!declared.includes(ceiling.field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["execution", "spendCeiling", "field"],
          message: `execution.spendCeiling.field "${ceiling.field}" is not one of the declared outcome fields`
        });
      }
    }
  });

export type CallExecutionShape = z.infer<typeof callExecutionSchema>;
export type CallEnvelopeWithPolicy = z.infer<typeof callEnvelopeWithPolicySchema>;
export type CallEnvelopeWithGuardrails = z.infer<typeof callEnvelopeWithGuardrailsSchema>;
export type CallEnvelope = CallEnvelopeWithPolicy | CallEnvelopeWithGuardrails;

/** Strict parse — unknown fields, bad enums, and missing required fields all
 * throw a ZodError with a field path. A config-driven interface makes a silent
 * typo dangerous, so we reject rather than ignore. */
export function parseCallPolicy(input: unknown): CallPolicy {
  return callPolicySchema.parse(input);
}

/** Parses a call envelope carrying EXACTLY ONE of a typed `policy` or raw
 * `guardrails[]`. Both-present, neither-present, unknown fields, a bad
 * version, and a malformed `brief`/`policy` all throw a ZodError. */
export function parseCallEnvelope(input: unknown): CallEnvelope {
  return callEnvelopeSchema.parse(input);
}
