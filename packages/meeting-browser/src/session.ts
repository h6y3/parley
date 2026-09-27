import { randomUUID } from "node:crypto";
import type { TranscriptEvent } from "@parley/core";
import { emitMeetingArtifacts } from "./artifacts.js";
import { createFrameCoverageClock, measureCoverage } from "./coverage.js";
import { createCueLedger } from "./cue-ledger.js";
import { waitUntilMeetingEnded } from "./join-driver.js";
import { partialTranscript } from "./transcription-interrupted.js";
import { DEFAULT_MAX_MEETING_SECONDS } from "./types.js";
import type { BrowserMeetingConfig, JoinOutcome, PlatformAdapter } from "./types.js";

/** Cadence for both loops this module drives: the caption-reading loop, and
 * `waitUntilMeetingEnded`'s own internal poll (passed in as `pollMs` below,
 * rather than its own default) — one number for both, so there is only one
 * interval to reason about. */
export const CAPTION_POLL_MS = 1000;

export interface SessionDeps {
  openPage(profileDir: string): Promise<unknown>;
  /** Close the page `openPage` returned, and NOTHING else.
   *
   * Not the browser and not the operator's other tabs: this transport attaches
   * to a Chrome window a human started and signed in by hand, so the only
   * thing it is entitled to close is the one page it opened itself.
   *
   * Paired with `openPage` here rather than folded into the caller's own
   * teardown because the page is opaque to this module — it is whatever
   * `openPage` returned — and a module that cannot name the type cannot close
   * it. Called on every ending, after `adapter.leave`, and required to be safe
   * on a page that is already gone. */
  closePage(page: unknown): Promise<void>;
  adapter: PlatformAdapter;
  /** MUST NOT be called before `adapter.join` resolves `"admitted"` — see
   * Decision 4 at the call site below.
   *
   * `startedAtMs` is when the capture began, on THIS deps object's own
   * `now()` clock. Reported by whoever starts the tap rather than observed
   * here, because the composition root already takes that reading to offset
   * the transcriber's clock — and two readings of one instant is two answers
   * to "when did capture begin", one of which would be wrong the moment they
   * drifted. It is the origin of the record's coverage window. */
  startTap(): { frames: AsyncIterable<Buffer>; stop(): Promise<void>; startedAtMs: number };
  /** Consume the tap's frames and resolve with everything that was heard.
   *
   * A failure mid-meeting MUST reject — that rejection is this module's only
   * signal that the pipeline died, and it is what ends the meeting rather
   * than leaving it sitting on a call it is no longer taking notes on. It
   * must reject with a `TranscriptionInterruptedError` carrying the events
   * that had already arrived: an implementation that rejects with a bare
   * error is asserting that a pipeline which died at minute 55 heard nothing
   * in the first 55, and this module cannot tell the difference. */
  transcribe(frames: AsyncIterable<Buffer>): Promise<TranscriptEvent[]>;
  now(): number;
  /** Hand the finished meeting to whatever post-call hook the deployment has
   * configured. Bound to its command (if any) by whoever constructs this
   * deps object — this module never reads `process.env` itself, which is
   * what lets its own tests inject a fake dispatcher instead of mutating the
   * environment. Called on EVERY join outcome, including a failed one: a
   * join that never succeeded is exactly the event most worth reporting, and
   * a rejection here (a hook that could not spawn at all) is left to
   * propagate rather than being caught and discarded. */
  dispatchPostCall(recordsPath: string, meetingId: string): Promise<number | null>;
}

/** The three values the committed record schema accepts (`endedReason`,
 * `@parley/cli`'s `meeting-record.ts`). Not this module's own vocabulary —
 * see `SessionEnding`. */
type EndedReason = "far_end" | "duration_cap" | "transcription_lost";

