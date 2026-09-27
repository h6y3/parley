import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitMeetingArtifacts } from "../src/artifacts.js";

const base = {
  meetingId: "MTGfixture0001",
  startedAt: "2026-08-22T17:00:00.000Z",
  endedAt: "2026-08-22T17:40:00.000Z",
  endedReason: "far_end" as const,
  coveredMs: 2_400_000,
  gapMs: 0
};

describe("emitMeetingArtifacts", () => {
  it("writes a transcript and a record for an admitted meeting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mb-"));
    const out = await emitMeetingArtifacts({
      ...base,
      joinOutcome: "admitted",
      recordsPath: join(dir, "records.jsonl"),
      transcriptsDir: dir,
      events: [
        { speaker: "participant", text: "the deadline slipped", startMs: 10_000, isFinal: true }
      ],
      cues: [{ speaker: "Priya", text: "the deadline slipped", atMs: 10_100 }]
    });
    expect(out.transcriptPath).not.toBeNull();
    const lines = (await readFile(out.transcriptPath!, "utf8")).trim().split("\n");
    const header = JSON.parse(lines[0]);
    // Decision 11: caption attribution is NOT diarization, and the header
    // must not claim it was attempted.
    expect(header.diarized).toBe(false);
    // The name AND what it is worth. `attributeEvents` produces all three and
    // the writer used to emit only the first, so a caption matched within
    // three seconds at 0.6 confidence reached the consumer looking exactly
    // like diarization-grade attribution.
    expect(JSON.parse(lines[1])).toMatchObject({
      speakerId: "Priya",
      speakerSource: "roster",
      speakerConfidence: 0.6
    });
  });

  /** `diarized: false` and a populated `speakerId` are not in tension, and a
   * consumer must be able to see that from the artifact: captions are not
   * diarization, and the row's own `speakerSource` is what says so. */
  it("writes an unattributed row as three explicit nulls, not as a missing shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mb-"));
    const out = await emitMeetingArtifacts({
      ...base,
      joinOutcome: "admitted",
      recordsPath: join(dir, "records.jsonl"),
      transcriptsDir: dir,
      events: [
        { speaker: "participant", text: "the deadline slipped", startMs: 10_000, isFinal: true }
      ],
      // No captions were on, so nothing can be attributed.
      cues: []
    });
    const row = JSON.parse((await readFile(out.transcriptPath!, "utf8")).trim().split("\n")[1]);
    expect(row).toMatchObject({
      speakerId: null,
      speakerSource: null,
      speakerConfidence: null
    });
  });

  it("writes a record and NO transcript when the join failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mb-"));
    const out = await emitMeetingArtifacts({
      ...base,
      joinOutcome: "denied",
      recordsPath: join(dir, "records.jsonl"),
      transcriptsDir: dir,
      events: [],
      cues: []
    });
    expect(out.transcriptPath).toBeNull();
    const record = JSON.parse((await readFile(out.recordsPath, "utf8")).trim());
    // Decision 10: a failed attempt is evidence, not silence.
    expect(record.status).toBe("never_joined");
    expect(record.joinOutcome).toBe("denied");
    expect(record.consentReceipt).toBeNull();
  });

  /** The record is what anything downstream watches, so a transcript with no
   * record is not a partial success — it is a meeting that silently did not
   * happen, plus a file of what was said in it. `buildMeetingRecord` throws
   * on input its schema refuses (a malformed timestamp makes durationSeconds
   * NaN), and it used to throw AFTER the transcript was already on disk. */
  it("writes nothing at all when the record cannot be built", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mb-"));
    await expect(
      emitMeetingArtifacts({
        ...base,
        endedAt: "not-a-timestamp",
        joinOutcome: "admitted",
        recordsPath: join(dir, "records.jsonl"),
        transcriptsDir: dir,
        events: [
          { speaker: "participant", text: "the deadline slipped", startMs: 10_000, isFinal: true }
        ],
        cues: []
      })
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  /** The record schema exempts a completed meeting from carrying a consent
   * receipt on the strength of this field and nothing else. It used to infer
   * the exemption from the presence of joinOutcome, so a record from here
   * validated by accident; now it validates because it says what it is. A
   * record written without this would be REJECTED by buildMeetingRecord
   * below, not silently accepted, which is why one assertion covers it. */
  it("states transport: browser on the record, which is what licenses the null receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mb-"));
    const out = await emitMeetingArtifacts({
      ...base,
      joinOutcome: "admitted",
      recordsPath: join(dir, "records.jsonl"),
      transcriptsDir: dir,
      events: [],
      cues: []
    });
    const record = JSON.parse((await readFile(out.recordsPath, "utf8")).trim());
    expect(record.transport).toBe("browser");
    expect(record.status).toBe("completed");
    expect(record.consentReceipt).toBeNull();
  });
});
