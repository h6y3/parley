import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Validator } from "jsonschema";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Relative import, not the self-referencing `@parley/cli`, matching every
// sibling test in this directory (schema-agreement.test.ts,
// meeting-record.test.ts). A self-import resolves through package.json's
// `exports` map, and `tsc --noEmit` refuses it here with TS2209 ("the
// project root is ambiguous") because this package's tsconfig has no
// `rootDir` — a repo-wide pattern shared by all nine packages, not something
// worth making cli alone diverge from for one test file.
import { meetingRecordSchema } from "../src/meeting-record.js";
import {
  captureConsentRefused,
  captureRoadmapSync,
  captureTruncatedStandup
} from "./helpers/capture-meeting-fixtures.js";

/** The path a capture into a scratch directory cannot know: where its own
 * output is committed. The one substitution made on a captured record, applied
 * identically here and by whoever regenerates the files. */
const ROADMAP_SYNC_COMMITTED_TRANSCRIPT = "fixtures/meetings/roadmap-sync/transcript.jsonl";
const TRUNCATED_STANDUP_COMMITTED_TRANSCRIPT =
  "fixtures/meetings/truncated-standup/transcript.jsonl";

/** Resolve a path under the repo-root `fixtures/` directory regardless of the
 * test runner's cwd. Mirrors `schema-agreement.test.ts`'s `repoRootSchemaPath`
 * — `pnpm --filter @parley/cli exec vitest run` runs with cwd set to
 * `packages/cli`, so a bare relative path such as `fixtures/meetings/...`
 * resolves under the PACKAGE directory (and 404s) rather than the repo root
 * the fixtures actually live in. */
function repoRootFixturePath(...segments: string[]): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return join(testDir, "..", "..", "..", "fixtures", ...segments);
}

const FIXTURE_NAMES = ["roadmap-sync", "consent-refused", "truncated-standup"];

function repoRootSchemaPath(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return join(testDir, "..", "..", "..", "schema", "meeting-record.schema.json");
}

