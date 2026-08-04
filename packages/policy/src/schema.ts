import { z } from "zod";

export const WIRE_VERSION = 1;

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
    scope: z.object({ lock: z.boolean() }).strict(),
    grounding: z.object({ antiInvention: z.boolean() }).strict(),
    deferral: z.object({ enabled: z.boolean() }).strict(),
    authority: z
      .object({
        authorizedCommitments: z.array(z.string().min(1)).optional(),
        alwaysDefer: z.array(z.string().min(1)).optional()
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
    facts: z.array(z.string())
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
    version: z.literal(WIRE_VERSION),
    brief: briefSchema,
    policy: callPolicySchema
  })
  .strict();

const callEnvelopeWithGuardrailsSchema = z
  .object({
    version: z.literal(WIRE_VERSION),
    brief: briefSchema,
    guardrails: z.array(z.string().min(1))
  })
  .strict();

export const callEnvelopeSchema = z.union([
  callEnvelopeWithPolicySchema,
  callEnvelopeWithGuardrailsSchema
]);

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
