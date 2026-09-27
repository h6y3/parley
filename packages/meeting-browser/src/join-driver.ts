import type { JoinOutcome, PlatformAdapter } from "./types.js";

/** Phrases that identify each pre-join screen. Every pattern here is either
 * VERIFIED against a real capture in `test/fixtures/google-meet/` or marked
 * UNVERIFIED in its own comment — see the fixture README's "States not
 * captured" section. Two of the plan's original guesses were checked against
 * the real captures and found to match nothing at all:
 *
 * - The plan guessed the waiting-room text as
 *   `/asking to be let in|waiting for the host/i`. Neither phrase appears
 *   anywhere in `prejoin-waiting.html`. The real text, found there three
 *   times (once as a genuine visible text node, not just an `alt` or
 *   `aria-label`), is "Please wait until a meeting host brings you into the
 *   call."
 * - The plan assumed the ready screen's visible text was "Join now" or "Ask
 *   to join". `prejoin-ready.html`'s join control's *visible* text is "Ask to
 *   join" (2 occurrences, 0 in every other capture); its full accessible name
 *   — "Ask to join without microphone & camera" — lives only in the
 *   `aria-label` (see `PRE_JOIN.joinButton` in `google-meet.ts`).
 *
 * Order does not matter: the patterns are mutually exclusive in every real
 * capture (verified — none of the phrases below overlaps another capture's
 * text).
 *
 * ⚠️ EVERY PATTERN HERE MATCHES ENGLISH COPY ONLY, and this limit is worse
 * than the one the in-call anchors carry — which is the limit every locale
 * note in this file used to be about.
 *
 * An anchor failure means admission cannot be CONFIRMED: the bot has knocked,
 * is very possibly in the meeting, and the run ends at
 * `waiting_room_timeout` having sat there. A failure HERE is earlier and
 * quieter. `/ask to join/i` is what recognises the ready screen, and
 * recognising it is the only thing that clicks the join control (see
 * `joinMeeting`'s loop: `clicked` is set nowhere else). On a Meet UI
 * rendering in another language nothing matches, `clicked` stays false, the
 * join control is never pressed — and the transport times out **having never
 * knocked**. Nobody in the room ever saw a notetaker, the host was never
 * asked to admit anything, and the outcome reads the same as a host who
 * ignored a request that was never sent.
 *
 * That is the discriminator to check first when a `waiting_room_timeout`
 * arrives: ask the host whether a participant asked to be let in. If yes,
 * suspect the anchors (`IN_CALL_ANCHORS`, `google-meet.ts`). If nobody ever
 * knocked, suspect this list. The fix for either is a re-capture in that
 * locale and locale-aware patterns, not a longer timeout.
 *
 * Nothing here can be made locale-independent by rewriting a regex: these are
 * phrases Google chooses, and the only structural alternative — scoping the
 * text read to a pre-join-only container — does not exist in the captures
 * (every structural ancestor of both the join control and the lobby text is
 * present in every captured state, in-call included).
 *
 * Returns `undefined` rather than a default when nothing matches. An
 * unrecognised screen is exactly the state where guessing is most harmful:
 * the caller can retry or time out, but a manufactured "denied" would abandon
 * a meeting that was about to admit us. A non-English UI is the commonest way
 * to reach that `undefined` on a page that is in fact perfectly readable to a
 * human. */