/** How the session actually stopped, in this module's own terms. One more
 * member than the record has, because the record's list is committed and
 * shared with a consumer in another repository; collapsing the distinction
 * here as well would lose it entirely.
 *
 * `capture_failed` is an adapter or tap that THREW — `readCaptions` on a page
 * whose captions region has gone, `hasEnded` on a page that will not answer,
 * a tap that cannot be started or stopped. Distinct from `transcription_lost`
 * because that one is an ENUMERATED failure of a subsystem this module models
 * on purpose, with its own observer promise; this is the control flow itself
 * breaking. */
type SessionEnding = EndedReason | "capture_failed";

/** How each ending is written down. `capture_failed` maps to
 * `transcription_lost` and there is no other honest choice available: the
 * record's enum is exactly three values and cannot be widened from here (it
 * is `@parley/cli`'s, and a Python consumer validates against the committed
 * JSON Schema). Of the three, `far_end` would claim the room hung up and
 * `duration_cap` would claim we hit our own ceiling — both false, and both
 * describe a broken capture as a healthy meeting that simply ended early.
 * `transcription_lost` says the pipeline that produces the transcript died
 * mid-meeting and the meeting was ended deliberately rather than continue not
 * taking notes, which is precisely what happened. */
const RECORD_ENDED_REASON: Record<SessionEnding, EndedReason> = {
  far_end: "far_end",
  duration_cap: "duration_cap",
  transcription_lost: "transcription_lost",
  capture_failed: "transcription_lost"
};

/** This meeting's identifier: the session's start instant, then eight random
 * hex characters.
 *
 * The timestamp alone was the whole id, and two meetings starting in the same
 * millisecond therefore got the SAME one — not a theoretical concern for a
 * library whose caller may well start several joins from one scheduler tick,
 * and a silent one: the id is the record's `callId` and the argument the
 * post-call hook is dispatched with, so a collision merges two meetings into
 * one as far as every consumer downstream is concerned, with no error
 * anywhere.
 *
 * The timestamp is KEPT and kept first: it is what makes a records file sort
 * and skim usefully, and the schema calls `callId` opaque, so nothing
 * downstream parses it. The suffix is `randomUUID` rather than a counter
 * because a counter is per-process and two processes writing one records file
 * is exactly the case a counter cannot cover. */
