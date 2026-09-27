import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { JoinOutcome, TranscriptEvent } from "@parley/core";
import { buildMeetingRecord, transcriptJsonlPath, writeTranscriptJsonl } from "@parley/cli";
import { attributeEvents } from "./attribution.js";
import type { CaptionCue } from "./types.js";

export interface EmitInput {
  meetingId: string;
  startedAt: string;
  endedAt: string;
  endedReason: "far_end" | "duration_cap" | "transcription_lost";
  coveredMs: number;
  gapMs: number;
  joinOutcome: JoinOutcome;
  recordsPath: string;
  transcriptsDir: string;
  events: readonly TranscriptEvent[];
  cues: readonly CaptionCue[];
}

/** Build this meeting's record, then write its transcript, then append it.
 *
 * A join that was never admitted still writes a record (Decision 10): the
 * consuming system watches records, so an attempt that produced none would be
 * invisible rather than failed. It writes no transcript, because there is
 * nothing truthful to put in one.
 *
 * Decision 7 (evidence at attempt, not at success) is satisfied here rather
 * than by any reporting hook: because a failed attempt still appends a record,
 * a consumer that watches records sees the failure for free, and this package
 * stays free of any knowledge of who consumes it.
 *
 * Decision 12: `endedReason` needs no new values. Its existing three already
 * map — `far_end` when the host ends it or removes us, `duration_cap` for our
 * own ceiling, `transcription_lost` when the audio pipeline dies.
 *
 * `consentReceipt` is always null here (Decision 6): a browser meeting has no
 * spoken consent exchange, so all five of that object's fields are
 * inapplicable. `status` — not this field — is what distinguishes a completed
 * meeting from a refused one.
 *
 * `transport: "browser"` is what makes that null legal, and it is stated
 * rather than left to be inferred. The record schema's consent invariant used
 * to read the presence of `joinOutcome` as a proxy for "consent is not spoken
 * here"; this package sets the fact the rule is actually about, so a record
 * from here is exempt because of what it IS rather than because of which
 * other fields it happens to carry.
 */
export async function emitMeetingArtifacts(
  input: EmitInput
): Promise<{ recordsPath: string; transcriptPath: string | null }> {
  const admitted = input.joinOutcome === "admitted";
  const durationSeconds = (Date.parse(input.endedAt) - Date.parse(input.startedAt)) / 1000;

  // The record is built and VALIDATED before anything reaches the disk. This
  // wrote the transcript first, and `buildMeetingRecord` throws on input it
  // refuses — a malformed timestamp makes durationSeconds NaN, which the
  // record schema rejects — so a bad input left a transcript on disk with no
  // record ever written for it. Nothing downstream watches transcripts; it
  // watches records. An orphan is therefore not a partial success, it is a
  // meeting that silently did not happen, plus a file of what was said in it.
  //
  // The path is resolved from `transcriptJsonlPath` rather than predicted,
  // so the name the record carries and the name the writer uses are one
  // expression and cannot drift apart.
  const transcriptPath = admitted ? transcriptJsonlPath(input.transcriptsDir) : null;

  const record = buildMeetingRecord({
    transport: "browser",
    callId: input.meetingId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationSeconds,
    status: admitted ? "completed" : "never_joined",
    endedReason: input.endedReason,
    coveredMs: admitted ? input.coveredMs : 0,
    gapMs: admitted ? input.gapMs : 0,
    modelTurnsCompleted: 0,
    joinOutcome: input.joinOutcome,
    consentReceipt: null,
    transcriptPath
  });

  if (transcriptPath !== null) {
    const written = await writeTranscriptJsonl(
      input.transcriptsDir,
      {
        callId: input.meetingId,
        startedAt: input.startedAt,
        // Decision 11: diarization was NOT attempted, and this must not
        // imply it was. Caption-derived attribution rides on each row's own
        // `speakerSource`/`speakerConfidence` instead — which is a claim
        // this comment made while it was false: the writer dropped both
        // fields in transit, so a name inferred from a caption within three
        // seconds was written indistinguishably from diarization-grade
        // attribution, and no reader could tell which one it held.
        diarized: false
      },
      attributeEvents(input.events, input.cues),
      []
    );
    if (written !== transcriptPath) {
      // Unreachable while both sides call `transcriptJsonlPath`. If it ever
      // becomes reachable, the record already names a file that is not the
      // one on disk, and appending it would publish that lie — so fail here
      // instead, loudly, with both paths.
      throw new Error(`transcript written to ${written} but the record names ${transcriptPath}`);
    }
  }

  await mkdir(dirname(input.recordsPath), { recursive: true, mode: 0o700 });
  await appendFile(input.recordsPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return { recordsPath: input.recordsPath, transcriptPath };
}
