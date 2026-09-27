import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Validator } from "jsonschema";
import { captureMeetAttributedStandup } from "./helpers/capture-browser-fixture.js";

const FIXTURE = "meet-attributed-standup";
const COMMITTED_TRANSCRIPT = `fixtures/meetings/${FIXTURE}/transcript.jsonl`;

/** Resolve a repo-root path regardless of the runner's cwd -- vitest runs with
 * cwd set to this package, so a bare `fixtures/...` would resolve under
 * `packages/meeting-browser/`. Mirrors `meeting-fixtures.test.ts`. */
function repoRoot(...segments: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ...segments);
}

function committedLines(): Record<string, unknown>[] {
  return readFileSync(repoRoot("fixtures", "meetings", FIXTURE, "transcript.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function committedRecord(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(repoRoot("fixtures", "meetings", FIXTURE, "record.json"), "utf8")
  ) as Record<string, unknown>;
}

describe("the committed browser-transport fixture is what production produces", () => {
  it("regenerates byte for byte", async () => {
    const out = await mkdtemp(join(tmpdir(), "parley-meet-fixture-"));
    const captured = await captureMeetAttributedStandup(out, COMMITTED_TRANSCRIPT);
    expect(captured.transcript).toBe(
      readFileSync(repoRoot("fixtures", "meetings", FIXTURE, "transcript.jsonl"), "utf8")
    );
    expect(captured.record).toEqual(committedRecord());
  });
});

describe("what the committed browser fixture shows a consumer", () => {
  it("validates against the shipped record schema", () => {
    const schema: object = JSON.parse(
      readFileSync(repoRoot("schema", "meeting-record.schema.json"), "utf8")
    );
    const result = new Validator().validate(committedRecord(), schema);
    expect(result.valid, result.toString()).toBe(true);
  });

  it("every row validates against the shipped transcript schema", () => {
    const schema = JSON.parse(
      readFileSync(repoRoot("schema", "transcript.schema.json"), "utf8")
    ) as { definitions: Record<string, object> };
    const validator = new Validator();
    validator.addSchema(schema, "/transcript");
    const [header, ...rows] = committedLines();
    expect(validator.validate(header, schema.definitions.TranscriptHeader).valid).toBe(true);
    for (const row of rows) {
      const def = row.type === "gap" ? "TranscriptGapRow" : "TranscriptUtteranceRow";
      const result = validator.validate(row, schema.definitions[def]);
      expect(result.valid, `${JSON.stringify(row)}: ${result.toString()}`).toBe(true);
    }
  });

  /** The whole reason this fixture exists: A2 had no committed sample of an
   * ATTRIBUTED transcript, so its readout was written against `speakerId:
   * null` on every row and hardcoded "this call has no diarization". */
  it("carries real display names in speakerId, at roster provenance", () => {
    const utterances = committedLines().filter((l) => l.type === "utterance");
    const attributed = utterances.filter((u) => u.speakerId !== null);
    expect(attributed.length).toBeGreaterThan(0);
    for (const u of attributed) {
      expect(typeof u.speakerId).toBe("string");
      expect(u.speakerSource).toBe("roster");
      expect(u.speakerConfidence).toBe(0.6);
    }
    expect(new Set(attributed.map((u) => u.speakerId)).size).toBeGreaterThan(1);
  });

  /** PARTIAL attribution, and it must stay partial. A consumer that only ever
   * sees fully-attributed rows will not write the unattributed branch, and a
   * caption line dropping is ordinary rather than exceptional. */
  it("leaves the utterance with no caption cue near it unattributed", () => {
    const utterances = committedLines().filter((l) => l.type === "utterance");
    const unattributed = utterances.filter((u) => u.speakerId === null);
    expect(unattributed).toHaveLength(1);
    // null, not absent: a reader parsing one line at a time needs the key.
    expect(Object.hasOwn(unattributed[0], "speakerId")).toBe(true);
    expect(unattributed[0].speakerSource).toBeNull();
    expect(unattributed[0].speakerConfidence).toBeNull();
  });

  /** `diarized` stays false while `speakerId` is populated, and that pairing
   * is deliberate (Decision 11): false means diarization was not ATTEMPTED,
   * which is true. A consumer must therefore branch on the rows, never on this
   * header field, to decide whether it may name anyone. */
  it("reports diarized:false in the header despite carrying attributed rows", () => {
    const [header] = committedLines();
    expect(header.diarized).toBe(false);
  });

  it("is a browser record with no consent receipt", () => {
    const record = committedRecord();
    expect(record.transport).toBe("browser");
    expect(record.consentReceipt).toBeNull();
    expect(record.status).toBe("completed");
    expect(record.joinOutcome).toBe("admitted");
  });
});
