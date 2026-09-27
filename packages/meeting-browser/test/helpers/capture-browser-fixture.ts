import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEvent } from "@parley/core";
import { emitMeetingArtifacts } from "../../src/artifacts.js";
import type { CaptionCue } from "../../src/types.js";

/**
 * CAPTURE the committed browser-transport meeting fixture by driving the real
 * production writer, rather than hand-writing a file that looks like what
 * production might emit.
 *
 * This is the same discipline as `packages/cli/test/helpers/capture-meeting-
 * fixtures.ts` and exists for the same reason: the committed fixtures are
 * contract to A2, the Python consumer, and a hand-authored one teaches its
 * author a shape production cannot produce. The previous generation of the
 * telephony fixtures did exactly that and shipped rows that could not exist.
 *
 * What is real here: `emitMeetingArtifacts` is the production writer, so
 * `attributeEvents` does the caption/utterance alignment, `writeTranscriptJsonl`
 * decides every row's shape, and `buildMeetingRecord` validates the record.
 * Nothing about attribution is asserted by this file -- it supplies utterances
 * and caption cues, and whatever alignment production performs is what gets
 * committed.
 *
 * What is not real: there is no browser, no CDP connection, no audio tap and no
 * transcription provider. Those produce the events and cues on a live run; here
 * they are the inputs. This fixture is about the ARTIFACT shape a browser
 * meeting emits, which is the only part A2 consumes.
 *
 * Deterministic by construction: every timestamp is a literal, and
 * `transcriptJsonlPath` is a pure join. No `Date` faking is needed, unlike the
 * telephony capture, because nothing here reads a clock.
 *
 * NO network call and no credential.
 *
 * `isFinal: true` on every event is not decoration: `writeTranscriptJsonl`
 * drops any event without it ("interims are a wire concern, never a record"),
 * and the first run of this capture omitted it and produced a transcript of
 * nothing but a header. A hand-authored fixture would have carried four rows
 * production discards, and taught its reader a shape that cannot occur.
 */

/** The two display names Google Meet's caption region would show. Both are
 * established sample identities in this repository; no real person appears in
 * a committed fixture. */
const JORDAN = "Jordan Rivera";
const ALEX = "Alex Mercer";

const STARTED_AT = "2026-08-27T16:00:00.000Z";
const ENDED_AT = "2026-08-27T16:04:00.000Z";

/**
 * Four utterances, three caption cues, and that asymmetry is the point.
 *
 * The third utterance has no cue within `ALIGN_WINDOW_MS`, so production leaves
 * it unattributed. A fixture in which every row is attributed would let a
 * consumer treat attribution as total and never write the branch for a row that
 * has none -- and captions dropping lines is ordinary, not exceptional. This is
 * the committed sample of a PARTIALLY attributed transcript, which is the shape
 * a real meeting produces.
 */
const EVENTS: readonly TranscriptEvent[] = [
  {
    speaker: "participant",
    isFinal: true,
    startMs: 12000,
    endMs: 18000,
    text: "Let's start with the ingest rewrite. The review is done, so that unblocks the next ticket."
  },
  {
    speaker: "participant",
    isFinal: true,
    startMs: 31000,
    endMs: 38000,
    text: "Then I'll take the migration this week. I want the backfill finished before the freeze."
  },
  {
    speaker: "participant",
    isFinal: true,
    startMs: 58000,
    endMs: 63000,
    text: "One thing we still have not settled is whether the freeze date moves."
  },
  {
    speaker: "participant",
    isFinal: true,
    startMs: 74000,
    endMs: 81000,
    text: "Let's decide the freeze on Thursday once we see where the backfill lands."
  }
];

/** Caption cues as the DOM scraper reports them: a display name, the caption
 * text, and the time the line was first seen.
 *
 * The cue text deliberately does NOT match the utterance text word for word --
 * unpunctuated and lowercased, as Meet's live caption region renders it. The
 * two pipelines are independent: Deepgram produces the transcript from tapped
 * audio, the caption region is an accessibility rendering of the same speech.
 * Only `speaker` is taken from a cue; a fixture whose cue text matched its
 * utterance text exactly would invite a future consumer to align the two on
 * content, which production never does and could not rely on. Cue times deliberately straddle their utterance --
 * captions render after the words are spoken, and one here lands slightly
 * EARLY, because the tap and the renderer have independent latency and the
 * aligner must not assume a sign. */
const CUES: readonly CaptionCue[] = [
  {
    speaker: JORDAN,
    text: "lets start with the ingest rewrite the review is done so that unblocks the next ticket",
    atMs: 12800
  },
  {
    speaker: ALEX,
    text: "then ill take the migration this week i want the backfill finished before the freeze",
    atMs: 30400
  },
  {
    speaker: JORDAN,
    text: "lets decide the freeze on thursday once we see where the backfill lands",
    atMs: 74600
  }
];

export async function captureMeetAttributedStandup(
  outDir: string,
  committedTranscriptPath: string
): Promise<{ record: unknown; transcript: string }> {
  const recordsPath = join(outDir, "records.jsonl");
  const transcriptsDir = join(outDir, "transcripts");

  const { transcriptPath } = await emitMeetingArtifacts({
    meetingId: "MEETfixture0001",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    endedReason: "far_end",
    // A browser meeting has no consent handoff, so coverage starts at join and
    // `coveredMs + gapMs` accounts for the WHOLE meeting -- unlike the
    // telephony fixtures, where the pre-consent period is uncovered by
    // construction. A consumer that learned "the sum is always short" from
    // roadmap-sync alone would have learned a telephony fact as a universal one.
    coveredMs: 232000,
    gapMs: 8000,
    joinOutcome: "admitted",
    recordsPath,
    transcriptsDir,
    events: EVENTS,
    cues: CUES
  });

  if (transcriptPath === null) throw new Error("capture wrote no transcript");

  const transcript = await readFile(transcriptPath, "utf8");
  const recordLine = (await readFile(recordsPath, "utf8")).trim();
  const record = JSON.parse(recordLine) as Record<string, unknown>;

  // The one substitution, identical to the telephony capture's: a capture into
  // a scratch directory cannot know where its own output will be committed.
  record.transcriptPath = committedTranscriptPath;

  return { record, transcript };
}