function newMeetingId(startedAtMs: number): string {
  return `MTG${startedAtMs}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/** Whatever was thrown, as an `Error`. A caller that reads `captureFault`
 * needs a message and a stack, and `throw "nope"` is legal JavaScript. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** How long any one teardown step will wait on the PAGE before giving up on
 * it and finishing the meeting without it.
 *
 * Everything teardown does to a page — leaving, closing, and waiting for the
 * two polling loops to notice they have been stopped — is a round trip into
 * somebody else's renderer, and a wedged renderer answers none of them. The
 * duration ceiling exists to bound a runaway browser on a shared host, and it
 * cannot do that if the steps AFTER it fire are themselves unbounded: the
 * ceiling would resolve on time and the run would hang one line later, which
 * is the same defect moved rather than fixed.
 *
 * Five seconds is far longer than any of these takes on a page that is
 * answering at all, and short enough that a wedged one costs the record
 * nothing worth having. Giving up is recorded as a fault, never as silence. */
export const TEARDOWN_STEP_TIMEOUT_MS = 5000;

/** Whether `promise` settled inside `ms`. OBSERVES it either way — a rejection
 * that nobody reads is an unhandled rejection, and these promises are exactly
 * the ones a caller is abandoning — and clears its own timer when it wins, so
 * a bounded step leaves nothing armed behind it. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    const settle = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(settle, settle);
  });
}

/** The duration ceiling, as a branch of the race in its own right.
 *
 * It used to be a `deps.now()` comparison at the top of the caption loop,
 * which meant it could only fire if that loop was still going round. Every
 * other line of that loop is a browser round trip with NO default timeout, so
 * a wedged renderer parked the loop indefinitely and the ceiling — the thing
 * protecting against a runaway browser on a shared host — was never evaluated
 * again. A timer does not need the page's cooperation to expire.
 *
 * CANCELLABLE, and the caller must cancel it: this is a two-hour timer by
 * default, and an abandoned one holds the event loop open for the rest of it
 * on every meeting that ends any other way. */
function armCeiling(ms: number): { reached: Promise<"duration_cap">; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<"duration_cap">((resolve) => {
    timer = setTimeout(() => {
      resolve("duration_cap");
    }, ms);
  });
  return {
    reached,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/** Resolves as soon as EITHER `ms` has elapsed OR `stop` has already settled
 * — so a caption-loop tick can be cut short the instant the meeting's ending
 * is decided elsewhere (by `waitUntilMeetingEnded`, the duration ceiling, or
 * a transcription failure), instead of finishing out its own last sleep.
 *
 * CLEARS its own timer when `stop` wins. `Promise.race` settles the promise
 * but does nothing to the loser, so the abandoned `setTimeout` stayed armed
 * and kept the event loop alive for up to a full poll interval AFTER the
 * meeting was torn down, the record written and the tap stopped — a process
 * that should have exited sitting there waiting on a tick nobody would read.
 * `defaultWait` in `join-driver.ts` already takes exactly this care for
 * exactly this reason; this is the same hazard, in the other loop of the
 * same race, and it was the half that did not. */
function tickOrStop(ms: number, stop: Promise<void>): Promise<"stop" | "tick"> {
  return new Promise<"stop" | "tick">((resolve) => {
    const timer = setTimeout(() => {
      resolve("tick");
    }, ms);
    void stop.then(() => {
      clearTimeout(timer);
      resolve("stop");
    });
  });
}

export interface BrowserMeetingResult {
  joinOutcome: JoinOutcome;
  recordsPath: string;
  transcriptPath: string | null;
  /** Whether the platform's live captions were still carrying attribution
   * when this meeting ended.
   *
   * `false` is not an error and does not stop a meeting being recorded — it
   * says the transcript in `transcriptPath` is not fully attributed, because
   * attribution comes from captions. It covers two cases deliberately: they
   * were never on, and they stopped part-way (`readCaptions` threw, which
   * loses attribution and nothing else — see the caption loop). A partly
   * attributed transcript reads `false`, because a caller deciding whether to
   * put names in front of a human needs "not throughout", not "at some
   * point". `captureFault` carries which of the two it was.
   *
   * The record cannot say this: it has no field for it, and `endedReason`
   * would be a lie (the meeting ended perfectly normally). A caller that
   * presents a transcript to a human is the one that needs to know, so it is
   * returned rather than swallowed. */
  captionsEnabled: boolean;
  /** What broke, when something broke, and `null` on every clean run.
   *
   * The record cannot carry this: its `endedReason` is a committed
   * three-value enum, so `capture_failed` is written down as
   * `transcription_lost` and the message that says WHICH adapter call threw
   * has nowhere in the record to live. Returned rather than logged, because
   * this package owns no logger and picking one for its callers is not its
   * decision — and rather than rethrown, because the record, the transcript
   * and the post-call dispatch have all already succeeded by then, and a
   * rejection would hide three completed side effects behind one failure. */
  captureFault: Error | null;
}

/**
 * Drives one meeting end to end: open the page, attempt to join, and — only
 * once admitted — capture audio and captions until the meeting ends, then
 * emit the record and (if admitted) the transcript.
 *
 * Every join attempt emits a record, including a failed one (Decision 10 —
 * `emitMeetingArtifacts`'s own doc comment): a consumer watches records, so
 * an attempt that produced none would be invisible rather than failed. A
 * failed join writes no transcript, because there is nothing truthful to put
 * in one.
 *
 * "Every attempt" includes an attempt something THREW during, at ANY point —
 * opening the page, driving the join, reading captions, stopping the tap. All
 * of them end the meeting through the same teardown as any other ending —
 * stop signal, ended-poll abort, tap stop, record, post-call hook — and the
 * record says `transcription_lost`, never `far_end`. The error itself comes
 * back in `captureFault`.
 *
 * The two join-time calls were outside that guarantee until this round, and
 * they are the likeliest to throw in the whole package: a throw from either
 * produced no record at all, and a throw from the second one left the
 * transport in the room while it did so.
 */
export async function runBrowserMeeting(
  config: BrowserMeetingConfig,
  deps: SessionDeps
): Promise<BrowserMeetingResult> {
  const t0 = deps.now();
  let captionsEnabled = false;
  const startedAt = new Date(t0).toISOString();
  const meetingId = newMeetingId(t0);

  /** When the capture began, and `null` until it has — the origin of the
   * record's coverage window. Declared here because `finish` reads it on
   * every exit, including the ones reached before a tap exists at all. */
  let captureStartedAtMs: number | null = null;
  /** Watches frames go past on their way to the transcriber, so the coverage
   * window closes when audio actually stopped arriving rather than when the
   * transcription promise happened to settle. */
  const frameClock = createFrameCoverageClock(deps.now);

  /** Every DISTINCT caption line this meeting showed, at the time it was
   * first shown — see `cue-ledger.ts`. A plain array here recorded one cue
   * per line per poll, so a sentence on screen for six seconds became six
   * cues, each stamped later than the last, and the newest speaker's words
   * were published under the previous speaker's name. */
  const cues = createCueLedger();

  /** Whatever broke first, and `null` on every clean run. ONE variable rather
   * than a parameter threaded through `finish`: five separate sites can write
   * it now — the two join-time guards below, the caption loop, the ended-poll
   * and the tap's own stop — and a second channel for the same fact is a
   * second chance for a caller to report the wrong one. First writer wins:
   * the earliest fault is the one that explains the rest. */
  let captureFault: Error | null = null;
  const noteFault = (error: unknown): void => {
    captureFault ??= asError(error);
  };

  /** How the join ended, and the value written down if it never returned one
   * at all.
   *
   * `join_error` (`JOIN_OUTCOMES`, `@parley/core`) means exactly that: the
   * attempt did not run to completion, so there is no verdict to report. It
   * is the initial value AND what both guards below leave behind, because
   * both cover the same shape — a page that would not open, or a join that
   * threw part-way through.
   *
   * This was `waiting_room_timeout`, on the reasoning that widening the enum
   * would break a consumer validating against a committed schema. That
   * constraint does not hold: the consumer resolves its schema directory to
   * this repository's own `schema/` folder and reads the committed files
   * directly, so regenerating updates its validation in the same motion. What
   * the old value cost is not hypothetical — it made ONE outcome mean three
   * different things (a genuine lobby timeout, a successful join whose
   * in-call anchors went unrecognised, and a crash), which is precisely the
   * defect this project has already fixed once, when a single message covered
   * two distinct refusals and a live failure could not be diagnosed from the
   * log.
   *
   * WHICH throw it was is still in `captureFault`, and `status:
   * "never_joined"` still says the meeting never happened. Read the three
   * together — but the first of them no longer has to carry the other two. */
  let joinOutcome: JoinOutcome = "join_error";

  /** Whether a page is open that this run is responsible for getting out of.
   * A flag rather than a null check on the page itself: the page is `unknown`,
   * so `undefined` is a value `openPage` is allowed to return and cannot be
   * read as "there isn't one". */
  let pageIsOpen = false;

  /** Get out of the meeting, and close the tab this transport opened.
   *
   * Until this round neither happened. `leaveCallButton` was defined in the
   * adapter and never clicked, and the page was never closed — only the CDP
   * connection was dropped. So after ANY ending the notetaker stayed in the
   * participant list, under the display name that is the room's only
   * disclosure that a notetaker is present, no longer recording anything,
   * with the owning process gone and no way to remove it but by hand. On a
   * meeting that outruns the duration ceiling that is guaranteed rather than
   * hypothetical, and the display name goes on asserting something that
   * stopped being true at teardown.
   *
   * BOTH steps, in this order, and neither is redundant. The click is the
   * graceful exit and is what the room sees; closing the page is what
   * actually guarantees departure, since a closed tab cannot be a
   * participant. That is also why a failed leave is only noted: the close
   * behind it still gets us out.
   *
   * Guarded end to end, because "every attempt emits evidence" outranks it —
   * a page that will not answer is a fault to REPORT, never a reason to throw
   * away the meeting that was already recorded. Runs exactly once. */
  const leaveMeetingAndClosePage = async (): Promise<void> => {
    if (!pageIsOpen) return;
    pageIsOpen = false;
    for (const [what, run] of [
      ["leaving the meeting", () => deps.adapter.leave(page)],
      ["closing the page", () => deps.closePage(page)]
    ] as const) {
      const done = run().then(
        () => undefined,
        (error: unknown) => {
          noteFault(error);
        }
      );
      // Bounded for the same reason the loop waits below are: these are calls
      // into a page that may be exactly the thing that has stopped answering,
      // and the record must not be held hostage to it.
      if (!(await settledWithin(done, TEARDOWN_STEP_TIMEOUT_MS))) {
        noteFault(
          new Error(
            `meeting teardown: ${what} did not finish within ${TEARDOWN_STEP_TIMEOUT_MS}ms. The ` +
              `notetaker may still be in the participant list; the meeting is being written ` +
              `down regardless.`
          )
        );
      }
    }
  };

  /** Write the record, hand it to the post-call hook, and return. Every exit
   * from this function goes through here — including the ones reached by
   * something throwing. That is the whole point: "every attempt emits
   * evidence" is not a property of the happy path, and a teardown reachable
   * only when nothing went wrong is not a teardown. */
  const finish = async (
    ending: SessionEnding,
    events: readonly TranscriptEvent[]
  ): Promise<BrowserMeetingResult> => {
    // The clock is read BEFORE teardown, not after: `endedAtMs` is when the
    // meeting ended, and leaving takes a click and a page close. Read
    // afterwards it would charge the teardown to the meeting's duration and
    // to `gapMs`, which measures against this same instant.
    const endedAtMs = deps.now();
    await leaveMeetingAndClosePage();
    const endedAt = new Date(endedAtMs).toISOString();
    // Measured, not assumed — see `coverage.ts`. These two were
    // `endedAt - t0` and `0`, so every record claimed perfect coverage with
    // no holes: on a meeting whose capture never started, on one whose
    // capture died two minutes in, and on the happy path, where the minutes
    // spent in the waiting room were counted as audio the transcript could
    // vouch for.
    const coverage = measureCoverage({
      t0,
      captureStartedAtMs,
      lastFrameAtMs: frameClock.lastFrameAtMs,
      endedAtMs
    });
    const out = await emitMeetingArtifacts({
      meetingId,
      startedAt,
      endedAt,
      endedReason: RECORD_ENDED_REASON[ending],
      coveredMs: coverage.coveredMs,
      gapMs: coverage.gapMs,
      joinOutcome,
      recordsPath: config.recordsPath,
      transcriptsDir: config.transcriptsDir,
      events,
      cues: cues.cues
    });
    await deps.dispatchPostCall(out.recordsPath, meetingId);
    return { joinOutcome, captionsEnabled, captureFault, ...out };
  };

  // The two riskiest calls in the package, and until now the only two outside
  // a guard. Both are chains of browser round trips that throw on a timeout or
  // a rotated selector — the ordinary failure of a scraper driving somebody
  // else's single-page app — and an unguarded throw here rejected
  // `runBrowserMeeting` before `finish` existed, so the attempt produced NO
  // record. On a consumer that watches records that is invisible rather than
  // failed, which is the one thing this module promises never to be.
  //
  // The worse half is the second one: `joinMeeting` calls `hasEnded` AFTER the
  // click and after admission is confirmed, so a throw there left the
  // transport sitting IN the room, with no record, no capture, and a caller
  // whose `finally` merely drops the CDP connection.
  let page: unknown;
  try {
    page = await deps.openPage(config.chromeProfileDir);
    pageIsOpen = true;
  } catch (error) {
    // No page was ever opened, so there is nothing to leave and nothing to
    // close — but there is still an attempt to write down.
    noteFault(error);
    return finish("capture_failed", []);
  }

  try {
    joinOutcome = await deps.adapter.join(page, config.url, config.displayName);
  } catch (error) {
    // `joinOutcome` is left at its initial `join_error`, deliberately not
    // reassigned here: the assignment above is the ONLY thing that can move
    // it off that value, so "the join threw" and "the join never returned"
    // cannot drift apart into two spellings of the same fact.
    noteFault(error);
    return finish("capture_failed", []);
  }

  if (joinOutcome !== "admitted") {
    // `far_end` on a join that never happened is not a claim that the room
    // hung up — it is the record schema's own catch-all, and the field that
    // says what actually occurred here is `status: "never_joined"`, which
    // `emitMeetingArtifacts` sets from this same `joinOutcome`. The schema
    // has no member meaning "never connected", deliberately: it documents
    // `far_end` as the default covering an error or a party that was never
    // reached, and adding a value a reader is told to expect would mean
    // changing a committed schema another repository validates against.
    // `joinOutcome` itself carries WHICH failure it was. Read the three
    // fields together; none of them lies on its own.
    return finish("far_end", []);
  }

  // Captions are what carry speaker attribution, and Meet does not have them
  // on by default. Nothing here used to switch them on — every fixture-backed
  // test ran against a capture whose operator had enabled them by hand — so
  // on a real meeting the first `readCaptions` would have found no region and
  // thrown.
  //
  // A failure to enable them DEGRADES and never ends the meeting: the audio
  // tap and the transcriber are untouched by it, so the meeting still
  // produces a full transcript, just an unattributed one (`attributeEvents`
  // returns every event unchanged when it is given no cues). Losing who said
  // what is a real loss; losing the meeting is a much larger one, and the
  // choice between them is not close.
  //
  // A THROW here is treated as `false` for the same reason. The adapter
  // contract asks for `false` rather than a throw on the ordinary "no
  // control" case, but a session that died because a toggle could not be
  // clicked would be the very failure this whole change exists to remove.
  try {
    captionsEnabled = await deps.adapter.ensureCaptions(page);
  } catch {
    captionsEnabled = false;
  }

  // Decision 4: the tap captures ALL system audio, since macOS has no
  // per-application output routing. Started before admission was confirmed,
  // a failed join would quietly transcribe whatever room the host machine is
  // sitting in. It must not start until this line is reached.
  //
  // Guarded because a throw here used to reject `runBrowserMeeting` outright,
  // and a meeting that WAS joined then produced no record at all — invisible
  // rather than failed, on a consumer that watches records.
  let tap: ReturnType<SessionDeps["startTap"]>;
  try {
    tap = deps.startTap();
    captureStartedAtMs = tap.startedAtMs;
  } catch (error) {
    // Left `null`: no capture window ever opened, which `measureCoverage`
    // reports as a meeting that is entirely gap rather than one with no
    // holes in it.
    noteFault(error);
    return finish("capture_failed", []);
  }
  const ceilingMs = (config.maxMeetingSeconds ?? DEFAULT_MAX_MEETING_SECONDS) * 1000;

  const transcribeResult = deps.transcribe(frameClock.meter(tap.frames));
  // A tap/transcription failure is a DIFFERENT ending from the room hanging
  // up or our own duration ceiling, and the record must say which — see
  // `endedReason` below. Resolving (never rejecting) this observer promise,
  // rather than racing the rejection itself, keeps `transcribeResult`'s
  // rejection handled from this one attachment regardless of which branch of
  // the race below wins.
  const transcriptionFailure = new Promise<"transcription_lost">((resolve) => {
    transcribeResult.catch(() => resolve("transcription_lost"));
  });

  // Signalled once any race branch below has already won, so the caption
  // loop's current wait is cut short instead of running out its own tick.
  let signalStop = (): void => {};
  const stopped = new Promise<void>((resolve) => {
    signalStop = resolve;
  });

  // Task 7's `waitUntilMeetingEnded` already carries the two-consecutive-poll
  // confirmation `hasEnded` needs (it is a NEGATIVE signal — every
  // `IN_MEETING_MARKERS` member absent — and a transient reload presents the
  // same zero-marker DOM as a real ending). Wired here, for the meeting's whole
  // remaining life, rather than reimplemented: a caption-loop tick that
  // merely skips reading captions on one `true` reading (below) is a
  // completely different, much weaker claim than "the meeting has ended",
  // and only this function is allowed to make the latter.
  // Cancelled below the moment any other branch of the race wins. Without
  // this the poll outlives the meeting: it never resolves once the ceiling or
  // a tap failure has already decided the ending, so it keeps calling
  // `hasEnded` on a page this module has finished with — once per interval,
  // for the life of the process, one abandoned loop per meeting run.
  const endedWatch = new AbortController();
  const confirmedEnded: Promise<SessionEnding> = waitUntilMeetingEnded(deps.adapter, page, {
    pollMs: CAPTION_POLL_MS,
    // Omitted rather than defaulted here when the caller named no tolerance:
    // `waitUntilMeetingEnded` owns the default and the reasoning behind the
    // number, and a second `??` in this file would be a second place for it
    // to be wrong.
    ...(config.endedConfirmSeconds === undefined
      ? {}
      : { confirmMs: config.endedConfirmSeconds * 1000 }),
    signal: endedWatch.signal
  }).then(
    (): SessionEnding => "far_end",
    (error: unknown): SessionEnding => {
      // The other place `adapter.hasEnded` is called, and the second route to
      // the same defect the caption loop's guard closes: an unguarded
      // rejection here rejected `Promise.race` below and skipped the whole
      // teardown, for a meeting that had genuinely been joined.
      //
      // An ABORT is not a fault. This module aborts only AFTER the race has
      // settled, so the value returned on that path can never win the race —
      // it exists to be swallowed by the `.catch` below, and returning it is
      // what keeps a deliberate cancellation from reading as a capture
      // failure or surfacing as an unhandled rejection.
      if (endedWatch.signal.aborted) return "far_end";
      noteFault(error);
      return "capture_failed";
    }
  );

  // The ceiling is armed from the SESSION's t0, not from here: the join is
  // part of the meeting's length, and a waiting room can be minutes of it.
  const ceiling = armCeiling(Math.max(0, ceilingMs - (deps.now() - t0)));

  const captionLoop = (async (): Promise<"capture_failed" | "stopped"> => {
    for (;;) {
      // Both adapter calls are guarded, and they are guarded DIFFERENTLY,
      // because they fail at different things. Unguarded, either throw
      // rejected this promise, `Promise.race` below rejected with it, and
      // EVERY line after the race was skipped: no stop signal, no ended-poll
      // abort, no tap stop, and no record for a meeting that had genuinely
      // been joined.
      if (captionsEnabled) {
        // Constraint: `hasEnded` MUST be checked before `readCaptions` on
        // every tick. Once the captions region is gone, `readCaptions`
        // throws by design (a missing container is not a quiet meeting) — a
        // tick that scraped captions first would throw on a perfectly normal
        // meeting ending. A single `true` reading here only skips this
        // tick's read; it is not by itself an ending (that is
        // `confirmedEnded`'s job, above).
        let ended: boolean;
        try {
          ended = await deps.adapter.hasEnded(page);
        } catch (error) {
          // This one DOES end the meeting. `hasEnded` is the question "are
          // we still in the room", and a page that cannot answer it is a
          // page this module cannot keep driving — carrying on would mean
          // capturing a host machine whose meeting may have ended minutes
          // ago.
          noteFault(error);
          return "capture_failed";
        }
        if (!ended) {
          try {
            for (const cue of await deps.adapter.readCaptions(page)) {
              // Cue times arrive as wall-clock; the adapter deliberately does
              // not know t0, so converting to the session's own base —
              // matching `TranscriptEvent.startMs`'s base — is this module's
              // job.
              //
              // Deduplicated on INGEST rather than filtered later: the ledger
              // keeps the first timestamp a line was seen at, and there is no
              // way to recover that afterwards from a list where every copy
              // carries a different, later one.
              cues.add({ ...cue, atMs: cue.atMs - t0 });
            }
          } catch (error) {
            // This one DEGRADES, and used to end the meeting and record it
            // as `transcription_lost` — which was false twice over: the tap
            // and the transcriber are untouched by a caption scrape that
            // failed, so the meeting was still producing a full transcript,
            // and the thing that died was attribution alone.
            //
            // This module already models exactly that loss: `ensureCaptions`
            // returning false continues the meeting unattributed and reports
            // it through `captionsEnabled`. The same loss arriving thirty
            // seconds later is the same loss. Trading the rest of the
            // meeting's content for a signal that can simply be reported is
            // not a trade worth making.
            //
            // Reading stops rather than retrying: `readCaptions` throws when
            // the region is absent or its selectors have rotated, and
            // neither heals within a meeting — polling on would raise the
            // same exception every second for the rest of the call.
            captionsEnabled = false;
            noteFault(error);
          }
        }
      }

      if ((await tickOrStop(CAPTION_POLL_MS, stopped)) === "stop") return "stopped";
    }
  })();

  const winner = await Promise.race([
    confirmedEnded,
    transcriptionFailure,
    captionLoop,
    ceiling.reached
  ]);
  signalStop();
  endedWatch.abort();
  ceiling.cancel();
  // Two loops can still be running after the race settles — the caption loop
  // and the ended-poll — and BOTH are awaited to a stop before the tap is
  // touched, so nothing here reads a page or a stream that teardown has
  // begun on.
  //
  // The `catch` on each is not decoration. `waitUntilMeetingEnded` rejects on
  // abort (resolving would read as "the meeting ended"), and the ended-poll
  // is normally the losing branch, so on every duration-cap and
  // transcription-lost run this promise rejects AFTER the race has settled.
  // Observing it here is what keeps a deliberate cancellation from surfacing
  // as an unhandled rejection, and keeps that guarantee stated where the
  // cancellation happens rather than resting on `Promise.race` having
  // attached handlers of its own.
  //
  // BOUNDED, because both of them are page round trips. An unbounded await
  // here hands a wedged renderer the power to withhold the record — and it
  // would do so on exactly the run the ceiling had just correctly ended.
  for (const [what, loop] of [
    ["the caption loop", captionLoop],
    ["the ended-meeting poll", confirmedEnded]
  ] as const) {
    if (!(await settledWithin(loop, TEARDOWN_STEP_TIMEOUT_MS))) {
      noteFault(
        new Error(
          `meeting teardown: ${what} did not stop within ${TEARDOWN_STEP_TIMEOUT_MS}ms of being ` +
            `told to. The page is not answering, so the meeting is being written down without ` +
            `waiting for it.`
        )
      );
    }
  }

  if (winner === "stopped") {
    // Unreachable: `captionLoop` only ever resolves "stopped" after
    // `stopped` has already settled, which only happens once this race has
    // already produced one of the other values.
    throw new Error(`runBrowserMeeting: unreachable race winner ${String(winner)}`);
  }
  const ending: SessionEnding = winner;

  // Stopping the tap is itself teardown, so a failure here must not be able
  // to suppress the record the way an unguarded `startTap` once did. The
  // ending is NOT rewritten: by this point the meeting has already ended for
  // a known reason and the frames have already been captured — a tap that
  // will not shut down cleanly is a fault to report, not a different story
  // about how the meeting went.
  try {
    await tap.stop();
  } catch (error) {
    noteFault(error);
  }
  // A transcription that FAILED is not a transcription that heard nothing —
  // see `SessionDeps.transcribe`. `partialTranscript` recovers whatever
  // reached the transcriber before the failure; anything that is not an
  // interruption (a transcriber that never connected, a bug) yields `[]`,
  // because there is genuinely nothing to salvage.
  const events = await transcribeResult.catch((error: unknown) => partialTranscript(error));
  return finish(ending, events);
}