const PRE_JOIN_MARKERS: ReadonlyArray<[RegExp, JoinOutcome]> = [
  // VERIFIED: prejoin-ready.html, the join control's visible text.
  [/ask to join/i, "admitted"],
  // UNVERIFIED: never observed in any of the five real captures — the two
  // capture sessions' guest account always went through the waiting room, so
  // the direct-entry path (no admission step, e.g. same organisation as the
  // host) was never exercised. Meet is documented elsewhere to use "Join
  // now" for that path; kept as a second pattern for it rather than
  // asserted against evidence.
  [/join now/i, "admitted"],
  // VERIFIED: prejoin-waiting.html, the lobby status text (3 occurrences,
  // one a genuine text node).
  [/please wait until a meeting host brings you into the call/i, "waiting_room_timeout"],
  // UNVERIFIED (denied, not-started, expired-session — see fixture README
  // "States not captured"): none of these three could be produced on demand
  // during the capture session, so no real markup or copy exists to check
  // against. Best-known phrasing only.
  [/you can'?t join|no one responded|denied your request/i, "denied"],
  [/hasn'?t started|not started yet/i, "not_started"],
  [/sign in to join|choose an account/i, "auth_required"]
];

export function classifyPreJoin(pageText: string): JoinOutcome | undefined {
  for (const [pattern, outcome] of PRE_JOIN_MARKERS) {
    if (pattern.test(pageText)) return outcome;
  }
  return undefined;
}

/** The DOM surface `joinMeeting` drives, declared structurally (not imported
 * from `playwright`) so this package takes no runtime dependency on it. A
 * real Playwright `Page`/`Locator` satisfies these; so does any fixture- or
 * string-backed stand-in a test builds. */
export interface JoinLocator {
  count(): Promise<number>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  first(): JoinLocator;
  getAttribute(name: string): Promise<string | null>;
}

export interface JoinPage {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  innerText(selector: string): Promise<string>;
  locator(selector: string): JoinLocator;
  waitForTimeout(ms: number): Promise<void>;
}

/** The platform-specific pieces `joinMeeting` needs but cannot derive itself:
 * where the name field, camera toggle, microphone toggle and join control
 * live. Supplied by each adapter (see `google-meet.ts`'s `PRE_JOIN`). */
export interface PreJoinSelectors {
  /** Missing is "nothing to turn off", never an error — the capture host had
   * no camera, and Meet still rendered this control, so absence here is
   * only ever a real capability gap, not drift to alert on. */
  cameraToggle: string;
  /** Missing is "nothing to turn off" here too — but a control that is
   * PRESENT and unreadable is not, and refuses the join. See `joinMeeting`
   * for why the two devices are treated differently. */
  micToggle: string;
  /** Missing is "nothing to fill". Never observed in either real pre-join
   * capture: both were taken signed in to a Google account, and Meet does
   * not offer a name field to a signed-in participant — the account's own
   * profile name is what the room sees, which is exactly how the notetaker
   * account's display name reached the room in this capture session. Real
   * for the anonymous-join path; that path itself is UNVERIFIED, since it
   * was never exercised. */
  nameField: string;
  joinButton: string;
}

export interface JoinMeetingOptions {
  selectors: PreJoinSelectors;
  /** Resolves once the in-call UI has appeared — confirms admission
   * independent of the click having succeeded, because clicking a knock
   * control only queues the caller. Deliberately never derived from
   * `adapter.hasEnded`: `prejoin-waiting.html` already carries its own
   * preview tile and a "Leave call" control, so `hasEnded`'s negative
   * ("not ended") reading is already true while still in the waiting room —
   * using it here would report admission the instant the knock is sent. */
  isAdmitted(page: JoinPage): Promise<boolean>;
  /** Whether the page carries ANY in-call marker at all — rendered or not.
   * A DIFFERENT question from `isAdmitted`, and the reason it is a separate
   * option is that the two must be allowed to fail independently.
   *
   * They answer different things and err in opposite directions on purpose:
   *
   * - `isAdmitted` gates starting the audio tap, so it demands the STRONGER
   *   evidence — an anchor that is actually rendered. Being wrong here
   *   records a room that never admitted us.
   * - This one gates whether page text may be turned into a terminal
   *   pre-join verdict, and the destructive action there is CLASSIFYING, so
   *   it settles for the WEAKER evidence — an anchor merely present. Being
   *   wrong here abandons a meeting we are sitting in because somebody in it
   *   said "you can't join".
   *
   * Optional. When omitted the gate falls back to `isAdmitted`'s ALREADY
   * COMPUTED answer — one signal deciding both questions, which is exactly
   * the coupling this option exists to let an adapter break, kept as the
   * default so an adapter that does not care is unchanged and costs no extra
   * page round trip. `google-meet.ts` supplies it, because its `isAdmitted`
   * was narrowed to rendered anchors and a mounted-but-hidden one would
   * otherwise have swung the classification gate open on an in-call page.
   *
   * Only ever consulted when `isAdmitted` already said no: a rendered anchor
   * is a present one, so on an admitted page the answer is known. */
  inCallMarkerPresent?(page: JoinPage): Promise<boolean>;
  waitingRoomTimeoutMs?: number;
  pollMs?: number;
  /** Injectable clock for the waiting-room deadline, so a timeout can be
   * pinned in a test without a real wait. Defaults to `Date.now`. Pacing
   * between polls uses `page.waitForTimeout` instead of a second injectable
   * here — it is already part of the page contract and matches a real
   * Playwright `Page`, so a test-only page can make it resolve instantly
   * without this module needing a parallel knob for the same thing. */
  now?(): number;
}

export const DEFAULT_WAITING_ROOM_TIMEOUT_MS = 120_000;
export const DEFAULT_PRE_JOIN_POLL_MS = 2000;

/** Resolves after `ms`, or REJECTS the moment `signal` aborts — and clears
 * its own timer when it does, so a cancelled poll leaves nothing pending that
 * could keep a process alive for another interval. */
function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs `wait`, but stops waiting the instant `signal` aborts.
 *
 * The signal is ALSO handed to `wait` (`defaultWait` uses it to clear its
 * timer), but the race is what makes cancellation prompt regardless: an
 * injected `wait` is free to ignore the second argument, and a caller that
 * cancelled must not then be held for a full poll interval by a sleep that
 * did not opt in. */
function waitOrAbort(
  wait: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal === undefined) return wait(ms);
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    wait(ms, signal).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error as Error);
      }
    );
  });
}

