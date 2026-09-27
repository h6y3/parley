import type { CaptionCue } from "./types.js";

/** The caption lines seen this meeting, each kept once, at the time it was
 * FIRST seen.
 *
 * This exists because a caption line is a thing on a screen, not an event. It
 * persists for several seconds while later lines push it up, and the scraper
 * stamps every line it can see with the instant of the scrape — so one spoken
 * sentence arrives three to ten times, each copy stamped LATER than the last.
 *
 * The damage is not noise, it is confident misattribution. When a new speaker
 * starts, the previous speaker's line is still on screen and gets an
 * identical, fresh timestamp; the aligner's tie-break (`attribution.ts`) only
 * prefers a cue whose `atMs` is strictly SMALLER, which two cues from one
 * scrape never are, so DOM order decides and the oldest line on screen wins.
 * The new speaker's words are then published under the previous speaker's
 * name, in a document a human reads and quotes.
 *
 * FIRST timestamp, never the last and never an average: a caption appears
 * once the words have been spoken and recognised, so its first appearance is
 * the closest this transport can get to when they were said. Every re-stamp
 * afterwards is the scraper's own clock, describing nothing that happened in
 * the room.
 *
 * The key is `(speaker, text)`. The cost of that choice, stated: a speaker
 * who says the same short thing twice in one meeting ("yes", "agreed") has
 * the second one folded into the first and keeps the earlier timestamp. That
 * is a bounded error on a line whose attribution is already correct — the
 * speaker is the same by construction — and it is much smaller than the
 * alternative, which is attributing a sentence to the wrong person entirely.
 *
 * Deduplicating also bounds the list. Unfiltered it grew by every line on
 * screen on every poll — tens of thousands of retained objects across a long
 * meeting, all of them copies, every one of them scanned by the aligner for
 * every utterance.
 *
 * What this does NOT fix, stated so nobody reads more into it: two DISTINCT
 * lines first seen in the same scrape still carry the same `atMs`, and the
 * aligner's tie-break cannot separate them, so list order decides between
 * those two. That is a genuine tie — both lines really did appear within one
 * poll of each other — and the error it can produce is bounded to speech from
 * the same second. The unbounded version was a stale line from minutes ago
 * being re-stamped into a tie with a live one, and that is what is gone.
 */
export interface CueLedger {
  /** Record a cue if this `(speaker, text)` has not been seen before.
   *
   * Returns whether it was recorded, which is what a test needs to tell "kept
   * the first" from "kept none". */
  add(cue: CaptionCue): boolean;
  /** Every distinct cue, in the order first seen. */
  readonly cues: readonly CaptionCue[];
}

/** `JSON.stringify` rather than a template string: `${speaker}|${text}` makes
 * a speaker named `A` saying `B|C` collide with a speaker named `A|B` saying
 * `C`, and there is no separator character a caption cannot contain. */
function cueKey(cue: CaptionCue): string {
  return JSON.stringify([cue.speaker, cue.text]);
}

export function createCueLedger(): CueLedger {
  const seen = new Set<string>();
  const cues: CaptionCue[] = [];
  return {
    add(cue: CaptionCue): boolean {
      const key = cueKey(cue);
      if (seen.has(key)) return false;
      seen.add(key);
      cues.push(cue);
      return true;
    },
    get cues(): readonly CaptionCue[] {
      return cues;
    }
  };
}
