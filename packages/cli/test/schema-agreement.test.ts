import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Validator } from "jsonschema";
import { JOIN_OUTCOMES, MEETING_TRANSPORTS } from "@parley/core";
import {
  MEETING_RECORD_INVARIANTS,
  MEETING_STATUSES,
  meetingRecordSchema,
  type MeetingRecordFields,
  type MeetingRecordInvariant
} from "../src/meeting-record.js";

/** The committed JSON Schema is the ONLY thing the downstream Python consumer
 * validates against, and its cross-cutting invariants are a projection of
 * `MEETING_RECORD_INVARIANTS`. `test/emit-schema.test.ts` proves the committed
 * file matches what the generator produces; this proves the generator's output
 * and the zod runtime reach the SAME VERDICT on real records.
 *
 * This file used to enumerate invariants by hand, one row per case. That is
 * the shape of test that let the defect it was written for survive: a third
 * invariant added with no row left the suite green. It enumerates INPUTS now,
 * not invariants — the cartesian product of every field any invariant reads —
 * and the two derivations are compared on all of them. Adding an invariant
 * that reads a field this matrix does not vary fails the coverage check at the
 * bottom, which is the only maintenance this file should ever need. */
function repoRootSchemaPath(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return join(testDir, "..", "..", "..", "schema", "meeting-record.schema.json");
}

const receipt = {
  requestedAt: "2026-08-19T17:00:00.000Z",
  grantedAt: "2026-08-19T17:00:00.000Z",
  phrase: "go ahead and take notes",
  utterances: []
};

/** Everything no invariant reads. Held constant so a disagreement can only
 * ever be about a rule, never about a shape error in the fixture. */
const base = {
  version: 1 as const,
  kind: "meeting" as const,
  callId: "CA1",
  startedAt: "2026-08-19T17:00:00.000Z",
  endedAt: "2026-08-19T17:45:00.000Z",
  durationSeconds: 2700,
  endedReason: "far_end" as const,
  gapMs: 0,
  coveredMs: 2_700_000
};

/** One axis per field the invariant table reads, carrying every value that
 * could change a verdict. `undefined` means the key is OMITTED from the
 * record, which is a different input from a present key — several clauses turn
 * on exactly that distinction.
 *
 * Keyed against `MeetingRecordFields` itself, not a plain `string` — a typo'd
 * or renamed key here is a compile error rather than a field that silently
 * stops being varied. That typing is only half the guarantee: it keeps this
 * object's keys anchored to the record, the same way `MeetingRecordInvariant`
 * ["reads"](../src/meeting-record.js) keeps each invariant's declared inputs
 * anchored to it, but it does not by itself connect the two — the coverage
 * test below (`varies every field an invariant declares it reads`) is what
 * checks THAT connection, so an invariant and this object can no longer drift
 * from each other any more than either can drift from the record. */
const axes = {
  status: [...MEETING_STATUSES],
  transcriptPath: [null, "/tmp/t.jsonl"],
  consentReceipt: [null, receipt],
  transport: [undefined, ...MEETING_TRANSPORTS],
  joinOutcome: [undefined, ...JOIN_OUTCOMES]
} satisfies Partial<Record<keyof MeetingRecordFields, readonly unknown[]>>;

function matrix(): Record<string, unknown>[] {
  let records: Record<string, unknown>[] = [{ ...base }];
  for (const [field, values] of Object.entries(axes)) {
    const next: Record<string, unknown>[] = [];
    for (const record of records) {
      for (const value of values) {
        // An omitted key, not a key set to undefined: `JSON.stringify` drops
        // the latter, so a record carrying one is not a record any consumer
        // could ever receive, and draft-07's `required` would disagree with
        // zod about it for reasons that have nothing to do with an invariant.
        next.push(value === undefined ? { ...record } : { ...record, [field]: value });
      }
    }
    records = next;
  }
  return records;
}

