/** How much of this meeting the transcript can actually vouch for.
 *
 * The record's two fields are defined by the committed schema:
 * `coveredMs` is "milliseconds of audio actually delivered to the
 * transcriber — what the transcript can vouch for", and `gapMs` is what tells
 * a consumer that "a real stretch of what the room said may be missing". This
 * module is where both stop being guesses.
 *
 * They were `endedAt - t0` and `0`, unconditionally — so `coveredMs` always
 * equalled `durationSeconds * 1000` exactly and `gapMs` always said there
 * were no holes. That claim survived a tap that never started, a capture that
 * died at minute 2 of 60, and the ordinary happy path, where the minutes
 * before the tap opened (the waiting room, the captions toggle) were counted
 * as covered audio. A number that is the same on a healthy meeting and a
 * broken one carries no information, and it is worse than an absent one
 * because it reads as a measurement.
 */

/** What the session observed. Every field is an instant on the session's own
 * clock (`SessionDeps.now`), the same clock `startedAt` and `endedAt` come
 * from — a coverage window measured against a different clock than the record
 * it sits in is the silent kind of wrong. */
export interface CoverageInput {
  /** The session's t0 — its first clock reading. */
  t0: number;
  /** When the capture began, or `null` if it never did. */
  captureStartedAtMs: number | null;
  /** When the last frame of audio reached the transcriber, or `null` if none
   * ever did. */
  lastFrameAtMs: number | null;
  /** When the meeting ended. */
  endedAtMs: number;
}

export interface Coverage {
  coveredMs: number;
  gapMs: number;
}

/** Split the meeting into the part the transcript can vouch for and the part
 * it cannot.
 *
 * The window opens when the capture did. Time before that — waiting room,
 * admission, switching captions on — is outside it, exactly as the record
 * schema describes for the telephony transport's pre-consent time: counted by
 * neither field, which is why `coveredMs + gapMs` is normally LESS than
 * `durationSeconds * 1000` and why that shortfall is not a bug to reconcile.
 *
 * With ONE exception, and it is deliberate: if the capture never started at
 * all, the window is taken to be the whole meeting and every millisecond of
 * it is a gap. There is no window to measure in that case, and `gapMs: 0`
 * would say "no holes" about a meeting where nothing whatsoever was recorded
 * — the precise lie this module exists to remove.
 *
 * What `coveredMs` measures is the DELIVERY window: first frame to last, from
 * a stream that either flows or dies. It is not a sum of frame durations, so
 * a device that stayed open while producing silence is counted as covered.
 * That is the honest limit of what this transport can observe from outside
 * the audio, and it is stated rather than papered over. */
export function measureCoverage(input: CoverageInput): Coverage {
  const windowStart = input.captureStartedAtMs ?? input.t0;
  const coveredUntil = input.lastFrameAtMs ?? windowStart;
  const coveredMs = Math.max(0, coveredUntil - windowStart);
  const gapMs = Math.max(0, input.endedAtMs - windowStart - coveredMs);
  return { coveredMs, gapMs };
}

export interface FrameCoverageClock {
  /** Pass the tap's frames through, remembering when the last one was
   * handed on. */
  meter(frames: AsyncIterable<Buffer>): AsyncIterable<Buffer>;
  /** When the last frame reached the transcriber, or `null` if none did. */
  readonly lastFrameAtMs: number | null;
}

/** Watch frames go past, and remember when the last one did.
 *
 * That instant, and not "when `transcribe` settled", is when audio stopped
 * reaching the transcriber: a transcription resolves only after its flush
 * round-trip, which would inflate every meeting's coverage by the flush, and
 * it can also resolve long after a stream died. Metering the stream itself
 * costs one clock read per frame and answers the question directly. */
export function createFrameCoverageClock(now: () => number): FrameCoverageClock {
  let lastFrameAtMs: number | null = null;
  return {
    get lastFrameAtMs(): number | null {
      return lastFrameAtMs;
    },
    async *meter(frames: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
      for await (const frame of frames) {
        lastFrameAtMs = now();
        yield frame;
      }
    }
  };
}
