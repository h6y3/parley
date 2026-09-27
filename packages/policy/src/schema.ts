import { z } from "zod";
import {
  CALL_MAX_DURATION_SECONDS,
  CALL_MAX_PRESSES,
  MEETING_MAX_DURATION_SECONDS,
  MEETING_MAX_PRESSES,
  SEND_DIGITS_MAX_LENGTH,
  SEND_DIGITS_PATTERN
} from "@parley/core";

/** Bumped for the execution plane. Both versions are accepted: a v1 envelope is
 * valid and simply gets no execution plane. */
export const WIRE_VERSION = 2;

const versionSchema = z.union([z.literal(1), z.literal(2)]);

/** Every negated form `phrase` collides with around the standalone word
 * "do" — the one word call `CA0573ebc91a165c9c0230f8890915f87b` (2026-08-20)
 * found the hole in. Two shapes, both built by leaving the rest of the
 * phrase untouched and only touching the word "do" itself, because that is
 * exactly what happened live: the accepted phrase was "please do", the room
 * said "please dont take notes" — a flat REFUSAL — and it granted consent,
 * because `findConsentMatch` (`@parley/core`'s `execution.ts`) does plain
 * `normalized.includes(needle)` and "dont"/"don't"/"do not" all START WITH
 * "do". So: (1) "do" replaced by "do not"/"don't"/"dont" (catches "do" as
 * the phrase's LAST word — the "please do" case, since the original phrase
 * stays a PREFIX of the replacement); (2) a bare "not"/"never"/"no" landing
 * directly in front of "do" (catches "do" as the phrase's FIRST word, since
 * the original then stays a SUFFIX of the result). An occurrence of "do" in
 * the middle of a phrase triggers neither shape, and that is not an
 * oversight: splicing a word into the middle of a string cannot leave the
 * original intact as a contiguous substring of the result, so no version of
 * this check could catch that case without producing a DIFFERENT phrase
 * than what was actually said — see `collidesWithOwnDoNegation` below. */
function negatedDoVariants(normalized: string): string[] {
  const words = normalized.split(" ").filter((w) => w.length > 0);
  const variants: string[] = [];
  words.forEach((word, i) => {
    if (word !== "do") return;
    const before = words.slice(0, i);
    const after = words.slice(i + 1);
    for (const fused of ["do not", "don't", "dont"]) {
      variants.push([...before, fused, ...after].join(" "));
    }
    for (const bare of ["not", "never", "no"]) {
      variants.push([...before, bare, "do", ...after].join(" "));
    }
  });
  return variants;
}

/** `true` means `phrase` is unsafe: it (or a "do"-negated rewrite of it) is a
 * substring of that same rewrite, which is exactly the shape that let a
 * refusal grant consent on 2026-08-20. Honesty about scope, because the
 * comment above `negatedDoVariants` earns nothing if this claims more than
 * it checks: this function knows exactly one word, "do". A phrase built
 * around "go", "take", "begin", or any other verb is not covered, and a
 * `false` result here is not proof that phrase is safe against every way
 * English can negate a sentence — only against this one, concretely-observed
 * failure. Ordering (`findConsentMatch`, `@parley/core`) is what actually
 * carries the rest of that burden, same as it does for the two-word floor
 * below.
 *
 * Normalizes with the same three operations as `normalizePhrase`
 * (`@parley/core`'s `execution.ts` — lowercase, collapse whitespace, trim)
 * so this predicts the exact comparison `findConsentMatch` performs at
 * runtime. Reimplemented rather than imported: it is three operations, and
 * this is a schema-validation concern that belongs with the two-word floor
 * it sits next to, not a reason to widen `@parley/core`'s public surface. */
function collidesWithOwnDoNegation(phrase: string): boolean {
  const normalized = phrase.toLowerCase().replace(/\s+/g, " ").trim();
  return negatedDoVariants(normalized).some((variant) => variant.includes(normalized));
}