function describeRecord(record: Record<string, unknown>): string {
  const varied = Object.keys(axes).map(
    (field) => `${field}=${field in record ? JSON.stringify(record[field]) : "<absent>"}`
  );
  return varied.join(" ");
}

describe("the zod schema and the committed JSON Schema agree", () => {
  it("reaches the same verdict on every combination of every field an invariant reads", async () => {
    const committed: object = JSON.parse(await readFile(repoRootSchemaPath(), "utf8"));
    const validator = new Validator();

    for (const record of matrix()) {
      const zodValid = meetingRecordSchema.safeParse(record).success;
      const jsonSchemaValid = validator.validate(record, committed).valid;
      expect(
        jsonSchemaValid,
        `zod said ${zodValid} and the committed JSON Schema said ${jsonSchemaValid} for: ${describeRecord(record)}`
      ).toBe(zodValid);
    }
  });

  /** The consequence of `removeAdditionalStrategy: "strict"`
   * (`src/emit-schema.ts`), asserted where it is actually felt: the two
   * derivations must agree that an unknown field is FINE.
   *
   * Both artifacts are additive-within-a-major with unknown fields ignored,
   * and the zod schema is deliberately not `.strict()` for that reason. Drop
   * that one option from the generator and zod-to-json-schema's default takes
   * over — `additionalProperties: false` — so this repository writes a record
   * its own committed schema rejects, and the failure surfaces in another
   * repository rather than here. It is the sort of defect a test suite in
   * this repository can only catch deliberately.
   *
   * `futureField` stands for whatever a later 1.x writer adds. The record is
   * otherwise a valid one, so a disagreement can only be about the unknown
   * key. */
  it("both accept a record carrying a field neither has been told about", async () => {
    const committed: object = JSON.parse(await readFile(repoRootSchemaPath(), "utf8"));
    const validator = new Validator();
    const record = {
      ...base,
      status: "never_joined",
      transport: "browser",
      transcriptPath: null,
      consentReceipt: null,
      futureField: "written by a later 1.x producer"
    };

    expect(meetingRecordSchema.safeParse(record).success).toBe(true);
    expect(validator.validate(record, committed).valid).toBe(true);
  });

  /** `realtime` and `firstModelAudioMs` are read by the provider A/B, in the
   * consumer, against the committed file. Additive and optional, so the case
   * worth pinning is the one a mis-projected field would get wrong: both
   * derivations must accept the fields present and absent, and both must
   * reject the same malformed values. */
  it("agrees on realtime and firstModelAudioMs, present, absent and malformed", async () => {
    const committed: object = JSON.parse(await readFile(repoRootSchemaPath(), "utf8"));
    const validator = new Validator();
    const valid = {
      ...base,
      status: "never_joined",
      transcriptPath: null,
      consentReceipt: null
    };
    const cases: ReadonlyArray<{ fields: Record<string, unknown>; ok: boolean }> = [
      { fields: {}, ok: true },
      { fields: { realtime: { provider: "deepgram", model: "gpt-4o-mini" } }, ok: true },
      {
        fields: {
          realtime: { provider: "gemini", model: "gemini-3.8-live" },
          firstModelAudioMs: 0
        },
        ok: true
      },
      { fields: { firstModelAudioMs: 1234 }, ok: true },
      { fields: { firstModelAudioMs: -1 }, ok: false },
      { fields: { firstModelAudioMs: "1234" }, ok: false },
      { fields: { realtime: { provider: "deepgram" } }, ok: false },
      { fields: { realtime: { model: "gpt-4o-mini" } }, ok: false },
      { fields: { realtime: "deepgram" }, ok: false }
    ];

    for (const { fields, ok } of cases) {
      const record = { ...valid, ...fields };
      const label = JSON.stringify(fields);
      expect(meetingRecordSchema.safeParse(record).success, `zod on ${label}`).toBe(ok);
      expect(validator.validate(record, committed).valid, `JSON Schema on ${label}`).toBe(ok);
    }
  });

  /** Without this, an invariant reading a field the matrix does not vary would
   * be tested by nothing while every assertion above still passed — the same
   * blind spot, one level up. An invariant that never fires across the whole
   * product is an invariant this file cannot speak for. */
  it("exercises every invariant in the table, and still admits a valid record", async () => {
    const records = matrix();
    const fired = new Set<string>();
    let valid = 0;

    for (const record of records) {
      const parsed = meetingRecordSchema.safeParse(record);
      if (parsed.success) {
        valid += 1;
        continue;
      }
      for (const issue of parsed.error.issues) fired.add(issue.message);
    }

    for (const invariant of MEETING_RECORD_INVARIANTS) {
      expect(
        fired.has(invariant.message),
        `no record in the matrix violates "${invariant.id}" — add the field it reads to \`axes\``
      ).toBe(true);
    }
    expect(
      valid,
      "every record in the matrix is invalid, so agreement above proves nothing"
    ).toBeGreaterThan(0);
  });

  /** Firing at least once (above) proves an invariant fires; it does not
   * prove the matrix VARIES the fields that invariant's predicate reads. A
   * field an invariant reads but the matrix holds constant is compared at
   * exactly one value in the agreement test above — a clause mishandling
   * every other value drifts undetected. `reads` (`MeetingRecordInvariant`,
   * ../src/meeting-record.js) declares those fields against the record's own
   * keys, so a typo or rename fails to compile; this is the runtime half —
   * every declared field must be one `axes` actually varies (more than one
   * value), not merely one it happens to hold. */
  it("varies every field an invariant declares it reads", () => {
    const variedFields = new Set(
      Object.entries(axes)
        .filter(([, values]) => values.length > 1)
        .map(([field]) => field)
    );

    for (const invariant of MEETING_RECORD_INVARIANTS) {
      for (const field of invariant.reads) {
        expect(
          variedFields.has(field),
          `invariant "${invariant.id}" reads "${field}", which \`axes\` does not vary (fewer ` +
            "than two values) — its JSON Schema clause is only ever compared against one value " +
            "of that field, so a mismatch at any other value would go undetected"
        ).toBe(true);
      }
    }
  });

  /** `axes` decides what the only cross-language comparison in this
   * repository actually compares, and until now nothing constrained its
   * VALUES. The coverage test above requires each declared-read field to
   * carry more than one value; a field trimmed from five values to two
   * satisfies that and silently deletes three cases from the matrix, with the
   * whole suite still green. Enum-backed axes are pinned by SET EQUALITY
   * against the enum itself, so trimming one fails here rather than passing
   * quietly.
   *
   * The two nullable axes carry no enum to compare against, so they are held
   * to the equivalent claim about their own domain: each must offer the
   * absent form and a present one. A `transcriptPath` axis of two paths, or a
   * `consentReceipt` axis of two receipts, varies a field without varying the
   * thing every invariant reading it actually branches on. */
  it("varies every value of every enum an axis stands for, so trimming one fails here", () => {
    const enumAxes: ReadonlyArray<{
      readonly field: keyof typeof axes;
      readonly members: readonly string[];
      readonly optional: boolean;
    }> = [
      { field: "status", members: MEETING_STATUSES, optional: false },
      { field: "transport", members: MEETING_TRANSPORTS, optional: true },
      { field: "joinOutcome", members: JOIN_OUTCOMES, optional: true }
    ];

    for (const { field, members, optional } of enumAxes) {
      const values = axes[field] as readonly unknown[];
      const present = values.filter((value) => value !== undefined);
      expect(new Set(present), `${field} must vary every member of its enum`).toEqual(
        new Set<unknown>(members)
      );
      expect(present, `${field} must not repeat a member`).toHaveLength(members.length);
      // An OMITTED key is a distinct input from any present value, and both
      // optional fields have clauses that turn on exactly that distinction.
      expect(values.includes(undefined), `${field} is optional, so absence is a case`).toBe(
        optional
      );
    }
  });

  it("varies both the absent and the present form of every nullable axis", () => {
    for (const field of ["transcriptPath", "consentReceipt"] as const) {
      const values = axes[field] as readonly unknown[];
      expect(values.includes(null), `${field} must include null`).toBe(true);
      expect(
        values.some((value) => value !== null && value !== undefined),
        `${field} must include a present value`
      ).toBe(true);
    }
  });

  /** The coverage set two tests up is keyed on each invariant's `message`. If
   * two invariants shared one, whichever fired would satisfy the coverage
   * assertion for BOTH, and the other could never fire while the suite
   * stayed green. A loop beside that one, over the same table, is what makes
   * the keying safe rather than merely conventional. */
  it("keys every invariant by a distinct id and a distinct message", () => {
    const ids = new Set<string>();
    const messages = new Set<string>();

    for (const invariant of MEETING_RECORD_INVARIANTS) {
      expect(ids.has(invariant.id), `duplicate invariant id "${invariant.id}"`).toBe(false);
      ids.add(invariant.id);

      expect(
        messages.has(invariant.message),
        `duplicate invariant message "${invariant.message}" (id "${invariant.id}") — the ` +
          "coverage set above is keyed on message, so a duplicate would let one invariant " +
          "satisfy the other's coverage without ever firing itself"
      ).toBe(false);
      messages.add(invariant.message);
    }
  });

  it("expresses every invariant in the committed file a consumer actually reads", async () => {
    const committed = JSON.parse(await readFile(repoRootSchemaPath(), "utf8")) as {
      definitions: { MeetingRecord: { allOf?: { description?: string }[] } };
    };
    const descriptions = (committed.definitions.MeetingRecord.allOf ?? []).map(
      (clause) => clause.description ?? ""
    );

    expect(descriptions).toHaveLength(MEETING_RECORD_INVARIANTS.length);
    for (const invariant of MEETING_RECORD_INVARIANTS) {
      expect(
        descriptions.some((description) => description.startsWith(invariant.message)),
        `the committed schema carries no clause for "${invariant.id}" — re-run \`pnpm --filter @parley/cli run emit-schema\``
      ).toBe(true);
    }
  });
});