/** What a toggle-driving attempt did, distinguished so a caller can tell
 * "there was nothing to do" from "there was nothing we could read". */
export type ToggleResult = "absent" | "already" | "clicked" | "unrecognised";

/** Drive one Meet toggle to a desired state, reading its `aria-label` as the
 * ACTION the button performs rather than as the current state.
 *
 * That inversion is the single most dangerous detail in Meet's markup for a
 * scraper, and it is VERIFIED in both directions on two different controls:
 * `prejoin-ready.html` reads "Turn off microphone"/"Turn off camera" with
 * `data-is-muted="false"` on both — i.e. currently ON — and
 * `prejoin-waiting.html`, captured after the devices were turned off before
 * asking to join, reads "Turn on microphone"/"Turn on camera". Read the
 * label forwards and a scraper reports the opposite of the truth.
 *
 * One function rather than one per control, because every caller of it is
 * betting on the same convention, and a second hand-rolled copy is a second
 * chance to invert it. `unrecognised` rather than a guess when the label
 * says neither: an unknown wording is exactly where clicking blind is worst,
 * since the click itself changes the state we could not read. */
export async function driveToggle(
  page: JoinPage,
  selector: string,
  desired: "on" | "off"
): Promise<ToggleResult> {
  const el = page.locator(selector).first();
  if ((await el.count()) === 0) return "absent";
  const label = (await el.getAttribute("aria-label")) ?? "";
  const actionTurnsOn = /turn on/i.test(label);
  const actionTurnsOff = /turn off/i.test(label);
  if (actionTurnsOn === actionTurnsOff) return "unrecognised";
  // "Turn on X" is offered only while X is off, and vice versa.
  const current = actionTurnsOn ? "off" : "on";
  if (current === desired) return "already";
  await el.click();
  return "clicked";
}

/** The transport refused to join, because it could not establish that a
 * device it is required to silence is silent.
 *
 * A class rather than a bare `Error` because this is a REFUSAL and not a
 * breakage: the browser is fine, the meeting is there, and this code decided
 * not to enter it. A caller putting a failure in front of a human should be
 * able to tell those apart, and `captureFault` (`session.ts`) is where this
 * arrives. */