/** One acceptable consent utterance — shared by `consent.phrase` (required,
 * the common single-phrase case) and each entry of `consent.additionalPhrases`
 * (optional extras), so both are held to the same floor.
 *
 * The floor is two words, not four. Four words was guarding against the
 * phrase being said BY ACCIDENT and counting as consent — a real risk, but
 * length was the wrong instrument for it: it turns the phrase into a
 * password rather than something a person says, and a live call proved the
 * cost of that directly — the declared phrase was "go ahead and take
 * notes", the principal answered "go ahead", and the gate refused a real
 * human doing the obvious thing. The risk a length floor was standing in
 * for is actually about ORDERING — an utterance heard before the agent's
 * request is consent to nothing — and `findConsentMatch`
 * (`@parley/core`'s `execution.ts`) enforces exactly that. With ordering
 * doing the protective work, two words is enough that a bare "yes" or a
 * stray "sure" still cannot carry it alone, while staying short enough that
 * "go ahead" works. */
const consentPhraseSchema = z
  .string()
  .trim()
  .min(1)
  .refine((p) => p.trim().split(/\s+/).length >= 2, {
    message:
      "consent phrase must be at least two words — ordering (it must be heard after the " +
      "agent's own request), not length, is what protects against a stray utterance counting " +
      "as consent"
  })
  .refine((p) => !collidesWithOwnDoNegation(p), {
    message:
      'consent phrase collides with its own negation around the word "do" — a room saying ' +
      '"dont"/"don\'t"/"do not" this phrase would still match it by substring, turning a ' +
      "REFUSAL into a granted consent (see CA0573ebc91a165c9c0230f8890915f87b, 2026-08-20) — " +
      'choose a phrase that isn\'t built around "do"'
  });

