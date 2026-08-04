import { describe, expect, it } from "vitest";
import { z } from "zod";
import { composePolicy } from "../src/compose.js";
import { callPolicySchema } from "../src/schema.js";
import type { CallPolicy } from "../src/schema.js";

/**
 * Drift guard: every top-level key of CallPolicy must actually be consumed by
 * the composer. Without this test, a schema field can pass strict validation
 * and then be silently dropped by every rail — exactly what happened with
 * `deferral.followUpWith` and `callback.useForBookings` (both removed
 * alongside this test; see git history). Both of those dead fields lived one
 * level of nesting deep inside an object field (`deferral`, `callback`) — a
 * gap the original version of this guard (top-level-only) could not catch,
 * since a nested field can come and go without touching the top-level key
 * set at all. See "nested key-set match" below for the fix.
 *
 * Mechanical checks:
 *
 *  1. Top-level key-set match — the fully-populated `full` fixture below
 *     must declare EXACTLY the same top-level keys as `callPolicySchema`. If
 *     a new top-level field is added to the schema and this file isn't
 *     updated, this assertion fails immediately, before rail coverage is
 *     even considered.
 *
 *  2. Nested key-set match — for every top-level field whose value is
 *     itself an object (`disclosure`, `scope`, `grounding`, `deferral`,
 *     `authority`, `callback`, `wrapUp`, `voicemail`), the fixture's nested
 *     keys must match the schema's nested keys EXACTLY. The schema side is
 *     derived from the live zod shape (`callPolicySchema.shape.<field>`,
 *     unwrapped via `.unwrap()` when it's `.optional()`) rather than hand-
 *     listed, so a brand-new nested leaf — like a re-added
 *     `deferral.followUpWith` — changes the derived key set automatically
 *     and this assertion fails the moment the schema changes, with no
 *     separate edit required to "notice" the new field. `identity` (a
 *     discriminated union, not a plain object with a `.shape`),
 *     `pronunciation` / `extraGuardrails` (arrays), and `principalName` (a
 *     bare scalar) are structurally different and excluded from this
 *     check — each has its own participation test below instead.
 *
 *  3. Participation — for every key from (1) and (2), removing it (or, for
 *     a required boolean, flipping it to the value that would NOT fire its
 *     rail) changes composePolicy's output. A field that passes (1)/(2) but
 *     fails (3) is a field present on the wire with no rail reading it.
 *
 * `principalName` is exempt from "has its own rail sentence" — it has no
 * dedicated prose the way e.g. scope.lock has SCOPE_STATEMENT. It IS
 * consumed, though: it's interpolated into onBehalfIntro, honestIfAsked,
 * deferralRule, alwaysDeferRule, authorityRule, callbackRule, and
 * voicemailLeaveMessage. We prove participation the only way that makes
 * sense for an interpolated value: changing it changes the output.
 */

/** The top-level CallPolicy fields whose value is itself a nested object,
 * checked leaf-by-leaf below. Deliberately excludes `identity` (discriminated
 * union), `pronunciation` / `extraGuardrails` (arrays), and `principalName`
 * (scalar) — none of those have a `.shape` to derive keys from, and each is
 * covered by its own dedicated participation test in this file. */
const NESTED_OBJECT_FIELDS = [
  "disclosure",
  "scope",
  "grounding",
  "deferral",
  "authority",
  "callback",
  "wrapUp",
  "voicemail"
] as const satisfies readonly (keyof CallPolicy)[];

/** Unwrap a `.optional()` wrapper (if present) and return the inner
 * ZodObject's own declared keys — the schema's canonical, always-current
 * leaf list for a nested field. Throws if the field isn't ultimately a plain
 * object, which would mean this helper was pointed at the wrong kind of
 * field (e.g. `identity`'s discriminated union). */
function nestedSchemaLeafKeys(zodType: z.ZodTypeAny): string[] {
  const unwrapped = zodType instanceof z.ZodOptional ? zodType.unwrap() : zodType;
  if (!(unwrapped instanceof z.ZodObject)) {
    throw new Error(
      "nestedSchemaLeafKeys: expected a ZodObject, optionally wrapped in .optional()"
    );
  }
  return Object.keys(unwrapped.shape).sort();
}

// Every optional field present; every boolean set to the value that makes
// its rail fire.
const full: CallPolicy = {
  principalName: "Alex Rivera",
  identity: { style: "onBehalf", role: "personal assistant" },
  disclosure: { honestIfAsked: true, volunteer: true },
  scope: { lock: true },
  grounding: { antiInvention: true },
  deferral: { enabled: true },
  authority: {
    authorizedCommitments: ["A table for four at 7pm is fine."],
    alwaysDefer: ["Legal waivers."]
  },
  callback: { number: "+15551234567" },
  wrapUp: { enabled: true },
  voicemail: { onMachine: "leaveMessage" },
  pronunciation: ["Pronounce the last name Rivera as ree-VAIR-uh."],
  extraGuardrails: ["Custom note."]
};