export class DeviceStateUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceStateUnknownError";
  }
}

/** Camera and microphone are turned off BEFORE the join click, never after:
 * a notetaker that appears with a live microphone, even for one second, is a
 * different product from the one specified.
 *
 * A toggle that is absent is "nothing to turn off", never an error — the
 * capture host had no camera, and Meet still rendered the control, so
 * absence here is only ever a real capability gap.
 *
 * RETURNS the result, which it used to discard. `driveToggle` has four
 * outcomes and two of them mean the device was not touched: `absent`, which
 * is the benign one above, and `unrecognised`, which means the control IS
 * there, its label read neither "turn on" nor "turn off", and it was
 * therefore deliberately not clicked. Swallowing the second alongside the
 * first is how a notetaker joins with a live device and nothing anywhere
 * says so. What to do about it is the caller's decision, and it differs by
 * device — see `joinMeeting`. */
async function turnOff(page: JoinPage, selector: string): Promise<ToggleResult> {
  return driveToggle(page, selector, "off");
}

/** Drives the pre-join screen for any adapter: fills the display name if a
 * field is offered, turns camera and microphone off, asks to join, and polls
 * until the in-call UI confirms admission, a terminal screen is recognised,
 * or the waiting-room deadline passes.
 *
 * `adapter` is consulted for `hasEnded` as a second, independent guard on
 * admission: `opts.isAdmitted` is the precise positive signal (the
 * platform's own in-call marker), and requiring `hasEnded` to also agree we
 * are not in a torn-down state guards against a stale render of that marker
 * surviving into a teardown. */