export const callExecutionSchema = z
  .object({
    ivr: z
      .object({
        // Bound raised to the meeting maximum; the superRefine below restores
        // 20 for every envelope that is not a meeting. Same inversion as
        // limits.maxDurationSeconds below — see that field for why.
        maxPresses: z.number().int().min(1).max(MEETING_MAX_PRESSES),
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
        // Bound raised to the meeting maximum; the superRefine below restores
        // 1800 for every envelope that is not a meeting. Inverted deliberately:
        // zod validates the object before superRefine runs, so a bound left at
        // 1800 here can never be relaxed by a cross-field rule.
        maxDurationSeconds: z.number().int().min(30).max(MEETING_MAX_DURATION_SECONDS),
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
      .optional(),
    meeting: z
      .object({
        consent: z
          .object({
            phrase: consentPhraseSchema,
            // Optional so every existing single-phrase envelope keeps
            // parsing unchanged — `phrase` alone is still the common case.
            // Each entry is held to the same floor and the same
            // after-the-request ordering rule as `phrase` itself.
            additionalPhrases: z.array(consentPhraseSchema).optional(),
            timeoutSeconds: z.number().int().min(30).max(900),
            onTimeout: z.literal("hangUp")
          })
          .strict(),
        // Context for the meeting's downstream readout (A2, a separate
        // repository) — never read by anything in this call path, so it
        // cannot change what the model is told or does (see
        // `MeetingExecution.brief`, `@parley/core`, for the full reasoning).
        // The whole block, and every field inside it, is optional: a caller
        // who knows nothing about a meeting beyond its number must be able
        // to say so by omission rather than inventing a title, and partial
        // knowledge (a title with no track) is exactly as valid as full
        // knowledge. `.min(1)` on the strings and array entries below
        // matches every other free-text field in this schema and rejects an
        // empty string masquerading as "supplied" — a caller with nothing to
        // say should omit the field, not send `""`.
        brief: z
          .object({
            title: z.string().min(1).optional(),
            topic: z.string().min(1).optional(),
            role: z.string().min(1).optional(),
            // `.min(1)` on the ARRAY as well as its items: an empty list is not a
            // weaker directive, it is no directive, and storing `[]` makes a reader
            // distinguish "no tracks" from "absent" for no gain. The record schema's
            // description promises a present track is non-empty; this is what makes
            // that promise true rather than aspirational.
            track: z.array(z.string().min(1)).min(1).optional()
          })
          .strict()
          .optional()
        // No `announce` here. The prose the room hears is composed from
        // `policy.meeting.purpose` (see `meetingAnnounce` in constants.ts);
        // this block had a second, required `announce.purpose` that nothing
        // read, so setting it and leaving the policy one unset made the room
        // hear the default with no error. `.strict()` below now REJECTS it,
        // which is the point — a caller who still sends it finds out.
      })
      .strict()
      .optional(),
    // Carrier-side DTMF at origination — Twilio's SendDigits, played before
    // the model or the media stream exists. Deliberately carries no `policy`
    // pairing below, unlike `ivr`/`meeting` above: those pairings exist
    // because the model must be told, in prose, what it may do with a tool.
    // There is nothing for the model to be told here — the carrier has
    // already played the tones by the time the model is on the line — so
    // `execution.dial` needs no matching `policy` field, checked or
    // otherwise, and may appear alongside either a typed `policy` or raw
    // `guardrails[]`. See `CallExecution.dial` (@parley/core) for the fuller
    // design note.
    dial: z
      .object({
        sendDigits: z.string().min(1).max(SEND_DIGITS_MAX_LENGTH).regex(SEND_DIGITS_PATTERN)
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((execution, ctx) => {
    const isMeeting = execution.meeting !== undefined;
    if (!isMeeting && (execution.limits?.maxDurationSeconds ?? 0) > CALL_MAX_DURATION_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["limits", "maxDurationSeconds"],
        message: `maxDurationSeconds above ${CALL_MAX_DURATION_SECONDS} requires execution.meeting`
      });
    }
    if (!isMeeting && (execution.ivr?.maxPresses ?? 0) > CALL_MAX_PRESSES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ivr", "maxPresses"],
        message: `maxPresses above ${CALL_MAX_PRESSES} requires execution.meeting`
      });
    }
  });

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
    extraGuardrails: z.array(z.string().min(1)).optional(),
    meeting: z
      .object({ announce: z.boolean(), purpose: z.string().min(1).optional() })
      .strict()
      .optional()
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
    preferences: z.array(z.string().min(1)).optional(),
    operation: z
      .object({
        id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/),
        attempt: z.number().int().min(1),
        maxAttempts: z.number().int().min(1).max(10)
      })
      .strict()
      .refine((operation) => operation.attempt <= operation.maxAttempts, {
        message: "operation attempt must not exceed maxAttempts"
      })
      .optional()
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
 * record unbounded — the gap closes by construction rather than by remembering.
 *
 * The meeting pairing: `composePolicy` composes the four meeting rails
 * (announce, ask for objections, notetaker scope) off `policy.meeting.announce`
 * ALONE — see the `order: 15` meeting rail in compose.ts. Without this check an
 * envelope could carry `policy.meeting.announce: true` and no
 * `execution.meeting`: the model is instructed to tell a room it will take
 * notes and to call `begin_notetaking` on the go-ahead, but the tool is never
 * declared, so it cannot be called, `CallSession.isMeeting` is false, and
 * nothing — including request-handler.ts's transcription-plane guard, which
 * keys on the exact same `execution.meeting !== undefined` — ever fires. A
 * room told an AI will take notes, no notes taken, agent still live on the
 * speaking plane: the defect the transcription-plane fix exists to prevent,
 * reached through the one door that check cannot see, because from
 * `execution`'s side alone this envelope looks like an ordinary call.
 *
 * The meeting-shape rejections (below, gated on the same `policyMeeting`):
 * five OPTIONAL policy fields — `authority.spend`, `authority.
 * authorizedCommitments`, `callback`, `wrapUp`, `voicemail` — that a
 * two-party-call envelope can carry but that are meaningless once
 * `policy.meeting.announce` is true, rejected outright rather than silently
 * composing no rail for them. Same mechanism as the pairings above, extended
 * rather than duplicated. The policy schema's five REQUIRED fields
 * (`identity`, `disclosure`, `scope`, `grounding`, `deferral`) are equally
 * meaningless for a meeting but cannot be rejected here — a meeting envelope
 * cannot omit a required field — so those are suppressed at the composer by
 * shape instead (`compose.ts`'s rail-set selection). Two different fixes for
 * the same defect, forced apart by which fields the schema lets a caller
 * decline. */
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

      // `policy.meeting.announce: false` (or an absent `announce`) composes no
      // meeting rail at all — see compose.ts's `p.meeting?.announce ? [...] :
      // []` — so it carries none of the promise `execution.meeting` exists to
      // keep, and pairing on mere object presence would reject a harmless
      // combination. `announce === true` is the exact condition that matters.
      const policyMeeting = env.policy.meeting?.announce === true;
      const execMeeting = env.execution?.meeting !== undefined;
      if (policyMeeting !== execMeeting) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["execution", "meeting"],
          message:
            "policy.meeting.announce and execution.meeting must both be present or both absent"
        });
      }

      // Fields meaningless for a meeting notetaker, REJECTED outright rather
      // than silently suppressed. `identity`, `disclosure`, `scope`,
      // `grounding`, and `deferral` are meaningless for a meeting too, but the
      // policy schema REQUIRES all five, so a meeting envelope cannot omit
      // them — there is nothing here to reject, and composePolicy's
      // shape-based rail-set selection (`compose.ts`) suppresses their rails
      // at the composer instead. These five are different: each is OPTIONAL,
      // so a caller CAN decline it, and a caller who sets one on a meeting
      // envelope has copied a phone-call envelope and is wrong about what
      // this call will do. Silently ignoring the field — composing no rail
      // for it and saying nothing — would hide that mistake rather than
      // surface it, so this rejects instead, the same way the ivr and meeting
      // pairings above reject rather than silently drop. Every message here
      // names the field and says why it cannot act for a notetaker: the agent
      // goes voiceless the instant consent is granted
      // (`TranscriptionSession`, @parley/core, has no outbound method), and
      // before that its only job is one announcement and one question.
      if (policyMeeting) {
        const rejectedForMeeting: Array<{
          path: (string | number)[];
          present: boolean;
          reason: string;
        }> = [
          {
            path: ["policy", "authority", "spend"],
            present: env.policy.authority.spend !== undefined,
            reason:
              "the agent can never negotiate or quote a price on a meeting — it goes voiceless " +
              "the instant consent is granted, and before that its only job is announcing " +
              "itself and asking for consent"
          },
          {
            path: ["policy", "authority", "authorizedCommitments"],
            present: env.policy.authority.authorizedCommitments !== undefined,
            reason:
              "the agent can never confirm or commit to anything on a meeting — it is a " +
              "notetaker, not a negotiator, and is silent for the entire meeting once consent " +
              "is granted"
          },
          {
            path: ["policy", "callback"],
            present: env.policy.callback !== undefined,
            reason:
              "a callback number is something the agent gives out when asked, and a meeting " +
              "notetaker is never asked anything — it cannot answer once notetaking has begun, " +
              "and has nothing to answer before that beyond its own consent question"
          },
          {
            path: ["policy", "wrapUp"],
            present: env.policy.wrapUp !== undefined,
            reason:
              "wrap-up is a goodbye ceremony for a call the agent is closing; a meeting " +
              "notetaker never closes the meeting, and cannot speak a wrap-up even if it wanted " +
              "to once notetaking has begun"
          },
          {
            path: ["policy", "voicemail"],
            present: env.policy.voicemail !== undefined,
            reason:
              "voicemail is an outbound-dial concept for when the far end never answers; a " +
              "meeting is joined via a bridge, and there is no voicemail state to reach"
          }
        ];
        for (const field of rejectedForMeeting) {
          if (field.present) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: field.path,
              message: `${field.path.join(".")} is meaningless for a meeting notetaker: ${field.reason}`
            });
          }
        }
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
