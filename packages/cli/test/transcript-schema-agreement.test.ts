import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Validator, type Schema } from "jsonschema";
import { transcriptRowSchema } from "../src/transcript-schema.js";
import { writeTranscriptJsonl } from "../src/transcript-writer.js";

/** Mirrors `schema-agreement.test.ts`'s role for MeetingRecord: the staleness
 * test in `emit-schema.test.ts` only proves the committed file matches what
 * the zod source WOULD generate for hand-built fixture objects. It says
 * nothing about whether a file the shipped writer actually produces —
 * exercising every branch (header, timed utterance, gap, untimed straggler,
 * an interim that must not survive) in one real call to
 * `writeTranscriptJsonl` — validates against that same committed file. Using
 * the writer rather than a hand-built JSONL string is deliberate: a
 * hand-written sample can silently diverge from what production emits (key
 * order, exact null handling) in a way that would still validate against a
 * schema built from the same author's assumptions. */
function repoRootSchemaPath(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return join(testDir, "..", "..", "..", "schema", "transcript.schema.json");
}

/** `jsonschema`'s `Validator` resolves a `#/...` `$ref` against whatever
 * object is passed AS the schema itself, never against some separately
 * tracked document root. `committed.definitions.TranscriptRow` extracted on
 * its own is `{ anyOf: [{$ref: "#/definitions/TranscriptUtteranceRow"}, ...] }`
 * — handed to `validate()` by itself, those two `$ref`s point at a document
 * with no `definitions` key at all and fail to resolve. Wrapping the named
 * definition back up with the full `definitions` map from the same committed
 * document (exactly the shape the committed file's own top level already
 * is, just re-pointed at a different name) is what makes it self-contained
 * again. */
function definitionSchema(committed: Schema, name: string): Schema {
  return { $ref: `#/definitions/${name}`, definitions: committed.definitions };
}