function composed(p: CallPolicy): string {
  return composePolicy(p).join("\n---\n");
}

// Removes an optional top-level key from `full` while keeping everything
// else identical. `Partial<CallPolicy>` makes the delete legal (the field is
// genuinely optional on CallPolicy); the cast back documents that the result
// is still a valid CallPolicy with that one key absent.
function omit<K extends keyof CallPolicy>(key: K): CallPolicy {
  const clone: Partial<CallPolicy> = { ...full };
  delete clone[key];
  return clone as CallPolicy;
}

const baseline = composed(full);

describe("schema/composer rail coverage (drift guard)", () => {
  it("the fully-populated policy composes a non-empty guardrail set", () => {
    expect(composePolicy(full).length).toBeGreaterThan(0);
  });

  it("full fixture's top-level keys match the schema exactly", () => {
    const schemaKeys = Object.keys(callPolicySchema.shape).sort();
    const fixtureKeys = Object.keys(full).sort();
    expect(fixtureKeys).toEqual(schemaKeys);
  });

  it.each(NESTED_OBJECT_FIELDS)(
    "full fixture's nested keys for %s match the schema exactly (derived from the live zod shape, not hand-listed)",
    (field) => {
      const schemaKeys = nestedSchemaLeafKeys(callPolicySchema.shape[field]);
      const fixtureValue = full[field] as Record<string, unknown> | undefined;
      if (!fixtureValue) {
        throw new Error(
          `full.${field} must be populated in this fixture to exercise nested-key coverage`
        );
      }
      const fixtureKeys = Object.keys(fixtureValue).sort();
      expect(fixtureKeys).toEqual(schemaKeys);
    }
  );

  it("principalName participates (interpolated, no dedicated rail sentence — documented exemption)", () => {
    const mutated: CallPolicy = { ...full, principalName: "SomeoneElse" };
    expect(composed(mutated)).not.toBe(baseline);
  });

  it("identity participates", () => {
    const mutated: CallPolicy = { ...full, identity: { style: "self" } };
    expect(composed(mutated)).not.toBe(baseline);
  });

  it("disclosure.honestIfAsked participates", () => {
    const mutated: CallPolicy = {
      ...full,
      disclosure: { ...full.disclosure, honestIfAsked: false }
    };
    expect(composed(mutated)).not.toBe(baseline);
  });

  it("disclosure.volunteer participates", () => {
    const mutated: CallPolicy = { ...full, disclosure: { ...full.disclosure, volunteer: false } };
    expect(composed(mutated)).not.toBe(baseline);
  });

  it("scope.lock participates", () => {
    const mutated: CallPolicy = { ...full, scope: { lock: false } };
    expect(composed(mutated)).not.toBe(baseline);
  });

  it("grounding.antiInvention participates", () => {
    const mutated: CallPolicy = { ...full, grounding: { antiInvention: false } };
    expect(composed(mutated)).not.toBe(baseline);
  });

  it("deferral.enabled participates", () => {
    const mutated: CallPolicy = { ...full, deferral: { enabled: false } };
    expect(composed(mutated)).not.toBe(baseline);
  });

  it("authority.authorizedCommitments participates", () => {
    const mutated: CallPolicy = { ...full, authority: { alwaysDefer: full.authority.alwaysDefer } };
    expect(composed(mutated)).not.toBe(baseline);
  });

  it("authority.alwaysDefer participates", () => {
    const mutated: CallPolicy = {
      ...full,
      authority: { authorizedCommitments: full.authority.authorizedCommitments }
    };
    expect(composed(mutated)).not.toBe(baseline);
  });

  it("callback participates", () => {
    expect(composed(omit("callback"))).not.toBe(baseline);
  });

  it("wrapUp.enabled participates", () => {
    const mutated: CallPolicy = { ...full, wrapUp: { enabled: false } };
    expect(composed(mutated)).not.toBe(baseline);
  });

  it("voicemail participates", () => {
    expect(composed(omit("voicemail"))).not.toBe(baseline);
  });

  it("pronunciation participates", () => {
    expect(composed(omit("pronunciation"))).not.toBe(baseline);
  });

  it("extraGuardrails participates", () => {
    expect(composed(omit("extraGuardrails"))).not.toBe(baseline);
  });
});
