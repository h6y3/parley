import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEvent } from "@parley/core";
import type { TranscriptGap } from "@parley/core";

export interface TranscriptHeader {
  callId: string;
  startedAt: string;
  /** FALSE means the TRANSCRIPTION PROVIDER did not attempt diarization. A
   * reader must be able to tell that apart from "attempted and found one
   * speaker" — the two license completely different claims about who said
   * what.
   *
   * It says nothing about whether the rows are attributed: a caller can
   * attribute speech by other means (the browser meeting transport matches
   * the meeting's own captions) and still write `false` here, because
   * captions are not diarization. Each row's `speakerSource` is what says
   * where its `speakerId` came from. */
  diarized: boolean;
}

/** Write the meeting transcript as JSONL: one header, then finals only, with
 * gap rows INTERLEAVED in time order, and any untimed row appended after the
 * timeline.
 *
 * Gaps are rows rather than a sidecar array on the call record because a
 * reader must not have to join two documents on a time base to discover that
 * the transcript has a hole in it. Interleaved, the hole is impossible to
 * miss and impossible to read past.
 *
 * **Untimed rows go LAST, and that is a decision rather than a fallback.**
 * Production emits exactly one kind of untimed row: an utterance from the
 * SPEAKING plane, which is a realtime model that reports no timestamps at all
 * — most visibly the model turn still open when `beginNotetaking()` retires
 * that plane, which is committed into the transcript as it closes. Everything
 * else on a meeting's transcript comes from the listening plane, which stamps
 * `startMs`.
 *
 * Sorting such a row on `startMs ?? 0` — which this did — placed it at
 * position 0: ahead of every gap row and every utterance, asserting it was the
 * first thing said on the call. That is a claim the writer has no basis for,
 * and it defeats the one property the interleaving exists to give a reader
 * ("the rows are in time order, so a gap is impossible to read past").
 * Appending instead claims nothing: the row carries `startMs: null`, it sits
 * outside the ordered region, and a reader that sorts or scans by time is
 * never told a falsehood. Dropping it was the other candidate and is worse —
 * it is a real utterance, and the one most likely to be about consent. */
/** Where `writeTranscriptJsonl` will put this meeting's transcript.
 *
 * Exported so a caller that must know the path BEFORE the file exists — one
 * building a record that names it, and validating that record before writing
 * anything to disk — does not have to restate the convention. Restated, the
 * caller's copy and this writer's could disagree and the record would name a
 * file nobody wrote. */
export function transcriptJsonlPath(dir: string): string {
  return join(dir, "transcript.jsonl");
}

export async function writeTranscriptJsonl(
  dir: string,
  header: TranscriptHeader,
  events: readonly TranscriptEvent[],
  gaps: readonly TranscriptGap[]
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = transcriptJsonlPath(dir);

  const utteranceLine = (e: TranscriptEvent): unknown => ({
    type: "utterance",
    speaker: e.speaker,
    // Explicit null, never an omitted key: every reader then has an
    // unattributed branch from its first line of code, and a transport that
    // CAN attribute fills the field rather than changing the shape.
    speakerId: e.speakerId ?? null,
    // The provenance travels with the name, and it used to be dropped here.
    // `attributeEvents` (@parley/meeting-browser) produces all three — a
    // caption line matched to this utterance within three seconds, at
    // `roster`/0.6 — and this writer emitted the name alone, so an inference
    // was written indistinguishably from diarization-grade attribution and
    // no consumer could tell which it was holding. A name a reader will
    // quote to a human must carry what it is worth.
    speakerSource: e.speakerSource ?? null,
    speakerConfidence: e.speakerConfidence ?? null,
    startMs: e.startMs ?? null,
    endMs: e.endMs ?? null,
    text: e.text
  });

  const rows: { at: number; line: unknown }[] = [];
  /** Kept in ENCOUNTER order, which is the only order anything knows about
   * them — a separate list rather than a sentinel sort key, because
   * `Infinity - Infinity` is `NaN` and a comparator returning NaN has no
   * defined result. */
  const untimed: unknown[] = [];
  for (const e of events) {
    if (!e.isFinal) continue; // interims are a wire concern, never a record
    if (e.startMs === undefined) untimed.push(utteranceLine(e));
    else rows.push({ at: e.startMs, line: utteranceLine(e) });
  }
  for (const g of gaps) {
    rows.push({ at: g.fromMs, line: { type: "gap", ...g } });
  }
  rows.sort((a, b) => a.at - b.at);

  const body = [
    JSON.stringify({ v: 1, ...header, timeBase: "msSinceStartedAt" }),
    ...rows.map((r) => JSON.stringify(r.line)),
    ...untimed.map((line) => JSON.stringify(line))
  ].join("\n");

  // `mode` applies on CREATE only — an existing file keeps its old permissions.
  // A transcript path is per-callId so a collision means a re-run, and chmod
  // after the write makes the guarantee unconditional rather than incidental.
  await writeFile(path, `${body}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