describe("committed meeting fixtures", () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}/record.json validates against the shipped schema`, () => {
      const raw = JSON.parse(
        readFileSync(repoRootFixturePath("meetings", name, "record.json"), "utf8")
      );
      const parsed = meetingRecordSchema.safeParse(raw);
      expect(parsed.success, JSON.stringify(parsed, null, 2)).toBe(true);
    });
  }

  /** `transport` was introduced OPTIONAL, with absence meaning telephony, on
   * the claim that every record written before it existed stays valid
   * unmodified. These fixtures are the only such records this repository
   * holds, so this is where that claim is checked rather than asserted — and
   * it is checked against the committed JSON Schema too, because the file a
   * downstream consumer validates with is the one the claim is about. */
  it("carry no transport field at all, and still validate on both sides", () => {
    const committed: object = JSON.parse(readFileSync(repoRootSchemaPath(), "utf8"));
    const validator = new Validator();

    for (const name of FIXTURE_NAMES) {
      const raw = JSON.parse(
        readFileSync(repoRootFixturePath("meetings", name, "record.json"), "utf8")
      ) as Record<string, unknown>;

      expect(Object.hasOwn(raw, "transport"), `${name} carries a transport field`).toBe(false);
      expect(meetingRecordSchema.safeParse(raw).success, `${name} failed zod`).toBe(true);
      const result = validator.validate(raw, committed);
      expect(result.valid, `${name} failed the committed JSON Schema: ${result.toString()}`).toBe(
        true
      );
    }
  });

  it("the roadmap-sync transcript is header-first, time-ordered, and finals-only", () => {
    const lines = readFileSync(
      repoRootFixturePath("meetings", "roadmap-sync", "transcript.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ v: 1, timeBase: "msSinceStartedAt", diarized: false });
    expect(lines.slice(1).every((l) => l.type === "utterance" || l.type === "gap")).toBe(true);

    // Timed rows first, in time order; untimed rows after them. `startMs ??
    // fromMs` alone produced `undefined` for an untimed row and a comparator
    // returning NaN, which sorts nothing and asserts nothing.
    const at = (l: { startMs?: number | null; fromMs?: number }): number | null =>
      typeof l.startMs === "number" ? l.startMs : typeof l.fromMs === "number" ? l.fromMs : null;
    const times = lines.slice(1).map(at);
    const timed = times.filter((t): t is number => t !== null);
    expect(times.slice(0, timed.length)).toEqual(timed);
    expect([...timed].sort((a, b) => a - b)).toEqual(timed);
    // The fixture must actually EXERCISE the untimed case, or the ordering
    // rule above is asserted over data that cannot violate it.
    expect(times.filter((t) => t === null)).toHaveLength(1);
  });

  it("gapMs in the record equals the gap rows in the transcript", () => {
    const record = JSON.parse(
      readFileSync(repoRootFixturePath("meetings", "roadmap-sync", "record.json"), "utf8")
    );
    const gaps = readFileSync(
      repoRootFixturePath("meetings", "roadmap-sync", "transcript.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((l) => l.type === "gap");
    const total = gaps.reduce((sum, g) => sum + (g.toMs - g.fromMs), 0);
    expect(record.gapMs).toBe(total);
  });

  // NOT `coveredMs === durationSeconds * 1000 - gapMs`, which this asserted
  // while the fixture was hand-built. Nothing is covered before consent —
  // `CallSession` registers no transcription sink until the handoff — so the
  // shortfall between the call's length and (covered + gap) is exactly the
  // pre-consent period, and a fixture satisfying the tighter identity is a
  // fixture describing a meeting that could not have happened.
  it("coveredMs and gapMs together account for the meeting AFTER consent, never for the whole call", () => {
    const record = JSON.parse(
      readFileSync(repoRootFixturePath("meetings", "roadmap-sync", "record.json"), "utf8")
    );
    const callMs = record.durationSeconds * 1000;
    expect(record.coveredMs + record.gapMs).toBeLessThan(callMs);
    expect(record.coveredMs + record.gapMs).toBeGreaterThan(0);
  });

  it("truncated-standup's record reads completed / duration_cap, and its transcript has no gap row and at least two timed participant utterances", () => {
    const record = JSON.parse(
      readFileSync(repoRootFixturePath("meetings", "truncated-standup", "record.json"), "utf8")
    );
    expect(record.status).toBe("completed");
    expect(record.endedReason).toBe("duration_cap");

    const lines = readFileSync(
      repoRootFixturePath("meetings", "truncated-standup", "transcript.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const gapRows = lines.filter((l) => l.type === "gap");
    expect(gapRows).toHaveLength(0);
    const timedParticipantRows = lines.filter(
      (l) => l.type === "utterance" && l.speaker === "participant" && typeof l.startMs === "number"
    );
    expect(timedParticipantRows.length).toBeGreaterThanOrEqual(2);
  });

  it("carries no row for the announcement or the go-ahead — production never puts either in the transcript", () => {
    const receipt = JSON.parse(
      readFileSync(repoRootFixturePath("meetings", "roadmap-sync", "record.json"), "utf8")
    ).consentReceipt;
    const transcript = readFileSync(
      repoRootFixturePath("meetings", "roadmap-sync", "transcript.jsonl"),
      "utf8"
    );
    // Both live in the consent receipt and nowhere else: pre-consent speech
    // reaches a volatile buffer, never `transcriptLog`.
    expect(receipt.utterances).toHaveLength(2);
    for (const u of receipt.utterances) {
      expect(transcript).not.toContain(u.text);
    }
  });
});

/**
 * The fixtures are CAPTURED, and this is where that claim is enforced rather
 * than asserted in prose: the same meeting is driven through the real
 * production path on every run — `handleMediaConnection` -> a real
 * `CallSession` -> the real `ToolGate` -> the real consent handoff -> the real
 * `runCompletedCallPostCall` -> the real `writeTranscriptJsonl` — and the
 * result is compared against what is committed.
 *
 * A previous generation stopped one layer short: it fed a hand-assembled
 * `CompletedCallRecord` into `runCompletedCallPostCall`, which cannot see any
 * of the decisions `CallSession` makes about WHICH events reach a transcript.
 * The fixture that produced carried the announcement and the go-ahead as timed
 * transcript rows and a model row stamped `startMs: 8000`, none of which
 * production can emit — in files whose README said they "reflect exactly what
 * production emits today".
 */
describe("the committed fixtures are what the production path actually produces", () => {
  it("regenerates roadmap-sync byte for byte", async () => {
    const out = await mkdtemp(join(tmpdir(), "parley-fixture-"));
    const captured = await captureRoadmapSync(out, ROADMAP_SYNC_COMMITTED_TRANSCRIPT);
    expect(captured.transcript).toBe(
      readFileSync(repoRootFixturePath("meetings", "roadmap-sync", "transcript.jsonl"), "utf8")
    );
    expect(captured.record).toEqual(
      JSON.parse(
        readFileSync(repoRootFixturePath("meetings", "roadmap-sync", "record.json"), "utf8")
      )
    );
  });

  it("regenerates consent-refused, and writes no transcript at all", async () => {
    const out = await mkdtemp(join(tmpdir(), "parley-fixture-"));
    const captured = await captureConsentRefused(out);
    expect(captured.transcript).toBeNull();
    expect(captured.record).toEqual(
      JSON.parse(
        readFileSync(repoRootFixturePath("meetings", "consent-refused", "record.json"), "utf8")
      )
    );
  });

  it("regenerates truncated-standup byte for byte", async () => {
    const out = await mkdtemp(join(tmpdir(), "parley-fixture-"));
    const captured = await captureTruncatedStandup(out, TRUNCATED_STANDUP_COMMITTED_TRANSCRIPT);
    expect(captured.transcript).toBe(
      readFileSync(repoRootFixturePath("meetings", "truncated-standup", "transcript.jsonl"), "utf8")
    );
    expect(captured.record).toEqual(
      JSON.parse(
        readFileSync(repoRootFixturePath("meetings", "truncated-standup", "record.json"), "utf8")
      )
    );
  });
});