export async function joinMeeting(
  adapter: Pick<PlatformAdapter, "hasEnded">,
  page: JoinPage,
  url: string,
  displayName: string,
  opts: JoinMeetingOptions
): Promise<JoinOutcome> {
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const nameField = page.locator(opts.selectors.nameField).first();
  if ((await nameField.count()) > 0) await nameField.fill(displayName);

  // The camera first, and its `unrecognised` is TOLERATED — deliberately, and
  // on evidence rather than by symmetry with the line below.
  //
  // `in-call-captions-off.html` is a real capture in which
  // `[role="button"][aria-label*="amera"]` matches exactly one element, whose
  // label is "Camera problem. Show more info": Meet had SUBSTITUTED a
  // device-fault control for the toggle. That state drives `driveToggle`
  // straight to `unrecognised`, and it is also a state in which the camera
  // demonstrably is not transmitting — the control says so. Refusing to join
  // there would abandon meetings on any host whose webcam has faulted, which
  // is common and harmless. Stated plainly, the residual: if some OTHER
  // unreadable camera label exists, this joins with an unknown camera state.
  const camera = await turnOff(page, opts.selectors.cameraToggle);

  const microphone = await turnOff(page, opts.selectors.micToggle);
  if (microphone === "unrecognised") {
    // `unrecognised` is not "the microphone is on" — it is "this code cannot
    // tell", and on this device that is the same thing. The module's own
    // standard is that a notetaker appearing with a live microphone even for
    // one second is a different product, and an unknown state cannot be
    // asserted to meet it. Nothing else downstream can recover the answer
    // either: the click that would settle it is the one action that could
    // itself turn a live microphone ON.
    //
    // It fires BEFORE the join control is clicked, so the refusal costs an
    // attempt rather than a meeting somebody is sitting in. `session.ts`
    // catches it, writes the record, and closes the page.
    throw new DeviceStateUnknownError(
      `join refused: the microphone control (${opts.selectors.micToggle}) is on the page but ` +
        `its label states neither "turn on" nor "turn off", so this transport cannot ` +
        `establish that the microphone is off and will not enter the meeting with an unknown ` +
        `microphone state. Clicking blind is not an option — the click is what could turn a ` +
        `live microphone on. Re-capture the pre-join fixtures and update the selectors ` +
        `(packages/meeting-browser/test/fixtures/google-meet/README.md). ` +
        `The camera control read: ${camera}.`
    );
  }

  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? DEFAULT_PRE_JOIN_POLL_MS;
  const deadline = now() + (opts.waitingRoomTimeoutMs ?? DEFAULT_WAITING_ROOM_TIMEOUT_MS);

  let clicked = false;
  for (;;) {
    // Admission is confirmed by the in-call UI appearing, never by the click
    // succeeding: clicking a knock control only queues us.
    const admitted = await opts.isAdmitted(page);
    if (clicked && admitted && !(await adapter.hasEnded(page))) {
      return "admitted";
    }

    // `classifyPreJoin` matches phrases against the WHOLE page text, and
    // in-call pages are full of text nobody here controls: captions, chat,
    // participant names, notifications. "You can't join", "not started" or
    // "sign in" arriving in any of those would turn an already-successful
    // join into a terminal verdict — a meeting abandoned mid-call because
    // somebody said the wrong sentence.
    //
    // So classification is confined to pages showing NO in-call anchor. That
    // is derived, not chosen: every anchor in `IN_CALL_ANCHORS` matches zero
    // times in both real pre-join captures, so this gate cannot suppress a
    // genuine pre-join screen — while an in-call page, by definition,
    // matches at least one and is never classified at all.
    //
    // Scoping the text read to a pre-join-only container would be the
    // narrower fix and is NOT available: in the captures every structural
    // ancestor of both the join control and the lobby text (`c-wiz`, the
    // page root, the `jsname`-keyed wrappers) is present in every captured
    // state, in-call included. There is nothing to scope to.
    //
    // A SEPARATE query from `isAdmitted`, not a reuse of its answer. The two
    // gate different things and want different strengths of evidence — see
    // `inCallMarkerPresent` above — and once `isAdmitted` was narrowed to
    // RENDERED anchors, reusing it here would have meant an in-call page
    // whose anchors were mounted-but-hidden reading as "not admitted" AND
    // "safe to classify", which is the worse of the two errors. Skipped
    // entirely when `admitted` is already true: a rendered anchor is a
    // present one, so the second round trip would be asking a question whose
    // answer is already known.
    //
    // WHAT REMAINS COUPLED, stated because separating the calls does not
    // separate their evidence: both signals are derived from the same
    // English-only anchor list. In a Meet UI rendering in another language
    // every anchor fails at once, so `admitted` is permanently false, this
    // gate is permanently open, and in-call text is classified for the whole
    // loop — the same page can then return `denied` from inside a meeting.
    // No locale-independent in-call-only anchor exists in the captures to
    // fix that with (see `IN_CALL_ANCHORS` in `google-meet.ts`), so it is a
    // known limit rather than an oversight, and the timeout below is where
    // it surfaces.
    const inCallMarker =
      admitted ||
      (opts.inCallMarkerPresent !== undefined && (await opts.inCallMarkerPresent(page)));
    if (!inCallMarker) {
      const outcome = classifyPreJoin(await page.innerText("body"));
      if (outcome === "denied" || outcome === "not_started" || outcome === "auth_required") {
        return outcome;
      }
      if (outcome === "admitted" && !clicked) {
        await page.locator(opts.selectors.joinButton).first().click();
        clicked = true;
      }
    }

    if (now() > deadline) {
      // READ THIS BEFORE BELIEVING A `waiting_room_timeout`.
      //
      // It is the honest answer to "we could not confirm admission", and a
      // NON-ENGLISH Meet UI reaches it in TWO different ways that look
      // identical from here and need opposite fixes. Ask the host one
      // question — did a participant ask to be let in? — because that is the
      // only thing that separates them.
      //
      // 1. THE HOST SAW A KNOCK, or says the notetaker was visibly in the
      //    meeting. Then the anchors failed. Every member of
      //    `IN_CALL_ANCHORS` matches English copy — "Meeting details",
      //    "Captions", "Call feature notifications and actions" — so in
      //    another UI language all of them fail together, `isAdmitted` is
      //    permanently false, and this line is reached from inside a meeting
      //    the bot is sitting in. No locale-independent in-call-only anchor
      //    exists in the captures to fix that with: every structural ancestor
      //    of the controls is present in every captured state, and the
      //    in-call-only `data-*` names belong to the captions language menu,
      //    which is itself captions-dependent.
      //
      //    The same list also gates whether page text may be classified (see
      //    `inCallMarkerPresent` above), so the same locale failure leaves
      //    that gate open for the whole loop — an in-call page can then
      //    return `denied` instead of reaching this line at all.
      //
      // 2. NOBODY EVER KNOCKED. Then `classifyPreJoin` failed, which is the
      //    earlier and quieter half and is documented at `PRE_JOIN_MARKERS`.
      //    Its patterns are English-only too, and `/ask to join/i` is the
      //    only thing in this loop that sets `clicked` — so on an
      //    unrecognised ready screen the join control is never pressed and
      //    the run times out having never asked for anything. The room saw no
      //    notetaker at all, which is why symptom 1 above must not be the
      //    first thing a debugger checks: it points at the meeting, and in
      //    this case there was never a request to admit.
      //
      // The fix for either is a re-capture on that locale and locale-aware
      // patterns, never a longer timeout: neither failure is a matter of
      // waiting. `JOIN_OUTCOMES` in `@parley/core` points here.
      return "waiting_room_timeout";
    }
    await page.waitForTimeout(pollMs);
  }
}

