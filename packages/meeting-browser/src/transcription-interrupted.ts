import type { TranscriptEvent } from "@parley/core";

/** A transcription that died part-way through, carrying what it had already
 * heard.
 *
 * The failure this exists to prevent is total rather than partial: the
 * transcription plane accumulates events for the whole meeting and only
 * returns them when the frame stream ends, so a tap that dies at minute 55 of
 * 60 rejected the promise and every one of those 55 minutes went with it. The
 * session's own `catch` turned the rejection into `[]`, so the record said
 * `transcription_lost` — accurately — over a transcript file that was empty
 * for no reason anyone could see.
 *
 * A REJECTION carrying the events, rather than a resolution: the rejection is
 * the only signal `session.ts` has that the pipeline died, and it is what
 * ends the meeting rather than sitting on a call it is no longer taking notes
 * on. Resolving with partial events would preserve the words and lose the
 * fact that they stop early — which is the more dangerous half, because a
 * short transcript that claims to be complete is unfalsifiable after the
 * meeting. Both facts travel together or the artifact lies about one of them.
 */
export class TranscriptionInterruptedError extends Error {
  /** Everything the transcriber had delivered before the interruption, in the
   * order it arrived. Possibly empty — a tap that dies before its first frame
   * is the same failure with nothing to salvage. */
  readonly events: readonly TranscriptEvent[];

  constructor(cause: unknown, events: readonly TranscriptEvent[]) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`transcription interrupted after ${events.length} utterance(s): ${detail}`, { cause });
    this.name = "TranscriptionInterruptedError";
    this.events = events;
  }
}

/** Whatever a failed transcription managed to hear before it failed.
 *
 * Exported beside the class so the recovery is one expression at the call
 * site and the `instanceof` test lives in exactly one place. Anything else —
 * a transcriber that could not connect at all, a bug — yields `[]`, because
 * there is genuinely nothing to salvage and inventing a partial transcript
 * from an unknown failure would be worse than an empty one. */
export function partialTranscript(error: unknown): TranscriptEvent[] {
  return error instanceof TranscriptionInterruptedError ? [...error.events] : [];
}
