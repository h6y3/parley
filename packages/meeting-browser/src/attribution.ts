import type { TranscriptEvent } from "@parley/core";
import type { CaptionCue } from "./types.js";

/** How far apart a caption cue and an utterance may start and still be taken
 * for the same speech. Captions are rendered after the words are spoken and
 * the two pipelines have independent latency, so exact equality never happens.
 * Three seconds is wide enough to absorb that skew and narrow enough that a
 * different speaker's next sentence does not fall inside it at conversational
 * pace. */
export const ALIGN_WINDOW_MS = 3000;

/** Attribution derived from captions is INFERRED, and this is the number that
 * says so. It is deliberately not 1: `speakerSource: "roster"` plus a
 * confidence below certainty is the honest description of "the meeting UI said
 * this name was speaking around then". True diarization would be a different
 * `speakerSource` and would license a stronger claim. */
export const ROSTER_CONFIDENCE = 0.6;

/** Attach speaker names from caption cues to transcript events, by time.
 *
 * Pure and non-mutating: returns new event objects. An event with no cue
 * inside `ALIGN_WINDOW_MS` is returned unattributed rather than guessed at —
 * captions dropping a line must cost that line's attribution and nothing more.
 *
 * Tie-break: when two cues are exactly equidistant from an utterance, the
 * EARLIER cue (by `atMs`) wins. This is a deliberate, order-independent rule,
 * not an artifact of iteration order — a caller passing the same two cues in
 * either order must get the same speaker back.
 */
export function attributeEvents(
  events: readonly TranscriptEvent[],
  cues: readonly CaptionCue[],
  opts: { windowMs?: number } = {}
): TranscriptEvent[] {
  const windowMs = opts.windowMs ?? ALIGN_WINDOW_MS;
  return events.map((event) => {
    if (event.startMs === undefined) return { ...event };
    let best: CaptionCue | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const cue of cues) {
      const delta = Math.abs(cue.atMs - event.startMs);
      if (delta > windowMs) continue;
      const isCloser = delta < bestDelta;
      const isTieButEarlier = delta === bestDelta && best !== undefined && cue.atMs < best.atMs;
      if (isCloser || isTieButEarlier) {
        best = cue;
        bestDelta = delta;
      }
    }
    if (!best) return { ...event };
    return {
      ...event,
      speakerId: best.speaker,
      speakerSource: "roster" as const,
      speakerConfidence: ROSTER_CONFIDENCE
    };
  });
}