/** How long the ended signal must hold CONTINUOUSLY before a meeting is
 * treated as actually over. Thirty seconds.
 *
 * A DURATION, not a count of polls, because the thing being tolerated is a
 * duration: a page blackout of some length. Expressed as polls it silently
 * changes meaning whenever the poll interval changes — `session.ts` polls at
 * 1000ms and this module defaults to 2000ms, so the same "two polls" was two
 * seconds in one caller and four in the other, and neither number appears
 * anywhere in the reasoning that chose it.
 *
 * `hasEnded` (see `google-meet.ts`) is a NEGATIVE signal: every member of
 * `IN_MEETING_MARKERS` absent. That is indistinguishable, on a single poll,
 * from a transient full-page reload — a network blip that reloads Meet
 * presents zero of all three markers for as long as it takes to re-render.
 * No fixture exists for a reconnect (it cannot be produced on demand any more
 * than a denied join can), so this cannot be pinned against captured markup —
 * it is tested at the loop level instead, with a stubbed adapter.
 *
 * THE NUMBER WAS 2 POLLS, i.e. a 2–4 second blackout ended the meeting, and
 * the comment defending it argued that "the pre-join screen's anchors
 * reappear well inside one interval". That is a claim about
 * `PRE_JOIN_MARKERS`, and the set actually consulted here is
 * `IN_MEETING_MARKERS` — on which a FULLY RESTORED pre-join screen measures
 * 0 of 3. The capture proves it: `hasEnded(prejoin-ready.html)` is `true`,
 * asserted in `google-meet.test.ts`. So the justification cited the fixture
 * that refutes it, and a Meet reload does not repaint a multi-megabyte SPA in
 * four seconds anyway. What that bought was a stopped tap, a transcript
 * truncated mid-meeting and a false `far_end`, needing no Google UI drift to
 * fire.
 *
 * Thirty seconds is chosen against a COLD SPA render — the whole application
 * fetched and rebuilt on a slow link, plus the reconnect behind it — which is
 * the event this has to survive. It is an order of magnitude above the
 * blackout that used to end a meeting and two orders below the meeting
 * itself.
 *
 * The cost, stated: a meeting that has genuinely ended goes on being captured
 * for up to this long, and the tap captures all system audio. That tail is
 * bounded, it is measured (the record's `coveredMs`/`gapMs` span it), and it
 * is the cheaper of the two errors — the other one silently truncates the
 * meeting it was recording. */
export const HAS_ENDED_CONFIRM_MS = 30_000;