/** The property that actually closed the drift, asserted where a change to it
 * cannot pass unnoticed: `violatedBy`, `jsonSchema`, and — since `reads` was
 * added to close the coverage gap one level up — `reads` too are REQUIRED
 * members of one entry, so a partially-declared invariant is a COMPILE error
 * rather than a test someone has to remember to extend. Each
 * `@ts-expect-error` below fails `pnpm typecheck` — with "Unused
 * '@ts-expect-error' directive" — the moment that stops being true. There is
 * nothing to run here; being compiled is the whole assertion. Each fixture
 * below omits exactly one member (the other two are present but otherwise
 * meaningless) so the missing one, not some other one, is what the compiler
 * is proving is required. */
// @ts-expect-error -- an invariant with only its runtime half must not compile
const runtimeHalfOnly: MeetingRecordInvariant = {
  id: "runtime-half-only",
  message: "a partially-declared invariant must not compile",
  rationale: "it would enforce at runtime here and go unenforced in the consumer",
  path: ["status"],
  reads: ["status"],
  violatedBy: () => false
};

// @ts-expect-error -- an invariant with only its JSON Schema half must not compile
const schemaHalfOnly: MeetingRecordInvariant = {
  id: "schema-half-only",
  message: "a partially-declared invariant must not compile",
  rationale: "it would reject records downstream that this repository happily writes",
  path: ["status"],
  reads: ["status"],
  jsonSchema: { if: {}, then: {} }
};

// @ts-expect-error -- an invariant with no declared `reads` must not compile
const readsMissing: MeetingRecordInvariant = {
  id: "reads-missing",
  message: "a partially-declared invariant must not compile",
  rationale: "its clause could depend on a field the coverage matrix never has to vary",
  path: ["status"],
  violatedBy: () => false,
  jsonSchema: { if: {}, then: {} }
};

void runtimeHalfOnly;
void schemaHalfOnly;
void readsMissing;
