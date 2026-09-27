import { describe, expect, it } from "vitest";
import { JOIN_OUTCOMES } from "@parley/core";
import { buildMeetingRecord, meetingRecordSchema } from "../src/meeting-record.js";

const base = {
  callId: "CA1",
  startedAt: "2026-08-19T17:00:00.000Z",
  endedAt: "2026-08-19T17:45:00.000Z",
  durationSeconds: 2700,
  endedReason: "far_end" as const,
  brief: { title: "Roadmap sync", topic: "Q4 scope", role: "observer", track: ["decisions"] },
  gapMs: 0,
  coveredMs: 2_700_000
};

describe("meeting record", () => {
  it("carries kind:meeting so a global post-call hook can route it", () => {
    const record = buildMeetingRecord({
      ...base,
      status: "completed",
      transcriptPath: "/tmp/t.jsonl",
      consentReceipt: {
        requestedAt: base.startedAt,
        grantedAt: base.startedAt,
        phrase: "go ahead and take notes",
        utterances: []
      }
    });
    expect(record.kind).toBe("meeting");
    expect(record.version).toBe(1);
    expect(meetingRecordSchema.safeParse(record).success).toBe(true);
  });

  it("REFUSES a consent_refused record that still names a transcript", () => {
    const parsed = meetingRecordSchema.safeParse({
      ...base,
      version: 1,
      kind: "meeting",
      status: "consent_refused",
      consentReceipt: null,
      transcriptPath: "/tmp/t.jsonl"
    });
    expect(parsed.success).toBe(false);
  });

  it("REFUSES a completed record with no consent receipt", () => {
    const parsed = meetingRecordSchema.safeParse({
      ...base,
      version: 1,
      kind: "meeting",
      status: "completed",
      consentReceipt: null,
      transcriptPath: "/tmp/t.jsonl"
    });
    expect(parsed.success).toBe(false);
  });

  it("ignores unknown fields rather than rejecting them — additive within a major", () => {
    const parsed = meetingRecordSchema.safeParse({
      ...base,
      version: 1,
      kind: "meeting",
      status: "completed",
      consentReceipt: {
        requestedAt: base.startedAt,
        grantedAt: base.startedAt,
        phrase: "go ahead and take notes",
        utterances: []
      },
      transcriptPath: "/tmp/t.jsonl",
      somethingFromVersion1Point1: true
    });
    expect(parsed.success).toBe(true);
  });
});

describe("meeting record brief", () => {
  const receipt = {
    requestedAt: "2026-08-19T17:00:00.000Z",
    grantedAt: "2026-08-19T17:00:00.000Z",
    phrase: "go ahead and take notes",
    utterances: []
  };

  // `base` (above) always carries a fully-populated brief — every test below
  // that needs a record with NO brief at all builds from this instead of
  // `base`, rather than destructuring `brief` out of `base` and discarding it
  // into an unused binding on every call site.
  const withoutBrief = {
    callId: base.callId,
    startedAt: base.startedAt,
    endedAt: base.endedAt,
    durationSeconds: base.durationSeconds,
    endedReason: base.endedReason,
    gapMs: base.gapMs,
    coveredMs: base.coveredMs
  };

  it("carries a fully-supplied brief through verbatim", () => {
    const record = buildMeetingRecord({
      ...base,
      status: "completed",
      transcriptPath: "/tmp/t.jsonl",
      consentReceipt: receipt
    });
    expect(record.brief).toEqual(base.brief);
  });

  it("omits brief entirely — not an object of empty strings — when none was supplied", () => {
    const record = buildMeetingRecord({
      ...withoutBrief,
      status: "completed",
      transcriptPath: "/tmp/t.jsonl",
      consentReceipt: receipt
    });
    expect(record).not.toHaveProperty("brief");
  });

  it("a title with no track is valid and round-trips — partial supply", () => {
    const record = buildMeetingRecord({
      ...withoutBrief,
      brief: { title: "Roadmap sync" },
      status: "completed",
      transcriptPath: "/tmp/t.jsonl",
      consentReceipt: receipt
    });
    expect(record.brief).toEqual({ title: "Roadmap sync" });
  });

  it("REFUSES an empty-string title — an absent field, not an empty one, is how 'unset' is said", () => {
    const parsed = meetingRecordSchema.safeParse({
      ...withoutBrief,
      version: 1,
      kind: "meeting",
      brief: { title: "" },
      status: "completed",
      transcriptPath: "/tmp/t.jsonl",
      consentReceipt: receipt
    });
    expect(parsed.success).toBe(false);
  });

  it("a record with no brief field at all still validates — brief never becomes required", () => {
    const parsed = meetingRecordSchema.safeParse({
      ...withoutBrief,
      version: 1,
      kind: "meeting",
      status: "never_joined",
      consentReceipt: null,
      transcriptPath: null
    });
    expect(parsed.success).toBe(true);
  });
});