export const DEFAULT_ENDED_POLL_MS = 2000;

/** How many consecutive readings span at least `confirmMs` at `pollMs`.
 *
 * N readings are separated by N−1 intervals, so a streak of N covers
 * (N−1)·pollMs of wall time: the `+ 1` is what makes the tolerance the
 * duration it claims to be rather than one interval short of it. Never fewer
 * than two — a single reading is not a confirmation of anything, which is the
 * one part of the old two-poll rule that was right.
 *
 * Exported so the arithmetic is testable on its own. It is the only place
 * this module converts between the unit the reasoning is in (time) and the
 * unit the loop runs in (polls). */
export function confirmPollsForWindow(confirmMs: number, pollMs: number): number {
  return Math.max(2, Math.floor(confirmMs / pollMs) + 1);
}

export interface WaitUntilMeetingEndedOptions {
  /** How long the ended signal must hold continuously, in milliseconds.
   * Defaults to `HAS_ENDED_CONFIRM_MS`. In THIS unit rather than a poll
   * count: a caller tuning it is reasoning about how long a blackout it wants
   * to survive, and it must not change meaning when `pollMs` does. */
  confirmMs?: number;
  pollMs?: number;
  /** Injectable so tests do not sleep for real. Defaults to a real timer.
   * Receives `signal` as a second argument so a sleep can cancel itself; a
   * `wait` that ignores it is still cancelled promptly by the caller, which
   * races it — see `waitOrAbort`. */
  wait?(ms: number, signal?: AbortSignal): Promise<void>;
  /** Stops the poll. REQUIRED of any caller that abandons this promise while
   * it is still running — see the function's own doc comment for why an
   * abandoned poll is not harmless. */
  signal?: AbortSignal;
}

/** Polls `adapter.hasEnded(page)` until the ended signal has held CONTINUOUSLY
 * for `confirmMs` (see `HAS_ENDED_CONFIRM_MS`), then resolves. Any single
 * `false` resets the streak to zero — the anchors reappearing means the prior `true` was a
 * transient reload, not an ending. A loop that trusted a single reading would
 * end a healthy meeting on a reconnect, which is a live risk for any caller
 * that stops the audio tap and writes a record on `hasEnded()` alone.
 *
 * CANCELLABLE, and callers that race it must cancel it. This function owns
 * neither the page nor its lifetime: a caller that races it against a
 * duration ceiling or a failure observer and then walks away leaves a poll
 * running for the life of the process, calling into a page the caller has
 * finished with, once per interval, forever — one such loop per meeting. Pass
 * `opts.signal` and abort it once another branch has won.
 *
 * On abort this REJECTS (with the signal's reason) rather than resolving.
 * Resolving would be indistinguishable from "the meeting ended", which is
 * exactly the false conclusion a cancelled poll must not be able to reach —
 * `session.ts` maps this promise's resolution straight to `endedReason:
 * "far_end"`. Cancelling callers must therefore observe the rejection; see
 * `runBrowserMeeting` for the shape. */
export async function waitUntilMeetingEnded(
  adapter: Pick<PlatformAdapter, "hasEnded">,
  page: unknown,
  opts: WaitUntilMeetingEndedOptions = {}
): Promise<void> {
  const pollMs = opts.pollMs ?? DEFAULT_ENDED_POLL_MS;
  const confirmPolls = confirmPollsForWindow(opts.confirmMs ?? HAS_ENDED_CONFIRM_MS, pollMs);
  const wait = opts.wait ?? defaultWait;
  const signal = opts.signal;

  let consecutive = 0;
  for (;;) {
    // Checked before each poll, not only around the sleep: an abort that
    // lands while `hasEnded` is in flight must not buy one more call into a
    // page the caller has already let go of.
    signal?.throwIfAborted();
    const ended = await adapter.hasEnded(page);
    signal?.throwIfAborted();
    consecutive = ended ? consecutive + 1 : 0;
    if (consecutive >= confirmPolls) return;
    await waitOrAbort(wait, pollMs, signal);
  }
}
