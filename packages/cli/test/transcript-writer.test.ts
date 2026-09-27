import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTranscriptJsonl } from "../src/transcript-writer.js";

describe("writeTranscriptJsonl", () => {
  it("writes a header, finals only, and gap rows INTERLEAVED in time order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-t-"));
    const path = await writeTranscriptJsonl(
      dir,
      { callId: "CA1", startedAt: "2026-08-19T17:00:00.000Z", diarized: false },
      [
        { speaker: "participant", text: "before", startMs: 1000, endMs: 2000, isFinal: true },
        { speaker: "participant", text: "interim", startMs: 5000, endMs: 6000, isFinal: false },
        { speaker: "participant", text: "after", startMs: 9000, endMs: 9500, isFinal: true }
      ],
      [{ fromMs: 3000, toMs: 8000, reason: "transcriber_not_ready" }]
    );
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({
      v: 1,
      callId: "CA1",
      startedAt: "2026-08-19T17:00:00.000Z",
      timeBase: "msSinceStartedAt",
      diarized: false
    });
    expect(lines.slice(1).map((l) => l.type)).toEqual(["utterance", "gap", "utterance"]);
    expect(lines[1]).toMatchObject({ text: "before", speakerId: null });
    expect(lines.find((l) => l.text === "interim")).toBeUndefined();
  });

  /** `attributeEvents` (@parley/meeting-browser) produces three fields — a
   * name, where it came from, and what it is worth — and this writer emitted
   * the name alone. A caption line matched within three seconds at 0.6
   * confidence was written indistinguishably from diarization-grade
   * attribution, in a file whose consumer puts names in front of a human. */
  it("writes where a speakerId came from and what it is worth, not just the name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-t-"));
    const path = await writeTranscriptJsonl(
      dir,
      { callId: "CA5", startedAt: "2026-08-19T17:00:00.000Z", diarized: false },
      [
        {
          speaker: "participant",
          speakerId: "Priya",
          speakerSource: "roster",
          speakerConfidence: 0.6,
          text: "the deadline slipped",
          startMs: 1000,
          endMs: 2000,
          isFinal: true
        }
      ],
      []
    );
    const row = JSON.parse((await readFile(path, "utf8")).trim().split("\n")[1] as string);
    expect(row).toMatchObject({
      speakerId: "Priya",
      speakerSource: "roster",
      speakerConfidence: 0.6
    });
    // The header still says diarization was not attempted, because it was
    // not — captions are not diarization, and the row's own speakerSource is
    // what a reader branches on.
    const header = JSON.parse((await readFile(path, "utf8")).trim().split("\n")[0] as string);
    expect(header.diarized).toBe(false);
  });

  it("writes speakerId as an explicit null so every reader has an unattributed branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-t-"));
    const path = await writeTranscriptJsonl(
      dir,
      { callId: "CA2", startedAt: "2026-08-19T17:00:00.000Z", diarized: false },
      [{ speaker: "participant", text: "x", startMs: 0, endMs: 1, isFinal: true }],
      []
    );
    const second = JSON.parse((await readFile(path, "utf8")).trim().split("\n")[1] as string);
    // All three keys present, all three null: a reader branches on the same
    // shape whether or not anything was attributed.
    for (const key of ["speakerId", "speakerSource", "speakerConfidence"]) {
      expect(Object.prototype.hasOwnProperty.call(second, key)).toBe(true);
      expect(second[key]).toBeNull();
    }
  });

  it("creates the file mode 600 — a meeting transcript is not world-readable", async () => {
    const { stat } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "parley-t-"));
    const path = await writeTranscriptJsonl(
      dir,
      { callId: "CA3", startedAt: "2026-08-19T17:00:00.000Z", diarized: false },
      [],
      []
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("forces mode 600 on an OVERWRITE too — writeFile's `mode` only applies on create", async () => {
    // A fresh mkdtemp only ever exercises the create path, where writeFile's
    // own `mode` option already does the job — that leaves the explicit
    // `chmod` after the write with zero coverage, since deleting it wouldn't
    // fail any test that only ever writes to a brand-new file. This test
    // pre-creates the file at a looser mode first, so only the `chmod`
    // (not writeFile's create-time `mode`) can be what tightens it back.
    const { chmod, stat, writeFile: writeFileDirect } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "parley-t-"));
    const existingPath = join(dir, "transcript.jsonl");
    await writeFileDirect(existingPath, "stale contents from a previous run\n");
    await chmod(existingPath, 0o644);
    expect((await stat(existingPath)).mode & 0o777).toBe(0o644);

    const path = await writeTranscriptJsonl(
      dir,
      { callId: "CA4", startedAt: "2026-08-19T17:00:00.000Z", diarized: false },
      [],
      []
    );

    expect(path).toBe(existingPath);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

/** Contract 1 to A2 says gap rows are "interleaved in time order". A row with
 * no `startMs` has no place in that order, and sorting it on `startMs ?? 0`
 * put it at position 0 — ahead of every gap and every utterance, asserting it
 * was the first thing said. Production emits exactly such a row: an utterance
 * from the speaking plane, which reports no timestamps, most visibly the model
 * turn still open when the consent handoff retires that plane. */
describe("rows with no time of their own", () => {
  const header = { callId: "CA9", startedAt: "2026-08-19T17:00:00.000Z", diarized: false };

  it("appends an untimed utterance AFTER the timeline instead of sorting it to position 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-t-"));
    const path = await writeTranscriptJsonl(
      dir,
      header,
      [
        { speaker: "model", text: "starting notes now", isFinal: true },
        { speaker: "participant", text: "first", startMs: 1000, endMs: 2000, isFinal: true },
        { speaker: "participant", text: "last", startMs: 9000, endMs: 9500, isFinal: true }
      ],
      [{ fromMs: 3000, toMs: 8000, reason: "transcriber_not_ready" }]
    );
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.slice(1).map((l) => l.text ?? l.type)).toEqual([
      "first",
      "gap",
      "last",
      "starting notes now"
    ]);
  });

  it("still writes its startMs and endMs as explicit nulls — unplaced, never zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-t-"));
    const path = await writeTranscriptJsonl(
      dir,
      header,
      [{ speaker: "model", text: "starting notes now", isFinal: true }],
      []
    );
    const row = JSON.parse((await readFile(path, "utf8")).trim().split("\n")[1] as string);
    expect(row).toMatchObject({ startMs: null, endMs: null, speakerId: null });
  });

  it("keeps several untimed rows in the order they were spoken", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-t-"));
    const path = await writeTranscriptJsonl(
      dir,
      header,
      [
        { speaker: "model", text: "one", isFinal: true },
        { speaker: "participant", text: "timed", startMs: 500, endMs: 600, isFinal: true },
        { speaker: "model", text: "two", isFinal: true }
      ],
      []
    );
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.slice(1).map((l) => l.text)).toEqual(["timed", "one", "two"]);
  });
});