describe("a real transcript from the shipped writer validates against the committed schema", () => {
  it("validates the header, every utterance row and every gap row — and rejects a row shaped like neither", async () => {
    const committed: Schema = JSON.parse(await readFile(repoRootSchemaPath(), "utf8"));
    const validator = new Validator();

    const dir = await mkdtemp(join(tmpdir(), "parley-transcript-schema-"));
    const path = await writeTranscriptJsonl(
      dir,
      { callId: "CA_SCHEMA_TEST", startedAt: "2026-08-19T17:00:00.000Z", diarized: false },
      [
        // The untimed straggler: the speaking plane's still-open turn at the
        // moment the consent handoff retires it. Spoken FIRST, chronologically,
        // but carries no startMs at all — this is the row the ordering rule
        // exists for.
        { speaker: "model", text: "starting notes now", isFinal: true },
        // An ATTRIBUTED row, as the browser meeting transport produces them:
        // a name, its source and its confidence. Without one here, the
        // committed schema's new provenance fields would be validated only
        // against nulls — and a row carrying them is the one a consumer
        // reads a person's name off.
        {
          speaker: "participant",
          speakerId: "Priya",
          speakerSource: "roster",
          speakerConfidence: 0.6,
          text: "first",
          startMs: 1000,
          endMs: 2000,
          isFinal: true
        },
        // An interim result for the same segment: must never reach the file.
        {
          speaker: "participant",
          text: "las",
          startMs: 9000,
          endMs: 9300,
          isFinal: false
        },
        { speaker: "participant", text: "last", startMs: 9000, endMs: 9500, isFinal: true }
      ],
      [{ fromMs: 3000, toMs: 8000, reason: "transcriber_not_ready" }]
    );
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const [header, ...body] = lines;

    expect(validator.validate(header, definitionSchema(committed, "TranscriptHeader")).valid).toBe(
      true
    );

    for (const row of body) {
      expect(
        validator.validate(row, definitionSchema(committed, "TranscriptRow")).valid,
        `row should validate against TranscriptRow: ${JSON.stringify(row)}`
      ).toBe(true);
    }

    // Both row shapes were actually exercised above, not just asserted to
    // theoretically validate.
    expect(body.filter((r) => r.type === "utterance")).toHaveLength(3);
    expect(body.filter((r) => r.type === "gap")).toHaveLength(1);

    // The interim never reached the file at all.
    expect(body.some((r) => r.text === "las")).toBe(false);

    // The attributed row kept all three fields through the writer — the
    // provenance used to be dropped in transit, which the schema alone
    // cannot catch: a row of nulls validates just as happily.
    expect(body.find((r) => r.text === "first")).toMatchObject({
      speakerId: "Priya",
      speakerSource: "roster",
      speakerConfidence: 0.6
    });

    // The append-untimed-last property, re-checked here against rows that
    // have ALSO just been confirmed schema-valid — not only against the
    // writer's own unit tests in transcript-writer.test.ts. This is the
    // property a consumer is most likely to get wrong.
    expect(body.map((r) => r.type)).toEqual(["utterance", "gap", "utterance", "utterance"]);
    expect(body[body.length - 1]).toMatchObject({
      text: "starting notes now",
      startMs: null,
      endMs: null
    });

    // A row shaped like neither an utterance (missing speaker/speakerId/
    // startMs/endMs/text) nor a gap (missing fromMs/toMs/reason) is rejected,
    // not silently accepted as a partial match of either.
    const missingFields = { type: "utterance" };
    expect(
      validator.validate(missingFields, definitionSchema(committed, "TranscriptRow")).valid
    ).toBe(false);

    const unknownDiscriminator = { type: "narration", text: "not a real row shape" };
    expect(
      validator.validate(unknownDiscriminator, definitionSchema(committed, "TranscriptRow")).valid
    ).toBe(false);
  });

  /** The regression this pins is a REREAD, not a write.
   *
   * `speakerSource` and `speakerConfidence` were added to the utterance row
   * and put straight into the schema's `required` array — which does not
   * describe the file the writer produces today, it describes every file it
   * has ever produced. The consumer loads this committed schema and validates
   * historical transcripts with it, and every transcript written before those
   * two fields existed omits both keys entirely, so making them required
   * invalidated every one of them retroactively. Real files on the intended
   * host stopped validating without a single byte of them changing.
   *
   * The same branch had already settled this question twice, the other way:
   * `joinOutcome` and `transport` on MeetingRecord are both optional and
   * additive, each with a description saying in as many words that records
   * written before them must stay valid.
   *
   * Both validators are checked here, deliberately. The zod schema is the
   * source and the committed JSON Schema is what the consumer actually
   * loads — an asymmetry between them is exactly the defect class this whole
   * file exists for, and a fix applied to only one of them would leave the
   * other still rejecting the same file. */
  it("still validates a transcript row written before the provenance fields existed", async () => {
    const committed: Schema = JSON.parse(await readFile(repoRootSchemaPath(), "utf8"));
    const validator = new Validator();

    // Exactly the shape the writer emitted before this round: no
    // `speakerSource` key and no `speakerConfidence` key at all — ABSENT, not
    // null. A null-valued pair would validate under a `required` array too,
    // so a fixture carrying nulls could not have caught this.
    const historicalRow = {
      type: "utterance",
      speaker: "participant",
      speakerId: null,
      startMs: 1000,
      endMs: 2000,
      text: "the deadline slipped"
    };
    expect("speakerSource" in historicalRow).toBe(false);
    expect("speakerConfidence" in historicalRow).toBe(false);

    const result = validator.validate(historicalRow, definitionSchema(committed, "TranscriptRow"));
    expect(result.errors.map((e) => e.stack)).toEqual([]);
    expect(result.valid).toBe(true);

    expect(transcriptRowSchema.safeParse(historicalRow).success).toBe(true);

    // Absent is not the same claim as null, and neither validator may force
    // one into the other: a row that DOES record provenance still validates,
    // and so does one that positively records having none.
    for (const row of [
      { ...historicalRow, speakerSource: null, speakerConfidence: null },
      {
        ...historicalRow,
        speakerId: "Priya",
        speakerSource: "roster",
        speakerConfidence: 0.6
      }
    ]) {
      expect(
        validator.validate(row, definitionSchema(committed, "TranscriptRow")).valid,
        `row should validate against TranscriptRow: ${JSON.stringify(row)}`
      ).toBe(true);
      expect(transcriptRowSchema.safeParse(row).success).toBe(true);
    }
  });
});
