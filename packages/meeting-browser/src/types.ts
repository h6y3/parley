/** The join outcomes are declared ONCE, in `@parley/core` — not here, and not
 * in `@parley/cli`'s record schema, which used to retype the same strings
 * into a `z.enum(...)` because this package depends on the CLI and so cannot
 * be imported by it. Re-exported rather than redeclared so this package's
 * public surface is unchanged and there is still exactly one list. */
import type { JoinOutcome } from "@parley/core";

export { JOIN_OUTCOMES } from "@parley/core";
export type { JoinOutcome } from "@parley/core";

/** One caption line as the meeting UI rendered it: who, what, and when we saw
 * it. Times are milliseconds since the session's t0, matching
 * `TranscriptEvent.startMs`'s base so the aligner needs no conversion. */
export interface CaptionCue {
  speaker: string;
  text: string;
  atMs: number;
}

/** What every platform must implement. Spec 3 adds Zoom and Teams behind this
 * same interface; nothing outside this package may branch on platform. */
export interface PlatformAdapter {
  readonly id: string;
  /** Drive the pre-join screen: name, camera off, microphone off, then ask to
   * join. Resolves to how the attempt ended. */
  join(page: unknown, url: string, displayName: string): Promise<JoinOutcome>;
  /** Switch the platform's live captions ON, and report whether they are on
   * when this resolves. Called ONCE, after admission and before the first
   * `readCaptions`.
   *
   * `false` is a legitimate answer, not an error: a meeting whose captions
   * cannot be enabled must still be recorded, just without speaker
   * attribution. `true` is the only thing that licenses a caller to call
   * `readCaptions` at all — an adapter that returns `false` is telling the
   * caller that `readCaptions` would throw, since a scraper is required to
   * throw rather than report an absent container as a quiet room.
   *
   * MUST NOT throw for the ordinary "no control here" case; reserve a throw
   * for a page that cannot be driven at all. A caller is still expected to
   * treat a throw as `false` rather than as the end of the meeting. */
  ensureCaptions(page: unknown): Promise<boolean>;
  /** Every caption line currently on screen. MUST throw rather than return []
   * when its selector matches no element at all — see Decision 8. Call only
   * after `ensureCaptions` has resolved `true`. */
  readCaptions(page: unknown): Promise<CaptionCue[]>;
  /** Current participant display names. Same throw-on-no-match rule. */
  readRoster(page: unknown): Promise<string[]>;
  /** True once the meeting has ended or we have been removed. */
  hasEnded(page: unknown): Promise<boolean>;
  /** Leave the meeting: drive whatever control the platform offers for it.
   *
   * Called on EVERY ending, including a join that was never admitted — the
   * lobby has a leave control too, and a notetaker that stopped recording but
   * stayed in the participant list is asserting, under the display name that
   * is the room's only disclosure, something that has stopped being true.
   *
   * MUST NOT throw for "there is nothing to leave". A meeting the room ended
   * has already taken the control off the page, and that is the commonest
   * ending there is; a throw on it would report a fault on every healthy
   * meeting. Reserve a throw for a page that could not be driven at all — a
   * caller is required to guard this and to write its record anyway, because
   * failing to get out is not a reason to lose the meeting. */
  leave(page: unknown): Promise<void>;
}

/** Two hours. A meeting is not a phone call: the PSTN path's ceiling is far
 * too short, and an unbounded session is a runaway browser on a shared host. */
export const DEFAULT_MAX_MEETING_SECONDS = 7200;

export interface BrowserMeetingConfig {
  url: string;
  /** Caller-supplied (Decision 2: the display name IS the disclosure). This
   * package ships no default, and must not: the name is the legal disclosure
   * to the room, and a library does not get to choose it. It replaces the
   * spoken announcement entirely. */
  displayName: string;
  chromeProfileDir: string;
  recordsPath: string;
  transcriptsDir: string;
  maxMeetingSeconds?: number;
  /** How long the platform's "we are no longer in a meeting" signal must hold
   * CONTINUOUSLY before this session believes it, in seconds. Defaults to
   * `HAS_ENDED_CONFIRM_MS` (`join-driver.ts`), which is where the reasoning
   * for the number lives.
   *
   * A knob rather than a constant because the right value is a property of
   * the DEPLOYMENT, not of the platform: it trades how promptly a real ending
   * is noticed against how long a page blackout — a reconnect, a cold re-render
   * of the meeting UI — can last without being mistaken for one. A host on a
   * flaky link wants more; nothing here can know which host it is on. */
  endedConfirmSeconds?: number;
}