describe("meeting record joinOutcome", () => {
  // At describe scope, not inside the first `it`: every test below builds
  // from the same failed-join record.
  const base = {
    version: 1,
    kind: "meeting" as const,
    callId: "MTGfixture0001",
    startedAt: "2026-08-22T17:00:00.000Z",
    endedAt: "2026-08-22T17:40:00.000Z",
    durationSeconds: 2400,
    // Brief's literal fixture paired status "completed" with
    // consentReceipt: null, which the pre-existing invariant (a completed
    // meeting must carry its receipt) rejects on its own, before
    // joinOutcome ever enters it — a failure unrelated to what these tests
    // check. "never_joined" keeps consentReceipt: null valid and is the
    // status this field's own doc comment names for a failed join, so it
    // fits the case better than "completed" did.
    status: "never_joined" as const,
    endedReason: "far_end" as const,
    coveredMs: 2_400_000,
    gapMs: 0,
    modelTurnsCompleted: 0,
    consentReceipt: null,
    transcriptPath: null
  };

  it("accepts a joinOutcome and still accepts a record without one", () => {
    expect(meetingRecordSchema.parse(base).joinOutcome).toBeUndefined();
    expect(meetingRecordSchema.parse({ ...base, joinOutcome: "admitted" }).joinOutcome).toBe(
      "admitted"
    );
    expect(() => meetingRecordSchema.parse({ ...base, joinOutcome: "nonsense" })).toThrow();
  });

  /** The record's enum is built FROM `JOIN_OUTCOMES` (`@parley/core`), which
   * is the only reason this holds. It was the same string literals retyped
   * into a `z.enum(...)`, and a transport emitting an outcome this schema had
   * never been told about would have written a record the schema itself
   * rejects. Driven off core's list rather than a literal here, so adding an
   * outcome to core and forgetting this package fails the suite. */
  it("accepts every outcome core declares — the transport cannot emit one this rejects", () => {
    for (const outcome of JOIN_OUTCOMES) {
      const parsed = meetingRecordSchema.safeParse({ ...base, joinOutcome: outcome });
      expect(parsed.success, `joinOutcome ${outcome} was rejected by the record schema`).toBe(true);
    }
  });
});

describe("meeting record transport", () => {
  const receipt = {
    requestedAt: "2026-08-19T17:00:00.000Z",
    grantedAt: "2026-08-19T17:00:00.000Z",
    phrase: "go ahead and take notes",
    utterances: []
  };
  const completed = {
    ...base,
    version: 1,
    kind: "meeting" as const,
    status: "completed" as const,
    transcriptPath: "/tmp/t.jsonl"
  };

  /** The defect this field was introduced to close. The consent invariant
   * keyed on the PRESENCE of joinOutcome as a proxy for "consent is not
   * spoken here", and nothing enforced the proxy — so a telephony record
   * carrying a joinOutcome for any reason escaped the requirement to carry
   * the receipt that authorized it, which is the one requirement on this
   * record that exists for a legal reason. */
  it("REFUSES a completed telephony record with no receipt even when it carries a joinOutcome", () => {
    const parsed = meetingRecordSchema.safeParse({
      ...completed,
      joinOutcome: "admitted",
      consentReceipt: null
    });
    expect(parsed.success).toBe(false);
  });

  it("REFUSES it identically when transport is stated outright", () => {
    const parsed = meetingRecordSchema.safeParse({
      ...completed,
      transport: "telephony",
      joinOutcome: "admitted",
      consentReceipt: null
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a completed browser meeting with no receipt — there was no spoken exchange to receipt", () => {
    const parsed = meetingRecordSchema.safeParse({
      ...completed,
      transport: "browser",
      joinOutcome: "admitted",
      consentReceipt: null
    });
    expect(parsed.success).toBe(true);
  });

  /** The exemption is now a property of the transport alone. A browser
   * meeting that reports no joinOutcome is still a browser meeting. */
  it("exempts a browser meeting whether or not it reports a joinOutcome", () => {
    const parsed = meetingRecordSchema.safeParse({
      ...completed,
      transport: "browser",
      consentReceipt: null
    });
    expect(parsed.success).toBe(true);
  });

  it("treats an absent transport as telephony — a completed record still owes its receipt", () => {
    expect(meetingRecordSchema.safeParse({ ...completed, consentReceipt: null }).success).toBe(
      false
    );
    expect(meetingRecordSchema.safeParse({ ...completed, consentReceipt: receipt }).success).toBe(
      true
    );
  });

  it("REFUSES a transport it does not know", () => {
    const parsed = meetingRecordSchema.safeParse({
      ...completed,
      transport: "carrier_pigeon",
      consentReceipt: receipt
    });
    expect(parsed.success).toBe(false);
  });
});
